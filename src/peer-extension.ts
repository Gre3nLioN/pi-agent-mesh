/**
 * Peer extension — loaded into each spawned pi session via `-e`.
 *
 * Registers the tool surface the LLM uses to talk to peers. None of
 * these tools exist on a vanilla pi session. Each tool proxies an
 * RPC to the orchestrator over a Unix socket (the only writer to
 * the log is the orchestrator).
 *
 * Also enforces a per-turn tool-call budget (TOOL_BUDGET_PER_TURN)
 * to keep the LLM from spiraling in response to a single notification.
 * When the budget is hit, the Nth tool call returns a STOP message and
 * a `budget_hit` event is sent to the orchestrator for tracking.
 *
 * For stage 2 we register exactly one tool: `post`. Stage 3+ adds
 * the rest.
 */

import { Type } from "typebox";
import { connect, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Max tool calls per turn. **Must match the value advertised in
 * the orchestrator's steer message** (see `MAX_STEER_PREVIEW_CHARS`'s
 * sibling budget message in `orchestrator.ts`). If you change one,
 * change the other.
 *
 * The orchestrator enforces this limit (the 4th call returns a STOP).
 * Track via the `budget_hit` RPC the extension sends to the orchestrator.
 */
const TOOL_BUDGET_PER_TURN = 5;

/**
 * Resolve a stable path for the orchestrator's control socket.
 *
 * The orchestrator publishes this path in MESH_SOCKET_PATH env var
 * when it spawns the agent. We trust the env var (it comes from our
 * own orchestrator process). Fall back to a per-pid temp path for
 * standalone testing.
 */
function resolveSocketPath(): string {
	if (process.env.MESH_SOCKET_PATH) return process.env.MESH_SOCKET_PATH;
	return join(tmpdir(), `mesh-${process.pid}.sock`);
}

type RpcRequest = { type: string; [k: string]: unknown };
type RpcReply = { ok: boolean; data?: unknown; error?: string };

/**
 * Synchronous-looking RPC over a Unix socket. We open a fresh socket
 * per call (cheap on localhost, and keeps the code simple). For stage 2
 * a single `post` call is the only consumer; future stages may want
 * a persistent connection.
 */
function callOrchestrator(req: RpcRequest): Promise<RpcReply> {
	const socketPath = resolveSocketPath();
	if (!existsSync(socketPath)) {
		return Promise.resolve({ ok: false, error: `orchestrator socket not found at ${socketPath}` });
	}

	return new Promise<RpcReply>((resolve) => {
		const sock: Socket = connect(socketPath);
		let buf = "";
		const timer = setTimeout(() => {
			sock.destroy();
			resolve({ ok: false, error: "orchestrator RPC timed out (5s)" });
		}, 5000);

		sock.on("connect", () => {
			sock.write(JSON.stringify(req) + "\n");
		});

		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			const idx = buf.indexOf("\n");
			if (idx >= 0) {
				const line = buf.slice(0, idx);
				clearTimeout(timer);
				sock.end();
				try {
					resolve(JSON.parse(line));
				} catch (e: any) {
					resolve({ ok: false, error: `bad reply JSON: ${e.message}` });
				}
			}
		});

		sock.on("error", (err) => {
			clearTimeout(timer);
			resolve({ ok: false, error: `socket error: ${err.message}` });
		});
	});
}

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
};

/**
 * Per-turn tool-call tracking. Reset by the turn_start listener; each
 * tool's execute calls `consumeBudget()` to check.
 */
let currentTurnToolCalls = 0;
let currentTurnNumber = 0;

/**
 * Send a budget_hit event to the orchestrator (fire and forget).
 * The orchestrator increments a counter so we can see how often the
 * limit is hit and decide whether to raise it.
 */
function reportBudgetHit(tool: string, calls: number): void {
	callOrchestrator({
		type: "budget_hit",
		author: AGENT_NAME,
		tool,
		calls,
		budget: TOOL_BUDGET_PER_TURN,
	}).catch(() => {
		// Orchestrator may be down; don't fail the tool.
	});
}

/**
 * Check if there's budget left for this turn. If yes, consume one
 * slot and return null. If no, return a STOP tool result that the
 * wrapped execute should use instead of running the real tool.
 */
function consumeBudget(toolName: string): ToolResult | null {
	currentTurnToolCalls++;
	if (currentTurnToolCalls > TOOL_BUDGET_PER_TURN) {
		reportBudgetHit(toolName, currentTurnToolCalls);
		return {
			content: [
				{
					type: "text",
					text:
						`[tool budget exhausted] you have used ${currentTurnToolCalls} of ${TOOL_BUDGET_PER_TURN} tool calls in this turn. ` +
						`Respond with a text message only. Do not call any more tools in this turn. ` +
						`The orchestrator will let you call tools again on the next turn.`,
				},
			],
			isError: true,
			details: {
				budget: TOOL_BUDGET_PER_TURN,
				used: currentTurnToolCalls,
				tool: toolName,
			},
		};
	}
	return null;
}

/**
 * Wrap a tool's execute function with the per-turn budget check.
 * If the budget is exhausted, the wrapped execute returns the STOP
 * result without running the real tool. Otherwise, the real tool runs.
 */
function withBudget(
	toolName: string,
	execute: (...args: any[]) => Promise<ToolResult>,
): (...args: any[]) => Promise<ToolResult> {
	return async (...args: any[]) => {
		const blocked = consumeBudget(toolName);
		if (blocked) return blocked;
		return execute(...args);
	};
}

const AGENT_NAME = process.env.MESH_AGENT_NAME ?? "unknown";

/**
 * Send a JSON-RPC to the orchestrator and shape the result as a pi
 * tool result. On error, returns isError=true. On success, the
 * orchestrator's `data` payload is passed through as `details` and
 * a short human-readable string is included in `content`.
 */
async function rpc(
	type: string,
	params: Record<string, unknown>,
	successMessage: (data: any) => string,
): Promise<ToolResult> {
	const reply = await callOrchestrator({ type, ...params, author: AGENT_NAME });
	if (!reply.ok) {
		return {
			content: [{ type: "text", text: `error: ${reply.error}` }],
			isError: true,
			details: { error: reply.error ?? "unknown" },
		};
	}
	return {
		content: [{ type: "text", text: successMessage(reply.data) }],
		details: (reply.data ?? {}) as Record<string, unknown>,
	};
}

export default function (pi: ExtensionAPI) {
	// Reset the per-turn tool-call counter at the start of each turn.
	// Without this, a long session would accumulate calls indefinitely and
	// the budget would never reset.
	pi.on("turn_start", () => {
		currentTurnNumber++;
		currentTurnToolCalls = 0;
	});

	// Tool: create_topic(topic_id, description, kind?, initial_involved?, name?, notify_on_post?)
	pi.registerTool({
		name: "create_topic",
		label: "Create Topic",
		description:
			"Create a new topic in the mesh scratchpad. Topics group related entries " +
				"and have a stable id matching the convention <domain>-<action>-<short> " +
				"(e.g. 'auth-review-a3f7').",
		parameters: Type.Object({
			topic_id: Type.String({
				description:
					"Topic identifier, must match the convention <domain>-<action>-<short> " +
						"(lowercase, dashes, 3 segments, suffix 2-8 chars). Example: 'auth-review-a3f7'.",
				minLength: 1,
			}),
			description: Type.String({
				description:
					"One-line summary of what the topic is about. Used for discovery " +
						"when other agents search for topics.",
				minLength: 1,
			}),
			kind: Type.Optional(
				Type.Union([
					Type.Literal("chat"),
					Type.Literal("task"),
					Type.Literal("decision"),
					Type.Literal("handoff"),
				]),
			),
			initial_involved: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Agent names to mark as involved from the start. Defaults to just the caller.",
				}),
			),
			name: Type.Optional(
				Type.String({
					description: "Optional short display name. Defaults to using the topic id.",
				}),
			),
			notify_on_post: Type.Optional(
				Type.Boolean({
					description:
						"If true, every new entry in this topic is automatically pushed (steered) " +
							"to all involved agents. Default false. Set true for active discussion " +
							"topics where everyone should see every message; leave false for " +
							"low-traffic topics where you only want to be notified on @mentions.",
				}),
			),
		}),
		execute: withBudget("create_topic", async (_callId, params) => {
			return rpc(
				"create_topic",
				{
					topic_id: params.topic_id,
					description: params.description,
					kind: params.kind,
					initial_involved: params.initial_involved,
					name: params.name,
					notify_on_post: params.notify_on_post,
				},
				(data: any) => {
					const t = data.topic;
					const notify = t.notify_on_post ? " (notify_on_post=true)" : "";
					return `created topic ${t.id} (kind=${t.kind}, status=${t.status})${notify} with ${data.involved.length} involved agent(s): ${data.involved.join(", ")}`;
				},
			);
		}),
	});

	// Tool: post(topic_id, body, mentions?, requires_confirmation_from?)
	pi.registerTool({
		name: "post",
		label: "Post to Topic",
		description:
			"Post a message to a topic in the mesh scratchpad. The orchestrator validates " +
				"and writes the entry. The topic must exist (use create_topic first). " +
				"Use `mentions` to ping specific agents by name (they get a high-priority " +
				"notification regardless of the topic's notify_on_post setting). " +
				"Use `requires_confirmation_from` ONLY for posts that gate your next action " +
				"on a confirmation — e.g. you intend to wait for an explicit sign-off before " +
				"proceeding. For a normal ping that does not block you, use `mentions` " +
				"instead. Setting `requires_confirmation_from` adds ~30-60s of latency even " +
				"if the agent doesn't call the `confirm` tool, because the entry times out " +
				"and you get a notification.",
		parameters: Type.Object({
			topic_id: Type.String({
				description:
					"Topic identifier, must match the convention <domain>-<action>-<short>.",
				minLength: 1,
			}),
			body: Type.String({
				description: "The message body. Plain text.",
				minLength: 1,
			}),
			mentions: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Agent names to mention. Mentioned agents get a high-priority notification " +
							"regardless of the topic's notify_on_post setting.",
				}),
			),
			requires_confirmation_from: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Agent names that must confirm this post before the author continues. " +
							"The author will be notified when each agent confirms, and again " +
							"on timeout. Use for multi-party synchronization.",
				}),
			),
		}),
		execute: withBudget("post", async (_callId, params) => {
			return rpc(
				"post",
				{
					topic_id: params.topic_id,
					body: params.body,
					mentions: params.mentions,
					requires_confirmation_from: params.requires_confirmation_from,
				},
				(data: any) => {
					const conf = data.confirmation;
					const confStr = conf
						? `; awaiting ${conf.total} confirmation(s) from [${conf.required.join(", ")}]`
						: "";
					return `posted entry ${data.id} to topic ${params.topic_id} at ${new Date(data.ts).toISOString()}${confStr}`;
				},
			);
		}),
	});

	// Tool: confirm(entry_id, body?)
	pi.registerTool({
		name: "confirm",
		label: "Confirm Entry",
		description:
			"Confirm a post that requested your confirmation. The orchestrator writes a " +
				"`confirmation` entry pointing back to the original, and notifies the original " +
				"author of the new state. You can only confirm entries whose " +
				"`requires_confirmation_from` includes your name. Idempotent: confirming " +
				"twice is a no-op.",
		parameters: Type.Object({
			entry_id: Type.String({
				description: "The id of the post you are confirming.",
				minLength: 1,
			}),
			body: Type.Optional(
				Type.String({
					description:
						"Optional confirmation message (e.g. 'verified on my end', 'looks good'). " +
							"Omit for a simple ack.",
				}),
			),
		}),
		execute: withBudget("confirm", async (_callId, params) => {
			return rpc(
				"confirm",
				{ entry_id: params.entry_id, body: params.body },
				(data: any) => {
					const c = data.confirmation;
					return `confirmed entry ${params.entry_id}: now ${c.confirmed_count}/${c.total_required} confirmed.`;
				},
			);
		}),
	});

	// Tool: read_entry(id)
	pi.registerTool({
		name: "read_entry",
		label: "Read Entry",
		description: "Read a single entry by its id, returning the full row.",
		parameters: Type.Object({
			id: Type.String({ description: "The entry id (a UUID).", minLength: 1 }),
		}),
		execute: withBudget("read_entry", async (_callId, params) => {
			return rpc("read_entry", { id: params.id }, (data: any) => {
				const e = data.entry;
				const parent = e.parent_entry ? ` parent=${e.parent_entry}` : "";
				const mentions =
					JSON.parse(e.mentions).length > 0 ? ` mentions=${e.mentions}` : "";
				return `entry ${e.id} by ${e.author} in ${e.topic_id} at ${new Date(e.ts).toISOString()}: ${JSON.stringify(e.body)}${parent}${mentions}`;
			});
		}),
	});

	// Tool: read_topic(topic_id, since_seq?, all?, from_checkpoint?)
	pi.registerTool({
		name: "read_topic",
		label: "Read Topic",
		description:
			"Read entries in a topic, ordered by sequence number ascending. " +
				"Returns the topic metadata, the involved list, and the entries. " +
				"By default (TIERED VIEW), returns the most recent checkpoint + entries " +
				"after it. If no checkpoint exists, returns all entries. Use `all: true` " +
				"to get the full history (escape hatch), or `from_checkpoint: <id>` to " +
				"read a specific checkpoint and entries after it.",
		parameters: Type.Object({
			topic_id: Type.String({
				description: "The topic id to read.",
				minLength: 1,
			}),
			since_seq: Type.Optional(
				Type.Number({
					description:
						"Optional seq number; only return entries with seq > this. " +
							"For incremental reads. Mutually exclusive with all/from_checkpoint.",
				}),
			),
			all: Type.Optional(
				Type.Boolean({
					description:
						"Optional flag; if true, return all entries in the topic. " +
							"Use this for audits or to read the full history. " +
							"Default is the tiered view (checkpoint + entries after).",
				}),
			),
			from_checkpoint: Type.Optional(
				Type.String({
					description:
						"Optional checkpoint entry id; return that checkpoint + entries " +
							"after it. Use list_checkpoints to see checkpoint ids.",
				}),
			),
		}),
		execute: withBudget("read_topic", async (_callId, params) => {
			return rpc("read_topic", params, (data: any) => {
				const t = data.topic;
				const lines: string[] = [];
				lines.push(
					`topic ${t.id} (${t.kind}, ${t.status}) created by ${t.created_by} at ${new Date(t.created_at).toISOString()}`,
				);
				lines.push(`  description: ${t.description}`);
				lines.push(`  involved: ${data.involved.join(", ")}`);
				if (data.tiered && data.checkpoint_seq_used) {
					lines.push(
						`  entries: ${data.count} (TIERED VIEW: from checkpoint seq ${data.checkpoint_seq_used}; topic has ${data.total} total entries. Use all: true to see the full history.)`,
					);
				} else if (data.since_seq_used) {
					lines.push(`  entries: ${data.count} (since seq ${data.since_seq_used}; topic has ${data.total} total)`);
				} else {
					lines.push(`  entries: ${data.count} (all)`);
				}
				for (const e of data.entries) {
					const isCheckpoint = e.kind === "checkpoint" ? " [CHECKPOINT]" : "";
					lines.push(
						`    - [seq ${e.seq}] [${new Date(e.ts).toISOString()}] ${e.author} (${e.kind})${isCheckpoint}: ${JSON.stringify(e.body)} (id=${e.id})`,
					);
				}
				return lines.join("\n");
			});
		}),
	});

	// Tool: write_checkpoint(topic_id, body, mentions?, parent_entry?)
	pi.registerTool({
		name: "write_checkpoint",
		label: "Write Checkpoint",
		description:
			"Write a self-contained state snapshot of a topic. Checkpoints are the " +
				"agent's 'save game' — they let future turns see the current state of " +
				"the work without reading the full history. A checkpoint is a snapshot, " +
				"NOT a delta: reading one checkpoint + the entries after it should " +
				"reconstruct the work state. Recommended structure: '# Checkpoint N' " +
				"with sections 'Locked decisions', 'Current state', 'Open questions', " +
				"'Next action'. Checkpoints are self-service: no confirmation gate, " +
				"no author check. Body limit 16KB (same as posts). Cannot be added to " +
				"closed topics. After writing, future read_topic calls default to " +
				"returning this checkpoint + entries after it (tiered view).",
		parameters: Type.Object({
			topic_id: Type.String({
				description: "The topic id to checkpoint.",
				minLength: 1,
			}),
			body: Type.String({
				description:
					"The checkpoint body. Self-contained state snapshot. " +
						"Recommended sections: Locked decisions, Current state, " +
						"Open questions, Next action. Markdown is fine.",
				minLength: 1,
			}),
			mentions: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional agent names to ping. Use sparingly.",
				}),
			),
			parent_entry: Type.Optional(
				Type.String({
					description:
						"Optional entry id this checkpoint chains to. If set, the " +
							"checkpoint is a delta against the named entry. If unset, " +
							"the checkpoint is fully self-contained.",
				}),
			),
		}),
		execute: withBudget("write_checkpoint", async (_callId, params) => {
			return rpc("write_checkpoint", params, (data: any) => {
				return `checkpoint written: id=${data.id} seq=${data.seq} topic=${params.topic_id}. Future read_topic calls on this topic will return this checkpoint + entries after it (tiered view).`;
			});
		}),
	});

	// Tool: list_checkpoints(topic_id)
	pi.registerTool({
		name: "list_checkpoints",
		label: "List Checkpoints",
		description:
			"List all checkpoint headers in a topic, with a 200-char preview of " +
				"each body. Use this to navigate: see what checkpoints exist, then " +
				"call read_entry(id) for the full body of the one you want.",
		parameters: Type.Object({
			topic_id: Type.String({
				description: "The topic id to list checkpoints for.",
				minLength: 1,
			}),
		}),
		execute: withBudget("list_checkpoints", async (_callId, params) => {
			return rpc("list_checkpoints", params, (data: any) => {
				if (data.count === 0) {
					return `no checkpoints in topic ${data.topic_id}. (read_topic will return all entries.)`;
				}
				const lines: string[] = [];
				lines.push(`${data.count} checkpoint(s) in ${data.topic_id}:`);
				for (const c of data.checkpoints) {
					lines.push(`  - [${new Date(c.ts).toISOString()}] ${c.author}: ${c.preview} (id=${c.id})`);
				}
				return lines.join("\n");
			});
		}),
	});

	// Tool: add_to_topic(topic_id, agent_name)
	pi.registerTool({
		name: "add_to_topic",
		label: "Add to Topic",
		description:
			"Add an agent to a topic's involved list. The agent will then be able " +
				"to see the topic and its entries in their read_inbox. Idempotent: adding " +
				"an already-involved agent is a no-op.",
		parameters: Type.Object({
			topic_id: Type.String({
				description: "The topic id. Must match the naming convention.",
				minLength: 1,
			}),
			agent_name: Type.String({
				description: "The agent name to add to the topic's involved list.",
				minLength: 1,
			}),
		}),
		execute: withBudget("add_to_topic", async (_callId, params) => {
			return rpc("add_to_topic", params, (data: any) => {
				const verb = data.was_new ? "added" : "was already in";
				return `agent "${data.added}" ${verb} topic ${data.topic_id}; involved now: [${data.involved.join(", ")}]`;
			});
		}),
	});

	// Tool: remove_from_topic(topic_id, agent_name)
	pi.registerTool({
		name: "remove_from_topic",
		label: "Remove from Topic",
		description:
			"Remove an agent from a topic's involved list. The agent will no longer " +
				"see the topic in read_inbox. Idempotent: removing an agent who is not " +
				"involved is a no-op (returns was_involved=false).",
		parameters: Type.Object({
			topic_id: Type.String({ description: "The topic id.", minLength: 1 }),
			agent_name: Type.String({
				description: "The agent name to remove.",
				minLength: 1,
			}),
		}),
		execute: withBudget("remove_from_topic", async (_callId, params) => {
			return rpc("remove_from_topic", params, (data: any) => {
				const verb = data.was_involved ? "removed" : "was not in";
				return `agent "${data.removed}" ${verb} topic ${data.topic_id}; involved now: [${data.involved.join(", ")}]`;
			});
		}),
	});

	// Tool: read_inbox()
	pi.registerTool({
		name: "read_inbox",
		label: "Read Inbox",
		description:
			"Read all new entries across every topic you are involved in, since the " +
				"last time you called read_inbox. The cursor advances automatically so " +
				"the next call only returns entries you have not seen yet. Returns entries " +
				"grouped by topic, with topic metadata, entry count, and the new cursor value. " +
				"Each entry's body is returned as a `body_preview` (first 200 chars). For the " +
				"full body, call read_entry(id).",
		parameters: Type.Object({}),
		execute: withBudget("read_inbox", async (_callId, _params) => {
			return rpc("read_inbox", {}, (data: any) => {
				if (data.total_new === 0) {
					return `inbox: no new entries across ${data.topics.length} topic(s)`;
				}
				const lines: string[] = [];
				lines.push(`inbox for "${data.agent}": ${data.total_new} new entry/entries across ${data.topics.length} topic(s)`);
				for (const t of data.topics) {
					lines.push(
						`\n[topic ${t.topic.id} — ${t.topic.kind}, ${t.topic.status}] (cursor now at seq ${t.cursor_advanced_to})`,
					);
					lines.push(`  description: ${t.topic.description}`);
					for (const e of t.entries) {
						const body = e.body_truncated
							? `${e.body_preview} (truncated, use read_entry("${e.id}") for full body)`
							: e.body_preview;
						lines.push(
							`    - [${new Date(e.ts).toISOString()}] ${e.author} (${e.kind}): ${JSON.stringify(body)} (id=${e.id})`,
						);
					}
				}
				return lines.join("\n");
			});
		}),
	});

	// Tool: react(entry_id, reaction?)
	pi.registerTool({
		name: "react",
		label: "React to Entry",
		description:
			"Add a lightweight reaction to an existing entry (kind='react'). The reaction " +
				"is logged in the topic with the parent_entry pointing back. Reactions do NOT " +
				"trigger a notification to the parent author — they're silent. Use this for " +
				"quick acks ('ack', '+1', 'thumbs_up') without posting a full reply. The " +
				"parent author sees the reaction next time they read the topic.",
		parameters: Type.Object({
			entry_id: Type.String({ description: "The entry id to react to.", minLength: 1 }),
			reaction: Type.Optional(
				Type.String({
					description: "Short reaction string. Default 'ack' if omitted. Keep it under 32 chars.",
				}),
			),
		}),
		execute: withBudget("react", async (_callId, params) => {
			return rpc("react", { entry_id: params.entry_id, body: params.reaction }, (data: any) =>
				`reacted to ${data.parent_entry}: ${JSON.stringify(data.body)}`,
			);
		}),
	});

	// Tool: close_topic(topic_id)
	pi.registerTool({
		name: "close_topic",
		label: "Close Topic",
		description:
			"Mark a topic as closed (status='closed'). The topic remains in the log " +
				"and new entries can still be posted, but the closed status signals to other " +
				"agents that this conversation is no longer active. Only involved agents " +
				"can close a topic.",
		parameters: Type.Object({
			topic_id: Type.String({ description: "The topic id to close.", minLength: 1 }),
		}),
		execute: withBudget("close_topic", async (_callId, params) => {
			return rpc("close_topic", { topic_id: params.topic_id }, (data: any) =>
				`closed topic ${data.topic_id} (closed by ${data.closed_by})`,
			);
		}),
	});

	// Tool: search_topics(query)
	pi.registerTool({
		name: "search_topics",
		label: "Search Topics",
		description:
			"Search topics by query. Matches against topic id, name, and description " +
				"(case-insensitive substring). Returns up to 20 topics, sorted by most " +
				"recently active. Use this for discovery when you don't know the exact " +
				"topic id.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query string.", minLength: 1 }),
		}),
		execute: withBudget("search_topics", async (_callId, params) => {
			return rpc("search_topics", { query: params.query }, (data: any) => {
				if (data.count === 0) return `no topics match "${data.query}"`;
				const lines: string[] = [];
				lines.push(`search for "${data.query}": ${data.count} match(es)`);
				for (const t of data.topics) {
					lines.push(`  ${t.id} (${t.kind}, ${t.status}): ${t.description}`);
				}
				return lines.join("\n");
			});
		}),
	});
}
