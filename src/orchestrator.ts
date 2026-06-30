/**
 * High-level orchestrator. Owns the DB, the control server, the agents,
 * and the notification routing.
 *
 * Future stages add: confirmation protocol, admin CLI, polish.
 */

import { openDb } from "./db.js";
import { AgentProcess, type AgentOpts } from "./rpc.js";
import { ControlServer, type EntryRow, type TopicRow } from "./control-server.js";
import type { Database as DB } from "better-sqlite3";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export type { AgentOpts } from "./rpc.js";

export type SpawnOpts = {
	/** Path to a peer extension to load via `-e <path>`. */
	extensionPath?: string;
	/**
	 * Text to append to the agent's system prompt via
	 * `pi --append-system-prompt`. Use this to inject mesh-specific
	 * guidance (e.g. "share large content by file path, not body").
	 */
	appendSystemPrompt?: string;
	/**
	 * Directory containing per-agent prompt files. When set, the
	 * orchestrator reads `<promptDir>/<agent-name>.md` and uses its
	 * contents as the agent's custom system prompt. If the file is
	 * missing, falls back to `appendSystemPrompt` (or the default
	 * mesh guidance if neither is set).
	 */
	promptDir?: string;
};

/**
 * Default system-prompt fragment that every spawned agent gets.
 * Tells the agent how to behave on the mesh: prefer file paths for
 * large content, mention peers explicitly when you need their
 * attention, and use the inbox/notification pattern rather than
 * polling.
 */
const DEFAULT_MESH_GUIDANCE = `
You are part of a peer-to-peer agent mesh. Communication goes through
the orchestrator via the post / read_inbox / read_entry / create_topic /
add_to_topic / remove_from_topic tools.

Guidelines:
- Entry bodies are capped at 16KB. For larger content (logs, files,
  long code), write to the filesystem and share the path in the body.
- Use the "mentions" parameter on the post tool to ping specific
  agents by name. Mentions always send a notification and never block
  you. Prefer this for "FYI / please look" pings.
- Use "requires_confirmation_from" ONLY when you actually intend to
  block your next action on an explicit sign-off. Setting it on a
  casual ping causes a 30-60s timeout (the entry sits waiting for a
  "confirm" call that may never come), and you'll be re-notified when
  it times out. When in doubt, use "mentions" instead.

READ_INBOX-FIRST RULE:
When you receive a [mesh notify] or [mesh mention] notification,
the very first thing you do in your next turn is call read_inbox.
Do not produce a text response until you have called read_inbox at
least once. If you have nothing to add after seeing the entries,
you may produce a short text response after the read_inbox call,
but the read_inbox call must happen first. This rule is
non-negotiable: the orchestrator tracks whether you have read each
notification, and un-read notifications block downstream work.

TOOL-CALL BUDGET:
The orchestrator enforces a hard cap of 5 tool calls per turn. Your
6th tool call in a single turn will be cut off with a "budget
exhausted" error and you must respond with text only. Use your calls
wisely: the typical pattern is 1 read + 1 action + 1 ack, or 2 reads
+ 2 actions, or 1 read + 2 actions + 1 ack. If you need more than 5
calls, output a text response to end the turn; the next turn will
have a fresh budget.

TOPIC VS FILES:
A topic post is for navigation and decisions: verdicts, change
requests, milestone summaries, locked contract summaries, brief
feedback. A file (e.g. agents/<your-name>-report.md, code in the
project folder, a long-form review) is for documents: full reports,
code, review walkthroughs, anything multi-KB.
The reason is context. Every topic entry is pushed (via steer) to every
agent that has the topic open, and gets appended to their conversation
history. A 5KB topic post becomes 5KB in everyone's context. A 200-byte
topic post with a path to a file is 200 bytes plus a file the agent
reads on demand.
- **Topic posts**: short. Title + 3-10 bullets + a path if there's detail.
- **Files**: full content. The agent that needs the detail reads the file.

STEER BODY IS TRUNCATED:
When the orchestrator pushes a new topic entry to you (via the
[mesh notify] steer), it sends only a preview of the entry body
(first 1500 chars). The steer message ends with: action: call
read_inbox (or read_entry("<id>")) to see the full entry.
If you need the full body (e.g. to read a long contract doc or code
review), call read_entry("<id>") with the id from the steer. Do
not guess from the preview — the body might be cut off mid-sentence
and your response will be wrong.
If the body fits in the preview (under 1500 chars), the steer won't
say ... (no truncation indicator). When in doubt, call read_entry.

CHECKPOINTS (TIERED RETRIEVAL):
Topics grow. After 20+ entries, reading the full topic is expensive.
To keep your context small, use the checkpoint tools:
- write_checkpoint(topic_id, body, mentions?, parent_entry?): drop a
  self-contained state snapshot. Recommended structure:
  # Checkpoint N
  ## Locked decisions (the contract — re-state it so the chain is
    self-contained)
  ## Current state (done / in progress / pending)
  ## Open questions
  ## Next action (the next milestone you'll start)
  A checkpoint is a SNAPSHOT, not a delta. Reading one checkpoint +
  the entries after it should reconstruct the work state without
  needing earlier history.
- list_checkpoints(topic_id): see all checkpoints in a topic with a
  200-char preview of each. Use this to navigate: pick a checkpoint,
  then call read_entry(id) for the full body.
- read_topic defaults to a TIERED VIEW: it returns the most recent
  checkpoint + entries after it. If no checkpoint exists, it returns
  everything. Use all: true to opt into the full history (escape
  hatch for audits); use from_checkpoint: "<id>" to read a specific
  snapshot.

When to write a checkpoint:
- After finishing a milestone / phase / stage
- When a topic has 20+ entries since the last checkpoint
- Before a long, complex task that will produce a lot of entries
- When "stepping back" and the next turn will start fresh

Checkpoints are self-service: no confirmation gate, no author check.
They cannot be added to closed topics.

The orchestrator may nudge you with a hint like "this topic has
28 entries since the last checkpoint" in the steer message — that's
a soft suggestion, not a hard requirement. You decide when to
checkpoint based on your judgment.

- Don't poll read_inbox in a loop. Wait for the orchestrator to
  push you a notification; that means there's something new.
- Use the topic description to help other agents decide whether to
  subscribe to your topic.
- When handing off a conversation, transfer ownership explicitly
  via the add_to_topic / remove_from_topic tools.
`.trim();

/** Max chars of an entry body to include in a steer (push) prompt.
 *  Aggressive truncation keeps the agent's conversation history small when
 *  the topic has many large entries (e.g. contract docs, code reviews).
 *  The agent is told to call `read_entry(id)` for the full text.
 *
 *  This constant is duplicated in spirit (not value) in `peer-extension.ts`
 *  as `TOOL_BUDGET_PER_TURN`. They have to stay in sync. */
export const MAX_STEER_PREVIEW_CHARS = 1500;

/**
 * Auto-nudge configuration. When enabled, the orchestrator watches
 * each agent and sends a "please post a status" prompt to any agent
 * that has been silent for more than `afterMinutes` minutes. The
 * nudge is sent at most once per silence (so it doesn't flood).
 *
 * Defaults: enabled, 30 min, the standard nudge message.
 * Pass via `mesh start --auto-nudge-after 30` etc.
 */
export interface AutoNudgeOptions {
	/** Master switch. If false, no auto-nudging happens. */
	enabled: boolean;
	/** Threshold in minutes. An agent is nudged if their last entry
	 *  is older than this AND no nudge has been sent for the current
	 *  silence yet. Default 30. Set to 0 to disable. */
	afterMinutes: number;
	/** How often (in minutes) the background check runs. Default 1. */
	checkIntervalMinutes: number;
	/** The message sent to the agent. */
	message: string;
}

export const DEFAULT_AUTO_NUDGE_MESSAGE =
	"[mesh auto-nudge] you've been silent for a while. If you're stuck, post a status. " +
	"If you're done, post your checkpoint. If you're waiting on someone, say so. " +
	"Otherwise, the next action is yours — please continue.";

export const DEFAULT_AUTO_NUDGE: AutoNudgeOptions = {
	enabled: true,
	afterMinutes: 30,
	checkIntervalMinutes: 1,
	message: DEFAULT_AUTO_NUDGE_MESSAGE,
};

export class Orchestrator {
	readonly db: DB;
	readonly dataDir: string;
	readonly socketPath: string;
	readonly startedAt: number;
	readonly agents = new Map<string, AgentProcess>();
	readonly control: ControlServer;
	readonly autoNudge: AutoNudgeOptions;

	/** Hook for tests / observability: called once per posted entry after notifications are sent. */
	onEntryNotified?: (entry: EntryRow, notifiedAgents: string[]) => void;

	/** Per-session tally of how often a peer's tool-call budget was hit. */
	budgetHits = 0;
	/** Per-agent tally (in-memory; not persisted). */
	private budgetHitsByAgent = new Map<string, number>();

	/** How long to wait before timing out a pending confirmation. Configurable; default 60s. */
	confirmationTimeoutMs = 60_000;
	/** Background tick that times out pending confirmations. */
	private confirmationTickHandle: NodeJS.Timeout | null = null;

	/** Background tick for auto-nudge. */
	private autoNudgeTickHandle: NodeJS.Timeout | null = null;
	/** Per-agent: timestamp of the last auto-nudge we sent. Used to
	 *  enforce "once per silence" — a new silence starts when the
	 *  agent posts, so we can nudge again for a new silence even if
	 *  the last nudge was recent. */
	private lastAutoNudgeAt = new Map<string, number>();
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

	async start(): Promise<void> {
		await this.control.start();
		// Background tick: every second, scan for timed-out pending
		// confirmations. Lightweight (a single indexed query) so 1Hz is fine.
		this.confirmationTickHandle = setInterval(() => {
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

	/**
	 * Forward an interesting event to the control server's broadcast
	 * stream. Used by `mesh watch` to see real-time activity.
	 */
	private pushEvent(event: unknown): void {
		this.control.pushEvent(event);
	}

	/** Spawn an agent and register it. The agent is told the orchestrator's socket path. */
	async spawnAgent(spec: AgentOpts, opts: SpawnOpts = {}): Promise<AgentProcess> {
		if (this.agents.has(spec.name)) {
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
				MESH_SOCKET_PATH: this.socketPath,
				MESH_AGENT_NAME: spec.name,
				...spec.env,
			},
		});
		await agent.start();
		this.agents.set(spec.name, agent);

		// Hook cost capture: every `turn_end` event from this agent
		// carries the assistant message with `usage` (tokens + cost).
		// We persist a row to the `costs` table.
		const lastSteerTopic = new Map<string, string>(); // agent name → topic id
		agent.on("event", (ev: any) => {
			if (ev?.type === "turn_end" && ev.message?.role === "assistant" && ev.message.usage) {
				this.recordCost(spec.name, spec.model ?? ev.message.model ?? "unknown", ev.message.usage, lastSteerTopic.get(spec.name));
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

		return agent;
	}

	getAgent(name: string): AgentProcess | undefined {
		return this.agents.get(name);
	}

	/** Names of all live agents. */
	listAgents(): string[] {
		return [...this.agents.keys()];
	}

	/**
	 * Notification handler: called by the control server after a post lands.
	 * Computes the notify set and sends a `steer` to each interested agent.
	 * Fire-and-forget: failures to deliver one notification don't block
	 * delivery of others, and don't fail the original post.
	 */
	private async handleNewEntry(entry: EntryRow): Promise<void> {
		// Push to the broadcast stream for `mesh watch` subscribers.
		this.pushEvent({ kind: "post", entry });

		// Reactions are silent — no notification, no pending confirmation
		// tracking. The parent author sees the reaction next time they
		// read the topic.
		if (entry.kind === "react") {
			process.stderr.write(
				`[orch:react] ${entry.author} reacted to ${entry.parent_entry}: ${entry.body}\n`,
			);
			return;
		}
		// Confirmations are routed to a different handler; regular posts
		// get the topic-bus notification path.
		if (entry.kind === "confirmation") {
			await this.handleConfirmation(entry);
			return;
		}

		const db = this.db;

		// Topic's involved list and notify_on_post flag.
		const topic = db
			.prepare("SELECT id, notify_on_post FROM topics WHERE id = ?")
			.get(entry.topic_id) as { id: string; notify_on_post: number } | undefined;
		if (!topic) return;

		const involved = (
			db
				.prepare("SELECT agent_name FROM topic_involved WHERE topic_id = ?")
				.all(entry.topic_id) as Array<{ agent_name: string }>
		).map((r) => r.agent_name);

		let mentions: string[] = [];
		try {
			mentions = JSON.parse(entry.mentions || "[]") as string[];
		} catch {
			// malformed JSON in DB shouldn't happen; ignore
		}

		// Build the notify set:
		//   - everyone in `involved` if notify_on_post is on
		//   - everyone in `mentions` always
		//   - minus the author (don't notify yourself)
		const notifySet = new Set<string>();
		if (topic.notify_on_post === 1) {
			for (const name of involved) {
				if (name !== entry.author) notifySet.add(name);
			}
		}
		for (const name of mentions) {
			if (name !== entry.author) notifySet.add(name);
		}

		// Send a notification to each agent. Fire and forget.
		// We use `prompt` with `streamingBehavior: "steer"` so the message
		// delivers immediately if the agent is idle, or queues for the next
		// turn boundary if the agent is busy. (Plain `steer` only queues;
		// if the agent is idle the message sits forever.)
		const notified: string[] = [];

		// Smarter notification: include context that helps the LLM decide
		// what to do. The format is intentionally short (a few lines)
		// because the LLM will call read_inbox / read_entry for details.
		// We pass the context builder the involved list length, recent
		// entry count, this agent's history in the topic, and a soft
		// nudge to write a checkpoint if the topic has grown big since
		// the last checkpoint.
		const buildContext = (agentName: string): string => {
			const recentCount = (
				db.prepare(
					"SELECT COUNT(*) AS n FROM entries WHERE topic_id = ? AND ts > ?",
				).get(entry.topic_id, Date.now() - 5 * 60 * 1000) as { n: number }
			).n;
			const agentHasPosted = !!db
				.prepare(
					"SELECT 1 FROM entries WHERE topic_id = ? AND author = ? LIMIT 1",
				)
				.get(entry.topic_id, agentName);
			const isReply = !!entry.parent_entry;
			const parts: string[] = [];
			parts.push(`${involved.length} involved agent(s)`);
			if (recentCount > 1) parts.push(`${recentCount} entries in last 5min`);
			if (isReply) parts.push("this is a reply");
			if (agentHasPosted) parts.push("you have already posted in this topic");
			else parts.push("you have not posted in this topic");
			// Soft nudge: if there are 20+ entries since the last checkpoint,
			// hint at the agent to consider writing a checkpoint. This is a
			// suggestion, not a hard requirement; the agent decides.
			const lastCheckpointSeq = (
				db
					.prepare(
						"SELECT seq FROM entries WHERE topic_id = ? AND kind = 'checkpoint' ORDER BY seq DESC LIMIT 1",
					)
					.get(entry.topic_id) as { seq: number } | undefined
			)?.seq;
			const totalSeq = (
				db
					.prepare("SELECT MAX(seq) AS s FROM entries WHERE topic_id = ?")
					.get(entry.topic_id) as { s: number | null }
			).s ?? 0;
			const sinceCheckpoint = lastCheckpointSeq === undefined ? totalSeq : totalSeq - lastCheckpointSeq;
			if (sinceCheckpoint >= 20) {
				parts.push(`${sinceCheckpoint} entries since last checkpoint; consider writing one`);
			}
			return parts.join("; ");
		};

		for (const agentName of notifySet) {
			const agent = this.agents.get(agentName);
			if (!agent) continue; // agent not spawned; will see entry on next read_inbox
			const wasMentioned = mentions.includes(agentName);
			const priority = wasMentioned ? "mention" : "notify";
			const preview = (entry.body ?? "").slice(0, MAX_STEER_PREVIEW_CHARS).replace(/\n/g, " ");
			const context = buildContext(agentName);
			const message =
				`[mesh ${priority}] topic="${entry.topic_id}" from=${entry.author}\n` +
				`id=${entry.id}\n` +
				`preview: ${JSON.stringify(preview)}${entry.body && entry.body.length > MAX_STEER_PREVIEW_CHARS ? "..." : ""}\n` +
				`context: ${context}\n` +
				`action: call read_inbox (or read_entry("${entry.id}")) to see the full entry, then decide.\n` +
				`budget: you have 5 tool calls this turn. (must match peer-extension's TOOL_BUDGET_PER_TURN)`;
			try {
				// Don't await. If the pipe is full or the agent errors, we move on.
				agent
					.send({
						type: "prompt",
						message,
						streamingBehavior: "steer",
					})
					.then(() => notified.push(agentName))
					.catch((err) => {
						process.stderr.write(
							`[orch:notify] notify to ${agentName} failed: ${err instanceof Error ? err.message : err}\n`,
						);
					});
			} catch (err) {
				process.stderr.write(
					`[orch:notify] notify to ${agentName} threw: ${err instanceof Error ? err.message : err}\n`,
				);
			}
		}

		// If something is listening (test or admin), let it know.
		// We do this after a tick so callers can observe the post+notify as a unit.
		setImmediate(() => this.onEntryNotified?.(entry, notified));
	}

	/**
	 * Record a tool-budget hit from a peer extension. Increments the
	 * per-session counter and the per-agent counter. We log to stderr
	 * too so the orchestrator's own log file captures it.
	 */
	/**
	 * Background tick: for each alive agent that's been silent for more
	 * than the threshold AND has never been nudged for the current
	 * silence, send a nudge. Once per silence — a new silence starts
	 * when the agent posts, so we can nudge again for a new silence
	 * even if the last nudge was recent.
	 *
	 * Only nudges agents that are involved in at least one open topic.
	 * Agents with no topic context are skipped (nothing for them to
	 * "do" or "be stuck on").
	 */
	private checkAutoNudge(): void {
		const now = Date.now();
		const thresholdMs = this.autoNudge.afterMinutes * 60 * 1000;

		for (const [name, agent] of this.agents) {
			// Skip if the agent process is gone (e.g. already shut down).
			if (!agent) continue;

			// Find the most recent entry by this agent. We order by ts
			// (time of activity), not seq (insert order), because entries
			// can be backdated (e.g. seeded in tests, imported from
			// another mesh) and we want the "most recent activity" not
			// the "most recent insert".
			const lastEntry = this.db
				.prepare(
					"SELECT seq, ts, topic_id, body FROM entries WHERE author = ? ORDER BY ts DESC LIMIT 1",
				)
				.get(name) as { seq: number; ts: number; topic_id: string; body: string } | undefined;

			// If the agent has never posted, "silence started" is the
			// orchestrator's start time. (We don't nudge a freshly spawned
			// agent that hasn't had a chance to do anything yet.)
			const silenceStartedAt = lastEntry?.ts ?? this.startedAt;

			// Not silent long enough? Skip.
			if (now - silenceStartedAt < thresholdMs) continue;

			// Have we already nudged for this silence? If the last nudge
			// was after the silence started, yes — don't flood.
			const lastNudgeAt = this.lastAutoNudgeAt.get(name) ?? 0;
			if (lastNudgeAt >= silenceStartedAt) continue;

			// Is the agent involved in at least one open topic? If not,
			// there's nothing for them to do, so nudging is noise.
			const openTopic = this.db
				.prepare(
					`SELECT t.id FROM topics t
					 JOIN topic_involved ti ON ti.topic_id = t.id
					 WHERE ti.agent_name = ? AND t.status != 'closed'
					 ORDER BY t.last_activity_at DESC LIMIT 1`,
				)
				.get(name) as { id: string } | undefined;
			if (!openTopic) continue;

			// Send the nudge. Use the same channel as `admin_inject` (a
			// `prompt` with `streamingBehavior: "steer"`), so it lands as
			// a normal message in the agent's next turn.
			this.lastAutoNudgeAt.set(name, now);
			this.autoNudgesSent++;
			// Persist the nudge for reputation (response rate, response time).
			this.recordNudge(name, "auto", openTopic.id);
			const silentFor = Math.round((now - silenceStartedAt) / 60000);
			const lastBody = lastEntry
				? lastEntry.body.length > 60
					? lastEntry.body.slice(0, 60) + "..."
					: lastEntry.body
				: "(no entries yet)";
			process.stderr.write(
				`[orch:auto-nudge] nudging ${name} in ${openTopic.id} (silent for ${silentFor}m, last entry: ${lastBody})\n`,
			);
			agent
				.send({ type: "prompt", message: this.autoNudge.message, streamingBehavior: "steer" })
				.catch((err) => {
					process.stderr.write(
						`[orch:auto-nudge] nudge to ${name} failed: ${err instanceof Error ? err.message : err}\n`,
					);
				});
		}
	}

	/**
	 * Record a cost event. Called from the agent's `turn_end` event
	 * hook (see `spawnAgent`). Persists a row to the `costs` table.
	 */
	private recordCost(agent: string, model: string, usage: {
		input: number;
		output: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number; total: number };
	}, topicId: string | undefined): void {
		try {
			const id = randomUUID();
			const ts = Date.now();
			// Generate a turn_id from ts+agent so we can dedupe if needed.
			const turnId = `${ts}-${agent}`;
			this.db
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
	 * Record a nudge event. Called by the auto-nudge background tick
	 * and by the admin_inject path (manual nudge). Used by reputation.
	 */
	private recordNudge(agent: string, source: "auto" | "manual", topicId: string | undefined): void {
		try {
			this.db
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

	/**
	 * Cost visibility for the `mesh cost` CLI. Returns totals +
	 * per-agent + per-model breakdown + recent events.
	 */
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
	 */
	private adminReputationStatus(): {
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
		const postStats = this.db
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
		const rejections = this.db
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
		const nudges = this.db
			.prepare(
				`SELECT agent, ts, topic_id FROM nudges ORDER BY ts ASC`,
			)
			.all() as Array<{ agent: string; ts: number; topic_id: string | null }>;
		const responsesByAgent = new Map<string, { responded: number; totalMs: number; count: number }>();
		for (const n of nudges) {
			// Find the first post by this agent after the nudge.
			const nextPost = this.db
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

	private adminCostStatus(opts: { agent?: string; topic_id?: string; since_ms?: number } = {}): {
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

		const totals = this.db
			.prepare(
				`SELECT COALESCE(SUM(cost_total_usd), 0) AS cost,
				        COALESCE(SUM(input_tokens), 0) AS inp,
				        COALESCE(SUM(output_tokens), 0) AS outp,
				        COUNT(*) AS n
				 FROM costs ${where}`,
			)
			.get(...params) as { cost: number; inp: number; outp: number; n: number };

		const perAgent = this.db
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

		const perModel = this.db
			.prepare(
				`SELECT model,
				        COALESCE(SUM(cost_total_usd), 0) AS cost,
				        COUNT(*) AS n
				 FROM costs ${where}
				 GROUP BY model
				 ORDER BY cost DESC`,
			)
			.all(...params) as Array<{ model: string; cost: number; n: number }>;

		const recent = this.db
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

	private recordBudgetHit(info: { author: string; tool: string; calls: number; budget: number }): void {
		this.budgetHits++;
		this.budgetHitsByAgent.set(
			info.author,
			(this.budgetHitsByAgent.get(info.author) ?? 0) + 1,
		);
		process.stderr.write(
			`[orch:budget] ${info.author} hit limit on ${info.tool} ` +
				`(call ${info.calls} of ${info.budget}). total this session: ${this.budgetHits}.\n`,
		);
	}

	/**
	 * Handle admin RPCs (type starting with `admin_`). These are
	 * sent by the human operator via the `mesh` CLI subcommands.
	 */
	private async handleAdminCommand(
		req: any,
	): Promise<{ ok: boolean; data?: unknown; error?: string }> {
		try {
			switch (req.type) {
				case "admin_list_agents":
					return { ok: true, data: { agents: this.adminListAgents() } };
				case "admin_list_topics":
					return { ok: true, data: { topics: this.adminListTopics() } };
				case "admin_get_entry":
					return { ok: true, data: this.adminGetEntry(req.id) };
				case "admin_get_topic":
					return { ok: true, data: this.adminGetTopic(req.topic_id) };
				case "admin_orchestrator_status":
					return { ok: true, data: this.adminOrchestratorStatus() };
				case "admin_auto_nudge_status":
					return { ok: true, data: this.adminAutoNudgeStatus() };
				case "admin_cost_status":
					return { ok: true, data: this.adminCostStatus(req) };
				case "admin_reputation_status":
					return { ok: true, data: this.adminReputationStatus() };
				case "admin_inject":
					return await this.adminInject(req.agent, req.message);
				case "admin_write_checkpoint":
					return this.control.handleWriteCheckpoint(req);
				case "admin_shutdown":
					// Schedule shutdown; return first. Use setImmediate so
					// the response goes out before any cleanup runs.
					setImmediate(() => {
						process.stderr.write(`[orch] received admin_shutdown; shutting down\n`);
						// Best-effort cleanup; force-exit at the end regardless.
						this.shutdown()
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

	/**
	 * List all known agents, plus each one's most recent entry (so the
	 * status UI can show "what they're working on" without a second query).
	 */
	private adminListAgents(): Array<{
		name: string;
		has_process: boolean;
		last_entry: { id: string; ts: number; kind: string; body: string; topic_id: string } | null;
		pending_confirmations: number;
	}> {
		return [...this.agents.keys()].map((name) => {
			const has_process = this.agents.has(name);
			const lastEntryRow = this.db
				.prepare(
					`SELECT id, ts, topic_id, author, kind, body
					 FROM entries WHERE author = ? ORDER BY seq DESC LIMIT 1`,
				)
				.get(name) as
				| { id: string; ts: number; topic_id: string; author: string; kind: string; body: string }
				| undefined;
			const pendingRow = this.db
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

	private adminListTopics(): Array<{
		id: string;
		status: string;
		kind: string;
		involved_count: number;
		last_activity_at: number;
		entry_count: number;
		checkpoint_count: number;
	}> {
		return this.db
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
	 * High-level orchestrator status, for the `mesh status` / `mesh tui` UI.
	 * Returns PID (own process), uptime, data dir, totals, and per-process
	 * counts. Cheap to compute (a few aggregate SQL queries).
	 */
	/**
	 * Auto-nudge visibility for the `mesh status` / `mesh tui` UI.
	 * Returns the config + per-agent last-nudge timestamp + total
	 * nudges sent this session.
	 */
	private adminAutoNudgeStatus(): {
		config: AutoNudgeOptions;
		nudges_sent: number;
		per_agent: Array<{ name: string; last_nudge_at: number | null }>;
	} {
		const per_agent = [...this.agents.keys()].map((name) => ({
			name,
			last_nudge_at: this.lastAutoNudgeAt.get(name) ?? null,
		}));
		return {
			config: this.autoNudge,
			nudges_sent: this.autoNudgesSent,
			per_agent,
		};
	}

	private adminOrchestratorStatus(): {
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
			topics: (this.db.prepare("SELECT COUNT(*) AS c FROM topics").get() as { c: number }).c,
			open_topics: (this.db.prepare("SELECT COUNT(*) AS c FROM topics WHERE status != 'closed'").get() as { c: number }).c,
			closed_topics: (this.db.prepare("SELECT COUNT(*) AS c FROM topics WHERE status = 'closed'").get() as { c: number }).c,
			entries: (this.db.prepare("SELECT COUNT(*) AS c FROM entries").get() as { c: number }).c,
			checkpoints: (this.db.prepare("SELECT COUNT(*) AS c FROM entries WHERE kind = 'checkpoint'").get() as { c: number }).c,
			pending_confirmations: (this.db.prepare("SELECT COUNT(*) AS c FROM pending_confirmations WHERE status = 'pending'").get() as { c: number }).c,
			agents: this.agents.size,
			agents_alive: this.agents.size, // all entries in the map are alive processes (removed on shutdown)
		};
		return {
			running: true as const,
			pid: process.pid,
			started_at: this.startedAt,
			uptime_ms: now - this.startedAt,
			data_dir: this.dataDir,
			socket_path: this.socketPath,
			auto_nudge: {
				enabled: this.autoNudge.enabled,
				after_minutes: this.autoNudge.afterMinutes,
				nudges_sent: this.autoNudgesSent,
			},
			totals,
		};
	}

	private adminGetEntry(id: string): { entry: EntryRow } | { error: string } {
		if (typeof id !== "string" || id.length === 0) return { error: "id is required" };
		const row = this.db
			.prepare(
				`SELECT id, ts, topic_id, author, kind, body, parent_entry, mentions, requires_confirmation_from
				 FROM entries WHERE id = ?`,
			)
			.get(id) as EntryRow | undefined;
		if (!row) return { error: `entry "${id}" not found` };
		return { entry: row };
	}

	private adminGetTopic(topicId: string): { topic: TopicRow; involved: string[]; entries: EntryRow[]; count: number; checkpoints: number; last_checkpoint: { id: string; ts: number; author: string } | null } | { error: string } {
		if (typeof topicId !== "string" || topicId.length === 0) return { error: "topic_id is required" };
		const topic = this.db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as TopicRow | undefined;
		if (!topic) return { error: `topic "${topicId}" not found` };
		const involved = (
			this.db
				.prepare("SELECT agent_name FROM topic_involved WHERE topic_id = ? ORDER BY agent_name")
				.all(topicId) as Array<{ agent_name: string }>
		).map((r) => r.agent_name);
		const entries = this.db
			.prepare(
				`SELECT id, ts, topic_id, author, kind, body, parent_entry, mentions, requires_confirmation_from
				 FROM entries WHERE topic_id = ? ORDER BY seq ASC`,
			)
			.all(topicId) as EntryRow[];
		const checkpointCount = (
			this.db
				.prepare("SELECT COUNT(*) AS c FROM entries WHERE topic_id = ? AND kind = 'checkpoint'")
				.get(topicId) as { c: number }
		).c;
		const lastCheckpointRow = this.db
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

	private async adminInject(agentName: string, message: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
		if (typeof agentName !== "string" || agentName.length === 0) {
			return { ok: false, error: "agent is required" };
		}
		if (typeof message !== "string" || message.length === 0) {
			return { ok: false, error: "message is required" };
		}
		const agent = this.agents.get(agentName);
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
		this.recordNudge(agentName, "manual", topicId);
		try {
			const r = await agent.send({ type: "prompt", message, streamingBehavior: "steer" });
			return { ok: true, data: { result: r, agent: agentName } };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * Handle a confirmation entry landing. Look up the parent post, compute
	 * the new state (X/N confirmed), and notify the parent author.
	 */
	private async handleConfirmation(confirmation: EntryRow): Promise<void> {
		if (!confirmation.parent_entry) {
			process.stderr.write(
				`[orch:confirm] confirmation ${confirmation.id} has no parent_entry; ignoring\n`,
			);
			return;
		}

		const db = this.db;
		const parent = db
			.prepare("SELECT id, ts, topic_id, author FROM entries WHERE id = ?")
			.get(confirmation.parent_entry) as { id: string; ts: number; topic_id: string; author: string } | undefined;
		if (!parent) {
			process.stderr.write(
				`[orch:confirm] parent ${confirmation.parent_entry} not found; ignoring\n`,
			);
			return;
		}

		const allRows = db
			.prepare(
				`SELECT required_agent, status FROM pending_confirmations WHERE entry_id = ? ORDER BY required_agent`,
			)
			.all(parent.id) as Array<{ required_agent: string; status: string }>;
		const total = allRows.length;
		const confirmed = allRows.filter((r) => r.status === "confirmed");
		const confirmedList = confirmed.map((r) => r.required_agent);
		const waitingList = allRows
			.filter((r) => r.status === "pending")
			.map((r) => r.required_agent);
		const timedOutList = allRows
			.filter((r) => r.status === "timed_out")
			.map((r) => r.required_agent);
		const confirmedCount = confirmed.length;
		const fullyConfirmed = confirmedCount === total;

		process.stderr.write(
			`[orch:confirm] ${confirmation.author} confirmed ${parent.id}: ` +
				`${confirmedCount}/${total} confirmed. ` +
				`notifying ${parent.author}.\n`,
		);

		// Notify the parent author. Don't notify if the confirmer is the
		// parent author themselves (would be self-notification noise).
		if (parent.author === confirmation.author) return;
		const agent = this.agents.get(parent.author);
		if (!agent) return; // author not spawned; will see the entry in next read_inbox

		const lines: string[] = [];
		lines.push(
			`[mesh confirmations] ${confirmedCount}/${total} confirmed for your entry ${parent.id} in topic "${parent.topic_id}":`,
		);
		if (fullyConfirmed) {
			lines.push(`  status: FULLY CONFIRMED. you can proceed.`);
		} else {
			lines.push(`  status: in progress.`);
		}
		if (confirmedList.length > 0) {
			lines.push(`  confirmed: [${confirmedList.join(", ")}]`);
		}
		if (waitingList.length > 0) {
			lines.push(`  waiting on: [${waitingList.join(", ")}]`);
		}
		if (timedOutList.length > 0) {
			lines.push(`  timed out: [${timedOutList.join(", ")}]`);
		}
		lines.push(`  confirmation entry id: ${confirmation.id}`);

		agent
			.send({ type: "prompt", message: lines.join("\n"), streamingBehavior: "steer" })
			.catch((err) => {
				process.stderr.write(
					`[orch:confirm] notify to ${parent.author} failed: ${err instanceof Error ? err.message : err}\n`,
				);
			});
	}

	/**
	 * Background tick: scan for pending confirmations that have been
	 * waiting too long and mark them as `timed_out`, then notify the
	 * parent author.
	 */
	private checkConfirmationTimeouts(): void {
		const cutoff = Date.now() - this.confirmationTimeoutMs;
		const timedOut = this.db
			.prepare(
				`SELECT pc.entry_id, pc.required_agent, e.author AS requester, e.topic_id
				 FROM pending_confirmations pc
				 JOIN entries e ON pc.entry_id = e.id
				 WHERE pc.status = 'pending' AND e.ts < ?`,
			)
			.all(cutoff) as Array<{
				entry_id: string;
				required_agent: string;
				requester: string;
				topic_id: string;
			}>;
		if (timedOut.length === 0) return;

		// Group by entry so we send one notification per parent.
		const byEntry = new Map<string, typeof timedOut>();
		for (const row of timedOut) {
			if (!byEntry.has(row.entry_id)) byEntry.set(row.entry_id, []);
			byEntry.get(row.entry_id)!.push(row);
		}

		for (const [entryId, rows] of byEntry) {
			// Mark as timed_out.
			const mark = this.db.prepare(
				"UPDATE pending_confirmations SET status = 'timed_out' WHERE entry_id = ? AND required_agent = ?",
			);
			for (const row of rows) {
				mark.run(entryId, row.required_agent);
			}

			// Compute the final state and notify.
			const allRows = this.db
				.prepare(
					"SELECT required_agent, status FROM pending_confirmations WHERE entry_id = ?",
				)
				.all(entryId) as Array<{ required_agent: string; status: string }>;
			const confirmedList = allRows
				.filter((r) => r.status === "confirmed")
				.map((r) => r.required_agent);
			const timedOutList = allRows
				.filter((r) => r.status === "timed_out")
				.map((r) => r.required_agent);
			const total = allRows.length;
			const requester = rows[0].requester;
			const topicId = rows[0].topic_id;

			process.stderr.write(
				`[orch:confirm] timeout for entry ${entryId}: ${confirmedList.length}/${total} confirmed, ` +
					`${timedOutList.length} timed out. notifying ${requester}.\n`,
			);

			const agent = this.agents.get(requester);
			if (!agent) continue;
			const lines: string[] = [];
			lines.push(
				`[mesh confirmations] your entry ${entryId} in topic "${topicId}" TIMED OUT:`,
			);
			lines.push(`  ${confirmedList.length}/${total} confirmed before timeout.`);
			if (confirmedList.length > 0) {
				lines.push(`  confirmed: [${confirmedList.join(", ")}]`);
			}
			if (timedOutList.length > 0) {
				lines.push(`  timed out (no response): [${timedOutList.join(", ")}]`);
			}
			lines.push(`  you can decide whether to proceed with partial confirmation, or take other action.`);
			agent
				.send({ type: "prompt", message: lines.join("\n"), streamingBehavior: "steer" })
				.catch((err) => {
					process.stderr.write(
						`[orch:confirm] timeout notify to ${requester} failed: ${err instanceof Error ? err.message : err}\n`,
					);
				});
		}
	}

	/** Shutdown all agents and close the DB. */
	async shutdown(): Promise<void> {
		if (this.confirmationTickHandle) {
			clearInterval(this.confirmationTickHandle);
			this.confirmationTickHandle = null;
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
}
