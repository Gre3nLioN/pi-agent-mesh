/**
 * Test that ControlServer.start() correctly distinguishes a live
 * orchestrator from a stale socket file.
 *
 * Cases:
 *   1. Start orch A; try to start orch B in the same dir → expect
 *      "mesh already running" error and A still alive.
 *   2. Simulate a hard crash: start orch A, unlink its socket
 *      directly, then start orch B in the same dir → expect
 *      success (crash-recovery path).
 *   3. Start orch A; verify a normal RPC still works after a
 *      refused second start.
 *
 * Run: npx tsx tests/double-start-test.ts
 */

import { resolve } from "node:path";
import { rmSync, existsSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
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

async function rpcPing(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = connect(socketPath);
		const t = setTimeout(() => {
			sock.destroy();
			resolve(false);
		}, 1000);
		sock.on("connect", () => {
			sock.write(JSON.stringify({ type: "ping" }) + "\n");
		});
		let buf = "";
		sock.on("data", (c) => {
			buf += c.toString();
			const i = buf.indexOf("\n");
			if (i >= 0) {
				clearTimeout(t);
				sock.end();
				try {
					resolve(JSON.parse(buf.slice(0, i)).ok === true);
				} catch {
					resolve(false);
				}
			}
		});
		sock.on("error", () => {
			clearTimeout(t);
			resolve(false);
		});
	});
}

async function main(): Promise<void> {
	const dataDir = resolve(process.cwd(), "data/double-start-test");
	if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });

	console.log("== double-start tests ==\n");

	await test("starting a second orchestrator in the same data dir is refused with a clear error", async () => {
		const a = new Orchestrator(dataDir);
		await a.start();
		try {
			const b = new Orchestrator(dataDir);
			let threw = false;
			try {
				await b.start();
			} catch (e: any) {
				threw = true;
				assert(
					/already running/.test(e.message),
					`expected "already running" in error, got: ${e.message}`,
				);
			}
			assert(threw, "second start should have thrown");
		} finally {
			await a.shutdown();
		}
	});

	await test("crash-recovery: stale socket file is unlinked and a new orchestrator takes over", async () => {
		const a = new Orchestrator(dataDir);
		await a.start();
		const socketPath = a.socketPath;
		// Simulate a hard crash: drop the orchestrator's reference but
		// unlink the socket file directly (as if a previous orch crashed
		// and left this file behind).
		try {
			unlinkSync(socketPath);
		} catch {
			/* ignore */
		}
		// Now start a new orchestrator. The probe should report not-alive,
		// the stale file should be unlinked, and bind() should succeed.
		const b = new Orchestrator(dataDir);
		await b.start();
		try {
			assert(existsSync(socketPath), "socket file should exist after restart");
			const ok = await rpcPing(socketPath);
			assert(ok, "new orchestrator should respond to ping");
		} finally {
			await b.shutdown();
		}
	});

	await test("original orchestrator survives a refused second start", async () => {
		const a = new Orchestrator(dataDir);
		await a.start();
		try {
			const b = new Orchestrator(dataDir);
			try {
				await b.start();
			} catch {
				/* expected */
			}
			// A should still be alive and responsive.
			const ok = await rpcPing(a.socketPath);
			assert(ok, "original orchestrator should still respond to ping");
		} finally {
			await a.shutdown();
		}
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
