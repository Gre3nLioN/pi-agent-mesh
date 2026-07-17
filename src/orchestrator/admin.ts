/**
 * Admin module — handleAdminCommand + all `admin*` query methods.
 *
 * Owns:
 *   - The dispatch switch on `req.type` for every `admin_*` RPC.
 *   - All admin query methods (`adminListAgents`, `adminListTopics`, etc.).
 *   - The `adminInject` action (sends a steer message to a live agent).
 *
 * Cross-module edges:
 *   - `adminInject` calls `recordNudge` (from `lifecycle.ts`) for the
 *     manual-nudge audit trail. This is the only function call from
 *     `admin.ts` into another module.
 *   - `adminListAgents` reads the `pending_confirmations` table (written by
 *     `topic-bus.ts#checkConfirmationTimeouts`); no function call.
 *   - `adminReputationStatus` reads the `nudges` table (written by
 *     `lifecycle.ts#recordNudge`); no function call. Implementation lives
 *     in `lifecycle.ts` because it belongs to the cost/reputation group.
 *   - `adminCostStatus` reads the `costs` table (written by
 *     `lifecycle.ts#recordCost`); no function call. Implementation lives
 *     in `lifecycle.ts`.
 *   - `adminAutoNudgeStatus` reads the `lastAutoNudgeAt` map (owned by
 *     `lifecycle.ts#checkAutoNudge`); passed through the ctx.
 */

import { ControlServer, type EntryRow, type TopicRow } from "../control-server.js";
import { AgentProcess } from "../rpc.js";
import type { Database as DB } from "better-sqlite3";
import type { AutoNudgeOptions } from "./defaults.js";
import { recordNudge } from "./lifecycle.js";
import { adminCostStatus, adminReputationStatus } from "./lifecycle.js";

// ────────────────────────────────────────────────────────────────────────────
// AdminCtx — what the admin functions read from the orchestrator.
// The Orchestrator class satisfies this interface structurally; no
// `implements` declaration needed.
// ────────────────────────────────────────────────────────────────────────────
export interface AdminCtx {
	db: DB;
	control: ControlServer;
	agents: Map<string, AgentProcess>;
	startedAt: number;
	socketPath: string;
	dataDir: string;
	autoNudge: AutoNudgeOptions;
	lastAutoNudgeAt: Map<string, number>;
	autoNudgesSent: number;
	// `shutdown` is called by the `admin_shutdown` case below.
	shutdown: () => Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────────
// Command dispatch
// ────────────────────────────────────────────────────────────────────────────

/**
 * Handle admin RPCs (type starting with `admin_`). These are
 * sent by the human operator via the `mesh` CLI subcommands.
 */
export async function handleAdminCommand(
	ctx: AdminCtx,
	req: any,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
	try {
		switch (req.type) {
			case "admin_list_agents":
				return { ok: true, data: { agents: adminListAgents(ctx) } };
			case "admin_list_topics":
				return { ok: true, data: { topics: adminListTopics(ctx) } };
			case "admin_get_entry":
				return { ok: true, data: adminGetEntry(ctx, req.id) };
			case "admin_get_topic":
				return { ok: true, data: adminGetTopic(ctx, req.topic_id) };
			case "admin_orchestrator_status":
				return { ok: true, data: adminOrchestratorStatus(ctx) };
			case "admin_auto_nudge_status":
				return { ok: true, data: adminAutoNudgeStatus(ctx) };
			case "admin_cost_status":
				return { ok: true, data: adminCostStatus(ctx, req) };
			case "admin_reputation_status":
				return { ok: true, data: adminReputationStatus(ctx) };
			case "admin_inject":
				return await adminInject(ctx, req.agent, req.message);
			case "admin_write_checkpoint":
				return ctx.control.handleWriteCheckpoint(req);
			case "admin_shutdown":
				// Schedule shutdown; return first. Use setImmediate so
				// the response goes out before any cleanup runs.
				setImmediate(() => {
					process.stderr.write(`[orch] received admin_shutdown; shutting down\n`);
					// Best-effort cleanup; force-exit at the end regardless.
					ctx.shutdown()
						.catch((err) => {
							process.stderr.write(
								`[orch] shutdown error: ${err instanceof Error ? err.message : err}\n`,
							);
						})
						.finally(() => {
							process.exit(0);
						});
					// Hard timeout in case shutdown hangs on a child.
					setTimeout(() => {
						process.stderr.write(`[orch] shutdown timeout; force-exit\n`);
						process.exit(0);
					}, 5000).unref();
				});
				return { ok: true, data: { shutting_down: true } };
			default:
				return { ok: false, error: `unknown admin command: ${req.type}` };
		}
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Query methods
// ────────────────────────────────────────────────────────────────────────────

/**
 * List all known agents, plus each one's most recent entry (so the
 * status UI can show "what they're working on" without a second query).
 */
export function adminListAgents(ctx: AdminCtx): Array<{
	name: string;
	has_process: boolean;
	last_entry: { id: string; ts: number; kind: string; body: string; topic_id: string } | null;
	pending_confirmations: number;
}> {
	return [...ctx.agents.keys()].map((name) => {
		const has_process = ctx.agents.has(name);
		const lastEntryRow = ctx.db
			.prepare(
				`SELECT id, ts, topic_id, author, kind, body
				 FROM entries WHERE author = ? ORDER BY seq DESC LIMIT 1`,
			)
			.get(name) as
			| { id: string; ts: number; topic_id: string; author: string; kind: string; body: string }
			| undefined;
		const pendingRow = ctx.db
			.prepare(
				`SELECT COUNT(*) AS n FROM pending_confirmations
				 WHERE required_agent = ? AND status = 'pending'`,
			)
			.get(name) as { n: number };
		return {
			name,
			has_process,
			last_entry: lastEntryRow
				? {
						id: lastEntryRow.id,
						ts: lastEntryRow.ts,
						kind: lastEntryRow.kind,
						body: lastEntryRow.body,
						topic_id: lastEntryRow.topic_id,
					}
				: null,
			pending_confirmations: pendingRow.n,
		};
	});
}

export function adminListTopics(ctx: AdminCtx): Array<{
	id: string;
	status: string;
	kind: string;
	involved_count: number;
	last_activity_at: number;
	entry_count: number;
	checkpoint_count: number;
}> {
	return ctx.db
		.prepare(
			`SELECT t.id, t.status, t.kind, t.last_activity_at,
			        (SELECT COUNT(*) FROM topic_involved ti WHERE ti.topic_id = t.id) AS involved_count,
			        (SELECT COUNT(*) FROM entries e WHERE e.topic_id = t.id) AS entry_count,
			        (SELECT COUNT(*) FROM entries e WHERE e.topic_id = t.id AND e.kind = 'checkpoint') AS checkpoint_count
			 FROM topics t ORDER BY t.last_activity_at DESC`,
		)
		.all() as Array<{
			id: string;
			status: string;
			kind: string;
			involved_count: number;
			last_activity_at: number;
			entry_count: number;
			checkpoint_count: number;
		}>;
}

/**
 * Auto-nudge visibility for the `mesh status` / `mesh tui` UI.
 * Returns the config + per-agent last-nudge timestamp + total
 * nudges sent this session.
 */
export function adminAutoNudgeStatus(ctx: AdminCtx): {
	config: AutoNudgeOptions;
	nudges_sent: number;
	per_agent: Array<{ name: string; last_nudge_at: number | null }>;
} {
	const per_agent = [...ctx.agents.keys()].map((name) => ({
		name,
		last_nudge_at: ctx.lastAutoNudgeAt.get(name) ?? null,
	}));
	return {
		config: ctx.autoNudge,
		nudges_sent: ctx.autoNudgesSent,
		per_agent,
	};
}

/**
 * High-level orchestrator status, for the `mesh status` / `mesh tui` UI.
 * Returns PID (own process), uptime, data dir, totals, and per-process
 * counts. Cheap to compute (a few aggregate SQL queries).
 */
export function adminOrchestratorStatus(ctx: AdminCtx): {
	running: true;
	pid: number;
	started_at: number;
	uptime_ms: number;
	data_dir: string;
	socket_path: string;
	auto_nudge: {
		enabled: boolean;
		after_minutes: number;
		nudges_sent: number;
	};
	totals: {
		topics: number;
		open_topics: number;
		closed_topics: number;
		entries: number;
		checkpoints: number;
		pending_confirmations: number;
		agents: number;
		agents_alive: number;
	};
} {
	const now = Date.now();
	const totals = {
		topics: (ctx.db.prepare("SELECT COUNT(*) AS c FROM topics").get() as { c: number }).c,
		open_topics: (ctx.db.prepare("SELECT COUNT(*) AS c FROM topics WHERE status != 'closed'").get() as { c: number }).c,
		closed_topics: (ctx.db.prepare("SELECT COUNT(*) AS c FROM topics WHERE status = 'closed'").get() as { c: number }).c,
		entries: (ctx.db.prepare("SELECT COUNT(*) AS c FROM entries").get() as { c: number }).c,
		checkpoints: (ctx.db.prepare("SELECT COUNT(*) AS c FROM entries WHERE kind = 'checkpoint'").get() as { c: number }).c,
		pending_confirmations: (ctx.db.prepare("SELECT COUNT(*) AS c FROM pending_confirmations WHERE status = 'pending'").get() as { c: number }).c,
		agents: ctx.agents.size,
		agents_alive: ctx.agents.size, // all entries in the map are alive processes (removed on shutdown)
	};
	return {
		running: true as const,
		pid: process.pid,
		started_at: ctx.startedAt,
		uptime_ms: now - ctx.startedAt,
		data_dir: ctx.dataDir,
		socket_path: ctx.socketPath,
		auto_nudge: {
			enabled: ctx.autoNudge.enabled,
			after_minutes: ctx.autoNudge.afterMinutes,
			nudges_sent: ctx.autoNudgesSent,
		},
		totals,
	};
}

export function adminGetEntry(ctx: AdminCtx, id: string): { entry: EntryRow } | { error: string } {
	if (typeof id !== "string" || id.length === 0) return { error: "id is required" };
	const row = ctx.db
		.prepare(
			`SELECT id, ts, topic_id, author, kind, body, parent_entry, mentions, requires_confirmation_from
			 FROM entries WHERE id = ?`,
		)
		.get(id) as EntryRow | undefined;
	if (!row) return { error: `entry "${id}" not found` };
	return { entry: row };
}

export function adminGetTopic(ctx: AdminCtx, topicId: string): { topic: TopicRow; involved: string[]; entries: EntryRow[]; count: number; checkpoints: number; last_checkpoint: { id: string; ts: number; author: string } | null } | { error: string } {
	if (typeof topicId !== "string" || topicId.length === 0) return { error: "topic_id is required" };
	const topic = ctx.db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as TopicRow | undefined;
	if (!topic) return { error: `topic "${topicId}" not found` };
	const involved = (
		ctx.db
			.prepare("SELECT agent_name FROM topic_involved WHERE topic_id = ? ORDER BY agent_name")
			.all(topicId) as Array<{ agent_name: string }>
	).map((r) => r.agent_name);
	const entries = ctx.db
		.prepare(
			`SELECT id, ts, topic_id, author, kind, body, parent_entry, mentions, requires_confirmation_from
			 FROM entries WHERE topic_id = ? ORDER BY seq ASC`,
		)
		.all(topicId) as EntryRow[];
	const checkpointCount = (
		ctx.db
			.prepare("SELECT COUNT(*) AS c FROM entries WHERE topic_id = ? AND kind = 'checkpoint'")
			.get(topicId) as { c: number }
	).c;
	const lastCheckpointRow = ctx.db
		.prepare(
			`SELECT id, ts, author FROM entries WHERE topic_id = ? AND kind = 'checkpoint' ORDER BY seq DESC LIMIT 1`,
		)
		.get(topicId) as { id: string; ts: number; author: string } | undefined;
	return {
		topic,
		involved,
		entries,
		count: entries.length,
		checkpoints: checkpointCount,
		last_checkpoint: lastCheckpointRow ?? null,
	};
}

// ────────────────────────────────────────────────────────────────────────────
// Actions
// ────────────────────────────────────────────────────────────────────────────

/**
 * Send a steer message to a live agent. Records a manual nudge in the
 * `nudges` table for reputation tracking (cross-module call into
 * `lifecycle.ts#recordNudge`).
 */
export async function adminInject(
	ctx: AdminCtx,
	agentName: string,
	message: string,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
	if (typeof agentName !== "string" || agentName.length === 0) {
		return { ok: false, error: "agent is required" };
	}
	if (typeof message !== "string" || message.length === 0) {
		return { ok: false, error: "message is required" };
	}
	const agent = ctx.agents.get(agentName);
	if (!agent) {
		return { ok: false, error: `agent "${agentName}" is not running` };
	}
	process.stderr.write(
		`[orch:admin] injecting ${message.length}-char message into ${agentName}\n`,
	);
	// Try to extract a topic id from the message (steer format: `topic="..."`).
	const m = message.match(/topic="([^"]+)"/);
	const topicId = m ? m[1] : undefined;
	// Record the nudge (for reputation). Manual nudges count as "manual" source.
	// Cross-module call into lifecycle.ts.
	recordNudge(ctx, agentName, "manual", topicId);
	try {
		const r = await agent.send({ type: "prompt", message, streamingBehavior: "steer" });
		return { ok: true, data: { result: r, agent: agentName } };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
