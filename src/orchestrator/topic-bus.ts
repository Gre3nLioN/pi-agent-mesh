/**
 * Topic-bus module — entry → agent notification routing + confirmation protocol.
 *
 * Owns:
 *   - The notification flow (`handleNewEntry`): when a new entry lands in the
 *     DB, decide which agents to notify and send each one a `steer` push.
 *   - The `pending_confirmations` table writes (via `checkConfirmationTimeouts`).
 *   - The `confirmationTickHandle` interval (the 1s tick that times out stale
 *     confirmations).
 *
 * Cross-module edges:
 *   - No function calls between this module and `lifecycle.ts`. They share the
 *     `db` for reads but never call each other.
 *   - `admin.ts#adminListAgents` reads the `pending_confirmations` table
 *     (written by `checkConfirmationTimeouts` here); no function call.
 */

import { ControlServer, type EntryRow } from "../control-server.js";
import { AgentProcess } from "../rpc.js";
import type { Database as DB } from "better-sqlite3";
import { MAX_STEER_PREVIEW_CHARS } from "./defaults.js";

// ────────────────────────────────────────────────────────────────────────────
// TopicBusCtx — what the topic-bus functions read from the orchestrator.
// The Orchestrator class satisfies this interface structurally; no
// `implements` declaration needed.
// ────────────────────────────────────────────────────────────────────────────
export interface TopicBusCtx {
	db: DB;
	control: ControlServer;
	agents: Map<string, AgentProcess>;
	onEntryNotified?: (entry: EntryRow, notifiedAgents: string[]) => void;
	maxSteerPreviewChars: number;
	confirmationTimeoutMs: number;
	pushEvent: (event: unknown) => void;
	// The interval handle is owned by the orchestrator so `shutdown` can clear
	// it. The holder is mutable so the topic-bus tick can set it on first
	// install and the facade can null it on shutdown.
	confirmationTickHandle: { current: NodeJS.Timeout | null };
}

// ────────────────────────────────────────────────────────────────────────────
// Notification routing
// ────────────────────────────────────────────────────────────────────────────

/**
 * Notification handler: called by the control server after a post lands.
 * Computes the notify set and sends a `steer` to each interested agent.
 * Fire-and-forget: failures to deliver one notification don't block
 * delivery of others, and don't fail the original post.
 *
 * NOTE on schema smell (design D8): the silent-log-and-return path for
 * `kind='react'` rows. `kind='react'` rows in `entries` come from agent
 * reactions (via peer-extension), not from anything in this module. The
 * same row kind is also read by `lifecycle.ts#adminReputationStatus` for
 * rejection-rate calculation. See design.md § D8 for the deferred cleanup.
 */
export async function handleNewEntry(ctx: TopicBusCtx, entry: EntryRow): Promise<void> {
	// Push to the broadcast stream for `mesh watch` subscribers.
	ctx.pushEvent({ kind: "post", entry });

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
		await handleConfirmation(ctx, entry);
		return;
	}

	const db = ctx.db;

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

	for (const agentName of notifySet) {
		const agent = ctx.agents.get(agentName);
		if (!agent) continue; // agent not spawned; will see entry on next read_inbox
		const wasMentioned = mentions.includes(agentName);
		const priority = wasMentioned ? "mention" : "notify";
		const preview = (entry.body ?? "").slice(0, ctx.maxSteerPreviewChars).replace(/\n/g, " ");
		const context = buildContext(ctx, entry, involved, agentName);
		const message =
			`[mesh ${priority}] topic="${entry.topic_id}" from=${entry.author}\n` +
			`id=${entry.id}\n` +
			`preview: ${JSON.stringify(preview)}${entry.body && entry.body.length > ctx.maxSteerPreviewChars ? "..." : ""}\n` +
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
	setImmediate(() => ctx.onEntryNotified?.(entry, notified));
}

/**
 * Build the context string for a notification. Extracted from the closure
 * that previously lived inside `handleNewEntry` so it can be unit-tested
 * and so the read paths are explicit. Returns a short semicolon-separated
 * string the agent sees in its steer message.
 */
function buildContext(
	ctx: TopicBusCtx,
	entry: EntryRow,
	involved: string[],
	agentName: string,
): string {
	const db = ctx.db;
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
}

// ────────────────────────────────────────────────────────────────────────────
// Confirmation protocol
// ────────────────────────────────────────────────────────────────────────────

/**
 * Handle a confirmation entry landing. Look up the parent post, compute
 * the new state (X/N confirmed), and notify the parent author.
 */
export async function handleConfirmation(ctx: TopicBusCtx, confirmation: EntryRow): Promise<void> {
	if (!confirmation.parent_entry) {
		process.stderr.write(
			`[orch:confirm] confirmation ${confirmation.id} has no parent_entry; ignoring\n`,
		);
		return;
	}

	const db = ctx.db;
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
	const agent = ctx.agents.get(parent.author);
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
export function checkConfirmationTimeouts(ctx: TopicBusCtx): void {
	const cutoff = Date.now() - ctx.confirmationTimeoutMs;
	const timedOut = ctx.db
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
		const mark = ctx.db.prepare(
			"UPDATE pending_confirmations SET status = 'timed_out' WHERE entry_id = ? AND required_agent = ?",
		);
		for (const row of rows) {
			mark.run(entryId, row.required_agent);
		}

		// Compute the final state and notify.
		const allRows = ctx.db
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

		const agent = ctx.agents.get(requester);
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
