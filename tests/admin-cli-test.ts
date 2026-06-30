/**
 * Stage 7 end-to-end test: admin CLI and manual discovery.
 *
 * Spawns the orchestrator as a child process, then drives the full
 * admin flow via the CLI subcommands:
 *   1. Start orchestrator with alice and bob pre-spawned.
 *   2. Inject a message into alice: "create topic 'T' with bob and
 *      notify_on_post=true, then post a hello message".
 *   3. Wait for alice to process.
 *   4. Verify via admin_get_topic that T exists with bob in involved.
 *   5. Inject another message: "add agent bob to topic T and post '...'".
 *   6. Verify.
 *   7. List agents and topics to confirm visibility.
 *   8. Stop the orchestrator.
 *
 * Run: tsx tests/admin-cli-test.ts
 */

import { resolve, join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";

const DATA_DIR = resolve(process.cwd(), "data/admin-cli-test");
const SOCKET_PATH = join(DATA_DIR, "mesh.sock");
const PROVIDER = "minimax";
const MODEL = "MiniMax-M3";

function ts(): string {
	return new Date().toISOString().slice(11, 23);
}
function log(scope: string, msg: string): void {
	process.stdout.write(`[${ts()}] [${scope}] ${msg}\n`);
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

function waitForSocket(path: string, timeoutMs = 10_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (existsSync(path)) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error(`socket ${path} never appeared after ${timeoutMs}ms`));
			setTimeout(tick, 50);
		};
		tick();
	});
}

interface AdminReply {
	ok: boolean;
	data?: any;
	error?: string;
}

function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const proc = spawn("npx", ["tsx", "src/cli.ts", ...args], {
			cwd: process.cwd(),
			env: { ...process.env, FORCE_COLOR: "0" },
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => (stdout += d.toString()));
		proc.stderr.on("data", (d) => (stderr += d.toString()));
		proc.on("exit", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
	});
}

/** Run the orchestrator as a foreground child process. Returns the proc and resolves when its socket appears. */
async function startOrchestrator(): Promise<ChildProcess> {
	if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });

	const proc = spawn("npx", [
		"tsx", "src/cli.ts", "start",
		"--data-dir", DATA_DIR,
		"--agents", "alice,bob",
		"--provider", PROVIDER,
		"--model", MODEL,
	], {
		cwd: process.cwd(),
		env: { ...process.env, FORCE_COLOR: "0" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stdout?.on("data", (d) => process.stdout.write(`[orch:stdout] ${d}`));
	proc.stderr?.on("data", (d) => process.stdout.write(`[orch:stderr] ${d}`));
	await waitForSocket(SOCKET_PATH, 15_000);
	return proc;
}

async function main(): Promise<void> {
	console.log("== stage 7: admin CLI and manual discovery ==\n");

	// Start the orchestrator.
	log("test", "starting orchestrator as child process...");
	const orchProc = await startOrchestrator();
	log("test", "orchestrator ready (socket appeared)");

	// Give the agents a moment to be fully ready.
	await new Promise((r) => setTimeout(r, 2000));

	try {
		// --- Step 1: list-agents shows alice and bob. ---
		await test("list-agents returns alice and bob", async () => {
			const r = await runCli("list-agents", "--data-dir", DATA_DIR);
			assert(r.code === 0, `list-agents exited ${r.code}: ${r.stderr}`);
			assert(/alice/.test(r.stdout), `expected 'alice' in stdout: ${r.stdout}`);
			assert(/bob/.test(r.stdout), `expected 'bob' in stdout: ${r.stdout}`);
		});

		// --- Step 2: inject a message to alice asking her to create a topic. ---
		await test("inject: alice creates topic 'mesh-stage7-t7p' with bob, posts 'hello bob'", async () => {
			const r = await runCli(
				"inject", "--data-dir", DATA_DIR,
				"--agent", "alice",
				"--message",
				`Use create_topic to make a topic "mesh-stage7-t7p" with description "stage 7 admin test", kind "chat", initial_involved = ["alice", "bob"], AND notify_on_post = true. Then use post to write "hello bob from injected prompt" to that topic. Output the entry id and STOP.`,
			);
			assert(r.code === 0, `inject exited ${r.code}: ${r.stderr}`);
			assert(r.stdout.includes('"ok": true'), `expected ok:true in stdout: ${r.stdout}`);
		});

		// Wait for alice to process.
		log("test", "waiting 20s for alice to process the injected message...");
		await new Promise((r) => setTimeout(r, 20_000));

		// --- Step 3: list-topics shows the new topic. ---
		await test("list-topics shows the new topic", async () => {
			const r = await runCli("list-topics", "--data-dir", DATA_DIR);
			assert(r.code === 0, `list-topics exited ${r.code}: ${r.stderr}`);
			assert(
				/mesh-stage7-t7p/.test(r.stdout),
				`expected 'mesh-stage7-t7p' in stdout: ${r.stdout}`,
			);
		});

		// --- Step 4: get-topic shows the topic with 1+ entries. ---
		await test("get-topic shows the topic with entries", async () => {
			const r = await runCli("get-topic", "mesh-stage7-t7p", "--data-dir", DATA_DIR);
			assert(r.code === 0, `get-topic exited ${r.code}: ${r.stderr}`);
			assert(
				/involved: \[alice, bob\]/.test(r.stdout),
				`expected involved list with alice and bob: ${r.stdout}`,
			);
			assert(
				/hello bob from injected prompt/.test(r.stdout),
				`expected the post body in stdout: ${r.stdout}`,
			);
		});

		// --- Step 5: get-entry works with a specific id. ---
		await test("get-entry works by id", async () => {
			// Look up the post id via get-entry directly using list-topics
			// first, then via DB to find an entry. Simpler: get-topic output
			// contains `id=xxxxxxxx` lines we can parse.
			const r = await runCli("get-topic", "mesh-stage7-t7p", "--data-dir", DATA_DIR);
			// Match the first `id=xxxxxxxx` line in the output.
			const m = r.stdout.match(/id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
			assert(m, `could not extract entry id from: ${r.stdout}`);
			const id = m![1];
			const r2 = await runCli("get-entry", id, "--data-dir", DATA_DIR);
			assert(r2.code === 0, `get-entry exited ${r2.code}: ${r2.stderr}`);
			assert(
				r2.stdout.includes(id),
				`expected entry id in get-entry output: ${r2.stdout}`,
			);
		});

		// --- Step 6: stop the orchestrator. ---
		await test("stop shuts down the orchestrator", async () => {
			const r = await runCli("stop", "--data-dir", DATA_DIR);
			assert(r.code === 0, `stop exited ${r.code}: ${r.stderr}`);
			// Wait for the orchestrator to actually exit.
			const exitCode: number = await new Promise((resolve) => {
				orchProc.on("exit", (code) => resolve(code ?? -1));
				setTimeout(() => resolve(-999), 5000); // timeout
			});
			assert(exitCode === 0 || exitCode === null, `orchestrator exited with ${exitCode}, expected 0`);
		});

		// --- Step 7: a follow-up command should now fail (no orchestrator running). ---
		await test("list-agents after stop fails (no orchestrator)", async () => {
			const r = await runCli("list-agents", "--data-dir", DATA_DIR);
			assert(r.code !== 0, `expected non-zero exit after stop, got 0`);
			assert(/not running/.test(r.stderr), `expected 'not running' in stderr: ${r.stderr}`);
		});
	} finally {
		// Make sure the orchestrator is dead, even if the test failed mid-way.
		if (!orchProc.killed) {
			orchProc.kill("SIGTERM");
			await new Promise((r) => setTimeout(r, 1000));
			if (!orchProc.killed) orchProc.kill("SIGKILL");
		}
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		console.log("\nfailures:");
		for (const f of failures) console.log(`  - ${f.name}: ${f.reason}`);
	}
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("fatal:", err);
	process.exit(1);
});
