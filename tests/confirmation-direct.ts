/**
 * Direct unit test of the confirmation protocol.
 *
 * Doesn't go through the LLM at all. Spawns one agent to receive
 * notifications, then directly invokes the orchestrator's RPCs to
 * test the full confirmation flow:
 *   - post with requires_confirmation_from
 *   - confirm by listed agent
 *   - confirm by unlisted agent (rejected)
 *   - timeout
 *   - confirm on entry that doesn't require it (rejected)
 *
 * Run: tsx tests/confirmation-direct.ts
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
	const dataDir = resolve(process.cwd(), "data/confirmation-direct");
	if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });

	log("test", `data dir: ${dataDir}`);
	const orch = new Orchestrator(dataDir);
	await orch.start();

	// Spawn one agent to receive notifications. We won't prompt it; we just
	// need it to exist in the orchestrator's agent map so notifications
	// can be sent to it.
	const alice = await orch.spawnAgent(
		{ name: "alice", provider: "minimax", model: "MiniMax-M3" },
		{ extensionPath: EXTENSION_PATH },
	);
	alice.on("stderr", (chunk: string) => {
		for (const line of chunk.split("\n")) {
			if (line.includes("orch:confirm") || line.includes("orch:budget")) {
				process.stderr.write(`[alice:stderr] ${line}\n`);
			}
		}
	});
	// Wait for the agent to be fully ready.
	await new Promise((r) => setTimeout(r, 500));

	console.log("\n== confirmation protocol tests ==\n");

	// ---------------------------------------------------------------------
	// POSITIVE FLOW
	// ---------------------------------------------------------------------

	await test("post with requires_confirmation_from creates pending rows", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "conf-test-a1",
			body: "please verify the API is up",
			author: "alice",
			requires_confirmation_from: ["bob", "carol"],
		});
		assert(r.ok, `post failed: ${r.error}`);
		assert(r.data.confirmation?.total === 2, `expected confirmation.total=2, got ${JSON.stringify(r.data.confirmation)}`);

		const pending = orch.db
			.prepare("SELECT required_agent, status FROM pending_confirmations WHERE entry_id = ?")
			.all(r.data.id) as Array<{ required_agent: string; status: string }>;
		assert(pending.length === 2, `expected 2 pending rows, got ${pending.length}`);
		assert(pending.every((p) => p.status === "pending"), `expected all status='pending'`);
	});

	await test("confirm by listed agent marks status=confirmed", async () => {
		// Find the request from the previous test.
		const request = orch.db
			.prepare("SELECT id FROM entries WHERE topic_id = ? ORDER BY seq LIMIT 1")
			.get("conf-test-a1") as { id: string };

		const r = await rpcCall(orch.socketPath, {
			type: "confirm",
			entry_id: request.id,
			author: "bob",
			body: "verified",
		});
		assert(r.ok, `confirm failed: ${r.error}`);
		assert(r.data.confirmation.confirmed_count === 1, `expected 1 confirmed, got ${r.data.confirmation.confirmed_count}`);
		assert(r.data.confirmation.total_required === 2, `expected 2 total, got ${r.data.confirmation.total_required}`);
		assert(r.data.confirmation.fully_confirmed === false, `expected fully_confirmed=false`);

		const bobStatus = orch.db
			.prepare("SELECT status FROM pending_confirmations WHERE entry_id = ? AND required_agent = ?")
			.get(request.id, "bob") as { status: string };
		assert(bobStatus.status === "confirmed", `bob status should be 'confirmed', got '${bobStatus.status}'`);
	});

	await test("idempotent re-confirm is a no-op", async () => {
		const request = orch.db
			.prepare("SELECT id FROM entries WHERE topic_id = ? ORDER BY seq LIMIT 1")
			.get("conf-test-a1") as { id: string };

		// bob confirms again
		const r = await rpcCall(orch.socketPath, {
			type: "confirm",
			entry_id: request.id,
			author: "bob",
		});
		assert(r.ok, `re-confirm failed: ${r.error}`);
		assert(r.data.confirmation.confirmed_count === 1, `re-confirm should be a no-op; got confirmed_count=${r.data.confirmation.confirmed_count}`);
	});

	await test("second confirm flips fully_confirmed=true", async () => {
		const request = orch.db
			.prepare("SELECT id FROM entries WHERE topic_id = ? ORDER BY seq LIMIT 1")
			.get("conf-test-a1") as { id: string };

		const r = await rpcCall(orch.socketPath, {
			type: "confirm",
			entry_id: request.id,
			author: "carol",
		});
		assert(r.ok, `confirm failed: ${r.error}`);
		assert(r.data.confirmation.fully_confirmed === true, `expected fully_confirmed=true`);
		assert(r.data.confirmation.confirmed_count === 2, `expected 2 confirmed`);
	});

	await test("confirmation entry was written to the log", async () => {
		// 3 confirmation entries expected: bob (initial), bob (idempotent re-confirm), carol.
		const confs = orch.db
			.prepare(
				"SELECT id, author, parent_entry, body FROM entries WHERE topic_id = ? AND kind = 'confirmation' ORDER BY seq",
			)
			.all("conf-test-a1") as Array<{ id: string; author: string; parent_entry: string; body: string }>;
		assert(confs.length === 3, `expected 3 confirmation entries (bob, bob re-confirm, carol), got ${confs.length}`);
		const request = orch.db
			.prepare("SELECT id FROM entries WHERE topic_id = ? AND kind = 'post' LIMIT 1")
			.get("conf-test-a1") as { id: string };
		assert(confs.every((c) => c.parent_entry === request.id), "all confirmations should point to the request");
		assert(confs.filter((c) => c.author === "bob").length === 2, "expected 2 confirmations from bob (incl. re-confirm)");
		assert(confs.filter((c) => c.author === "carol").length === 1, "expected 1 confirmation from carol");
	});

	// ---------------------------------------------------------------------
	// NEGATIVE CASES
	// ---------------------------------------------------------------------

	await test("confirm by unlisted agent is rejected", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "conf-test-b1",
			body: "needs confirmation from bob only",
			author: "alice",
			requires_confirmation_from: ["bob"],
		});
		assert(r.ok, `setup post failed: ${r.error}`);

		const wrong = await rpcCall(orch.socketPath, {
			type: "confirm",
			entry_id: r.data.id,
			author: "carol",
		});
		assert(!wrong.ok, "carol should not be able to confirm (not in list)");
		assert(
			/is not in the confirmation list/.test(wrong.error ?? ""),
			`error should mention "is not in the confirmation list", got: ${wrong.error}`,
		);
	});

	await test("confirm on entry that doesn't require it is rejected", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "conf-test-c1",
			body: "no confirmation needed",
			author: "alice",
		});
		assert(r.ok, `setup post failed: ${r.error}`);

		const bad = await rpcCall(orch.socketPath, {
			type: "confirm",
			entry_id: r.data.id,
			author: "bob",
		});
		assert(!bad.ok, "confirm on no-req entry should fail");
		assert(
			/does not require any confirmations/.test(bad.error ?? ""),
			`error should mention "does not require any confirmations", got: ${bad.error}`,
		);
	});

	await test("confirm on bogus entry id is rejected", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "confirm",
			entry_id: "00000000-0000-0000-0000-000000000000",
			author: "bob",
		});
		assert(!r.ok, "confirm on bogus id should fail");
		assert(/not found/.test(r.error ?? ""), `error: ${r.error}`);
	});

	// ---------------------------------------------------------------------
	// TIMEOUT
	// ---------------------------------------------------------------------

	await test("timeout: pending row flips to timed_out after the configured window", async () => {
		// Use a 1-second timeout for this test.
		orch.confirmationTimeoutMs = 1000;

		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "conf-test-d1",
			body: "bob, please verify (but I'll only wait 1s)",
			author: "alice",
			requires_confirmation_from: ["bob"],
		});
		assert(r.ok, `setup post failed: ${r.error}`);

		// Don't confirm. Wait for the timeout tick to fire (1s + a bit of slack).
		await new Promise((r) => setTimeout(r, 2000));

		const status = orch.db
			.prepare("SELECT status FROM pending_confirmations WHERE entry_id = ? AND required_agent = ?")
			.get(r.data.id, "bob") as { status: string };
		assert(status.status === "timed_out", `expected 'timed_out', got '${status.status}'`);

		// Reset the timeout for any later tests.
		orch.confirmationTimeoutMs = 60_000;
	});

	// ---------------------------------------------------------------------
	// MENTIONS
	// ---------------------------------------------------------------------

	await test("post with mentions stores them in the entry's mentions column", async () => {
		const r = await rpcCall(orch.socketPath, {
			type: "post",
			topic_id: "conf-test-e1",
			body: "@bob @carol please look",
			author: "alice",
			mentions: ["bob", "carol"],
		});
		assert(r.ok, `post failed: ${r.error}`);

		const e = orch.db
			.prepare("SELECT mentions FROM entries WHERE id = ?")
			.get(r.data.id) as { mentions: string };
		const mentions = JSON.parse(e.mentions) as string[];
		assert(
			mentions.length === 2 && mentions.includes("bob") && mentions.includes("carol"),
			`mentions should be ["bob", "carol"], got ${e.mentions}`,
		);
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
