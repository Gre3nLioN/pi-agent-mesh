/**
 * Orchestrator's control server.
 *
 * Listens on a Unix socket. The peer extension connects to it from
 * inside each spawned agent process to call tools (post, read_inbox,
 * etc.). The server is the only writer to the scratchpad.
 *
 * Stage 2: handles `post`.
 * Stage 3: adds `create_topic`, `read_entry`, `read_topic`.
 */

import { createServer, connect, type Server, type Socket } from "node:net";
import { unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Database as DB } from "better-sqlite3";

export type ControlServerOptions = {
	socketPath: string;
	db: DB;
	/** Called when a post lands, so the orchestrator can notify peers (stage 5+). */
	onPost?: (entry: EntryRow) => void;
	/** Called when a peer extension reports a tool-budget hit. */
	onBudgetHit?: (info: { author: string; tool: string; calls: number; budget: number }) => void;
	/**
	 * Called for any RPC with `type` starting with `admin_`. The
	 * orchestrator handles the actual logic (list, get, inject,
	 * shutdown). Returns `{ ok, data, error }`.
	 */
	onAdminCommand?: (req: any) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
};

export type OrchestratorEvent = {
	kind: "post" | "confirmation" | "react" | "agent_event" | "shutdown" | "info";
	ts: number;
	[key: string]: unknown;
};

export type EntryRow = {
	id: string;
	ts: number;
	topic_id: string;
	author: string;
	kind: string;
	body: string;
	parent_entry: string | null;
	mentions: string;
	requires_confirmation_from: string;
};

export type TopicRow = {
	id: string;
	name: string | null;
	description: string;
	kind: string;
	status: string;
	created_by: string;
	created_at: number;
	last_activity_at: number;
	notify_on_post: number;
};

const TOPIC_ID_RE = /^[a-z][a-z0-9-]*-[a-z][a-z0-9-]*-[a-z0-9]{2,8}$/;
const VALID_KINDS = new Set(["chat", "task", "decision", "handoff"]);

/**
 * Maximum size of an entry body, in bytes. ~4K tokens / ~16K characters.
 * Bodies larger than this are rejected to prevent a malicious or buggy
 * peer from filling the DB and blowing up LLM context when read_topic
 * returns them.
 */
const MAX_BODY_BYTES = 16 * 1024;

export class ControlServer {
	private server: Server | null = null;
	private sockets = new Set<Socket>();

	constructor(private opts: ControlServerOptions) {}

	async start(): Promise<void> {
		// If a socket file already exists, decide whether it's live (refuse
		// to clobber) or stale (unlink and rebind, the crash-recovery path).
		if (existsSync(this.opts.socketPath)) {
			const alive = await this.probeSocket();
			if (alive) {
				throw new Error(
					`mesh already running in this data dir (socket in use: ${this.opts.socketPath}). ` +
						`Run \`mesh stop\` to shut it down, or use a different --data-dir.`,
				);
			}
			try {
				unlinkSync(this.opts.socketPath);
			} catch {
				// ignore — listen() will produce a clearer error
			}
		}

		await new Promise<void>((resolve, reject) => {
			this.server = createServer((sock) => this.handleConnection(sock));
			this.server.once("error", reject);
			this.server.listen(this.opts.socketPath, () => {
				this.server?.off("error", reject);
				resolve();
			});
		});
	}

	/**
	 * Probe whether an orchestrator is actively listening on the
	 * socket path. Returns true on a successful connect within 200ms.
	 * Used to distinguish a live orchestrator (refuse to clobber) from
	 * a stale socket file left over from a hard crash (safe to unlink).
	 */
	private probeSocket(): Promise<boolean> {
		return new Promise((resolve) => {
			const sock = connect(this.opts.socketPath);
			const timer = setTimeout(() => {
				sock.destroy();
				resolve(false);
			}, 200);
			sock.on("connect", () => {
				clearTimeout(timer);
				sock.end();
				resolve(true);
			});
			sock.on("error", () => {
				clearTimeout(timer);
				resolve(false);
			});
		});
	}

	private handleConnection(sock: Socket): void {
		this.sockets.add(sock);
		sock.on("close", () => this.sockets.delete(sock));
		sock.on("error", () => this.sockets.delete(sock));

		// Tag the socket with metadata. Used by pushEvent to know
		// whether to write to this socket (only if subscribed).
		(sock as any).__isSubscriber = false;

		let buf = "";
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let idx: number;
			while ((idx = buf.indexOf("\n")) !== -1) {
				const raw = buf.slice(0, idx);
				buf = buf.slice(idx + 1);
				const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
				if (line.length > 0) this.handleRequest(sock, line);
			}
		});
	}

	private handleRequest(sock: Socket, line: string): void {
		let req: any;
		try {
			req = JSON.parse(line);
		} catch (e: any) {
			this.reply(sock, { ok: false, error: `bad request JSON: ${e.message}` });
			return;
		}

		// admin_subscribe_events is special: it tags the calling socket
		// for event streaming. Handle it here, not in the orchestrator.
		if (req.type === "admin_subscribe_events") {
			const reply = this.handleSubscribe(sock);
			this.reply(sock, reply);
			return;
		}
		this.dispatch(req)
			.then((reply) => this.reply(sock, reply))
			.catch((err) =>
				this.reply(sock, { ok: false, error: err instanceof Error ? err.message : String(err) }),
			);
	}

	private reply(sock: Socket, msg: unknown): void {
		if (sock.writable) sock.write(JSON.stringify(msg) + "\n");
	}

	private async dispatch(req: any): Promise<{ ok: boolean; data?: unknown; error?: string }> {
		switch (req.type) {
			case "ping":
				return { ok: true, data: { pong: Date.now() } };
			case "post":
				return this.handlePost(req);
			case "confirm":
				return this.handleConfirm(req);
			case "create_topic":
				return this.handleCreateTopic(req);
			case "read_entry":
				return this.handleReadEntry(req);
			case "read_topic":
				return this.handleReadTopic(req);
			case "write_checkpoint":
				return this.handleWriteCheckpoint(req);
			case "list_checkpoints":
				return this.handleListCheckpoints(req);
			case "add_to_topic":
				return this.handleAddToTopic(req);
			case "remove_from_topic":
				return this.handleRemoveFromTopic(req);
			case "read_inbox":
				return this.handleReadInbox(req);
			case "react":
				return this.handleReact(req);
			case "close_topic":
				return this.handleCloseTopic(req);
			case "search_topics":
				return this.handleSearchTopics(req);
			case "budget_hit":
				return this.handleBudgetHit(req);
			default:
				// Admin commands: type starts with "admin_". Hand them to the
				// orchestrator via the onAdminCommand callback.
				if (typeof req.type === "string" && req.type.startsWith("admin_")) {
					if (!this.opts.onAdminCommand) {
						return { ok: false, error: "admin commands not supported" };
					}
					return this.opts.onAdminCommand(req);
				}
				return { ok: false, error: `unknown request type: ${req.type}` };
		}
	}

	private handlePost(req: any): { ok: boolean; data?: unknown; error?: string } {
		const { topic_id, body, author, mentions, requires_confirmation_from, kind: rawKind } = req;

		// Default kind to 'post'. Only 'post' and 'handoff' are accepted here;
		// other kinds (react, confirmation, summary, handoff, checkpoint) have
		// their own RPCs/tools.
		const kind: "post" | "handoff" = rawKind === "handoff" ? "handoff" : "post";
		if (rawKind !== undefined && rawKind !== "post" && rawKind !== "handoff") {
			return { ok: false, error: `kind "${rawKind}" is not valid for the post tool; use 'post' or 'handoff'` };
		}

		// Validate.
		if (typeof topic_id !== "string" || topic_id.length === 0) {
			return { ok: false, error: "topic_id is required" };
		}
		if (typeof body !== "string" || body.length === 0) {
			return { ok: false, error: "body is required" };
		}
		if (typeof author !== "string" || author.length === 0) {
			return { ok: false, error: "author is required" };
		}
		// Byte-size check (UTF-8 encoded length).
		const bodyBytes = Buffer.byteLength(body, "utf8");
		if (bodyBytes > MAX_BODY_BYTES) {
			return {
				ok: false,
				error: `body too large: ${bodyBytes} bytes (max ${MAX_BODY_BYTES} bytes / ~${Math.floor(MAX_BODY_BYTES / 4)} tokens)`,
			};
		}
		if (!TOPIC_ID_RE.test(topic_id)) {
			return {
				ok: false,
				error: `topic_id "${topic_id}" does not match the convention <domain>-<action>-<short>`,
			};
		}

		// Validate mentions.
		let mentionsJson = "[]";
		if (mentions !== undefined) {
			if (!Array.isArray(mentions) || mentions.some((m) => typeof m !== "string" || m.length === 0)) {
				return { ok: false, error: "mentions must be an array of non-empty strings" };
			}
			mentionsJson = JSON.stringify(mentions);
		}

		// Validate requires_confirmation_from.
		let confJson = "[]";
		let requiredAgents: string[] = [];
		if (requires_confirmation_from !== undefined) {
			if (
				!Array.isArray(requires_confirmation_from) ||
				requires_confirmation_from.some((a) => typeof a !== "string" || a.length === 0)
			) {
				return { ok: false, error: "requires_confirmation_from must be an array of non-empty strings" };
			}
			requiredAgents = requires_confirmation_from as string[];
			confJson = JSON.stringify(requiredAgents);
		}

		// Validate handoff convention (kind='handoff' only).
		// The body must start with `to: <agent_name>` and the named agent
		// must be in the topic's `topic_involved` list. See design § D1–D4.
		if (kind === "handoff") {
			const toMatch = body.match(/^to:\s*(\S+)/m);
			if (!toMatch) {
				return {
					ok: false,
					error: "kind='handoff' requires a 'to: <agent_name>' line in the body",
				};
			}
			const toAgent = toMatch[1];
			// The topic must exist (it might be auto-created below, but for
			// handoffs we require the topic to already exist with the target
			// involved). If the topic doesn't exist yet, the `to:` agent
			// can't be in its involved list, so reject.
			const involvedRows = this.opts.db
				.prepare(
					"SELECT agent_name FROM topic_involved WHERE topic_id = ? ORDER BY agent_name",
				)
				.all(topic_id) as Array<{ agent_name: string }>;
			if (involvedRows.length === 0) {
				return {
					ok: false,
					error: `handoff 'to: ${toAgent}' rejected: topic "${topic_id}" does not exist or has no involved agents; create the topic and add ${toAgent} via add_to_topic first`,
				};
			}
			const involved = involvedRows.map((r) => r.agent_name);
			if (!involved.includes(toAgent)) {
				return {
					ok: false,
					error: `handoff 'to: ${toAgent}' is not an involved agent in topic "${topic_id}"`,
					data: { involved_agents: involved },
				};
			}
		}

		const db = this.opts.db;
		const now = Date.now();
		const id = randomUUID();
		const ts = now;

		// Ensure the topic exists. Auto-create on first post (pre-stage-3 behavior).
		const existing = db.prepare("SELECT id FROM topics WHERE id = ?").get(topic_id);
		if (!existing) {
			db.prepare(
				`INSERT INTO topics (id, name, description, kind, status, created_by, created_at, last_activity_at, notify_on_post)
				 VALUES (?, NULL, ?, 'chat', 'active', ?, ?, ?, 0)`,
			).run(topic_id, "(auto-created on first post)", author, ts, ts);
			db.prepare(
				`INSERT INTO topic_involved (topic_id, agent_name) VALUES (?, ?)`,
			).run(topic_id, author);
		} else {
			db.prepare(
				"UPDATE topics SET last_activity_at = ? WHERE id = ?",
			).run(ts, topic_id);
			// Make sure the author is in the involved list.
			const memberOf = db
				.prepare("SELECT 1 FROM topic_involved WHERE topic_id = ? AND agent_name = ?")
				.get(topic_id, author);
			if (!memberOf) {
				db.prepare(
					"INSERT INTO topic_involved (topic_id, agent_name) VALUES (?, ?)",
				).run(topic_id, author);
			}
		}

		// Insert the entry. `seq` is auto-filled by SQLite.
		const info = db
			.prepare(
				`INSERT INTO entries (id, ts, topic_id, author, kind, body, parent_entry, mentions, requires_confirmation_from)
				 VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
			)
			.run(id, ts, topic_id, author, kind, body, mentionsJson, confJson);
		const seq = Number(info.lastInsertRowid);

		const entry: EntryRow = {
			id,
			ts,
			topic_id,
			author,
			kind,
			body,
			parent_entry: null,
			mentions: mentionsJson,
			requires_confirmation_from: confJson,
		};

		// Register pending confirmations.
		for (const agent of requiredAgents) {
			db.prepare(
				`INSERT INTO pending_confirmations (entry_id, required_agent, status, confirmed_at)
				 VALUES (?, ?, 'pending', NULL)
				 ON CONFLICT (entry_id, required_agent) DO UPDATE SET status = 'pending', confirmed_at = NULL`,
			).run(id, agent);
		}

		this.opts.onPost?.(entry);

		return {
			ok: true,
			data: {
				id,
				ts,
				seq,
				confirmation: requiredAgents.length > 0
					? { total: requiredAgents.length, required: requiredAgents }
					: undefined,
			},
		};
	}

	private handleConfirm(req: any): { ok: boolean; data?: unknown; error?: string } {
		const { entry_id, author, body } = req;

		if (typeof entry_id !== "string" || entry_id.length === 0) {
			return { ok: false, error: "entry_id is required" };
		}
		if (typeof author !== "string" || author.length === 0) {
			return { ok: false, error: "author is required" };
		}

		const db = this.opts.db;

		// Find the parent entry.
		const parent = db
			.prepare(
				`SELECT id, ts, topic_id, author, kind, body, parent_entry, mentions, requires_confirmation_from
				 FROM entries WHERE id = ?`,
			)
			.get(entry_id) as EntryRow | undefined;
		if (!parent) {
			return { ok: false, error: `entry "${entry_id}" not found` };
		}
		if (parent.kind !== "post") {
			return { ok: false, error: `entry "${entry_id}" is a ${parent.kind}, not a post; only posts can be confirmed` };
		}

		// Parse the parent's required-confirmation list.
		let required: string[];
		try {
			required = JSON.parse(parent.requires_confirmation_from || "[]") as string[];
		} catch {
			required = [];
		}
		if (required.length === 0) {
			return { ok: false, error: `entry "${entry_id}" does not require any confirmations` };
		}
		if (!required.includes(author)) {
			return {
				ok: false,
				error: `agent "${author}" is not in the confirmation list for entry "${entry_id}"; required: [${required.join(", ")}]`,
			};
		}

		// Idempotent insert/update: mark (entry_id, author) as confirmed.
		const now = Date.now();
		db.prepare(
			`INSERT INTO pending_confirmations (entry_id, required_agent, status, confirmed_at)
			 VALUES (?, ?, 'confirmed', ?)
			 ON CONFLICT (entry_id, required_agent) DO UPDATE SET status = 'confirmed', confirmed_at = excluded.confirmed_at`,
		).run(entry_id, author, now);

		// Insert the confirmation entry. Use a new id; child entries get their own seq.
		const id = randomUUID();
		const ts = now;
		const confirmationBody = body && body.length > 0 ? body : "ack";
		const info = db
			.prepare(
				`INSERT INTO entries (id, ts, topic_id, author, kind, body, parent_entry, mentions, requires_confirmation_from)
				 VALUES (?, ?, ?, ?, 'confirmation', ?, ?, '[]', '[]')`,
			)
			.run(id, ts, parent.topic_id, author, confirmationBody, entry_id);
		const seq = Number(info.lastInsertRowid);

		// Compute the new state for the response.
		const allPending = db
			.prepare(
				`SELECT required_agent, status FROM pending_confirmations WHERE entry_id = ?`,
			)
			.all(entry_id) as Array<{ required_agent: string; status: string }>;
		const total = allPending.length;
		const confirmed = allPending.filter((r) => r.status === "confirmed").length;
		const confirmed_list = allPending.filter((r) => r.status === "confirmed").map((r) => r.required_agent);
		const waiting_list = allPending.filter((r) => r.status === "pending").map((r) => r.required_agent);

		const entry: EntryRow = {
			id,
			ts,
			topic_id: parent.topic_id,
			author,
			kind: "confirmation",
			body: confirmationBody,
			parent_entry: entry_id,
			mentions: "[]",
			requires_confirmation_from: "[]",
		};

		this.opts.onPost?.(entry);

		return {
			ok: true,
			data: {
				id,
				ts,
				seq,
				confirmation: {
					total_required: total,
					confirmed_count: confirmed,
					confirmed: confirmed_list,
					waiting: waiting_list,
					fully_confirmed: confirmed === total,
				},
			},
		};
	}

	private handleCreateTopic(req: any): { ok: boolean; data?: unknown; error?: string } {
		const { topic_id, name, description, kind, initial_involved, author, notify_on_post } = req;
		// The peer extension's rpc() helper always sends `author`; the DB column
		// for the topic creator is `created_by`, so we map author → created_by.
		const created_by = author;

		// Validate topic_id.
		if (typeof topic_id !== "string" || topic_id.length === 0) {
			return { ok: false, error: "topic_id is required" };
		}
		if (!TOPIC_ID_RE.test(topic_id)) {
			return {
				ok: false,
				error: `topic_id "${topic_id}" does not match the convention <domain>-<action>-<short>`,
			};
		}

		// Validate description.
		if (typeof description !== "string" || description.trim().length === 0) {
			return { ok: false, error: "description is required (one-line summary for discovery)" };
		}

		// Validate kind.
		const topicKind = kind ?? "chat";
		if (typeof topicKind !== "string" || !VALID_KINDS.has(topicKind)) {
			return {
				ok: false,
				error: `kind must be one of: ${[...VALID_KINDS].join(", ")} (got "${topicKind}")`,
			};
		}

		// Validate name (optional).
		if (name !== undefined && (typeof name !== "string" || name.length === 0)) {
			return { ok: false, error: "name must be a non-empty string when provided" };
		}

		// Validate initial_involved (optional, defaults to [created_by]).
		let involved: string[];
		if (initial_involved === undefined) {
			involved = [created_by];
		} else if (!Array.isArray(initial_involved)) {
			return { ok: false, error: "initial_involved must be an array of agent names" };
		} else if (initial_involved.some((a) => typeof a !== "string" || a.length === 0)) {
			return { ok: false, error: "initial_involved entries must be non-empty strings" };
		} else {
			involved = initial_involved as string[];
		}

		// Validate notify_on_post (optional, default false).
		let notifyFlag = 0;
		if (notify_on_post !== undefined) {
			if (typeof notify_on_post !== "boolean") {
				return { ok: false, error: "notify_on_post must be a boolean" };
			}
			notifyFlag = notify_on_post ? 1 : 0;
		}

		// created_by is required (the author of the create call).
		if (typeof created_by !== "string" || created_by.length === 0) {
			return { ok: false, error: "author (created_by) is required \u2014 the agent creating the topic" };
		}

		const db = this.opts.db;
		const now = Date.now();

		// Reject if topic already exists.
		const existing = db.prepare("SELECT id FROM topics WHERE id = ?").get(topic_id);
		if (existing) {
			return { ok: false, error: `topic "${topic_id}" already exists` };
		}

		// Create topic row.
		db.prepare(
			`INSERT INTO topics (id, name, description, kind, status, created_by, created_at, last_activity_at, notify_on_post)
			 VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
		).run(topic_id, name ?? null, description.trim(), topicKind, created_by, now, now, notifyFlag);

		// Add involved agents. Always include created_by even if not in the list.
		const involvedSet = new Set(involved);
		involvedSet.add(created_by);
		const insertInvolved = db.prepare(
			"INSERT INTO topic_involved (topic_id, agent_name) VALUES (?, ?)",
		);
		for (const agent of involvedSet) {
			insertInvolved.run(topic_id, agent);
		}

		const topic: TopicRow = {
			id: topic_id,
			name: name ?? null,
			description: description.trim(),
			kind: topicKind,
			status: "open",
			created_by,
			created_at: now,
			last_activity_at: now,
			notify_on_post: notifyFlag,
		};

		return {
			ok: true,
			data: {
				topic,
				involved: [...involvedSet],
			},
		};
	}

	private handleReadEntry(req: any): { ok: boolean; data?: unknown; error?: string } {
		const { id } = req;
		if (typeof id !== "string" || id.length === 0) {
			return { ok: false, error: "id is required" };
		}
		const row = this.opts.db
			.prepare(
				`SELECT id, ts, topic_id, author, kind, body, parent_entry, mentions, requires_confirmation_from
				 FROM entries WHERE id = ?`,
			)
			.get(id) as EntryRow | undefined;
		if (!row) {
			return { ok: false, error: `entry "${id}" not found` };
		}
		return { ok: true, data: { entry: row } };
	}

	private handleReadTopic(req: any): { ok: boolean; data?: unknown; error?: string } {
		const { topic_id, since_seq, all, from_checkpoint } = req;

		if (typeof topic_id !== "string" || topic_id.length === 0) {
			return { ok: false, error: "topic_id is required" };
		}

		const db = this.opts.db;
		const topic = db
			.prepare("SELECT * FROM topics WHERE id = ?")
			.get(topic_id) as TopicRow | undefined;
		if (!topic) {
			return { ok: false, error: `topic "${topic_id}" not found` };
		}

		// since_seq is optional. If provided, return only entries with seq > since_seq.
		// `all` is optional — if true, return all entries (escape hatch for the
		// tiered default; the agent opts in to the full history when needed).
		// `from_checkpoint` is optional — if provided, return that checkpoint +
		// entries after it (read a specific snapshot, not just the latest).
		const minSeq = typeof since_seq === "number" ? since_seq : 0;
		const wantAll = all === true;
		let checkpointSeq: number | null = null;

		if (!wantAll && since_seq === undefined) {
			if (typeof from_checkpoint === "string" && from_checkpoint.length > 0) {
				// Look up the seq of the named checkpoint.
				const row = db
					.prepare("SELECT seq FROM entries WHERE id = ? AND topic_id = ? AND kind = 'checkpoint'")
					.get(from_checkpoint, topic_id) as { seq: number } | undefined;
				if (!row) {
					return { ok: false, error: `checkpoint "${from_checkpoint}" not found in topic "${topic_id}"` };
				}
				checkpointSeq = row.seq;
			} else {
				// Tiered default: find the most recent checkpoint in the topic.
				const row = db
					.prepare("SELECT seq FROM entries WHERE topic_id = ? AND kind = 'checkpoint' ORDER BY seq DESC LIMIT 1")
					.get(topic_id) as { seq: number } | undefined;
				if (row) checkpointSeq = row.seq;
			}
		}

		// Decide the actual minSeq to use.
		let effectiveMinSeq: number;
		if (wantAll) {
			effectiveMinSeq = 0;
		} else if (checkpointSeq !== null) {
			effectiveMinSeq = checkpointSeq; // include the checkpoint itself
		} else {
			effectiveMinSeq = minSeq;
		}

		const entries = db
			.prepare(
				`SELECT id, ts, topic_id, author, kind, body, parent_entry, mentions, requires_confirmation_from
				 FROM entries WHERE topic_id = ? AND seq >= ? ORDER BY seq ASC`,
			)
			.all(topic_id, effectiveMinSeq) as EntryRow[];

		const involved = (
			db
				.prepare("SELECT agent_name FROM topic_involved WHERE topic_id = ? ORDER BY agent_name")
				.all(topic_id) as Array<{ agent_name: string }>
		).map((r) => r.agent_name);

		// Total entry count for the topic — useful context for the agent
		// to know "there are 30 entries total, this view shows 8".
		const totalRow = db
			.prepare("SELECT COUNT(*) AS c FROM entries WHERE topic_id = ?")
			.get(topic_id) as { c: number };

		return {
			ok: true,
			data: {
				topic,
				involved,
				entries,
				count: entries.length,
				total: totalRow.c,
				since_seq_used: minSeq,
				tiered: !wantAll && since_seq === undefined,
				checkpoint_seq_used: checkpointSeq,
			},
		};
	}

	private handleAddToTopic(req: any): { ok: boolean; data?: unknown; error?: string } {
		const { topic_id, agent_name, author } = req;
		// `author` is the caller (for audit); `agent_name` is who to add.

		if (typeof topic_id !== "string" || topic_id.length === 0) {
			return { ok: false, error: "topic_id is required" };
		}
		if (typeof agent_name !== "string" || agent_name.length === 0) {
			return { ok: false, error: "agent_name is required" };
		}
		if (typeof author !== "string" || author.length === 0) {
			return { ok: false, error: "author is required" };
		}
		if (!TOPIC_ID_RE.test(topic_id)) {
			return {
				ok: false,
				error: `topic_id "${topic_id}" does not match the convention <domain>-<action>-<short>`,
			};
		}

		const db = this.opts.db;
		const topic = db.prepare("SELECT id FROM topics WHERE id = ?").get(topic_id);
		if (!topic) {
			return { ok: false, error: `topic "${topic_id}" not found` };
		}

		// Idempotent: insert with ON CONFLICT DO NOTHING.
		db.prepare(
			`INSERT INTO topic_involved (topic_id, agent_name) VALUES (?, ?)
			 ON CONFLICT (topic_id, agent_name) DO NOTHING`,
		).run(topic_id, agent_name);

		// Reset the new agent's cursor for this topic so they can read all entries
		// from the beginning. (Otherwise the cursor default 0 is correct, so this
		// is a no-op for new agents — but explicit is fine.)
		db.prepare(
			`INSERT INTO cursors (agent_name, topic_id, last_read_seq) VALUES (?, ?, 0)
			 ON CONFLICT (agent_name, topic_id) DO NOTHING`,
		).run(agent_name, topic_id);

		const involved = (
			db
				.prepare("SELECT agent_name FROM topic_involved WHERE topic_id = ? ORDER BY agent_name")
				.all(topic_id) as Array<{ agent_name: string }>
		).map((r) => r.agent_name);

		return {
			ok: true,
			data: {
				topic_id,
				added: agent_name,
				involved,
				added_by: author,
			},
		};
	}

	private handleRemoveFromTopic(req: any): { ok: boolean; data?: unknown; error?: string } {
		const { topic_id, agent_name, author } = req;

		if (typeof topic_id !== "string" || topic_id.length === 0) {
			return { ok: false, error: "topic_id is required" };
		}
		if (typeof agent_name !== "string" || agent_name.length === 0) {
			return { ok: false, error: "agent_name is required" };
		}
		if (typeof author !== "string" || author.length === 0) {
			return { ok: false, error: "author is required" };
		}
		if (!TOPIC_ID_RE.test(topic_id)) {
			return {
				ok: false,
				error: `topic_id "${topic_id}" does not match the convention <domain>-<action>-<short>`,
			};
		}

		const db = this.opts.db;
		const result = db
			.prepare("DELETE FROM topic_involved WHERE topic_id = ? AND agent_name = ?")
			.run(topic_id, agent_name);

		// Also remove their cursor for this topic so a re-add sees all entries from the start.
		db.prepare("DELETE FROM cursors WHERE agent_name = ? AND topic_id = ?").run(
			agent_name,
			topic_id,
		);

		const involved = (
			db
				.prepare("SELECT agent_name FROM topic_involved WHERE topic_id = ? ORDER BY agent_name")
				.all(topic_id) as Array<{ agent_name: string }>
		).map((r) => r.agent_name);

		return {
			ok: true,
			data: {
				topic_id,
				removed: agent_name,
				involved,
				removed_by: author,
				was_involved: result.changes > 0,
			},
		};
	}

	/**
	 * Public so the orchestrator can call this from the admin command path
	 * (e.g. `mesh checkpoint`). Returns the same shape as the wire-level RPC.
	 */
	public handleWriteCheckpoint(req: any): { ok: boolean; data?: unknown; error?: string } {
		const { topic_id, body, author, mentions, parent_entry } = req;

		// Validate.
		if (typeof topic_id !== "string" || topic_id.length === 0) {
			return { ok: false, error: "topic_id is required" };
		}
		if (typeof body !== "string" || body.length === 0) {
			return { ok: false, error: "body is required" };
		}
		if (typeof author !== "string" || author.length === 0) {
			return { ok: false, error: "author is required" };
		}
		// Byte-size check.
		const bodyBytes = Buffer.byteLength(body, "utf8");
		if (bodyBytes > MAX_BODY_BYTES) {
			return {
				ok: false,
				error: `body too large: ${bodyBytes} bytes (max ${MAX_BODY_BYTES} bytes / ~${Math.floor(MAX_BODY_BYTES / 4)} tokens)`,
			};
		}
		if (!TOPIC_ID_RE.test(topic_id)) {
			return {
				ok: false,
				error: `topic_id "${topic_id}" does not match the convention <domain>-<action>-<short>`,
			};
		}

		// Checkpoints are self-service: no requires_confirmation_from.
		// The wire-level RPC doesn't accept it, but be defensive.

		// Validate mentions.
		let mentionsJson = "[]";
		if (mentions !== undefined) {
			if (!Array.isArray(mentions) || mentions.some((m) => typeof m !== "string" || m.length === 0)) {
				return { ok: false, error: "mentions must be an array of non-empty strings" };
			}
			mentionsJson = JSON.stringify(mentions);
		}

		// Validate parent_entry if provided.
		if (parent_entry !== undefined && parent_entry !== null) {
			if (typeof parent_entry !== "string" || parent_entry.length === 0) {
				return { ok: false, error: "parent_entry must be a non-empty string if provided" };
			}
		}

		const db = this.opts.db;
		const topic = db.prepare("SELECT id, status FROM topics WHERE id = ?").get(topic_id) as
			| { id: string; status: string }
			| undefined;
		if (!topic) {
			return { ok: false, error: `topic "${topic_id}" not found` };
		}
		if (topic.status === "closed") {
			return { ok: false, error: `topic "${topic_id}" is closed; checkpoints cannot be added to closed topics` };
		}

		const now = Date.now();
		const id = randomUUID();
		const ts = now;

		// Insert the checkpoint entry. The kind is 'checkpoint'.
		// requires_confirmation_from is always '[]' (self-service).
		const info = db
			.prepare(
				`INSERT INTO entries (id, ts, topic_id, author, kind, body, parent_entry, mentions, requires_confirmation_from)
				 VALUES (?, ?, ?, ?, 'checkpoint', ?, ?, ?, '[]')`,
			)
			.run(id, ts, topic_id, author, body, parent_entry ?? null, mentionsJson);
		const seq = Number(info.lastInsertRowid);

		// Bump topic's last_activity_at.
		db.prepare("UPDATE topics SET last_activity_at = ? WHERE id = ?").run(ts, topic_id);

		// Make sure the author is in the involved list.
		const memberOf = db
			.prepare("SELECT 1 FROM topic_involved WHERE topic_id = ? AND agent_name = ?")
			.get(topic_id, author);
		if (!memberOf) {
			db.prepare("INSERT INTO topic_involved (topic_id, agent_name) VALUES (?, ?)").run(topic_id, author);
		}

		const entry: EntryRow = {
			id,
			ts,
			topic_id,
			author,
			kind: "checkpoint",
			body,
			parent_entry: parent_entry ?? null,
			mentions: mentionsJson,
			requires_confirmation_from: "[]",
		};

		this.opts.onPost?.(entry);

		return {
			ok: true,
			data: {
				id,
				ts,
				seq,
				kind: "checkpoint",
			},
		};
	}

	private handleListCheckpoints(req: any): { ok: boolean; data?: unknown; error?: string } {
		const { topic_id } = req;

		if (typeof topic_id !== "string" || topic_id.length === 0) {
			return { ok: false, error: "topic_id is required" };
		}

		const db = this.opts.db;
		const topic = db.prepare("SELECT id FROM topics WHERE id = ?").get(topic_id);
		if (!topic) {
			return { ok: false, error: `topic "${topic_id}" not found` };
		}

		// Get just the checkpoint headers, with a 200-char preview of the body.
		// The agent uses this to navigate: "which checkpoints exist?" then
		// calls read_entry(id) for the full body of the one it wants.
		const rows = db
			.prepare(
				`SELECT id, ts, topic_id, author, kind, body
				 FROM entries WHERE topic_id = ? AND kind = 'checkpoint' ORDER BY seq ASC`,
			)
			.all(topic_id) as Array<{
				id: string;
				ts: number;
				topic_id: string;
				author: string;
				kind: string;
				body: string;
			}>;

		const checkpoints = rows.map((r) => ({
			id: r.id,
			ts: r.ts,
			topic_id: r.topic_id,
			author: r.author,
			preview: r.body.length > 200 ? r.body.slice(0, 200) + "..." : r.body,
		}));

		return {
			ok: true,
			data: {
				topic_id,
				count: checkpoints.length,
				checkpoints,
			},
		};
	}

	private handleReadInbox(req: any): { ok: boolean; data?: unknown; error?: string } {
		const { author } = req;
		if (typeof author !== "string" || author.length === 0) {
			return { ok: false, error: "author is required" };
		}

		const db = this.opts.db;

		// Topics this agent is involved in.
		const topics = db
			.prepare(
				"SELECT topic_id FROM topic_involved WHERE agent_name = ? ORDER BY topic_id",
			)
			.all(author) as Array<{ topic_id: string }>;

		if (topics.length === 0) {
			return { ok: true, data: { topics: [], total_new: 0, agent: author } };
		}

		// Run all the per-topic reads + cursor advances in a single transaction.
		const readTopic = db.prepare(
			`SELECT id, ts, topic_id, author, kind, body, parent_entry, mentions, requires_confirmation_from
			 FROM entries WHERE topic_id = ? AND seq > ? ORDER BY seq ASC`,
		);
		const getCursor = db.prepare(
			"SELECT last_read_seq FROM cursors WHERE agent_name = ? AND topic_id = ?",
		);
		const upsertCursor = db.prepare(
			`INSERT INTO cursors (agent_name, topic_id, last_read_seq) VALUES (?, ?, ?)
			 ON CONFLICT (agent_name, topic_id) DO UPDATE SET last_read_seq = MAX(last_read_seq, excluded.last_read_seq)`,
		);
		const getTopic = db.prepare("SELECT * FROM topics WHERE id = ?");

		// Stage 8: return SUMMARIES (first 200 chars) of entry bodies, not
		// full bodies. The LLM can call read_entry(id) for the full body if
		// it actually needs it. Big context saver when there are many new
		// entries in the inbox.
		const SUMMARY_BODY_BYTES = 200;
		const truncateBody = (body: string): string => {
			const flat = body.replace(/\n/g, " ");
			if (Buffer.byteLength(flat, "utf8") <= SUMMARY_BODY_BYTES) return flat;
			let i = SUMMARY_BODY_BYTES;
			while (i > 0 && (flat.charCodeAt(i) & 0xc0) === 0x80) i--; // don't split UTF-8
			return flat.slice(0, i) + "...";
		};

		const out: Array<{
			topic: TopicRow;
			entries: Array<Omit<EntryRow, "body"> & { body_preview: string; body_truncated: boolean }>;
			new_count: number;
			cursor_advanced_to: number;
		}> = [];
		let totalNew = 0;

		const tx = db.transaction(() => {
			for (const { topic_id } of topics) {
				const cursor = getCursor.get(author, topic_id) as
					| { last_read_seq: number }
					| undefined;
				const lastSeq = cursor?.last_read_seq ?? 0;
				const entries = readTopic.all(topic_id, lastSeq) as EntryRow[];

				if (entries.length === 0) continue;

				const topic = getTopic.get(topic_id) as TopicRow | undefined;
				if (!topic) continue;

				// Pull the max seq explicitly since EntryRow doesn't include it.
				const maxSeqRow = db
					.prepare(
						"SELECT MAX(seq) AS m FROM entries WHERE topic_id = ? AND seq > ?",
					)
					.get(topic_id, lastSeq) as { m: number | null };
				const newCursor = maxSeqRow.m ?? lastSeq;

				upsertCursor.run(author, topic_id, newCursor);

				// Replace full `body` with `body_preview` + `body_truncated` to
				// keep the LLM context bounded. Full body is in the DB.
				const summaryEntries = entries.map((e) => {
					const fullBody = e.body ?? "";
					const preview = truncateBody(fullBody);
					const { body: _drop, ...rest } = e;
					return {
						...rest,
						body_preview: preview,
						body_truncated: preview !== fullBody,
					};
				});

				out.push({
					topic,
					entries: summaryEntries,
					new_count: entries.length,
					cursor_advanced_to: newCursor,
				});
				totalNew += entries.length;
			}
		});
		tx();

		return {
			ok: true,
			data: {
				agent: author,
				topics: out,
				total_new: totalNew,
			},
		};
	}

	private handleReact(req: any): { ok: boolean; data?: unknown; error?: string } {
		const { entry_id, author, body } = req;
		if (typeof entry_id !== "string" || entry_id.length === 0) {
			return { ok: false, error: "entry_id is required" };
		}
		if (typeof author !== "string" || author.length === 0) {
			return { ok: false, error: "author is required" };
		}

		const db = this.opts.db;
		const parent = db
			.prepare("SELECT id, ts, topic_id, author, kind FROM entries WHERE id = ?")
			.get(entry_id) as { id: string; ts: number; topic_id: string; author: string; kind: string } | undefined;
		if (!parent) {
			return { ok: false, error: `entry "${entry_id}" not found` };
		}

		// Reactions are silent — the orchestrator does NOT push a
		// notification to the parent author. The author sees the
		// reaction next time they read the topic.
		const reactionBody = (typeof body === "string" && body.length > 0) ? body : "ack";
		const id = randomUUID();
		const ts = Date.now();
		db.prepare(
			`INSERT INTO entries (id, ts, topic_id, author, kind, body, parent_entry, mentions, requires_confirmation_from)
			 VALUES (?, ?, ?, ?, 'react', ?, ?, '[]', '[]')`,
		).run(id, ts, parent.topic_id, author, reactionBody, entry_id);

		this.opts.onPost?.({
			id, ts, topic_id: parent.topic_id, author, kind: "react",
			body: reactionBody, parent_entry: entry_id,
			mentions: "[]", requires_confirmation_from: "[]",
		});

		return {
			ok: true,
			data: { id, ts, topic_id: parent.topic_id, parent_entry: entry_id, body: reactionBody },
		};
	}

	private handleCloseTopic(req: any): { ok: boolean; data?: unknown; error?: string } {
		const { topic_id, author } = req;
		if (typeof topic_id !== "string" || topic_id.length === 0) {
			return { ok: false, error: "topic_id is required" };
		}
		if (typeof author !== "string" || author.length === 0) {
			return { ok: false, error: "author is required" };
		}

		const db = this.opts.db;
		const topic = db.prepare("SELECT id, status FROM topics WHERE id = ?").get(topic_id) as { id: string; status: string } | undefined;
		if (!topic) {
			return { ok: false, error: `topic "${topic_id}" not found` };
		}

		// Only involved agents can close a topic.
		const isInvolved = !!db
			.prepare("SELECT 1 FROM topic_involved WHERE topic_id = ? AND agent_name = ?")
			.get(topic_id, author);
		if (!isInvolved) {
			return {
				ok: false,
				error: `agent "${author}" is not involved in topic "${topic_id}"; cannot close`,
			};
		}

		db.prepare("UPDATE topics SET status = 'closed' WHERE id = ?").run(topic_id);
		return {
			ok: true,
			data: { topic_id, status: "closed", closed_by: author },
		};
	}

	private handleSearchTopics(req: any): { ok: boolean; data?: unknown; error?: string } {
		const { query, limit } = req;
		if (typeof query !== "string" || query.trim().length === 0) {
			return { ok: false, error: "query is required (non-empty string)" };
		}
		const max = typeof limit === "number" && limit > 0 ? Math.min(limit, 50) : 20;
		// Escape % and _ (LIKE wildcards) so the user's query isn't
		// interpreted as a wildcard pattern.
		const pattern = `%${query.replace(/[%_]/g, (c) => "\\" + c)}%`;
		const rows = this.opts.db
			.prepare(
				`SELECT id, name, description, kind, status, created_by, created_at, last_activity_at
				 FROM topics
				 WHERE description LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'
				 ORDER BY last_activity_at DESC
				 LIMIT ?`,
			)
			.all(pattern, pattern, pattern, max) as TopicRow[];
		return { ok: true, data: { query, count: rows.length, topics: rows } };
	}

	private handleBudgetHit(req: any): { ok: boolean; data?: unknown; error?: string } {
		const { author, tool, calls, budget } = req;
		if (typeof author !== "string" || author.length === 0) {
			return { ok: false, error: "author is required" };
		}
		if (typeof tool !== "string" || tool.length === 0) {
			return { ok: false, error: "tool is required" };
		}
		const callCount = typeof calls === "number" ? calls : 0;
		const budgetVal = typeof budget === "number" ? budget : 0;
		this.opts.onBudgetHit?.({ author, tool, calls: callCount, budget: budgetVal });
		return { ok: true, data: { recorded: true } };
	}

	/**
	 * Tag a connected socket as a subscriber and confirm via the
	 * normal reply mechanism. After this, the socket will receive
	 * events pushed by pushEvent().
	 */
	private handleSubscribe(sock: Socket): { ok: boolean; data?: unknown; error?: string } {
		(sock as any).__isSubscriber = true;
		return { ok: true, data: { subscribed: true } };
	}

	/**
	 * Push an event line to all currently-connected sockets that have
	 * subscribed. The line is JSONL: `{"type":"event","data":{...}}\n`.
	 * The socket is left open; the client (e.g. `mesh watch`) keeps
	 * reading.
	 */
	pushEvent(event: unknown): void {
		const line = JSON.stringify({ type: "event", data: event }) + "\n";
		for (const sock of this.sockets) {
			if ((sock as any).__isSubscriber && sock.writable) {
				sock.write(line);
			}
		}
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (!server) return;

		// Close all active client sockets.
		for (const s of this.sockets) s.destroy();
		this.sockets.clear();

		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			// Give it a moment, then force-resolve even if connections linger.
			setTimeout(resolve, 200);
		});

		// Remove the socket file.
		try {
			unlinkSync(this.opts.socketPath);
		} catch {
			// ignore
		}
	}
}
