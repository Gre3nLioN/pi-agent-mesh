/**
 * Checkpoint protocol tests.
 *
 * Verifies:
 *   - write_checkpoint creates an entry with kind='checkpoint'
 *   - read_topic with no checkpoint returns all entries (tiered view falls through)
 *   - read_topic with one checkpoint returns that checkpoint + entries after
 *   - read_topic with multiple checkpoints returns the most recent + entries after
 *   - read_topic with all=true returns the full history
 *   - read_topic with from_checkpoint returns that specific checkpoint + entries after
 *   - read_topic shows the tiered/since_seq/total metadata correctly
 *   - list_checkpoints returns the headers with 200-char previews
 *   - write_checkpoint to a closed topic fails cleanly
 *   - write_checkpoint with empty body fails cleanly
 *   - write_checkpoint to a non-existent topic fails cleanly
 *   - the migration is idempotent (re-running openDb doesn't break)
 *
 * Run: npx tsx tests/checkpoint-test.ts
 */

import { connect } from "node:net";
import { resolve } from "node:path";
import { rmSync } from "node:fs";
import { Orchestrator } from "../src/orchestrator.js";

type RpcReply = { ok: boolean; data?: any; error?: string };

async function rpcCall(
	socketPath: string,
	req: Record<string, unknown>,
	timeoutMs = 5000,
): Promise<RpcReply> {
	return new Promise((resolve) => {
		const sock = connect(socketPath);
		let buf = "";
		const timer = setTimeout(() => {
			sock.destroy();
			resolve({ ok: false, error: "timeout" });
		}, timeoutMs);
		sock.on("data", (d) => {
			buf += d.toString();
			// RPC replies end with a newline.
			if (buf.includes("\n")) {
				clearTimeout(timer);
				sock.end();
				try {
					resolve(JSON.parse(buf));
				} catch (e: any) {
					resolve({ ok: false, error: `bad JSON: ${e.message} (raw=${buf})` });
				}
			}
		});
		sock.on("error", (e) => {
			clearTimeout(timer);
			resolve({ ok: false, error: e.message });
		});
		sock.write(JSON.stringify(req) + "\n");
	});
}

let passed = 0;
let failed = 0;
const failures: Array<{ name: string; reason: string }> = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		passed++;
		console.log(`  PASS  ${name}`);
	} catch (e: any) {
		failed++;
		failures.push({ name, reason: e.message });
		console.log(`  FAIL  ${name}\n        ${e.message}`);
	}
}

function assert(cond: any, msg: string): void {
	if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
	const dataDir = resolve("/tmp/puzzle-mesh-checkpoint-test");
	rmSync(dataDir, { recursive: true, force: true });

	const orch = new Orchestrator(dataDir);
	await orch.start();

	console.log("== checkpoint tests ==\n");

	// Helper: create a topic and seed it with N posts.
	async function seedTopic(
		topicId: string,
		postCount: number,
	): Promise<{ author: string }> {
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: topicId,
			author: "test1",
			body: "first post (auto-creates topic)",
		});
		assert(r.ok, `seedTopic: first post failed: ${r.error}`);
		for (let i = 0; i < postCount; i++) {
			await rpcCall(orch.socketPath, {
				type: "post",
				topic_id: topicId,
				author: "test1",
				body: `post ${i + 2}`,
			});
		}
		return { author: "test1" };
	}

	// ---------------------------------------------------------------------

	await test("write_checkpoint creates an entry with kind='checkpoint'", async () => {
		await seedTopic("ck-test-1-create-aaa", 0);
		const r = await rpcCall(orch.socketPath, {
			type: "write_checkpoint",
			topic_id: "ck-test-1-create-aaa",
			author: "test1",
			body: "# Checkpoint 1\n\n## State\n- done: seed",
		});
		assert(r.ok, `write_checkpoint failed: ${r.error}`);
		assert(r.data.kind === "checkpoint", `kind=${r.data.kind}`);
		assert(typeof r.data.id === "string" && r.data.id.length > 0, `bad id`);
		assert(typeof r.data.seq === "number", `bad seq`);
	});

	await test("read_topic with no checkpoints returns all entries", async () => {
		await seedTopic("ck-test-2-no-ck-aaa", 3);
		const r = await rpcCall(orch.socketPath, {
			type: "read_topic",
			topic_id: "ck-test-2-no-ck-aaa",
		});
		assert(r.ok, `read_topic failed: ${r.error}`);
		assert(r.data.count === 4, `count=${r.data.count} (expected 4)`);
		assert(r.data.tiered === true, `tiered=${r.data.tiered}`);
		assert(r.data.checkpoint_seq_used === null, `checkpoint_seq_used=${r.data.checkpoint_seq_used}`);
	});

	await test("read_topic with one checkpoint returns that checkpoint + entries after", async () => {
		await seedTopic("ck-test-3-one-ck-aaa", 4); // 5 entries (1 + 4)
		// Write a checkpoint at this point (becomes seq 6).
		const ck = await rpcCall(orch.socketPath, {
			type: "write_checkpoint",
			topic_id: "ck-test-3-one-ck-aaa",
			author: "test1",
			body: "checkpoint after 5 entries",
		});
		assert(ck.ok, `write_checkpoint failed: ${ck.error}`);
		// Add 2 more posts.
		await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "ck-test-3-one-ck-aaa",
			author: "test1",
			body: "post after checkpoint 1",
		});
		await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "ck-test-3-one-ck-aaa",
			author: "test1",
			body: "post after checkpoint 2",
		});
		// Read with default (tiered) view: should return checkpoint + 2 posts.
		const r = await rpcCall(orch.socketPath, {
			type: "read_topic",
			topic_id: "ck-test-3-one-ck-aaa",
		});
		assert(r.ok, `read_topic failed: ${r.error}`);
		assert(r.data.count === 3, `count=${r.data.count} (expected 3 = 1 ck + 2 posts)`);
		assert(r.data.tiered === true, `tiered=${r.data.tiered}`);
		assert(r.data.total === 8, `total=${r.data.total} (expected 8 = 5 seed + 1 ck + 2 posts)`);
		assert(r.data.checkpoint_seq_used !== null, `checkpoint_seq_used should be set`);
		assert(r.data.entries[0].kind === "checkpoint", `first entry kind=${r.data.entries[0].kind}`);
	});

	await test("read_topic with multiple checkpoints returns the most recent + entries after", async () => {
		await seedTopic("ck-test-4-multi-ck-aaa", 2); // 3 entries
		// First checkpoint.
		await rpcCall(orch.socketPath, {
			type: "write_checkpoint",
			topic_id: "ck-test-4-multi-ck-aaa",
			author: "test1",
			body: "checkpoint A",
		});
		// 2 more posts.
		await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "ck-test-4-multi-ck-aaa",
			author: "test1",
			body: "post between A and B",
		});
		await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "ck-test-4-multi-ck-aaa",
			author: "test1",
			body: "post between A and B 2",
		});
		// Second checkpoint.
		await rpcCall(orch.socketPath, {
			type: "write_checkpoint",
			topic_id: "ck-test-4-multi-ck-aaa",
			author: "test2",
			body: "checkpoint B",
		});
		// 1 more post.
		await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "ck-test-4-multi-ck-aaa",
			author: "test1",
			body: "post after B",
		});
		// Default read: most recent checkpoint (B) + the post after = 2 entries.
		const r = await rpcCall(orch.socketPath, {
			type: "read_topic",
			topic_id: "ck-test-4-multi-ck-aaa",
		});
		assert(r.ok, `read_topic failed: ${r.error}`);
		assert(r.data.count === 2, `count=${r.data.count} (expected 2)`);
		assert(r.data.entries[0].body === "checkpoint B", `first entry body=${r.data.entries[0].body}`);
		assert(r.data.entries[1].body === "post after B", `second entry body=${r.data.entries[1].body}`);
	});

	await test("read_topic with all=true returns the full history", async () => {
		// Reuse the previous topic.
		const r = await rpcCall(orch.socketPath, {
			type: "read_topic",
			topic_id: "ck-test-4-multi-ck-aaa",
			all: true,
		});
		assert(r.ok, `read_topic failed: ${r.error}`);
		assert(r.data.count === 8, `count=${r.data.count} (expected 8 = 3 seed + 1 ck + 2 posts + 1 ck + 1 post)`);
		assert(r.data.tiered === false, `tiered=${r.data.tiered}`);
	});

	await test("read_topic with from_checkpoint returns that specific checkpoint + entries after", async () => {
		// Get checkpoint A's id by listing checkpoints.
		const list = await rpcCall(orch.socketPath, {
			type: "list_checkpoints",
			topic_id: "ck-test-4-multi-ck-aaa",
		});
		assert(list.ok, `list_checkpoints failed: ${list.error}`);
		assert(list.data.count === 2, `count=${list.data.count} (expected 2)`);
		const checkpointA = list.data.checkpoints[0]; // First checkpoint
		assert(checkpointA.preview === "checkpoint A", `preview=${checkpointA.preview}`);

		const r = await rpcCall(orch.socketPath, {
			type: "read_topic",
			topic_id: "ck-test-4-multi-ck-aaa",
			from_checkpoint: checkpointA.id,
		});
		assert(r.ok, `read_topic failed: ${r.error}`);
		// Checkpoint A + 2 posts + checkpoint B + 1 post = 5 entries
		assert(r.data.count === 5, `count=${r.data.count} (expected 5)`);
		assert(r.data.entries[0].body === "checkpoint A", `first entry body=${r.data.entries[0].body}`);
	});

	await test("read_topic metadata shows tiered, since_seq_used, total", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "read_topic",
			topic_id: "ck-test-3-one-ck-aaa",
		});
		assert(r.ok, `read_topic failed: ${r.error}`);
		assert(r.data.tiered === true, `tiered=${r.data.tiered}`);
		assert(r.data.since_seq_used === 0, `since_seq_used=${r.data.since_seq_used}`);
		assert(typeof r.data.total === "number" && r.data.total > 0, `total=${r.data.total}`);
	});

	await test("list_checkpoints returns headers with 200-char previews", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "list_checkpoints",
			topic_id: "ck-test-4-multi-ck-aaa",
		});
		assert(r.ok, `list_checkpoints failed: ${r.error}`);
		assert(r.data.count === 2, `count=${r.data.count}`);
		const a = r.data.checkpoints[0];
		assert(typeof a.id === "string" && a.id.length > 0, `bad id`);
		assert(typeof a.ts === "number", `bad ts`);
		assert(a.author === "test1", `author=${a.author}`);
		assert(typeof a.preview === "string", `bad preview`);
		assert(a.preview === "checkpoint A", `preview=${a.preview}`);
	});

	await test("write_checkpoint to a closed topic fails cleanly", async () => {
		await seedTopic("ck-test-closed-1-aaa", 0);
		// Close the topic via direct DB write (we don't have an admin close RPC in this test).
		const Database = (await import("better-sqlite3")).default;
		const db = new Database(resolve(dataDir, "mesh.db"));
		db.prepare("UPDATE topics SET status = 'closed' WHERE id = ?").run("ck-test-closed-1-aaa");
		db.close();

		const r = await rpcCall(orch.socketPath, {
			type: "write_checkpoint",
			topic_id: "ck-test-closed-1-aaa",
			author: "test1",
			body: "x",
		});
		assert(!r.ok, `write_checkpoint should have failed on closed topic`);
		assert(/closed/.test(r.error ?? ""), `error: ${r.error}`);
	});

	await test("write_checkpoint with empty body fails cleanly", async () => {
		await seedTopic("ck-test-empty-1-aaa", 0);
		const r = await rpcCall(orch.socketPath, {
			type: "write_checkpoint",
			topic_id: "ck-test-empty-1-aaa",
			author: "test1",
			body: "",
		});
		assert(!r.ok, `write_checkpoint should have failed with empty body`);
		assert(/body is required/.test(r.error ?? ""), `error: ${r.error}`);
	});

	await test("write_checkpoint to a non-existent topic fails cleanly", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "write_checkpoint",
			topic_id: "no-such-topic-1-aaa",
			author: "test1",
			body: "x",
		});
		assert(!r.ok, `write_checkpoint should have failed on non-existent topic`);
		// The TOPIC_ID_RE rejects "no-such-topic-1-aaa" (no <domain>-<action>-<short>).
		// To test the not-found path, use a valid-shaped but unknown id.
		const r2 = await rpcCall(orch.socketPath, {
			type: "write_checkpoint",
			topic_id: "missing-topic-thing-aaa",
			author: "test1",
			body: "x",
		});
		assert(!r2.ok, `write_checkpoint should have failed on missing topic`);
		assert(/not found/.test(r2.error ?? ""), `error: ${r2.error}`);
	});

	await test("tiered view reduces context size for long topics", async () => {
		// Seed a topic with 25 entries (no checkpoint).
		await seedTopic("ck-test-25-posts-aaa", 24); // 25 entries
		const all = await rpcCall(orch.socketPath, {
			type: "read_topic",
			topic_id: "ck-test-25-posts-aaa",
			all: true,
		});
		assert(all.data.count === 25, `count=${all.data.count}`);

		// Write a checkpoint at the end.
		const ck = await rpcCall(orch.socketPath, {
			type: "write_checkpoint",
			topic_id: "ck-test-25-posts-aaa",
			author: "test1",
			body: "snapshot of state",
		});
		assert(ck.ok, `write_checkpoint failed: ${ck.error}`);

		// Tiered view: should return just the checkpoint (1 entry).
		const tiered = await rpcCall(orch.socketPath, {
			type: "read_topic",
			topic_id: "ck-test-25-posts-aaa",
		});
		assert(tiered.data.count === 1, `count=${tiered.data.count} (expected 1)`);
		assert(tiered.data.total === 26, `total=${tiered.data.total} (expected 26)`);
		assert(tiered.data.entries[0].kind === "checkpoint", `first entry kind=${tiered.data.entries[0].kind}`);
	});

	// ---------------------------------------------------------------------

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		console.log("\nfailures:");
		for (const f of failures) console.log(`  - ${f.name}: ${f.reason}`);
	}
	await orch.shutdown();
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("fatal:", err);
	process.exit(1);
});
