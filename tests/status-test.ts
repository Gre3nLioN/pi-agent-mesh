/**
 * Tests for the status UI admin RPCs:
 *   - admin_list_agents now includes last_entry + pending_confirmations
 *   - admin_list_topics now includes entry_count + checkpoint_count
 *   - admin_orchestrator_status is new and returns PID/uptime/totals
 *
 * Run: npx tsx tests/status-test.ts
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
	const dataDir = resolve("/tmp/puzzle-mesh-status-test");
	rmSync(dataDir, { recursive: true, force: true });

	const orch = new Orchestrator(dataDir);
	await orch.start();

	console.log("== status RPC tests ==\n");

	// Seed a topic with a few entries so we have data to summarize.
	await rpcCall(orch.socketPath, {
		type: "post",
		topic_id: "status-test-topic-aaa",
		author: "test1",
		body: "first post",
	});
	await rpcCall(orch.socketPath, {
		type: "post",
		topic_id: "status-test-topic-aaa",
		author: "test2",
		body: "second post",
	});
	await rpcCall(orch.socketPath, {
		type: "write_checkpoint",
		topic_id: "status-test-topic-aaa",
		author: "test1",
		body: "checkpoint after 2 posts",
	});

	// ---------------------------------------------------------------------

	await test("admin_orchestrator_status returns pid, uptime, totals", async () => {
		const r = await rpcCall(orch.socketPath, { type: "admin_orchestrator_status" });
		assert(r.ok, `failed: ${r.error}`);
		const d = r.data;
		assert(d.running === true, `running=${d.running}`);
		assert(typeof d.pid === "number" && d.pid > 0, `pid=${d.pid}`);
		assert(typeof d.started_at === "number" && d.started_at > 0, `started_at=${d.started_at}`);
		assert(typeof d.uptime_ms === "number" && d.uptime_ms >= 0, `uptime_ms=${d.uptime_ms}`);
		assert(typeof d.data_dir === "string", `data_dir=${d.data_dir}`);
		assert(typeof d.socket_path === "string", `socket_path=${d.socket_path}`);
		assert(d.totals, `missing totals`);
		assert(typeof d.totals.entries === "number" && d.totals.entries >= 3, `entries=${d.totals.entries}`);
		assert(typeof d.totals.checkpoints === "number" && d.totals.checkpoints >= 1, `checkpoints=${d.totals.checkpoints}`);
		assert(typeof d.totals.topics === "number" && d.totals.topics >= 1, `topics=${d.totals.topics}`);
		assert(typeof d.totals.open_topics === "number", `open_topics=${d.totals.open_topics}`);
		assert(typeof d.totals.closed_topics === "number", `closed_topics=${d.totals.closed_topics}`);
		assert(typeof d.totals.agents === "number", `agents=${d.totals.agents}`);
		assert(typeof d.totals.pending_confirmations === "number", `pending_confirmations=${d.totals.pending_confirmations}`);
	});

	await test("admin_orchestrator_status totals match the DB", async () => {
		const r = await rpcCall(orch.socketPath, { type: "admin_orchestrator_status" });
		assert(r.ok, `failed: ${r.error}`);
		// We seeded 1 topic with 3 entries (2 posts + 1 checkpoint).
		assert(r.data.totals.topics === 1, `topics=${r.data.totals.topics}`);
		assert(r.data.totals.open_topics === 1, `open_topics=${r.data.totals.open_topics}`);
		assert(r.data.totals.closed_topics === 0, `closed_topics=${r.data.totals.closed_topics}`);
		assert(r.data.totals.entries === 3, `entries=${r.data.totals.entries}`);
		assert(r.data.totals.checkpoints === 1, `checkpoints=${r.data.totals.checkpoints}`);
	});

	await test("admin_list_agents includes last_entry per agent", async () => {
		const r = await rpcCall(orch.socketPath, { type: "admin_list_agents" });
		assert(r.ok, `failed: ${r.error}`);
		// No agents spawned in this test (we didn't pass --agents), so
		// the list might be empty. But if there are agents, they should
		// have last_entry + pending_confirmations fields.
		for (const a of r.data.agents) {
			assert("name" in a, `name missing`);
			assert("has_process" in a, `has_process missing`);
			assert("last_entry" in a, `last_entry missing`);
			assert("pending_confirmations" in a, `pending_confirmations missing`);
			if (a.last_entry) {
				assert(typeof a.last_entry.id === "string", `bad id`);
				assert(typeof a.last_entry.ts === "number", `bad ts`);
				assert(typeof a.last_entry.kind === "string", `bad kind`);
				assert(typeof a.last_entry.body === "string", `bad body`);
				assert(typeof a.last_entry.topic_id === "string", `bad topic_id`);
			}
		}
	});

	await test("admin_list_topics includes entry_count and checkpoint_count", async () => {
		const r = await rpcCall(orch.socketPath, { type: "admin_list_topics" });
		assert(r.ok, `failed: ${r.error}`);
		const topic = r.data.topics.find((t: any) => t.id === "status-test-topic-aaa");
		assert(topic, `topic not found`);
		assert(topic.entry_count === 3, `entry_count=${topic.entry_count} (expected 3)`);
		assert(topic.checkpoint_count === 1, `checkpoint_count=${topic.checkpoint_count} (expected 1)`);
		assert(topic.involved_count === 2, `involved_count=${topic.involved_count} (expected 2: test1, test2)`);
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
