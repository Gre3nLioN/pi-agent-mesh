/**
 * Test for the CLI polish: `mesh watch` and `mesh run`.
 *
 * Verifies:
 *   - `mesh run --message X` starts the orchestrator, injects, waits,
 *     stops. Returns the inject reply.
 *   - `mesh watch` connects, subscribes, and receives events when
 *     something is posted.
 *
 * Run: tsx tests/cli-polish-test.ts
 */

import { resolve, join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";

const DATA_DIR = resolve(process.cwd(), "data/cli-polish-test");

function ts(): string {
	return new Date().toISOString().slice(11, 23);
}
function log(scope: string, msg: string): void {
	process.stdout.write(`[${ts()}] [${scope}] ${msg}\n`);
}

function waitForSocket(path: string, timeoutMs = 15_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (existsSync(path)) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error(`socket ${path} never appeared`));
			setTimeout(tick, 50);
		};
		tick();
	});
}

async function startOrchestrator(agents: string[]): Promise<ChildProcess> {
	if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
	const proc = spawn("npx", [
		"tsx", "src/cli.ts", "start",
		"--data-dir", DATA_DIR,
		"--agents", agents.join(","),
	], {
		cwd: process.cwd(),
		env: { ...process.env, FORCE_COLOR: "0" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stdout?.on("data", (d) => process.stderr.write(`[orch:stdout] ${d}`));
	proc.stderr?.on("data", (d) => process.stderr.write(`[orch:stderr] ${d}`));
	await waitForSocket(join(DATA_DIR, "mesh.sock"), 15_000);
	// Let the agents fully come up.
	await new Promise((r) => setTimeout(r, 1500));
	return proc;
}

async function adminCall(socketPath: string, req: any, timeoutMs = 5000): Promise<any> {
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

async function shutdown(proc: ChildProcess): Promise<void> {
	if (proc.killed) return;
	await adminCall(join(DATA_DIR, "mesh.sock"), { type: "admin_shutdown" });
	await new Promise((r) => {
		proc.on("exit", () => r(undefined));
		setTimeout(r, 5000);
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
	console.log("== CLI polish: mesh run + mesh watch ==\n");

	await test("mesh run: one-shot start + inject + stop", async () => {
		// Use the CLI's own `run` subcommand. This spawns a new
		// orchestrator as a child process, injects, waits, stops.
		const { spawn: sp } = await import("node:child_process");
		const r = sp(
			"npx",
			[
				"tsx", "src/cli.ts", "run",
				"--data-dir", DATA_DIR + "-run",
				"--agent", "alice",
				"--message",
				"Use create_topic to make a topic 'cli-run-x1' with description 'cli run test' and initial_involved ['alice']. Then use post to write 'hello from mesh run' to that topic. Output the entry id and STOP.",
				"--wait-ms", "20000",
			],
			{ cwd: process.cwd(), env: { ...process.env, FORCE_COLOR: "0" } },
		);
		let stdout = "";
		let stderr = "";
		r.stdout.on("data", (d) => (stdout += d.toString()));
		r.stderr.on("data", (d) => (stderr += d.toString()));
		const code: number = await new Promise((resolve) => {
			r.on("exit", (c) => resolve(c ?? -1));
			setTimeout(() => {
				r.kill("SIGKILL");
				resolve(-999);
			}, 60_000);
		});
		assert(code === 0, `mesh run exited ${code}; stderr: ${stderr.slice(0, 1000)}`);
		assert(/inject reply: \{"ok":true/.test(stdout), `expected inject reply in stdout: ${stdout.slice(0, 1000)}`);
		assert(/mesh run.* orchestrator ready/.test(stdout), `expected 'orchestrator ready' in stdout`);
		assert(/mesh run.* waiting/.test(stdout), `expected 'waiting' in stdout`);
	});

	await test("mesh watch: receives events for posts", async () => {
		const proc = await startOrchestrator(["alice"]);
		const socketPath = join(DATA_DIR, "mesh.sock");

		// Open a watch socket and subscribe.
		const events: any[] = [];
		let subscribed = false;
		const sock = connect(socketPath);
		let buf = "";
		sock.on("connect", () => {
			sock.write(JSON.stringify({ type: "admin_subscribe_events" }) + "\n");
		});
		sock.on("data", (chunk) => {
			buf += chunk.toString();
			let idx: number;
			while ((idx = buf.indexOf("\n")) !== -1) {
				const raw = buf.slice(0, idx);
				buf = buf.slice(idx + 1);
				if (!subscribed) {
					subscribed = true;
					continue;
				}
				try {
					const p = JSON.parse(raw);
					if (p.type === "event" && p.data) events.push(p.data);
				} catch {
					// ignore non-JSON
				}
			}
		});

		// Give the subscribe a moment.
		await new Promise((r) => setTimeout(r, 300));

		// Inject a post via direct RPC. The post should be pushed to the watch socket.
		await adminCall(socketPath, {
			type: "post",
			topic_id: "cli-watch-w1",
			body: "x".repeat(250), // > 200 to trigger summary
			author: "alice",
		});

		// Wait for the event to arrive.
		await new Promise((r) => setTimeout(r, 500));

		sock.destroy();

		assert(events.length >= 1, `expected ≥1 event, got ${events.length}`);
		const postEvent = events.find((e) => e.kind === "post");
		assert(postEvent, `expected a 'post' event, got kinds: ${events.map((e) => e.kind).join(", ")}`);
		assert(postEvent.entry, "post event should include the entry");
		// `mesh watch` is for human operators; we send the full body so
		// they can see what the agents are saying. The summary
		// optimization only applies to read_inbox (LLM context).
		assert(
			postEvent.entry.body.length === 250,
			`watch event body should be full (250 chars), got ${postEvent.entry.body.length}`,
		);

		await shutdown(proc);
	});

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
