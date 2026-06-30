/**
 * Test that AgentProcess.send() correctly handles:
 *   - response timeout (rejects after configurable ms)
 *   - max pending cap (rejects immediately when reached)
 *   - backpressure (waits for 'drain' event if write returns false)
 *   - normal response (resolves with parsed data)
 *   - exited agent (rejects immediately)
 *
 * Uses a fake ChildProcess so we don't need a real pi binary.
 *
 * Run: npx tsx tests/agent-send-test.ts
 */

import { EventEmitter } from "node:events";
import { AgentProcess } from "../src/rpc.js";

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

/**
 * A minimal Writable that records what was written. `writeOk` lets us
 * simulate backpressure (return false). The 'drain' event is emitted
 * explicitly via emitDrain() so tests control the timing.
 */
class FakeWritable extends EventEmitter {
	writable = true;
	writeOk: boolean = true;
	writeCount = 0;
	written: string[] = [];
	write(chunk: any, cb?: (err?: Error | null) => void): boolean {
		this.writeCount++;
		if (typeof chunk === "string") this.written.push(chunk);
		if (cb) setImmediate(() => cb(null));
		return this.writeOk;
	}
	end() {
		this.emit("end");
	}
	emitDrain() {
		this.writeOk = true;
		this.emit("drain");
	}
}

class FakeChildProcess extends EventEmitter {
	stdin = new FakeWritable();
	stdout = new FakeWritable();
	stderr = new FakeWritable();
	pid = 12345;
	kill() {
		this.emit("exit", 0, null);
	}
}

function makeAgent(opts: any = {}): AgentProcess {
	const agent = new AgentProcess({ name: "test-agent", ...opts });
	const fakeProc = new FakeChildProcess();
	(agent as any).proc = fakeProc;
	(agent as any).exited = false;
	// attachStdout is normally called by start() after the real child
	// is spawned. We skip start() in unit tests and wire it up here
	// so the response parser listens to our fake stdout.
	(agent as any).attachStdout(fakeProc.stdout);
	return agent;
}

async function main(): Promise<void> {
	console.log("== agent-send tests ==\n");

	await test("send rejects with clear error after response timeout", async () => {
		const agent = makeAgent({ responseTimeoutMs: 50 });
		const start = Date.now();
		try {
			await agent.send({ type: "ping" });
			throw new Error("send should have rejected with timeout");
		} catch (e: any) {
			const elapsed = Date.now() - start;
			assert(
				/did not respond.*within 50ms/.test(e.message),
				`error message should mention timeout, got: ${e.message}`,
			);
			assert(elapsed >= 50, `should have waited at least 50ms, got ${elapsed}ms`);
			assert(elapsed < 500, `should have rejected promptly, got ${elapsed}ms`);
		}
	});

	await test("send rejects immediately when max pending is reached", async () => {
		const agent = makeAgent({ maxPending: 2 });
		// Simulate two pending requests already in flight.
		(agent as any).pending.set("a", {
			resolve: () => {},
			reject: () => {},
			command: "x",
		});
		(agent as any).pending.set("b", {
			resolve: () => {},
			reject: () => {},
			command: "x",
		});
		try {
			await agent.send({ type: "ping" });
			throw new Error("send should have rejected with overload");
		} catch (e: any) {
			assert(/overloaded/.test(e.message), `error should mention overload, got: ${e.message}`);
			assert(/2 pending/.test(e.message), `error should mention pending count: ${e.message}`);
		}
	});

	await test("send resolves with response data when agent replies", async () => {
		const agent = makeAgent({ responseTimeoutMs: 1000 });
		const fakeProc = (agent as any).proc as FakeChildProcess;
		const sendPromise = agent.send({ type: "ping" });
		// Wait one tick for the write to happen.
		await new Promise((r) => setImmediate(r));
		const written = fakeProc.stdin.written.join("");
		const parsed = JSON.parse(written.trim());
		const responseId = parsed.id;
		// Simulate the agent's response on stdout.
		fakeProc.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "response",
					id: responseId,
					command: "ping",
					success: true,
					data: { pong: 42 },
				}) + "\n",
			),
		);
		const result = (await sendPromise) as any;
		assert(result.pong === 42, `expected pong=42, got ${JSON.stringify(result)}`);
		// Pending map should be empty.
		assert((agent as any).pending.size === 0, "pending should be empty after response");
	});

	await test("send waits for 'drain' when write returns false", async () => {
		const agent = makeAgent({ responseTimeoutMs: 1000 });
		const fakeProc = (agent as any).proc as FakeChildProcess;
		fakeProc.stdin.writeOk = false;
		const sendPromise = agent.send({ type: "ping" });
		let settled = false;
		sendPromise.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		// Give a few ticks. Send should still be waiting for drain.
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		assert(!settled, "send should still be waiting for drain");
		// Now emit drain.
		fakeProc.stdin.emitDrain();
		await new Promise((r) => setImmediate(r));
		// The write should now have completed and the response timer set up.
		const written = fakeProc.stdin.written.join("");
		const parsed = JSON.parse(written.trim());
		// Send the response.
		fakeProc.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "response",
					id: parsed.id,
					command: "ping",
					success: true,
					data: { drained: true },
				}) + "\n",
			),
		);
		const result = (await sendPromise) as any;
		assert(settled, "send should have settled after drain + response");
		assert(result.drained === true, `expected drained=true, got ${JSON.stringify(result)}`);
	});

	await test("send rejects if process is exited", async () => {
		const agent = makeAgent();
		(agent as any).exited = true;
		try {
			await agent.send({ type: "ping" });
			throw new Error("send should have rejected");
		} catch (e: any) {
			assert(/has exited/.test(e.message), `error: ${e.message}`);
		}
	});

	await test("drain timeout rejects with clear error if process never drains", async () => {
		const agent = makeAgent({ responseTimeoutMs: 50 });
		const fakeProc = (agent as any).proc as FakeChildProcess;
		fakeProc.stdin.writeOk = false; // never drain
		const start = Date.now();
		try {
			await agent.send({ type: "ping" });
			throw new Error("send should have rejected with drain timeout");
		} catch (e: any) {
			const elapsed = Date.now() - start;
			assert(
				/did not drain within 50ms/.test(e.message),
				`error should mention drain timeout, got: ${e.message}`,
			);
			assert(elapsed >= 50, `should have waited at least 50ms, got ${elapsed}ms`);
		}
	});

	await test("late response after timeout is ignored (no double-settle)", async () => {
		const agent = makeAgent({ responseTimeoutMs: 50 });
		const fakeProc = (agent as any).proc as FakeChildProcess;
		const sendPromise = agent.send({ type: "ping" });
		await new Promise((r) => setImmediate(r));
		const written = fakeProc.stdin.written.join("");
		const parsed = JSON.parse(written.trim());
		const responseId = parsed.id;
		// Wait for the timeout to fire.
		try {
			await sendPromise;
			throw new Error("send should have rejected with timeout");
		} catch (e: any) {
			assert(/did not respond/.test(e.message), `timeout error: ${e.message}`);
		}
		// Now simulate a late response. Should not throw or double-settle.
		fakeProc.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "response",
					id: responseId,
					command: "ping",
					success: true,
					data: { late: true },
				}) + "\n",
			),
		);
		// Give it a tick to process.
		await new Promise((r) => setImmediate(r));
		// Pending should be empty (timeout cleaned it up).
		assert(
			(agent as any).pending.size === 0,
			`pending should be empty, got size ${(agent as any).pending.size}`,
		);
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
