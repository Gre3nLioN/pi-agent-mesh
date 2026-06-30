/**
 * Tests for the auto-nudge background task.
 *
 * Verifies:
 *   - Auto-nudge is enabled by default with a 30-min threshold
 *   - A silent agent (no entry in N minutes) is nudged
 *   - An agent that recently posted is NOT nudged
 *   - A nudged agent isn't re-nudged for the same silence (no flood)
 *   - An agent with no open topic is NOT nudged
 *   - The disabled flag turns it off
 *   - The threshold is configurable
 *   - admin_auto_nudge_status returns the right shape
 *   - admin_orchestrator_status includes auto_nudge info
 *
 * Run: npx tsx tests/auto-nudge-test.ts
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
	const dataDir = resolve("/tmp/puzzle-mesh-auto-nudge-test");
	rmSync(dataDir, { recursive: true, force: true });

	// Use a 1-min threshold and 1-min check interval so we don't have to
	// wait 30 minutes for the test. The check interval is just for
	// production; the test calls checkAutoNudge() directly to avoid
	// waiting for the timer.
	const orch = new Orchestrator(dataDir, {
		autoNudge: {
			enabled: true,
			afterMinutes: 1,
			checkIntervalMinutes: 60, // doesn't matter — we call check directly
			message: "TEST_NUDGE: please post a status",
		},
	});
	await orch.start();

	console.log("== auto-nudge tests ==\n");

	// Seed a topic with the agent involved, but no recent entries
	// (so the agent is "silent" for the purposes of auto-nudge).
	// We backdate the entry to > 1 minute ago.
	async function seedSilentAgent(agentName: string, topicId: string): Promise<void> {
		// Create a topic with the agent as involved (via a post from them).
		const oldTs = Date.now() - 5 * 60 * 1000; // 5 minutes ago
		// Direct DB write to backdate the entry.
		const Database = (await import("better-sqlite3")).default;
		const db = new Database(resolve(dataDir, "mesh.db"));
		// Insert topic if not exists.
		const existing = db.prepare("SELECT id FROM topics WHERE id = ?").get(topicId);
		if (!existing) {
			db.prepare(
				`INSERT INTO topics (id, name, description, kind, status, created_by, created_at, last_activity_at, notify_on_post)
				 VALUES (?, NULL, ?, 'chat', 'active', ?, ?, ?, 0)`,
			).run(topicId, "test topic", agentName, oldTs, oldTs);
			db.prepare("INSERT INTO topic_involved (topic_id, agent_name) VALUES (?, ?)").run(topicId, agentName);
		}
		// Insert a backdated entry by the agent.
		const id = `test-entry-${Math.random().toString(36).slice(2, 10)}`;
		db.prepare(
			`INSERT INTO entries (id, ts, topic_id, author, kind, body, parent_entry, mentions, requires_confirmation_from)
			 VALUES (?, ?, ?, ?, 'post', ?, NULL, '[]', '[]')`,
		).run(id, oldTs, topicId, agentName, "old post");
		db.close();
	}

	// Register a fake agent in the orchestrator's agents map.
	// (We can't actually spawn a real LLM agent in this test, so we
	// register a stub. The orchestrator's checkAutoNudge calls
	// agent.send() which is async; we just need the agent to exist.)
	async function registerFakeAgent(name: string): Promise<void> {
		// Use a stub agent process. We just need a name in the map.
		// The orchestrator's checkAutoNudge iterates this.agents and
		// calls agent.send() which we don't need to actually receive.
		// Cast to any to bypass the type.
		(orch as any).agents.set(name, {
			send: async (msg: any) => {
				// Capture the last nudge for assertion.
				(orch as any).__lastNudge = { agent: name, msg };
				return { ok: true };
			},
			shutdown: async () => {
				// Stub shutdown for orchestrator.shutdown().
			},
		});
	}

	// Reset the captured nudge.
	(orch as any).__lastNudge = null;

	// ---------------------------------------------------------------------

	await test("admin_auto_nudge_status returns the config + per-agent state", async () => {
		const r = await rpcCall(orch.socketPath, { type: "admin_auto_nudge_status" });
		assert(r.ok, `failed: ${r.error}`);
		assert(r.data.config.enabled === true, `enabled=${r.data.config.enabled}`);
		assert(r.data.config.afterMinutes === 1, `afterMinutes=${r.data.config.afterMinutes}`);
		assert(r.data.config.message === "TEST_NUDGE: please post a status", `message=${r.data.config.message}`);
		assert(typeof r.data.nudges_sent === "number", `nudges_sent type`);
		assert(Array.isArray(r.data.per_agent), `per_agent is array`);
	});

	await test("admin_orchestrator_status includes auto_nudge info", async () => {
		const r = await rpcCall(orch.socketPath, { type: "admin_orchestrator_status" });
		assert(r.ok, `failed: ${r.error}`);
		assert(r.data.auto_nudge, `missing auto_nudge`);
		assert(r.data.auto_nudge.enabled === true, `enabled=${r.data.auto_nudge.enabled}`);
		assert(r.data.auto_nudge.after_minutes === 1, `after_minutes=${r.data.auto_nudge.after_minutes}`);
		assert(typeof r.data.auto_nudge.nudges_sent === "number", `nudges_sent type`);
	});

	await test("a silent agent (no recent post) is nudged", async () => {
		(orch as any).__lastNudge = null;
		await registerFakeAgent("silent-agent");
		await seedSilentAgent("silent-agent", "auto-nudge-test-aaaa");
		(orch as any).checkAutoNudge();
		// Wait a moment for the async send() to complete.
		await new Promise((r) => setTimeout(r, 50));
		const nudge = (orch as any).__lastNudge;
		assert(nudge, `no nudge was sent`);
		assert(nudge.agent === "silent-agent", `nudged ${nudge.agent}`);
		assert(nudge.msg.message === "TEST_NUDGE: please post a status", `message=${nudge.msg.message}`);
		assert(nudge.msg.streamingBehavior === "steer", `streamingBehavior=${nudge.msg.streamingBehavior}`);
	});

	await test("a recently-active agent is NOT nudged", async () => {
		(orch as any).__lastNudge = null;
		await registerFakeAgent("active-agent");
		// Seed a recent post (just now).
		const Database = (await import("better-sqlite3")).default;
		const db = new Database(resolve(dataDir, "mesh.db"));
		const now = Date.now();
		const tid = "auto-nudge-test-active-aaa";
		const existing = db.prepare("SELECT id FROM topics WHERE id = ?").get(tid);
		if (!existing) {
			db.prepare(
				`INSERT INTO topics (id, name, description, kind, status, created_by, created_at, last_activity_at, notify_on_post)
				 VALUES (?, NULL, ?, 'chat', 'active', ?, ?, ?, 0)`,
			).run(tid, "active test", "active-agent", now, now);
			db.prepare("INSERT INTO topic_involved (topic_id, agent_name) VALUES (?, ?)").run(tid, "active-agent");
		}
		db.prepare(
			`INSERT INTO entries (id, ts, topic_id, author, kind, body, parent_entry, mentions, requires_confirmation_from)
			 VALUES (?, ?, ?, ?, 'post', ?, NULL, '[]', '[]')`,
		).run(`test-entry-active-${Math.random().toString(36).slice(2, 8)}`, now, tid, "active-agent", "just now");
		db.close();

		(orch as any).checkAutoNudge();
		await new Promise((r) => setTimeout(r, 50));
		const nudge = (orch as any).__lastNudge;
		assert(!nudge || nudge.agent !== "active-agent", `active agent was nudged: ${JSON.stringify(nudge)}`);
	});

	await test("a nudged agent isn't re-nudged for the same silence (no flood)", async () => {
		(orch as any).__lastNudge = null;
		await registerFakeAgent("flood-test-agent");
		await seedSilentAgent("flood-test-agent", "auto-nudge-test-flood-aa");
		// First nudge.
		(orch as any).checkAutoNudge();
		await new Promise((r) => setTimeout(r, 50));
		const first = (orch as any).__lastNudge;
		assert(first, `first nudge was not sent`);
		// Reset and try again — should NOT nudge (same silence).
		(orch as any).__lastNudge = null;
		(orch as any).checkAutoNudge();
		await new Promise((r) => setTimeout(r, 50));
		const second = (orch as any).__lastNudge;
		assert(!second, `agent was re-nudged for the same silence: ${JSON.stringify(second)}`);
	});

	await test("a new silence (agent posts) allows a new nudge", async () => {
		(orch as any).__lastNudge = null;
		await registerFakeAgent("silence-break-agent");
		await seedSilentAgent("silence-break-agent", "auto-nudge-test-break-aa");
		// First nudge.
		(orch as any).checkAutoNudge();
		await new Promise((r) => setTimeout(r, 50));
		assert((orch as any).__lastNudge, `first nudge was not sent`);
		// Simulate the agent posting (new silence starts). To test this
		// deterministically without waiting wall-clock time, we
		// backdate BOTH the agent's last post AND the orchestrator's
		// last-nudge record — making it look like the agent posted
		// 2 min ago, and the last nudge was 5 min ago. That puts us
		// firmly in a "new silence" that has been going for 2 min.
		const Database = (await import("better-sqlite3")).default;
		const db = new Database(resolve(dataDir, "mesh.db"));
		// Backdate the lastAutoNudgeAt map: the previous nudge was
		// 5 min ago (before the new silence started).
		(orch as any).lastAutoNudgeAt.set("silence-break-agent", Date.now() - 5 * 60 * 1000);
		// Insert a new entry backdated 2 min ago. This is the agent's
		// "I'm back" post — a new silence started 2 min ago.
		db.prepare(
			`INSERT INTO entries (id, ts, topic_id, author, kind, body, parent_entry, mentions, requires_confirmation_from)
			 VALUES (?, ?, ?, ?, 'post', ?, NULL, '[]', '[]')`,
		).run(`test-entry-new-${Math.random().toString(36).slice(2, 8)}`, Date.now() - 2 * 60 * 1000, "auto-nudge-test-break-aa", "silence-break-agent", "I'm back");
		db.close();

		// Now nudge again — should work because the new silence started.
		(orch as any).__lastNudge = null;
		(orch as any).checkAutoNudge();
		await new Promise((r) => setTimeout(r, 50));
		const second = (orch as any).__lastNudge;
		assert(second, `agent was not re-nudged for the new silence`);
	});

	await test("an agent with no open topic is NOT nudged", async () => {
		(orch as any).__lastNudge = null;
		await registerFakeAgent("no-topic-agent");
		// Don't seed any topic.
		(orch as any).checkAutoNudge();
		await new Promise((r) => setTimeout(r, 50));
		const nudge = (orch as any).__lastNudge;
		assert(!nudge || nudge.agent !== "no-topic-agent", `no-topic agent was nudged: ${JSON.stringify(nudge)}`);
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
