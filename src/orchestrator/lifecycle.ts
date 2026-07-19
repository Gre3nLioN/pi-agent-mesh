/**
 * Lifecycle module — agent registry, auto-nudge, cost & reputation tracking.
 *
 * Owns:
 *   - The agent registry (`agents` map) — read/write by spawnAgent, handleAgentExit, etc.
 *   - The auto-nudge state (`lastAutoNudgeAt`) and counter (`autoNudgesSent`)
 *   - The cost-attribution state (`budgetHits`, `budgetHitsByAgent`) and the
 *     per-agent `lastSteerTopic` closures that map agent names to their
 *     currently-active topic id
 *   - The `costs` and `nudges` tables (writes) and reads from `entries`,
 *     `topics`, `topic_involved` (for auto-nudge + admin queries)
 *
 * Cross-module edges:
 *   - `admin.ts#adminInject` calls `recordNudge` (this module) for manual nudges
 *   - `admin.ts#adminListAgents` reads the `pending_confirmations` table (written by
 *     `topic-bus.ts#checkConfirmationTimeouts`); no function call between modules
 *   - `admin.ts#adminReputationStatus` reads the `nudges` table (written by
 *     `recordNudge` here); no function call between modules
 *   - No function calls between this module and `topic-bus.ts` — they share the
 *     `db` for reads but never call each other
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentProcess, type AgentOpts } from "../rpc.js";
import { ControlServer } from "../control-server.js";
import type { Database as DB } from "better-sqlite3";
import {
	DEFAULT_MESH_GUIDANCE,
	DEFAULT_AUTO_NUDGE_MESSAGE,
	type AutoNudgeOptions,
	type SpawnOpts,
} from "./defaults.js";

// ────────────────────────────────────────────────────────────────────────────
// LifecycleCtx — what the lifecycle functions read from the orchestrator.
// The Orchestrator class satisfies this interface structurally; no
// `implements` declaration needed. `budgetHits` and `autoNudgesSent` are
// plain `number` fields (matching the facade's public API) so increments
// like `ctx.budgetHits++` mutate the facade's public field directly. Tests
// read `orch.budgetHits` and `orch.autoNudgesSent` as `number`.
// ────────────────────────────────────────────────────────────────────────────
export interface LifecycleCtx {
	db: DB;
	control: ControlServer;
	socketPath: string;
	agents: Map<string, AgentProcess>;
	autoNudge: AutoNudgeOptions;
	startedAt: number;
	lastAutoNudgeAt: Map<string, Map<string, number>>;
	// Mutable counters — plain `number` to match the facade's public API.
	autoNudgesSent: number;
	budgetHits: number;
	budgetHitsByAgent: Map<string, number>;
	// Cross-module callbacks
	pushEvent: (event: unknown) => void;
	handleAgentExit: (name: string) => void;
}

// ────────────────────────────────────────────────────────────────────────────
// Agent lifecycle
// ────────────────────────────────────────────────────────────────────────────

/** Spawn an agent and register it. The agent is told the orchestrator's socket path. */
export async function spawnAgent(
	ctx: LifecycleCtx,
	spec: AgentOpts,
	opts: SpawnOpts = {},
): Promise<AgentProcess> {
	if (ctx.agents.has(spec.name)) {
		throw new Error(`agent "${spec.name}" already exists`);
	}
	// Resolve the per-agent custom prompt.
	//   - If `promptDir` is set, look for `<promptDir>/<name>.md`.
	//   - File content replaces `appendSystemPrompt` (with a warning
	//     if both were set — file wins).
	//   - Missing file is not an error: fall back to `appendSystemPrompt`
	//     (or the default mesh guidance if neither is set).
	let customPrompt: string | undefined = opts.appendSystemPrompt;
	if (opts.promptDir) {
		const filePath = join(opts.promptDir, `${spec.name}.md`);
		let fileContent: string;
		try {
			fileContent = readFileSync(filePath, "utf8");
		} catch (err: any) {
			if (err && err.code === "ENOENT") {
				process.stderr.write(
					`[orch] no prompt file for "${spec.name}" at ${filePath}; ` +
						`using ${customPrompt ? "explicit appendSystemPrompt" : "default mesh guidance only"}\n`,
				);
			} else {
				throw new Error(
					`failed to read prompt file for "${spec.name}" at ${filePath}: ${err?.message ?? err}`,
				);
			}
			fileContent = undefined as any; // not loaded
		}
		if (fileContent !== undefined) {
			if (customPrompt) {
				process.stderr.write(
					`[orch] both promptDir file and explicit appendSystemPrompt set for "${spec.name}"; file wins\n`,
				);
			}
			customPrompt = fileContent;
			process.stderr.write(
				`[orch] loaded custom prompt for "${spec.name}" from ${filePath} (${fileContent.length} bytes)\n`,
			);
		}
	}
	const combinedPrompt = [customPrompt, DEFAULT_MESH_GUIDANCE]
		.filter((s) => s && s.length > 0)
		.join("\n\n");
	const agent = new AgentProcess({
		...spec,
		extensionPath: opts.extensionPath,
		appendSystemPrompt: combinedPrompt.length > 0 ? combinedPrompt : undefined,
		env: {
			MESH_SOCKET_PATH: ctx.socketPath,
			MESH_AGENT_NAME: spec.name,
			...spec.env,
		},
	});
	await agent.start();
	ctx.agents.set(spec.name, agent);

	// Persist the agent to the `agents` table so it survives an
	// orchestrator restart. INSERT OR REPLACE handles re-spawn
	// (same name, new pid) by overwriting the row. See design § D2.
	// `agent.pid ?? -1` is a safety net; if pid is ever undefined,
	// process.kill(-1, 0) will throw and the row is marked 'exited'
	// on the next reconcile. See design § Open Questions Q3.
	ctx.db
		.prepare(
			"INSERT OR REPLACE INTO agents (name, pid, status, started_at) VALUES (?, ?, 'alive', ?)",
		)
		.run(spec.name, agent.pid ?? -1, Date.now());

	// When the subprocess actually exits (crash, OOM, normal exit),
	// drop it from the registry. Without this, listAgents() / TUI
	// report ghost agents, auto-nudge keeps poking dead processes,
	// and admin_inject returns "agent has exited" instead of
	// "agent not found".
	agent.on("exit", () => ctx.handleAgentExit(spec.name));

	// Wire cost attribution: the turn_end listener and the send monkey-patch
	// that captures the last topic each agent was prompted about.
	attachCostAttribution(ctx, agent, spec);

	return agent;
}

export function getAgent(ctx: LifecycleCtx, name: string): AgentProcess | undefined {
	return ctx.agents.get(name);
}

/** Names of all live agents. */
export function listAgents(ctx: LifecycleCtx): string[] {
	return [...ctx.agents.keys()];
}

/**
 * Attach cost attribution to a freshly-spawned agent. Installs:
 *   - A `turn_end` event listener that persists a row to the `costs` table.
 *   - A monkey-patch on `agent.send` that captures the topic id from prompt
 *     messages (used to attribute the cost to a topic).
 *
 * The per-agent `lastSteerTopic` map is a closure variable; its lifetime
 * is bound to the agent process — the closure is GC'd when the agent is
 * removed from the registry by `handleAgentExit`.
 */
function attachCostAttribution(
	ctx: LifecycleCtx,
	agent: AgentProcess,
	spec: AgentOpts,
): void {
	// closure is GC'd when the agent is removed from the registry by `handleAgentExit`.
	const lastSteerTopic = new Map<string, string>(); // agent name → topic id
	agent.on("event", (ev: any) => {
		if (ev?.type === "turn_end" && ev.message?.role === "assistant" && ev.message.usage) {
			recordCost(
				ctx,
				spec.name,
				spec.model ?? ev.message.model ?? "unknown",
				ev.message.usage,
				lastSteerTopic.get(spec.name),
			);
		}
	});
	// Track what topic each agent was last prompted about, so we
	// can attribute cost to a topic. We hook into admin_inject and
	// auto-nudge by intercepting the send() call.
	const origSend = agent.send.bind(agent);
	(agent as any).send = async (msg: any) => {
		if (msg?.type === "prompt" && typeof msg.message === "string") {
			// Look for a topic id in the message body (e.g. "[mesh notify] topic=...")
			const m = msg.message.match(/topic="([^"]+)"/);
			if (m) lastSteerTopic.set(spec.name, m[1]);
		}
		return origSend(msg);
	};
}

/**
 * Remove a dead agent from the registry. Called by the `exit` listener
 * installed in spawnAgent(). Also clears the auto-nudge bookkeeping so
 * a re-spawned agent with the same name starts with a clean "never
 * nudged" state. `budgetHitsByAgent` is intentionally NOT cleared — it
 * tracks session-level totals that are useful to see even after an agent dies.
 */
export function handleAgentExit(ctx: LifecycleCtx, name: string): void {
	ctx.agents.delete(name);
	clearAutoNudgeStateFor(ctx, name);
	// Mark the agent row as 'exited' in the persistent registry.
	// The row stays in the table (no DELETE) so historical
	// reputation queries can still see it; the status column
	// is the source of truth for "is this agent currently live?".
	ctx.db
		.prepare("UPDATE agents SET status='exited' WHERE name=?")
		.run(name);
	process.stderr.write(
		`[orch] agent "${name}" exited; removed from registry\n`,
	);
}

/** Clear the per-agent auto-nudge bookkeeping. Kept separate so the
 *  cross-module edge from agents to auto-nudge is explicit. */
export function clearAutoNudgeStateFor(ctx: LifecycleCtx, name: string): void {
	ctx.lastAutoNudgeAt.delete(name);
}

// ────────────────────────────────────────────────────────────────────────────
// Auto-nudge
// ────────────────────────────────────────────────────────────────────────────

/**
 * Background tick: for each (agent, topic) pair where the agent is
 * silent in that topic, send a topic-specific nudge. Per-topic
 * cooldowns mean an agent silent in N topics can be nudged up to N
 * times per overall silence — one per topic.
 *
 * A nudge fires when:
 *   - the agent is alive (in ctx.agents),
 *   - the agent is in the topic's `topic_involved`,
 *   - the topic is open (status != 'closed'),
 *   - the agent's last entry in this specific topic is older than
 *     `autoNudge.afterMinutes`, AND
 *   - we haven't already nudged for this (agent, topic) silence.
 *
 * Agents with no open topic context produce zero (agent, topic) pairs
 * and are silently skipped (nothing for them to do).
 */
export function checkAutoNudge(ctx: LifecycleCtx): void {
	const now = Date.now();
	const thresholdMs = ctx.autoNudge.afterMinutes * 60 * 1000;

	for (const [name, agent] of ctx.agents) {
		// Skip if the agent process is gone (e.g. already shut down).
		if (!agent) continue;

		// Find all open topics the agent is involved in, ordered by
		// most recently active first. An agent silent in topic X but
		// active in topic Y will be iterated for both, but only
		// nudged about the ones where they are actually silent.
		const openTopics = ctx.db
			.prepare(
				`SELECT t.id FROM topics t
				 JOIN topic_involved ti ON ti.topic_id = t.id
				 WHERE ti.agent_name = ? AND t.status != 'closed'
				 ORDER BY t.last_activity_at DESC`,
			)
			.all(name) as Array<{ id: string }>;

		for (const topic of openTopics) {
			// Per-topic silence: find this agent's most recent entry
			// in this specific topic. Order by ts (time of activity),
			// not seq (insert order), because entries can be backdated.
			const lastInTopic = ctx.db
				.prepare(
					"SELECT ts, body FROM entries WHERE author = ? AND topic_id = ? ORDER BY ts DESC LIMIT 1",
				)
				.get(name, topic.id) as { ts: number; body: string } | undefined;

			// If the agent has never posted in this topic, "silence
			// started" is the orchestrator's start time.
			const silenceStartedAt = lastInTopic?.ts ?? ctx.startedAt;

			// Not silent long enough in this topic? Skip.
			if (now - silenceStartedAt < thresholdMs) continue;

			// Per-(agent, topic) cooldown.
			const lastNudgeAt = ctx.lastAutoNudgeAt.get(name)?.get(topic.id) ?? 0;
			if (lastNudgeAt >= silenceStartedAt) continue;

			// Build the topic-specific nudge content.
			const recent = findRecentEntriesFromOthers(ctx, topic.id, name, 3);
			const silentFor = Math.round((now - silenceStartedAt) / 60000);
			const message = buildTopicNudgeMessage(name, topic.id, lastInTopic, recent, silentFor);

			// Record the nudge. The set() on the inner map must happen
			// before agent.send() so a re-entrant tick doesn't double-nudge.
			let perTopic = ctx.lastAutoNudgeAt.get(name);
			if (!perTopic) {
				perTopic = new Map<string, number>();
				ctx.lastAutoNudgeAt.set(name, perTopic);
			}
			perTopic.set(topic.id, now);
			ctx.autoNudgesSent++;
			// Persist the nudge for reputation (response rate, response time).
			recordNudge(ctx, name, "auto", topic.id);

			const lastBody = lastInTopic
				? lastInTopic.body.length > 60
					? lastInTopic.body.slice(0, 60) + "..."
					: lastInTopic.body
				: "(no entries in this topic yet)";
			process.stderr.write(
				`[orch:auto-nudge] nudging ${name} in ${topic.id} (silent for ${silentFor}m, last entry in topic: ${lastBody})\n`,
			);
			agent
				.send({ type: "prompt", message, streamingBehavior: "steer" })
				.catch((err) => {
					process.stderr.write(
						`[orch:auto-nudge] nudge to ${name} failed: ${err instanceof Error ? err.message : err}\n`,
					);
				});
		}
	}
}

/**
 * Build the topic-specific nudge message. The format is intentionally
 * short (a few lines): topic id, silence duration, the agent's last
 * entry in this topic, recent entries from other agents, and a soft
 * "pick one or post a status" prompt.
 */
function buildTopicNudgeMessage(
	agentName: string,
	topicId: string,
	lastInTopic: { ts: number; body: string } | undefined,
	recent: Array<{ author: string; ts: number; body: string; agoMin: number }>,
	silentForMin: number,
): string {
	const lines: string[] = [];
	lines.push(`[mesh auto-nudge] you've been silent in topic "${topicId}" for ${silentForMin}m.`);
	if (lastInTopic) {
		const preview = lastInTopic.body.length > 100
			? lastInTopic.body.slice(0, 100) + "..."
			: lastInTopic.body;
		lines.push("");
		lines.push(`last entry by you in this topic: ${JSON.stringify(preview)}`);
	} else {
		lines.push("");
		lines.push(`you have not posted in this topic yet.`);
	}
	if (recent.length > 0) {
		lines.push("");
		lines.push(`recent entries from other agents in this topic:`);
		for (const r of recent) {
			const preview = r.body.length > 80 ? r.body.slice(0, 80) + "..." : r.body;
			lines.push(`  - ${r.author} (${r.agoMin}m ago): ${JSON.stringify(preview)}`);
		}
	}
	lines.push("");
	lines.push(`suggested next action: pick one of the above, post a status, or post a checkpoint if the topic has grown big.`);
	return lines.join("\n");
}

/**
 * Find the most recent N entries in a topic from agents OTHER than
 * `excludeAgent`. Used by the topic-specific nudge to give the
 * nudged agent context on what their peers have been up to.
 */
function findRecentEntriesFromOthers(
	ctx: LifecycleCtx,
	topicId: string,
	excludeAgent: string,
	limit: number,
): Array<{ author: string; ts: number; body: string; agoMin: number }> {
	const rows = ctx.db
		.prepare(
			"SELECT author, ts, body FROM entries WHERE topic_id = ? AND author != ? ORDER BY ts DESC LIMIT ?",
		)
		.all(topicId, excludeAgent, limit) as Array<{ author: string; ts: number; body: string }>;
	const now = Date.now();
	return rows.map((r) => ({ ...r, agoMin: Math.max(0, Math.round((now - r.ts) / 60000)) }));
}

/**
 * Record a nudge event. Called by the auto-nudge background tick
 * and by the admin_inject path (manual nudge). Used by reputation.
 *
 * NOTE on schema smell (design D8): the `nudges` table is the
 * source of truth for nudge audit. The `kind='react'` rows in
 * `entries` come from agent reactions (via peer-extension), not
 * from this function. The smell is that `adminReputationStatus`
 * reads `kind='react'` rows from `entries` for rejection-rate
 * calculation, which can conflate reactions with the audit row
 * kind. Deferred to a future change; see design.md § D8.
 */
export function recordNudge(
	ctx: Pick<LifecycleCtx, "db">,
	agent: string,
	source: "auto" | "manual",
	topicId: string | undefined,
): void {
	try {
		ctx.db
			.prepare(
				`INSERT INTO nudges (id, ts, agent, topic_id, source) VALUES (?, ?, ?, ?, ?)`,
			)
			.run(randomUUID(), Date.now(), agent, topicId ?? null, source);
	} catch (err) {
		process.stderr.write(
			`[orch:nudge-log] failed to record nudge: ${err instanceof Error ? err.message : err}\n`,
		);
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Cost & reputation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Record a cost event. Called from the agent's `turn_end` event
 * hook (see `attachCostAttribution`). Persists a row to the `costs` table.
 */
export function recordCost(
	ctx: Pick<LifecycleCtx, "db">,
	agent: string,
	model: string,
	usage: {
		input: number;
		output: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number; total: number };
	},
	topicId: string | undefined,
): void {
	try {
		const id = randomUUID();
		const ts = Date.now();
		// Generate a turn_id from ts+agent so we can dedupe if needed.
		const turnId = `${ts}-${agent}`;
		ctx.db
			.prepare(
				`INSERT INTO costs (id, ts, agent, topic_id, turn_id, model,
				   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
				   cost_input_usd, cost_output_usd, cost_cache_read_usd, cost_cache_write_usd,
				   cost_total_usd)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				ts,
				agent,
				topicId ?? null,
				turnId,
				model,
				usage.input ?? 0,
				usage.output ?? 0,
				usage.cacheRead ?? 0,
				usage.cacheWrite ?? 0,
				usage.cost.input ?? 0,
				usage.cost.output ?? 0,
				usage.cost.cacheRead ?? 0,
				usage.cost.cacheWrite ?? 0,
				usage.cost.total ?? 0,
			);
	} catch (err) {
		process.stderr.write(
			`[orch:cost] failed to record cost for ${agent}: ${err instanceof Error ? err.message : err}\n`,
		);
	}
}

/**
 * Record a tool-budget hit from a peer extension. Increments the
 * per-session counter and the per-agent counter. We log to stderr
 * too so the orchestrator's own log file captures it.
 */
export function recordBudgetHit(
	ctx: Pick<LifecycleCtx, "budgetHits" | "budgetHitsByAgent">,
	info: { author: string; tool: string; calls: number; budget: number },
): void {
	ctx.budgetHits++;
	ctx.budgetHitsByAgent.set(
		info.author,
		(ctx.budgetHitsByAgent.get(info.author) ?? 0) + 1,
	);
	process.stderr.write(
		`[orch:budget] ${info.author} hit limit on ${info.tool} ` +
			`(call ${info.calls} of ${info.budget}). total this session: ${ctx.budgetHits}.\n`,
	);
}

/**
 * Cost visibility for the `mesh cost` CLI. Returns totals +
 * per-agent + per-model breakdown + recent events.
 */
export function adminCostStatus(
	ctx: Pick<LifecycleCtx, "db">,
	opts: { agent?: string; topic_id?: string; since_ms?: number } = {},
): {
	totals: { cost_usd: number; input_tokens: number; output_tokens: number; turn_count: number };
	per_agent: Array<{ agent: string; cost_usd: number; input_tokens: number; output_tokens: number; turn_count: number; avg_cost_per_turn: number }>;
	per_model: Array<{ model: string; cost_usd: number; turn_count: number }>;
	recent: Array<{ ts: number; agent: string; topic_id: string | null; model: string; cost_total_usd: number; input_tokens: number; output_tokens: number }>;
} {
	const filters: string[] = [];
	const params: unknown[] = [];
	if (opts.agent) {
		filters.push("agent = ?");
		params.push(opts.agent);
	}
	if (opts.topic_id) {
		filters.push("topic_id = ?");
		params.push(opts.topic_id);
	}
	if (typeof opts.since_ms === "number") {
		filters.push("ts >= ?");
		params.push(opts.since_ms);
	}
	const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

	const totals = ctx.db
		.prepare(
			`SELECT COALESCE(SUM(cost_total_usd), 0) AS cost,
			        COALESCE(SUM(input_tokens), 0) AS inp,
			        COALESCE(SUM(output_tokens), 0) AS outp,
			        COUNT(*) AS n
			 FROM costs ${where}`,
		)
		.get(...params) as { cost: number; inp: number; outp: number; n: number };

	const perAgent = ctx.db
		.prepare(
			`SELECT agent,
			        COALESCE(SUM(cost_total_usd), 0) AS cost,
			        COALESCE(SUM(input_tokens), 0) AS inp,
			        COALESCE(SUM(output_tokens), 0) AS outp,
			        COUNT(*) AS n
			 FROM costs ${where}
			 GROUP BY agent
			 ORDER BY cost DESC`,
		)
		.all(...params) as Array<{ agent: string; cost: number; inp: number; outp: number; n: number }>;

	const perModel = ctx.db
		.prepare(
			`SELECT model,
			        COALESCE(SUM(cost_total_usd), 0) AS cost,
			        COUNT(*) AS n
			 FROM costs ${where}
			 GROUP BY model
			 ORDER BY cost DESC`,
		)
		.all(...params) as Array<{ model: string; cost: number; n: number }>;

	const recent = ctx.db
		.prepare(
			`SELECT ts, agent, topic_id, model, cost_total_usd, input_tokens, output_tokens
			 FROM costs ${where}
			 ORDER BY ts DESC LIMIT 10`,
		)
		.all(...params) as Array<{ ts: number; agent: string; topic_id: string | null; model: string; cost_total_usd: number; input_tokens: number; output_tokens: number }>;

	return {
		totals: {
			cost_usd: totals.cost,
			input_tokens: totals.inp,
			output_tokens: totals.outp,
			turn_count: totals.n,
		},
		per_agent: perAgent.map((r) => ({
			agent: r.agent,
			cost_usd: r.cost,
			input_tokens: r.inp,
			output_tokens: r.outp,
			turn_count: r.n,
			avg_cost_per_turn: r.n > 0 ? r.cost / r.n : 0,
		})),
		per_model: perModel.map((r) => ({ model: r.model, cost_usd: r.cost, turn_count: r.n })),
		recent,
	};
}

/**
 * Reputation visibility for the `mesh reputation` CLI. Computes
 * per-agent reputation from entries + nudges + reactions.
 *
 * Scoring (simple weighted sum, normalized to 0-10):
 *   + 2 * checkpoint_count
 *   + 5 * response_rate              (0-1, big bonus for being responsive)
 *   + 3 * acceptance_rate            (0-1, big bonus for accepted work)
 *   - 2 * rejection_rate              (penalty for rejections)
 *   + 0.1 * posts                    (small bonus for activity)
 *
 * NOTE on schema smell (design D8): the `rejection_rate` calculation
 * reads `kind='react'` rows from the `entries` table whose body matches
 * `%REQUEST_CHANGES%` and joins back via `parent_entry` to attribute
 * the rejection to the parent author. These rows are written by agent
 * reactions (via peer-extension), not by anything in this module. The
 * smell is that "rejection" and "reaction" share the `kind='react'`
 * row kind. Deferred to a future change; see design.md § D8.
 */
export function adminReputationStatus(ctx: Pick<LifecycleCtx, "db">): {
	per_agent: Array<{
		agent: string;
		score: number;
		components: {
			posts: number;
			checkpoints: number;
			topics: number;
			last_active_ms: number;
			nudges_received: number;
			nudges_responded: number;
			response_rate: number;
			avg_response_min: number;
			rejections: number;
			acceptance_rate: number;
		};
	}>;
} {
	// Aggregate per agent from the entries table.
	const postStats = ctx.db
		.prepare(
			`SELECT author AS agent,
			        COUNT(*) FILTER (WHERE kind = 'post') AS posts,
			        COUNT(*) FILTER (WHERE kind = 'checkpoint') AS checkpoints,
			        COUNT(DISTINCT topic_id) AS topics,
			        MAX(ts) AS last_active_ms
			 FROM entries
			 GROUP BY author`,
		)
		.all() as Array<{ agent: string; posts: number; checkpoints: number; topics: number; last_active_ms: number }>;

	// Rejections: a `react` entry whose body is REQUEST_CHANGES on
	// an entry whose author is the target. We don't track reaction
	// targets explicitly in the schema, so we approximate by counting
	// react entries on posts by the target agent via parent_entry.
	// For v1 we use a simpler approximation: count REQUEST_CHANGES
	// reactions globally and attribute to the agent whose post it
	// followed (parent_entry author).
	const rejections = ctx.db
		.prepare(
			`SELECT e2.author AS agent, COUNT(*) AS n
			 FROM entries e1
			 JOIN entries e2 ON e2.id = e1.parent_entry
			 WHERE e1.kind = 'react' AND e1.body LIKE '%REQUEST_CHANGES%'
			 GROUP BY e2.author`,
		)
		.all() as Array<{ agent: string; n: number }>;
	const rejectionsByAgent = new Map<string, number>();
	for (const r of rejections) rejectionsByAgent.set(r.agent, r.n);

	// Nudge responsiveness: for each nudge, look for a post by the
	// same agent within 10 minutes. Compute rate and avg time.
	const nudges = ctx.db
		.prepare(
			`SELECT agent, ts, topic_id FROM nudges ORDER BY ts ASC`,
		)
		.all() as Array<{ agent: string; ts: number; topic_id: string | null }>;
	const responsesByAgent = new Map<string, { responded: number; totalMs: number; count: number }>();
	for (const n of nudges) {
		// Find the first post by this agent after the nudge.
		const nextPost = ctx.db
			.prepare(
				`SELECT ts FROM entries
				 WHERE author = ? AND ts >= ? AND ts <= ? AND kind = 'post'
				 ORDER BY ts ASC LIMIT 1`,
			)
			.get(n.agent, n.ts, n.ts + 10 * 60 * 1000) as { ts: number } | undefined;
		const cur = responsesByAgent.get(n.agent) ?? { responded: 0, totalMs: 0, count: 0 };
		cur.count++;
		if (nextPost) {
			cur.responded++;
			cur.totalMs += nextPost.ts - n.ts;
		}
		responsesByAgent.set(n.agent, cur);
	}

	const result = postStats.map((p) => {
		const resp = responsesByAgent.get(p.agent);
		const response_rate = resp && resp.count > 0 ? resp.responded / resp.count : 0;
		const avg_response_min = resp && resp.responded > 0 ? (resp.totalMs / resp.responded) / 60000 : 0;
		const rej = rejectionsByAgent.get(p.agent) ?? 0;
		const acceptance_rate = p.posts > 0 ? Math.max(0, (p.posts - rej) / p.posts) : 1;
		const score = Math.max(
			0,
			Math.min(
				10,
				2 * p.checkpoints
					+ 5 * response_rate
					+ 3 * acceptance_rate
					- 2 * (p.posts > 0 ? rej / p.posts : 0)
					+ 0.1 * p.posts,
			),
		);
		return {
			agent: p.agent,
			score: Math.round(score * 100) / 100,
			components: {
				posts: p.posts,
				checkpoints: p.checkpoints,
				topics: p.topics,
				last_active_ms: p.last_active_ms,
				nudges_received: resp?.count ?? 0,
				nudges_responded: resp?.responded ?? 0,
				response_rate: Math.round(response_rate * 100) / 100,
				avg_response_min: Math.round(avg_response_min * 100) / 100,
				rejections: rej,
				acceptance_rate: Math.round(acceptance_rate * 100) / 100,
			},
		};
	});

	// Sort by score descending.
	result.sort((a, b) => b.score - a.score);

	return { per_agent: result };
}

// Re-export DEFAULT_AUTO_NUDGE_MESSAGE so the facade can build the autoNudge
// default without importing from defaults.ts twice.
export { DEFAULT_AUTO_NUDGE_MESSAGE };

// ──────────────────────────────────────────────────────────────────────────
// Persistent registry: reconcile on startup
// ──────────────────────────────────────────────────────────────────────────

/**
 * Reconcile the `agents` table against reality on orchestrator startup.
 *
 * For every row with `status='alive'`, check whether the underlying
 * process is still running via `process.kill(pid, 0)`. If the process
 * is gone, mark the row as `exited`. If it's still alive, leave the
 * row as `alive` (the orchestrator's in-memory `agents` map will
 * repopulate as agents reconnect — see design § Open Questions Q1).
 *
 * Called once from `Orchestrator.start()` before the background
 * ticks start. The reconcile is fast: a single SELECT + N process
 * system calls. See design § D3.
 */
export function reconcileAgents(ctx: LifecycleCtx): void {
	const rows = ctx.db
		.prepare("SELECT name, pid FROM agents WHERE status='alive'")
		.all() as Array<{ name: string; pid: number }>;
	if (rows.length === 0) return;
	const mark = ctx.db.prepare("UPDATE agents SET status='exited' WHERE name=?");
	for (const row of rows) {
		if (isProcessAlive(row.pid)) {
			process.stderr.write(
				`[orch:reconcile] agent "${row.name}" (pid=${row.pid}) still alive, leaving as 'alive'\n`,
			);
		} else {
			mark.run(row.name);
			process.stderr.write(
				`[orch:reconcile] agent "${row.name}" (pid=${row.pid}) is dead, marked 'exited'\n`,
			);
		}
	}
}

/**
 * Check whether a process is alive using `process.kill(pid, 0)`.
 * Signal 0 is a POSIX existence check: it doesn't actually send a
 * signal, it just checks whether the pid exists and whether we have
 * permission to signal it. Returns `true` for either success (process
 * exists, we own it) or `EPERM` (process exists, we can't signal it).
 * Returns `false` for any other error (typically `ESRCH` = no such pid).
 */
function isProcessAlive(pid: number): boolean {
	if (pid < 0) return false; // sentinel value; never a real pid
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		return err?.code === "EPERM";
	}
}
