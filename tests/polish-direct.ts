/**
 * Stage 8 polish: direct test of the new features.
 *
 * Verifies the orchestrator's mechanics for:
 *   - read_inbox summary (body_preview instead of full body)
 *   - react (silent, no notification, kind='react')
 *   - close_topic (status → closed)
 *   - search_topics (LIKE on id/name/description)
 *
 * Run: tsx tests/polish-direct.ts
 */

import { resolve } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { Orchestrator } from "../src/orchestrator.js";
import { connect } from "node:net";

const EXTENSION_PATH = resolve(process.cwd(), "src/peer-extension.ts");

function ts(): string {
	return new Date().toISOString().slice(11, 23);
}
function log(scope: string, msg: string): void {
	process.stdout.write(`[${ts()}] [${scope}] ${msg}\n`);
}

async function rpcCall(socketPath: string, req: any, timeoutMs = 5000): Promise<any> {
	return new Promise((resolve) => {
		const sock = connect(socketPath);
		let buf = "";
		const timer = setTimeout(() => {
			sock.destroy();
			resolve({ ok: false, error: "timeout" });
		}, timeoutMs);
		sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
		sock.on("data", (chunk) => {
			buf += chunk.toString();
			const i = buf.indexOf("\n");
			if (i >= 0) {
				clearTimeout(timer);
				sock.end();
				try {
					resolve(JSON.parse(buf.slice(0, i)));
				} catch {
					resolve({ ok: false, error: "bad json" });
				}
			}
		});
		sock.on("error", (err) => {
			clearTimeout(timer);
			resolve({ ok: false, error: err.message });
		});
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
	const dataDir = resolve(process.cwd(), "data/polish-direct");
	if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });

	log("test", `data dir: ${dataDir}`);
	const orch = new Orchestrator(dataDir);
	await orch.start();

	// Spawn one agent so notifications have somewhere to go.
	const alice = await orch.spawnAgent(
		{ name: "alice", provider: "minimax", model: "MiniMax-M3" },
		{ extensionPath: EXTENSION_PATH },
	);
	alice.on("stderr", (chunk: string) => {
		for (const line of chunk.split("\n")) {
			if (line.includes("orch:react") || line.includes("orch:budget")) {
				process.stderr.write(`[alice:stderr] ${line}\n`);
			}
		}
	});
	await new Promise((r) => setTimeout(r, 500));

	console.log("\n== polish: react / close_topic / search_topics / read_inbox summary ==\n");

	// ---------------------------------------------------------------------
	// SETUP: post a few entries across two topics so we can test react,
	// close_topic, search, and read_inbox.
	// ---------------------------------------------------------------------

	const topicARes = await rpcCall(orch.socketPath, {
		type: "create_topic",
		topic_id: "polish-topic-a1",
		description: "authentication review for the login flow",
		kind: "chat",
		initial_involved: ["alice"],
		author: "alice",
	});
	assert(topicARes.ok, `create_topic a: ${topicARes.error}`);

	const topicBRes = await rpcCall(orch.socketPath, {
		type: "create_topic",
		topic_id: "polish-topic-b2",
		description: "billing webhook discussion",
		kind: "chat",
		initial_involved: ["alice"],
		author: "alice",
	});
	assert(topicBRes.ok, `create_topic b: ${topicBRes.error}`);

	// A long post in topic A — over 200 chars so the summary truncates.
	const longBody =
		"This is a long authentication review that goes into detail about " +
		"the login flow. It includes discussion of session management, " +
		"token refresh, CSRF protection, and rate limiting. The body " +
		"is intentionally long to test the read_inbox summary optimization. " +
		"The 200-char preview should truncate this; the LLM can call " +
		"read_entry to get the full body when it actually needs it.";
	const postARes = await rpcCall(orch.socketPath, {
		type: "post",
		topic_id: "polish-topic-a1",
		body: longBody,
		author: "alice",
	});
	assert(postARes.ok, `post a: ${postARes.error}`);
	const postAId = postARes.data.id as string;

	const postA2Res = await rpcCall(orch.socketPath, {
		type: "post",
		topic_id: "polish-topic-a1",
		body: "short follow-up in topic A",
		author: "alice",
	});
	assert(postA2Res.ok, `post a2: ${postA2Res.error}`);

	const postBRes = await rpcCall(orch.socketPath, {
		type: "post",
		topic_id: "polish-topic-b2",
		body: "billing webhook delivery issue under investigation",
		author: "alice",
	});
	assert(postBRes.ok, `post b: ${postBRes.error}`);

	// ---------------------------------------------------------------------
	// READ_INBOX SUMMARY
	// ---------------------------------------------------------------------

	await test("read_inbox returns body_preview (200 chars) for long bodies", async () => {
		const r = await rpcCall(orch.socketPath, { type: "read_inbox", author: "alice" });
		assert(r.ok, `read_inbox failed: ${r.error}`);
		assert(r.data.total_new >= 3, `expected at least 3 new entries, got ${r.data.total_new}`);

		// Find the long post.
		let longEntry: any;
		for (const t of r.data.topics) {
			for (const e of t.entries) {
				if (e.id === postAId) longEntry = e;
			}
		}
		assert(longEntry, "long post not found in inbox");
		// body field should be replaced by body_preview
		assert(longEntry.body === undefined, "expected body field to be stripped from inbox response");
		assert(typeof longEntry.body_preview === "string", "expected body_preview field");
		assert(
			!longEntry.body_preview.includes("under investigation"),
			"body_preview should NOT contain the topic B post body",
		);
		assert(
			longEntry.body_preview.includes("authentication review"),
			"body_preview should include the start of the long post",
		);
		assert(
			longEntry.body_preview.length <= 210,
			`body_preview should be ≤ 210 chars (truncated), got ${longEntry.body_preview.length}`,
		);
		assert(
			longEntry.body_preview.endsWith("..."),
			"truncated body_preview should end with '...'",
		);
		assert(
			longEntry.body_truncated === true,
			"body_truncated should be true for the long post",
		);
	});

	await test("read_inbox: short post has body_preview = full body, body_truncated=false", async () => {
		// Use a fresh agent to keep the cursor at 0.
		await rpcCall(orch.socketPath, {
			type: "create_topic",
			topic_id: "polish-short-a1",
			description: "short body test",
			kind: "chat",
			initial_involved: ["shortagent"],
			author: "alice",
		});
		await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "polish-short-a1",
			body: "short body here",
			author: "alice",
		});
		const r = await rpcCall(orch.socketPath, { type: "read_inbox", author: "shortagent" });
		assert(r.ok, `read_inbox failed: ${r.error}`);
		assert(r.data.total_new === 1, `expected 1 new, got ${r.data.total_new}`);
		const e = r.data.topics[0].entries[0];
		assert(e.body_truncated === false, "expected body_truncated=false for short post");
		assert(
			e.body_preview === "short body here",
			`expected full body, got: ${e.body_preview}`,
		);
	});

	await test("read_inbox: read_entry still returns the full body", async () => {
		const r = await rpcCall(orch.socketPath, { type: "read_entry", id: postAId });
		assert(r.ok, `read_entry failed: ${r.error}`);
		assert(
			r.data.entry.body === longBody,
			"read_entry should return the full body even though read_inbox returns a preview",
		);
	});

	// ---------------------------------------------------------------------
	// REACT
	// ---------------------------------------------------------------------

	await test("react creates a kind='react' entry pointing back to parent", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "react",
			entry_id: postAId,
			author: "alice",
			body: "+1",
		});
		assert(r.ok, `react failed: ${r.error}`);
		assert(typeof r.data.id === "string", "expected id in response");
		assert(r.data.parent_entry === postAId, "expected parent_entry to point back");

		const entry = orch.db
			.prepare("SELECT id, kind, body, parent_entry, author FROM entries WHERE id = ?")
			.get(r.data.id) as { id: string; kind: string; body: string; parent_entry: string; author: string };
		assert(entry.kind === "react", `expected kind=react, got ${entry.kind}`);
		assert(entry.body === "+1", `expected body=+1, got ${entry.body}`);
		assert(entry.parent_entry === postAId, "expected parent_entry to match");
		assert(entry.author === "alice", "expected author=alice");
	});

	await test("react with no body defaults to 'ack'", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "react",
			entry_id: postAId,
			author: "alice",
		});
		assert(r.ok, `react failed: ${r.error}`);
		assert(r.data.body === "ack", `expected default body=ack, got ${r.data.body}`);
	});

	await test("react is silent (no notification to the original author)", async () => {
		// Note: this is a behavior test, not a direct observable. We just
		// verify the orchestrator's stderr doesn't include any "notifying
		// alice" line for the reaction. Since the test runs in a subprocess
		// and stderr isn't piped, we can only check the DB state.
		//
		// The key invariant: reactions don't bump anyone's cursor. If
		// they did, alice's cursor would advance on the next read_inbox
		// even though she didn't initiate it.
		const before = orch.db
			.prepare("SELECT last_read_seq FROM cursors WHERE agent_name = ? AND topic_id = ?")
			.get("alice", "polish-topic-a1") as { last_read_seq: number } | undefined;
		await rpcCall(orch.socketPath, {
			type: "react",
			entry_id: postAId,
			author: "alice",
		});
		const after = orch.db
			.prepare("SELECT last_read_seq FROM cursors WHERE agent_name = ? AND topic_id = ?")
			.get("alice", "polish-topic-a1") as { last_read_seq: number } | undefined;
		assert(
			(before?.last_read_seq ?? 0) === (after?.last_read_seq ?? 0),
			`react bumped alice's cursor: ${before?.last_read_seq} -> ${after?.last_read_seq}`,
		);
	});

	await test("react on bogus entry id is rejected", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "react",
			entry_id: "00000000-0000-0000-0000-000000000000",
			author: "alice",
		});
		assert(!r.ok, "react on bogus id should fail");
		assert(/not found/.test(r.error), `error: ${r.error}`);
	});

	// ---------------------------------------------------------------------
	// CLOSE_TOPIC
	// ---------------------------------------------------------------------

	await test("close_topic sets status to 'closed'", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "close_topic",
			topic_id: "polish-topic-b2",
			author: "alice",
		});
		assert(r.ok, `close_topic failed: ${r.error}`);
		assert(r.data.status === "closed", `expected status=closed, got ${r.data.status}`);

		const topic = orch.db
			.prepare("SELECT status FROM topics WHERE id = ?")
			.get("polish-topic-b2") as { status: string };
		assert(topic.status === "closed", "DB status should be closed");
	});

	await test("close_topic by non-involved agent is rejected", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "close_topic",
			topic_id: "polish-topic-a1",
			author: "carol", // not involved
		});
		assert(!r.ok, "close_topic by non-involved should fail");
		assert(
			/is not involved in topic/.test(r.error ?? ""),
			`error should mention "is not involved", got: ${r.error}`,
		);
	});

	await test("close_topic on bogus topic is rejected", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "close_topic",
			topic_id: "no-such-topic-x1",
			author: "alice",
		});
		assert(!r.ok, "close_topic on bogus topic should fail");
		assert(/not found/.test(r.error), `error: ${r.error}`);
	});

	// ---------------------------------------------------------------------
	// SEARCH_TOPICS
	// ---------------------------------------------------------------------

	await test("search_topics finds by description keyword (case-insensitive)", async () => {
		const r = await rpcCall(orch.socketPath, { type: "search_topics", query: "authentication" });
		assert(r.ok, `search failed: ${r.error}`);
		assert(r.data.count >= 1, `expected ≥1 match, got ${r.data.count}`);
		const ids = (r.data.topics as Array<{ id: string }>).map((t) => t.id);
		assert(
			ids.includes("polish-topic-a1"),
			`expected polish-topic-a1 in results: ${ids.join(", ")}`,
		);
	});

	await test("search_topics finds by id substring", async () => {
		const r = await rpcCall(orch.socketPath, { type: "search_topics", query: "polish-topic" });
		assert(r.ok, `search failed: ${r.error}`);
		assert(r.data.count >= 2, `expected ≥2 matches for 'polish-topic', got ${r.data.count}`);
	});

	await test("search_topics returns 0 for no match", async () => {
		const r = await rpcCall(orch.socketPath, { type: "search_topics", query: "xyzzy-no-match" });
		assert(r.ok, `search failed: ${r.error}`);
		assert(r.data.count === 0, `expected 0 matches, got ${r.data.count}`);
	});

	await test("search_topics escapes LIKE wildcards (no false positives)", async () => {
		// A query containing % shouldn't match everything. We need to find
		// some pattern that would only match a specific row.
		const r = await rpcCall(orch.socketPath, { type: "search_topics", query: "%" });
		assert(r.ok, `search failed: ${r.error}`);
		// The literal % character isn't in any description, so we should
		// get 0 matches even though % is a LIKE wildcard.
		assert(
			r.data.count === 0,
			`expected 0 matches for literal '%%' (escaped), got ${r.data.count}: ${JSON.stringify(r.data.topics)}`,
		);
	});

	await test("search_topics rejects empty query", async () => {
		const r = await rpcCall(orch.socketPath, { type: "search_topics", query: "" });
		assert(!r.ok, "empty query should fail");
		assert(/required/.test(r.error), `error: ${r.error}`);
	});

	// ---------------------------------------------------------------------
	// DONE
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
