/**
 * Test that Orchestrator.handleAgentExit() correctly removes a
 * dead agent from the registry and clears the auto-nudge
 * bookkeeping.
 *
 * Run: npx tsx tests/agent-exit-test.ts
 */

import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { rmSync, existsSync } from "node:fs";
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

async function main(): Promise<void> {
	const dataDir = resolve(process.cwd(), "data/agent-exit-test");
	if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });

	console.log("== agent-exit tests ==\n");

	await test("handleAgentExit removes the agent from the registry", async () => {
		const orch = new Orchestrator(dataDir);
		const fakeAgent = new EventEmitter();
		orch.agents.set("alice", fakeAgent as any);
		assert(orch.agents.has("alice"), "precondition: alice should be in the map");

		// Call the private method via bracket notation (testing internals
		// is the point of a unit test).
		(orch as any).handleAgentExit("alice");

		assert(!orch.agents.has("alice"), "alice should be removed after handleAgentExit");
	});

	await test("handleAgentExit clears the lastAutoNudgeAt entry", async () => {
		const orch = new Orchestrator(dataDir);
		(orch as any).lastAutoNudgeAt.set("bob", Date.now());
		assert(
			(orch as any).lastAutoNudgeAt.has("bob"),
			"precondition: bob should be in lastAutoNudgeAt",
		);

		(orch as any).handleAgentExit("bob");

		assert(
			!(orch as any).lastAutoNudgeAt.has("bob"),
			"bob should be removed from lastAutoNudgeAt after handleAgentExit",
		);
	});

	await test("handleAgentExit on unknown name is a safe no-op", async () => {
		const orch = new Orchestrator(dataDir);
		// Should not throw.
		(orch as any).handleAgentExit("never-existed");
		assert(orch.agents.size === 0, "registry should still be empty");
	});

	await test("exit event on a registered agent triggers the cleanup", async () => {
		// This is the wiring check: it simulates what spawnAgent does
		// (registers the exit listener) and verifies the chain works
		// without needing a real pi subprocess.
		const orch = new Orchestrator(dataDir);
		const fakeAgent = new EventEmitter();
		fakeAgent.on("exit", () => (orch as any).handleAgentExit("carol"));
		orch.agents.set("carol", fakeAgent as any);

		fakeAgent.emit("exit");

		assert(!orch.agents.has("carol"), "carol should be removed after exit event");
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
