/**
 * High-level orchestrator. Owns the DB, the control server, the agents,
 * and the notification routing.
 *
 * After the 4-way refactor, this file is a thin facade: it holds the
 * shared state and the intervals, and delegates the actual logic to
 * four focused modules under `./orchestrator/`.
 *
 * Module layout:
 *   ./orchestrator/defaults.ts  — constants, types, re-exports
 *   ./orchestrator/lifecycle.ts — agent registry + auto-nudge + cost/rep tracking
 *   ./orchestrator/topic-bus.ts — entry → agent notification routing + confirmations
 *   ./orchestrator/admin.ts     — admin CLI dispatch + queries
 *
 * Cross-module edges: 3 (all from admin.ts reading tables or calling
 * `recordNudge`). See design.md § Cross-module edges.
 */

import { openDb } from "./db.js";
import { AgentProcess, type AgentOpts } from "./rpc.js";
import { ControlServer, type EntryRow } from "./control-server.js";
import type { Database as DB } from "better-sqlite3";
import { join } from "node:path";
import {
	DEFAULT_AUTO_NUDGE,
	DEFAULT_AUTO_NUDGE_MESSAGE,
	MAX_STEER_PREVIEW_CHARS,
	type AutoNudgeOptions,
	type SpawnOpts,
} from "./orchestrator/defaults.js";

// Re-export the public surface so `src/cli.ts` and the test files keep
// working without any import-path or import-name change.
export {
	DEFAULT_AUTO_NUDGE,
	DEFAULT_AUTO_NUDGE_MESSAGE,
	MAX_STEER_PREVIEW_CHARS,
} from "./orchestrator/defaults.js";
export type { AutoNudgeOptions, AgentOpts, SpawnOpts } from "./orchestrator/defaults.js";

import * as lifecycle from "./orchestrator/lifecycle.js";
import * as topicBus from "./orchestrator/topic-bus.js";
import * as admin from "./orchestrator/admin.js";
import type { LifecycleCtx, TopicBusCtx, AdminCtx } from "./orchestrator/index.js";

export class Orchestrator {
	readonly db: DB;
	readonly dataDir: string;
	readonly socketPath: string;
	readonly startedAt: number;
	readonly agents = new Map<string, AgentProcess>();
	readonly control: ControlServer;
	readonly autoNudge: AutoNudgeOptions;
	/** Max chars of an entry body included in a steer push. Read by the
	 *  topic-bus module to truncate long bodies. */
	readonly maxSteerPreviewChars: number = MAX_STEER_PREVIEW_CHARS;

	/** Hook for tests / observability: called once per posted entry after notifications are sent. */
	onEntryNotified?: (entry: EntryRow, notifiedAgents: string[]) => void;

	/** Per-session tally of how often a peer's tool-call budget was hit. Mutable from outside. */
	budgetHits = 0;
	/** Per-agent tally (in-memory; not persisted). */
	budgetHitsByAgent = new Map<string, number>();

	/** How long to wait before timing out a pending confirmation. Configurable; default 60s. */
	confirmationTimeoutMs = 60_000;
	/** Background tick that times out pending confirmations. Holder so the
	 *  topic-bus module can read/write the handle without seeing the
	 *  Orchestrator class. */
	confirmationTickHandle: { current: NodeJS.Timeout | null } = { current: null };

	/** Background tick for auto-nudge. */
	autoNudgeTickHandle: NodeJS.Timeout | null = null;
	/** Per-agent: timestamp of the last auto-nudge we sent. */
	lastAutoNudgeAt = new Map<string, number>();
	/** Per-session tally of auto-nudges sent. */
	autoNudgesSent = 0;

	constructor(dataDir: string, opts: { autoNudge?: Partial<AutoNudgeOptions> } = {}) {
		this.dataDir = dataDir;
		this.socketPath = join(dataDir, "mesh.sock");
		this.startedAt = Date.now();
		this.autoNudge = { ...DEFAULT_AUTO_NUDGE, ...opts.autoNudge };
		this.db = openDb(`${dataDir}/mesh.db`);
		this.control = new ControlServer({
			socketPath: this.socketPath,
			db: this.db,
			onPost: (entry) => this.handleNewEntry(entry),
			onBudgetHit: (info) => this.recordBudgetHit(info),
			onAdminCommand: async (req) => this.handleAdminCommand(req),
		});
	}

	// ────────────────────────────────────────────────────────────────────────
	// Public API — every method delegates to a module function. The
	// facade passes `this` as the ctx for each call; the ctx interfaces
	// are declared in `./orchestrator/index.ts` and the cast there makes
	// the cast safe (the facade really does have all the fields).
	// ────────────────────────────────────────────────────────────────────────

	async start(): Promise<void> {
		await this.control.start();
		// Reconcile the persistent agent registry on startup. Marks any
		// row whose process is gone as 'exited' so the rest of the
		// orchestrator sees accurate liveness. Runs once, before the
		// background ticks start, so auto-nudge doesn't try to nudge
		// dead processes. See design § D3.
		lifecycle.reconcileAgents(this as unknown as LifecycleCtx);
		// Background tick: every second, scan for timed-out pending
		// confirmations. Lightweight (a single indexed query) so 1Hz is fine.
		this.confirmationTickHandle.current = setInterval(() => {
			try {
				this.checkConfirmationTimeouts();
			} catch (err) {
				process.stderr.write(
					`[orch:confirm] tick error: ${err instanceof Error ? err.message : err}\n`,
				);
			}
		}, 1000);

		// Background tick: auto-nudge silent agents. Runs every
		// `checkIntervalMinutes` minutes (default 1). Configurable
		// via mesh start --auto-nudge-after / --auto-nudge-disabled.
		if (this.autoNudge.enabled && this.autoNudge.afterMinutes > 0) {
			this.autoNudgeTickHandle = setInterval(() => {
				try {
					this.checkAutoNudge();
				} catch (err) {
					process.stderr.write(
						`[orch:auto-nudge] tick error: ${err instanceof Error ? err.message : err}\n`,
					);
				}
			}, this.autoNudge.checkIntervalMinutes * 60 * 1000);
			process.stderr.write(
				`[orch:auto-nudge] enabled, threshold ${this.autoNudge.afterMinutes}m, check every ${this.autoNudge.checkIntervalMinutes}m\n`,
			);
		} else {
			process.stderr.write(`[orch:auto-nudge] disabled\n`);
		}
	}

	/** Spawn an agent and register it. Delegates to the lifecycle module. */
	async spawnAgent(spec: AgentOpts, opts: SpawnOpts = {}): Promise<AgentProcess> {
		return lifecycle.spawnAgent(this as unknown as LifecycleCtx, spec, opts);
	}

	getAgent(name: string): AgentProcess | undefined {
		return lifecycle.getAgent(this as unknown as LifecycleCtx, name);
	}

	/** Names of all live agents. */
	listAgents(): string[] {
		return lifecycle.listAgents(this as unknown as LifecycleCtx);
	}

	/** Shutdown all agents and close the DB. */
	async shutdown(): Promise<void> {
		if (this.confirmationTickHandle.current) {
			clearInterval(this.confirmationTickHandle.current);
			this.confirmationTickHandle.current = null;
		}
		if (this.autoNudgeTickHandle) {
			clearInterval(this.autoNudgeTickHandle);
			this.autoNudgeTickHandle = null;
		}
		const agents = [...this.agents.values()];
		this.agents.clear();
		await Promise.all(agents.map((a) => a.shutdown()));
		await this.control.stop();
		this.db.close();
	}

	// ────────────────────────────────────────────────────────────────────────
	// Internal callbacks — these match the lifecycle/topic-bus/admin ctx
	// shapes so the module functions can call `this.handleAgentExit(name)`
	// and `this.pushEvent(event)` and `this.checkAutoNudge()` and friends.
	// Each is a one-liner that delegates to the right module.
	// ────────────────────────────────────────────────────────────────────────

	/** Forward an interesting event to the control server's broadcast
	 *  stream. Used by `mesh watch` to see real-time activity. */
	private pushEvent(event: unknown): void {
		this.control.pushEvent(event);
	}

	/** Called by the agent's `exit` listener. Delegates to lifecycle. */
	private handleAgentExit(name: string): void {
		lifecycle.handleAgentExit(this as unknown as LifecycleCtx, name);
	}

	/** Called by the control server's `onPost` callback. */
	private handleNewEntry(entry: EntryRow): Promise<void> {
		return topicBus.handleNewEntry(this as unknown as TopicBusCtx, entry);
	}

	/** Called by the control server's `onBudgetHit` callback. */
	private recordBudgetHit(info: { author: string; tool: string; calls: number; budget: number }): void {
		lifecycle.recordBudgetHit(this as unknown as lifecycle.LifecycleCtx, info);
	}

	/** Called by the 1s tick in `start()`. */
	private checkConfirmationTimeouts(): void {
		topicBus.checkConfirmationTimeouts(this as unknown as TopicBusCtx);
	}

	/** Called by the auto-nudge tick in `start()`. */
	private checkAutoNudge(): void {
		lifecycle.checkAutoNudge(this as unknown as LifecycleCtx);
	}

	/** Called by the control server's `onAdminCommand` callback. */
	private handleAdminCommand(req: any): Promise<{ ok: boolean; data?: unknown; error?: string }> {
		return admin.handleAdminCommand(this as unknown as AdminCtx, req);
	}
}
