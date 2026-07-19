/**
 * Tests for autoCheckpoint and autoCloseTopics (auto-topic-lifecycle change).
 *
 * Verifies:
 *   - autoCheckpoint writes a kind='checkpoint' entry by author='orchestrator' when 30+ entries since the last one
 *   - autoCheckpoint does NOT write when under threshold
 *   - autoCheckpoint body includes "Current state" and "Recent activity" sections
 *   - autoClose marks a topic closed when idle for 24h and no live agents
 *   - autoClose does NOT mark closed when an involved agent is alive
 *   - autoClose does NOT mark closed when last activity is recent
 *   - auto-generated entries have author='orchestrator'
 *
 * Run: npx tsx tests/auto-topic-lifecycle-test.ts
 */

import { resolve } from "node:path";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { Orchestrator } from "../src/orchestrator.js";

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

function getDb(dataDir: string): Database.Database {
	return new Database(resolve(dataDir, "mesh.db"));
}

/**
 * Create a topic with N entries, no checkpoints, all entries kind='post'.
 * Returns the topicId.
 */
function seedTopicWithEntries(
	dataDir: string,
	topicId: string,
	entryCount: number,
	options: { withCheckpoint?: boolean; backdateMs?: number } = {},
): void {
	const db = getDb(dataDir);
	const now = Date.now();
	const backdate = options.backdateMs ?? 0;
	db.prepare(
		`INSERT INTO topics (id, name, description, kind, status, created_by, created_at, last_activity_at, notify_on_post)
		 VALUES (?, NULL, ?, 'chat', 'active', ?, ?, ?, 0)`,
	).run(topicId, "test topic", "author1", now - backdate, now - backdate);
	db.prepare("INSERT INTO topic_involved (topic_id, agent_name) VALUES (?, ?)").run(topicId, "author1");
	db.prepare("INSERT INTO topic_involved (topic_id, agent_name) VALUES (?, ?)").run(topicId, "author2");
	for (let i = 0; i < entryCount; i++) {
		db.prepare(
			`INSERT INTO entries (id, ts, topic_id, author, kind, body, parent_entry, mentions, requires_confirmation_from)
			 VALUES (?, ?, ?, ?, 'post', ?, NULL, '[]', '[]')`,
		).run(`entry-${topicId}-${i}`, now - backdate + i, topicId, i % 2 === 0 ? "author1" : "author2", `post ${i}`);
	}
	if (options.withCheckpoint) {
		// Insert a checkpoint at the very start so subsequent entries
		// count against the threshold from that point.
		db.prepare(
			`INSERT INTO entries (id, ts, topic_id, author, kind, body, parent_entry, mentions, requires_confirmation_from)
			 VALUES (?, ?, ?, ?, 'checkpoint', ?, NULL, '[]', '[]')`,
		).run(`cp-${topicId}-0`, now - backdate, topicId, "orchestrator", "initial checkpoint");
	}
	db.close();
}

async function main(): Promise<void> {
	const dataDir = resolve("/tmp/puzzle-mesh-auto-topic-lifecycle-test");
	rmSync(dataDir, { recursive: true, force: true });

	const orch = new Orchestrator(dataDir, {
		autoNudge: { enabled: false, afterMinutes: 30, checkIntervalMinutes: 60, message: "x" },
	});
	await orch.start();

	console.log("== auto-topic-lifecycle tests ==\n");

	// ---------------------------------------------------------------------

	await test("autoCheckpoint writes when 30+ entries since last checkpoint", async () => {
		const topicId = "acp-over-threshold";
		seedTopicWithEntries(dataDir, topicId, 35);
		(orch as any).autoLifecycle();
		const db = getDb(dataDir);
		const row = db.prepare(
			"SELECT author, kind, body FROM entries WHERE topic_id = ? AND author = 'orchestrator' AND kind = 'checkpoint'",
		).get(topicId) as any;
		db.close();
		assert(row, `expected an auto-checkpoint row for ${topicId}`);
		assert(row.author === "orchestrator", `author=${row.author}`);
		assert(row.kind === "checkpoint", `kind=${row.kind}`);
		assert(row.body.includes("Auto-checkpoint"), `body missing title: ${row.body}`);
		assert(row.body.includes("35"), `body missing entry count: ${row.body}`);
	});

	await test("autoCheckpoint does NOT write when under threshold", async () => {
		const topicId = "acp-under-threshold";
		seedTopicWithEntries(dataDir, topicId, 25);
		(orch as any).autoLifecycle();
		const db = getDb(dataDir);
		const row = db.prepare(
			"SELECT id FROM entries WHERE topic_id = ? AND author = 'orchestrator' AND kind = 'checkpoint'",
		).get(topicId);
		db.close();
		assert(!row, `expected no auto-checkpoint for ${topicId}, but found one`);
	});

	await test("autoCheckpoint body includes 'Current state' and 'Recent activity'", async () => {
		const topicId = "acp-body-shape";
		seedTopicWithEntries(dataDir, topicId, 30);
		(orch as any).autoLifecycle();
		const db = getDb(dataDir);
		const row = db.prepare(
			"SELECT body FROM entries WHERE topic_id = ? AND author = 'orchestrator' AND kind = 'checkpoint'",
		).get(topicId) as any;
		db.close();
		assert(row, `expected auto-checkpoint`);
		assert(row.body.includes("## Current state"), `body missing 'Current state'`);
		assert(row.body.includes("## Recent activity"), `body missing 'Recent activity'`);
		assert(row.body.includes("## Next action"), `body missing 'Next action'`);
	});

	await test("autoCheckpoint resets the count (next fires after 30 more entries)", async () => {
		const topicId = "acp-resets";
		seedTopicWithEntries(dataDir, topicId, 30);
		(orch as any).autoLifecycle();
		// After the first auto-checkpoint, the next should fire only
		// after 30 more entries. Insert 5 more and tick again.
		const db = getDb(dataDir);
		const lastCp = db.prepare(
			"SELECT MAX(seq) AS s FROM entries WHERE topic_id = ? AND kind = 'checkpoint'",
		).get(topicId) as { s: number | null };
		assert(lastCp.s !== null, `expected first auto-checkpoint`);
		for (let i = 0; i < 5; i++) {
			db.prepare(
				`INSERT INTO entries (id, ts, topic_id, author, kind, body, parent_entry, mentions, requires_confirmation_from)
				 VALUES (?, ?, ?, ?, 'post', ?, NULL, '[]', '[]')`,
			).run(`extra-${topicId}-${i}`, Date.now(), topicId, "author1", `extra post ${i}`);
		}
		db.close();
		(orch as any).autoLifecycle();
		const db2 = getDb(dataDir);
		const cps = db2.prepare(
			"SELECT COUNT(*) AS c FROM entries WHERE topic_id = ? AND kind = 'checkpoint'",
		).get(topicId) as { c: number };
		db2.close();
		assert(cps.c === 1, `expected 1 checkpoint after only 5 more entries, got ${cps.c}`);
	});

	await test("autoClose marks a topic closed when idle for 24h and no live agents", async () => {
		const topicId = "acl-idle-no-agents";
		// Seed topic and 5 entries, all backdated 25h ago.
		seedTopicWithEntries(dataDir, topicId, 5, { backdateMs: 25 * 60 * 60 * 1000 });
		(orch as any).autoLifecycle();
		const db = getDb(dataDir);
		const topic = db.prepare("SELECT status FROM topics WHERE id = ?").get(topicId) as { status: string };
		const wrapUp = db.prepare(
			"SELECT author, kind, body FROM entries WHERE topic_id = ? AND author = 'orchestrator' AND kind = 'summary'",
		).get(topicId) as any;
		db.close();
		assert(topic.status === "closed", `topic status=${topic.status} (expected closed)`);
		assert(wrapUp, `expected a wrap-up entry`);
		assert(wrapUp.body.includes("Wrap-up"), `body missing wrap-up title`);
	});

	await test("autoClose does NOT mark closed when an involved agent is alive", async () => {
		const topicId = "acl-alive-agent";
		seedTopicWithEntries(dataDir, topicId, 5, { backdateMs: 25 * 60 * 60 * 1000 });
		// Mark author1 as alive in the agents table.
		const db = getDb(dataDir);
		db.prepare(
			"INSERT INTO agents (name, pid, status, started_at) VALUES (?, ?, 'alive', ?)",
		).run("author1", 99999, Date.now());
		db.close();
		(orch as any).autoLifecycle();
		const db2 = getDb(dataDir);
		const topic = db2.prepare("SELECT status FROM topics WHERE id = ?").get(topicId) as { status: string };
		const wrapUp = db2.prepare(
			"SELECT id FROM entries WHERE topic_id = ? AND author = 'orchestrator' AND kind = 'summary'",
		).get(topicId);
		db2.close();
		assert(topic.status === "active", `topic status=${topic.status} (expected active, agent alive)`);
		assert(!wrapUp, `expected no wrap-up entry when agent is alive`);
	});

	await test("autoClose does NOT mark closed when last activity is recent", async () => {
		const topicId = "acl-recent";
		seedTopicWithEntries(dataDir, topicId, 5);  // no backdate
		(orch as any).autoLifecycle();
		const db = getDb(dataDir);
		const topic = db.prepare("SELECT status FROM topics WHERE id = ?").get(topicId) as { status: string };
		const wrapUp = db.prepare(
			"SELECT id FROM entries WHERE topic_id = ? AND author = 'orchestrator' AND kind = 'summary'",
		).get(topicId);
		db.close();
		assert(topic.status === "active", `topic status=${topic.status} (expected active, recent activity)`);
		assert(!wrapUp, `expected no wrap-up entry when activity is recent`);
	});

	await test("auto-generated entries have author='orchestrator'", async () => {
		const cpTopic = "author-cp";
		seedTopicWithEntries(dataDir, cpTopic, 35);
		(orch as any).autoLifecycle();
		const db = getDb(dataDir);
		const row = db.prepare(
			"SELECT author FROM entries WHERE topic_id = ? AND author = 'orchestrator'",
		).get(cpTopic) as { author: string };
		db.close();
		assert(row, `expected at least one author='orchestrator' entry`);
		assert(row.author === "orchestrator", `author=${row.author}`);
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
