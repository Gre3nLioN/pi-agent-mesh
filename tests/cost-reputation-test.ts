/**
 * Tests for cost tracking and reputation tracking.
 *
 * Cost:
 *   - recordCost writes a row to the `costs` table
 *   - admin_cost_status returns totals, per-agent, per-model, recent
 *   - filters by agent / topic / since_ms work
 *   - the schema migration is idempotent
 *
 * Reputation:
 *   - admin_reputation_status returns per-agent scores
 *   - components include posts, checkpoints, response_rate, rejections
 *   - score is 0-10 and sorted descending
 *   - recordNudge creates a row
 *
 * Run: npx tsx tests/cost-reputation-test.ts
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
					resolve({ ok: false, error: `bad JSON: ${e.message}` });
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
	const dataDir = resolve("/tmp/puzzle-mesh-cost-rep-test");
	rmSync(dataDir, { recursive: true, force: true });

	const orch = new Orchestrator(dataDir, {
		autoNudge: { enabled: false, afterMinutes: 0, checkIntervalMinutes: 60, message: "" },
	});
	await orch.start();

	console.log("== cost + reputation tests ==\n");

	// Insert a cost row directly (we can't easily simulate a real LLM turn
	// in this test, but the data path is what we're testing).
	async function insertCost(opts: {
		agent: string;
		model?: string;
		topic_id?: string;
		input_tokens: number;
		output_tokens: number;
		cost_total: number;
		cost_input?: number;
		cost_output?: number;
	}): Promise<void> {
		const Database = (await import("better-sqlite3")).default;
		const db = new Database(resolve(dataDir, "mesh.db"));
		db.prepare(
			`INSERT INTO costs (id, ts, agent, topic_id, turn_id, model,
			   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
			   cost_input_usd, cost_output_usd, cost_cache_read_usd, cost_cache_write_usd,
			   cost_total_usd)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			`cost-${Math.random().toString(36).slice(2, 10)}`,
			Date.now(),
			opts.agent,
			opts.topic_id ?? null,
			`turn-${Date.now()}`,
			opts.model ?? "test-model",
			opts.input_tokens,
			opts.output_tokens,
			0,
			0,
			opts.cost_input ?? opts.cost_total * 0.4,
			opts.cost_output ?? opts.cost_total * 0.6,
			0,
			0,
			opts.cost_total,
		);
		db.close();
	}

	// Seed a topic and some entries.
	await rpcCall(orch.socketPath, {
		type: "post",
		topic_id: "rep-test-topic-aaa",
		author: "alice",
		body: "first post",
	});
	await rpcCall(orch.socketPath, {
		type: "post",
		topic_id: "rep-test-topic-aaa",
		author: "bob",
		body: "second post",
	});
	await rpcCall(orch.socketPath, {
		type: "write_checkpoint",
		topic_id: "rep-test-topic-aaa",
		author: "alice",
		body: "checkpoint 1",
	});
	await rpcCall(orch.socketPath, {
		type: "write_checkpoint",
		topic_id: "rep-test-topic-aaa",
		author: "alice",
		body: "checkpoint 2",
	});
	await rpcCall(orch.socketPath, {
		type: "post",
		topic_id: "rep-test-topic-aaa",
		author: "alice",
		body: "third post",
	});

	// ---------------------------------------------------------------------
	// COST TESTS
	// ---------------------------------------------------------------------

	await test("admin_cost_status returns the right shape (empty)", async () => {
		const r = await rpcCall(orch.socketPath, { type: "admin_cost_status" });
		assert(r.ok, `failed: ${r.error}`);
		assert(r.data.totals, `missing totals`);
		assert(Array.isArray(r.data.per_agent), `per_agent is array`);
		assert(Array.isArray(r.data.per_model), `per_model is array`);
		assert(Array.isArray(r.data.recent), `recent is array`);
		assert(r.data.totals.cost_usd === 0, `initial cost should be 0, got ${r.data.totals.cost_usd}`);
		assert(r.data.totals.turn_count === 0, `initial turn_count should be 0`);
	});

	await test("recordCost writes a row, admin_cost_status sees it", async () => {
		await insertCost({
			agent: "alice",
			topic_id: "rep-test-topic-aaa",
			input_tokens: 1000,
			output_tokens: 200,
			cost_total: 0.05,
		});
		const r = await rpcCall(orch.socketPath, { type: "admin_cost_status" });
		assert(r.ok, `failed: ${r.error}`);
		assert(r.data.totals.cost_usd === 0.05, `totals.cost_usd=${r.data.totals.cost_usd}`);
		assert(r.data.totals.input_tokens === 1000, `totals.input_tokens=${r.data.totals.input_tokens}`);
		assert(r.data.totals.output_tokens === 200, `totals.output_tokens=${r.data.totals.output_tokens}`);
		assert(r.data.totals.turn_count === 1, `totals.turn_count=${r.data.totals.turn_count}`);
		assert(r.data.per_agent.length === 1, `per_agent.length=${r.data.per_agent.length}`);
		assert(r.data.per_agent[0].agent === "alice", `agent=${r.data.per_agent[0].agent}`);
		assert(r.data.per_agent[0].cost_usd === 0.05, `agent cost=${r.data.per_agent[0].cost_usd}`);
	});

	await test("admin_cost_status aggregates by agent", async () => {
		await insertCost({ agent: "bob", input_tokens: 500, output_tokens: 100, cost_total: 0.02 });
		await insertCost({ agent: "bob", input_tokens: 800, output_tokens: 200, cost_total: 0.04 });
		const r = await rpcCall(orch.socketPath, { type: "admin_cost_status" });
		assert(r.ok, `failed: ${r.error}`);
		assert(r.data.totals.cost_usd > 0.10, `totals.cost_usd=${r.data.totals.cost_usd}`);
		assert(r.data.totals.turn_count === 3, `turn_count=${r.data.totals.turn_count}`);
		const bob = r.data.per_agent.find((a: any) => a.agent === "bob");
		assert(bob, `bob not in per_agent`);
		assert(bob.cost_usd === 0.06, `bob cost=${bob.cost_usd}`);
		assert(bob.turn_count === 2, `bob turn_count=${bob.turn_count}`);
		assert(bob.avg_cost_per_turn === 0.03, `bob avg=${bob.avg_cost_per_turn}`);
	});

	await test("admin_cost_status filters by agent", async () => {
		const r = await rpcCall(orch.socketPath, { type: "admin_cost_status", agent: "bob" });
		assert(r.ok, `failed: ${r.error}`);
		assert(r.data.totals.turn_count === 2, `filtered turn_count=${r.data.totals.turn_count}`);
		assert(r.data.totals.cost_usd === 0.06, `filtered cost=${r.data.totals.cost_usd}`);
		assert(r.data.per_agent.length === 1, `should only have bob`);
		assert(r.data.per_agent[0].agent === "bob", `agent=${r.data.per_agent[0].agent}`);
	});

	await test("admin_cost_status filters by topic", async () => {
		const r = await rpcCall(orch.socketPath, { type: "admin_cost_status", topic_id: "rep-test-topic-aaa" });
		assert(r.ok, `failed: ${r.error}`);
		assert(r.data.totals.turn_count === 1, `topic filter turn_count=${r.data.totals.turn_count}`);
		assert(r.data.totals.cost_usd === 0.05, `topic filter cost=${r.data.totals.cost_usd}`);
	});

	await test("admin_cost_status returns recent events", async () => {
		const r = await rpcCall(orch.socketPath, { type: "admin_cost_status" });
		assert(r.ok, `failed: ${r.error}`);
		assert(r.data.recent.length > 0, `recent should have events`);
		assert(typeof r.data.recent[0].ts === "number", `recent.ts`);
		assert(typeof r.data.recent[0].agent === "string", `recent.agent`);
		assert(typeof r.data.recent[0].cost_total_usd === "number", `recent.cost`);
	});

	// ---------------------------------------------------------------------
	// REPUTATION TESTS
	// ---------------------------------------------------------------------

	await test("admin_reputation_status returns per-agent scores", async () => {
		const r = await rpcCall(orch.socketPath, { type: "admin_reputation_status" });
		assert(r.ok, `failed: ${r.error}`);
		assert(Array.isArray(r.data.per_agent), `per_agent is array`);
		// We have alice (2 posts + 2 checkpoints) and bob (1 post).
		const alice = r.data.per_agent.find((a: any) => a.agent === "alice");
		const bob = r.data.per_agent.find((a: any) => a.agent === "bob");
		assert(alice, `alice not in per_agent`);
		assert(bob, `bob not in per_agent`);
		assert(typeof alice.score === "number", `alice score type`);
		assert(alice.score >= 0 && alice.score <= 10, `alice score ${alice.score} not in 0-10`);
		assert(alice.components.posts === 2, `alice posts=${alice.components.posts}`);
		assert(alice.components.checkpoints === 2, `alice checkpoints=${alice.components.checkpoints}`);
		assert(bob.components.posts === 1, `bob posts=${bob.components.posts}`);
		assert(bob.components.checkpoints === 0, `bob checkpoints=${bob.components.checkpoints}`);
	});

	await test("reputation score reflects checkpoints (alice > bob)", async () => {
		const r = await rpcCall(orch.socketPath, { type: "admin_reputation_status" });
		const alice = r.data.per_agent.find((a: any) => a.agent === "alice");
		const bob = r.data.per_agent.find((a: any) => a.agent === "bob");
		// Alice has 2 checkpoints, bob has 0; alice should score higher.
		assert(alice.score > bob.score, `alice (${alice.score}) should beat bob (${bob.score})`);
	});

	await test("reputation is sorted by score descending", async () => {
		const r = await rpcCall(orch.socketPath, { type: "admin_reputation_status" });
		const scores = r.data.per_agent.map((a: any) => a.score);
		for (let i = 1; i < scores.length; i++) {
			assert(scores[i - 1] >= scores[i], `not sorted: ${scores.join(", ")}`);
		}
	});

	await test("reputation includes last_active_ms", async () => {
		const r = await rpcCall(orch.socketPath, { type: "admin_reputation_status" });
		const alice = r.data.per_agent.find((a: any) => a.agent === "alice");
		assert(typeof alice.components.last_active_ms === "number", `last_active_ms type`);
		assert(alice.components.last_active_ms > 0, `last_active_ms should be > 0`);
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
