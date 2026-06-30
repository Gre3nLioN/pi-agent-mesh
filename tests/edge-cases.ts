/**
 * Edge case tests for entry/topic safety.
 *
 * Hits the control server directly (no LLM) to verify that special
 * characters, unicode, SQL injection attempts, oversized payloads, and
 * weird input shapes are handled correctly. Each test is independent
 * (uses a unique topic id) so failures don't cascade.
 *
 * Run: npx tsx tests/edge-cases.ts
 */

import { connect } from "node:net";
import { resolve } from "node:path";
import { rmSync, existsSync } from "node:fs";
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
		sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
		sock.on("data", (chunk) => {
			buf += chunk.toString();
			const i = buf.indexOf("\n");
			if (i >= 0) {
				clearTimeout(timer);
				sock.end();
				try {
					resolve(JSON.parse(buf.slice(0, i)));
				} catch (e: any) {
					resolve({ ok: false, error: `bad JSON: ${e.message}` });
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
	// Use a clean data dir.
	const dataDir = resolve(process.cwd(), "data/edge-cases-test");
	if (existsSync(dataDir)) {
		rmSync(dataDir, { recursive: true, force: true });
	}
	const orch = new Orchestrator(dataDir);
	await orch.start();

	console.log("== edge case tests ==\n");

	// ---------------------------------------------------------------------
	// BODY TESTS — round-trip a weird body through post + read_entry.
	// ---------------------------------------------------------------------

	await test("body with embedded newlines (LF)", async () => {
		const body = "line 1\nline 2\nline 3";
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-newline-a1",
			body,
			author: "tester",
		});
		assert(r.ok, `post failed: ${r.error}`);
		const e = await rpcCall(orch.socketPath, { type: "read_entry", id: r.data.id });
		assert(e.ok, `read_entry failed: ${e.error}`);
		assert(
			e.data.entry.body === body,
			`body mismatch after round-trip: ${JSON.stringify(e.data.entry.body)}`,
		);
	});

	await test("body with CRLF (Windows line endings)", async () => {
		const body = "line 1\r\nline 2\r\nline 3";
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-crlf-a1",
			body,
			author: "tester",
		});
		assert(r.ok, `post failed: ${r.error}`);
		const e = await rpcCall(orch.socketPath, { type: "read_entry", id: r.data.id });
		assert(e.ok, `read_entry failed: ${e.error}`);
		assert(
			e.data.entry.body === body,
			`body mismatch: ${JSON.stringify(e.data.entry.body)}`,
		);
	});

	await test("body with tabs and other whitespace", async () => {
		const body = "col1\tcol2\tcol3\nvalue\twith\ttabs";
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-tabs-a1",
			body,
			author: "tester",
		});
		assert(r.ok, `post failed: ${r.error}`);
		const e = await rpcCall(orch.socketPath, { type: "read_entry", id: r.data.id });
		assert(e.data.entry.body === body, `body mismatch`);
	});

	await test("body with single quotes", async () => {
		const body = "it's a 'quoted' string with apostrophes";
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-quote1-a1",
			body,
			author: "tester",
		});
		assert(r.ok, `post failed: ${r.error}`);
		const e = await rpcCall(orch.socketPath, { type: "read_entry", id: r.data.id });
		assert(e.data.entry.body === body, `body mismatch: ${JSON.stringify(e.data.entry.body)}`);
	});

	await test("body with double quotes", async () => {
		const body = 'she said "hello world" and walked away';
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-quote2-a1",
			body,
			author: "tester",
		});
		assert(r.ok, `post failed: ${r.error}`);
		const e = await rpcCall(orch.socketPath, { type: "read_entry", id: r.data.id });
		assert(e.data.entry.body === body, `body mismatch`);
	});

	await test("body with backslashes", async () => {
		const body = "path: C:\\Users\\test\\file.txt\nregex: \\d+\\s*";
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-backsl-a1",
			body,
			author: "tester",
		});
		assert(r.ok, `post failed: ${r.error}`);
		const e = await rpcCall(orch.socketPath, { type: "read_entry", id: r.data.id });
		assert(e.data.entry.body === body, `body mismatch: ${JSON.stringify(e.data.entry.body)}`);
	});

	await test("body with null bytes", async () => {
		const body = "before\0after\0null\0here";
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-nullby-a1",
			body,
			author: "tester",
		});
		assert(r.ok, `post failed: ${r.error}`);
		const e = await rpcCall(orch.socketPath, { type: "read_entry", id: r.data.id });
		assert(e.data.entry.body === body, `body mismatch: ${JSON.stringify(e.data.entry.body)}`);
	});

	await test("body with control characters", async () => {
		// \x01 through \x08 (excludes \t \n \r which we already test).
		const body = "ctrl:\x01\x02\x03\x04\x05\x06\x07\x08";
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-ctrlch-a1",
			body,
			author: "tester",
		});
		assert(r.ok, `post failed: ${r.error}`);
		const e = await rpcCall(orch.socketPath, { type: "read_entry", id: r.data.id });
		assert(e.data.entry.body === body, `body mismatch`);
	});

	await test("body with emoji (surrogate pairs)", async () => {
		const body = "celebration 🎉🚀✨ done! 👨‍👩‍👧‍👦 family";
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-emoji-a1",
			body,
			author: "tester",
		});
		assert(r.ok, `post failed: ${r.error}`);
		const e = await rpcCall(orch.socketPath, { type: "read_entry", id: r.data.id });
		assert(e.data.entry.body === body, `body mismatch: ${JSON.stringify(e.data.entry.body)}`);
	});

	await test("body with CJK (Chinese, Japanese, Korean)", async () => {
		const body = "你好世界 こんにちは 안녕하세요";
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-cjk-a1",
			body,
			author: "tester",
		});
		assert(r.ok, `post failed: ${r.error}`);
		const e = await rpcCall(orch.socketPath, { type: "read_entry", id: r.data.id });
		assert(e.data.entry.body === body, `body mismatch: ${JSON.stringify(e.data.entry.body)}`);
	});

	await test("body with RTL (Arabic, Hebrew)", async () => {
		const body = "مرحبا بالعالم שלום עולם";
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-rtl-a1",
			body,
			author: "tester",
		});
		assert(r.ok, `post failed: ${r.error}`);
		const e = await rpcCall(orch.socketPath, { type: "read_entry", id: r.data.id });
		assert(e.data.entry.body === body, `body mismatch`);
	});

	await test("body with SQL injection attempt", async () => {
		// The classic attack. With prepared statements this should just be stored as a string.
		const body = "'; DROP TABLE entries; --";
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-sqli-a1",
			body,
			author: "tester",
		});
		assert(r.ok, `post failed: ${r.error}`);
		const e = await rpcCall(orch.socketPath, { type: "read_entry", id: r.data.id });
		assert(e.data.entry.body === body, `body mismatch`);
		// Verify the table still exists.
		const count = orch.db
			.prepare("SELECT COUNT(*) AS n FROM entries")
			.get() as { n: number };
		assert(count.n > 0, `entries table should still have rows`);
	});

	await test("body with SQL injection in topic_id (should be rejected)", async () => {
		// Topic id has a strict regex, so this should be rejected by validation.
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-'; DROP",
			body: "x",
			author: "tester",
		});
		assert(!r.ok, `post with bad topic_id should have failed but returned ok`);
		assert(/convention/.test(r.error ?? ""), `error should mention convention: ${r.error}`);
	});

	await test("body with HTML/script tags (stored as-is, no XSS in TUI)", async () => {
		const body = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-html-a1",
			body,
			author: "tester",
		});
		assert(r.ok, `post failed: ${r.error}`);
		const e = await rpcCall(orch.socketPath, { type: "read_entry", id: r.data.id });
		assert(e.data.entry.body === body, `body mismatch`);
		// Note: the orchestrator doesn't render HTML. The TUI / extensions might.
		// Out of scope for this test.
	});

	await test("body with JSON literal", async () => {
		const body = '{"key": "value", "nested": [1, 2, 3], "quotes": "test"}';
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-json-a1",
			body,
			author: "tester",
		});
		assert(r.ok, `post failed: ${r.error}`);
		const e = await rpcCall(orch.socketPath, { type: "read_entry", id: r.data.id });
		assert(e.data.entry.body === body, `body mismatch`);
	});

	await test("body with markdown", async () => {
		const body = "# heading\n**bold** and *italic*\n- item 1\n- item 2\n```code block```";
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-mkd-a1",
			body,
			author: "tester",
		});
		assert(r.ok, `post failed: ${r.error}`);
		const e = await rpcCall(orch.socketPath, { type: "read_entry", id: r.data.id });
		assert(e.data.entry.body === body, `body mismatch`);
	});

	await test("body with 1MB of text (above 16KB limit, should be rejected)", async () => {
		// The orchestrator enforces a 16KB body limit. 1MB should be rejected.
		const body = "x".repeat(1024 * 1024);
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-bigbody-a1",
			body,
			author: "tester",
		}, 30000);
		assert(!r.ok, `1MB post should have been rejected`);
		assert(/body too large/.test(r.error ?? ""), `error: ${r.error}`);
		// Verify nothing was written.
		const count = orch.db
			.prepare("SELECT COUNT(*) AS n FROM entries WHERE topic_id = 'edge-bigbody-a1'")
			.get() as { n: number };
		assert(count.n === 0, `expected 0 rows, got ${count.n}`);
	});

	await test("body at 16KB boundary is accepted", async () => {
		// Exactly 16K bytes of ASCII 'x' (1 byte per char).
		const body = "x".repeat(16 * 1024);
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-ok16k-a1",
			body,
			author: "tester",
		});
		assert(r.ok, `16KB post should succeed: ${r.error}`);
	});

	await test("body just over 16KB is rejected (16K + 1 byte)", async () => {
		const body = "x".repeat(16 * 1024 + 1);
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-over16k-a1",
			body,
			author: "tester",
		});
		assert(!r.ok, `16K+1 byte should be rejected`);
	});

	await test("body with mixed weird characters (kitchen sink)", async () => {
		const body = [
			"newlines: a\nb\nc",
			"tabs:\there\tthere",
			"quotes: 'single' \"double\" `back`",
			"backslash: C:\\path\\to\\file",
			"emoji: 🎉🚀👨‍💻",
			"cjk: 你好 こんにちは",
			"rtl: مرحبا שלום",
			"sql: '; DROP TABLE x; --",
			"html: <b>bold</b>",
			"json: {\"a\":1}",
			"null: \0\0\0",
			"ctrl: \x01\x02\x03",
		].join("\n");
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-mixed-a1",
			body,
			author: "tester",
		});
		assert(r.ok, `post failed: ${r.error}`);
		const e = await rpcCall(orch.socketPath, { type: "read_entry", id: r.data.id });
		assert(
			e.data.entry.body === body,
			`body mismatch:\n  expected: ${JSON.stringify(body.slice(0, 200))}\n  got: ${JSON.stringify(e.data.entry.body.slice(0, 200))}`,
		);
	});

	// ---------------------------------------------------------------------
	// TOPIC_ID TESTS — all of these should be REJECTED by the regex.
	// ---------------------------------------------------------------------

	const badTopicIds = [
		["empty", ""],
		["uppercase", "A-b-c"],
		["emoji", "🎉-🎉-a3"],
		["with space", "a b-c-d"],
		["single segment", "abc"],
		["four segments", "a-b-c-d"],
		["too-short suffix", "a-b-1"],
		["too-long suffix", "a-b-1234567890"],
		["with newlines", "a-b-c\nDROP"],
		["with quotes", "a-'b-c"],
		["with backslash", "a-b-c\\d"],
		["with null byte", "a-b-\0c"],
		["with slash", "a-b/c-d"],
		["starts with dash", "-a-b-cd"],
		["ends with dash", "a-b-c-"],
		["only dashes", "---"],
		["only letters", "abcdef"],
		["mixed upper-lower", "A-b-c"],
	];

	for (const [label, id] of badTopicIds) {
		await test(`topic_id rejected: ${label} (${JSON.stringify(id).slice(0, 40)})`, async () => {
			const r = await rpcCall(orch.socketPath, {
				type: "post",
				topic_id: id,
				body: "x",
				author: "tester",
			});
			assert(!r.ok, `post with bad topic_id should have failed but returned ok`);
		});
	}

	// ---------------------------------------------------------------------
	// VALIDATION TESTS — empty / missing fields.
	// ---------------------------------------------------------------------

	await test("post rejected with empty body", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-emptybd-a1",
			body: "",
			author: "tester",
		});
		assert(!r.ok, `empty body should have failed`);
		assert(/body is required/.test(r.error ?? ""), `error: ${r.error}`);
	});

	await test("post rejected with missing topic_id", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			body: "x",
			author: "tester",
		});
		assert(!r.ok, `missing topic_id should have failed`);
	});

	await test("post rejected with empty author", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-noauth-a1",
			body: "x",
			author: "",
		});
		assert(!r.ok, `empty author should have failed`);
		assert(/author is required/.test(r.error ?? ""), `error: ${r.error}`);
	});

	await test("post with SQL-injecting author does not affect DB", async () => {
		// The orchestrator doesn't validate the format of `author`, but the
		// SQL is parameterized so this should be safe.
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "edge-sqlauth-a1",
			body: "x",
			author: "evil'; DROP TABLE entries; --",
		});
		assert(r.ok, `post failed: ${r.error}`);
		const e = await rpcCall(orch.socketPath, { type: "read_entry", id: r.data.id });
		assert(
			e.data.entry.author === "evil'; DROP TABLE entries; --",
			`author not stored verbatim: ${JSON.stringify(e.data.entry.author)}`,
		);
		const count = orch.db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number };
		assert(count.n > 0, `entries table should still have rows`);
	});

	// ---------------------------------------------------------------------
	// CONCURRENCY — multiple posts in quick succession.
	// ---------------------------------------------------------------------

	await test("10 sequential posts get seqs 1..10 with no gaps", async () => {
		// Truncate to a fresh topic.
		const topicId = "edge-seqconc-a1";
		const ids: number[] = [];
		for (let i = 0; i < 10; i++) {
			const r = await rpcCall(orch.socketPath, {
				type: "post",
				topic_id: topicId,
				body: `entry ${i}`,
				author: "tester",
			});
			assert(r.ok, `post ${i} failed: ${r.error}`);
			ids.push(r.data.seq);
		}
		for (let i = 0; i < 10; i++) {
			assert(ids[i] === ids[0] + i, `seq gap: expected ${ids[0] + i}, got ${ids[i]}`);
		}
	});

	// ---------------------------------------------------------------------
	// READ TESTS
	// ---------------------------------------------------------------------

	await test("read_inbox returns 0 for an agent with no topics", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "read_inbox",
			author: "ghost-agent",
		});
		assert(r.ok, `read_inbox failed: ${r.error}`);
		assert(r.data.total_new === 0, `expected 0 new, got ${r.data.total_new}`);
		assert(r.data.topics.length === 0, `expected 0 topics, got ${r.data.topics.length}`);
	});

	await test("read_entry with a UUID-shaped but non-existent id fails cleanly", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "read_entry",
			id: "00000000-0000-0000-0000-000000000000",
		});
		assert(!r.ok, `read_entry should have failed`);
		assert(/not found/.test(r.error ?? ""), `error: ${r.error}`);
	});

	await test("read_topic with non-existent topic fails cleanly", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "read_topic",
			topic_id: "no-such-topic-a1",
		});
		assert(!r.ok, `read_topic should have failed`);
		assert(/not found/.test(r.error ?? ""), `error: ${r.error}`);
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
