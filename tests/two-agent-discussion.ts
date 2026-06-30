/**
 * Two-agent discussion test.
 *
 * Drives a 3-round discussion between alice (question recipient) and
 * bob (final answerer) on a given topic, then prints:
 *   - the question
 *   - the full discussion
 *   - bob's final answer
 *   - timing + entry count stats
 *
 * Usage:
 *   tsx tests/two-agent-discussion.ts "your question here"
 *   tsx tests/two-agent-discussion.ts                  # uses a default question
 */

import { resolve } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { Orchestrator } from "../src/orchestrator.js";

const DEFAULT_QUESTION =
	"In a peer-to-peer agent mesh, what is the single most important design principle " +
	"the system should follow, and why?";

const ROUNDS = 3;
const TOPIC_ID = "two-agent-disc-a1";
const EXTENSION_PATH = resolve(process.cwd(), "src/peer-extension.ts");

function ts(): string {
	return new Date().toISOString().slice(11, 23);
}
function log(scope: string, msg: string): void {
	process.stdout.write(`[${ts()}] [${scope}] ${msg}\n`);
}

async function promptAndWait(
	agent: NonNullable<ReturnType<Orchestrator["getAgent"]>>,
	message: string,
	timeoutMs: number,
): Promise<{ messages: any[] }> {
	let r: any;
	try {
		r = await agent.send({ type: "prompt", message });
	} catch (err: any) {
		if (/already processing/i.test(err?.message ?? "")) {
			log("orch", `agent busy, queuing prompt with steering`);
			await agent.send({ type: "prompt", message, streamingBehavior: "steer" });
			return waitForAgentEnd(agent, timeoutMs);
		}
		throw err;
	}
	if (r && r.success === false) {
		throw new Error(`prompt rejected: ${r.error}`);
	}
	return waitForAgentEnd(agent, timeoutMs);
}

/**
 * Wait until the agent's `isStreaming` is false AND the pendingMessageCount is 0.
 * Polls the agent's get_state every 250ms. Used between rounds so we don't
 * enqueue prompts while a notification-triggered turn is still in flight.
 */
async function waitUntilIdle(
	agent: NonNullable<ReturnType<Orchestrator["getAgent"]>>,
	timeoutMs = 30_000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const state = (await agent.send({ type: "get_state" })) as any;
		if (!state.isStreaming && (state.pendingMessageCount ?? 0) === 0) {
			return;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`timed out waiting for agent to be idle (after ${timeoutMs}ms)`);
}

async function settleBoth(alice: any, bob: any, timeoutMs = 30_000): Promise<void> {
	await Promise.all([waitUntilIdle(alice, timeoutMs), waitUntilIdle(bob, timeoutMs)]);
}

async function waitForAgentEnd(
	agent: NonNullable<ReturnType<Orchestrator["getAgent"]>>,
	timeoutMs: number,
): Promise<{ messages: any[] }> {
	return new Promise((resolve, reject) => {
		const handler = (event: any) => {
			if (event?.type === "agent_end") {
				clearTimeout(timer);
				agent.off("event", handler);
				resolve({ messages: event.messages ?? [] });
			}
		};
		const timer = setTimeout(() => {
			agent.off("event", handler);
			reject(new Error(`timed out waiting for agent_end after ${timeoutMs}ms`));
		}, timeoutMs);
		agent.on("event", handler);
	});
}

async function main(): Promise<void> {
	const question = process.argv[2] ?? DEFAULT_QUESTION;

	// Clean data dir.
	const dataDir = resolve(process.cwd(), "data/two-agent-test");
	if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });

	log("orch", `data dir: ${dataDir}`);
	log("orch", `question: ${question}`);

	const orch = new Orchestrator(dataDir);
	await orch.start();
	log("orch", `control server: ${orch.socketPath}`);

	// Spawn two agents.
	const alice = await orch.spawnAgent(
		{ name: "alice", provider: "minimax", model: "MiniMax-M3" },
		{ extensionPath: EXTENSION_PATH },
	);
	const bob = await orch.spawnAgent(
		{ name: "bob", provider: "minimax", model: "MiniMax-M3" },
		{ extensionPath: EXTENSION_PATH },
	);

	alice.on("event", (ev: any) => {
		if (ev?.type === "message_update") return;
		log("alice:event", ev?.type ?? "?");
	});
	bob.on("event", (ev: any) => {
		if (ev?.type === "message_update") return;
		log("bob:event", ev?.type ?? "?");
	});

	// --- Round 0: alice creates the topic and posts the question. ---
	log("orch", "=== round 0: alice posts the question ===");
	const t0 = Date.now();
	await promptAndWait(
		alice,
		`Do EXACTLY this, in order, with no extra steps:\n` +
			`1. Call create_topic ONCE to make a topic "${TOPIC_ID}" with description "two-agent discussion", kind "chat", initial_involved = ["alice", "bob"], AND notify_on_post = FALSE (we drive the conversation with explicit prompts to avoid notification loops).\n` +
			`2. Call post ONCE to write this question to the topic (verbatim):\n\n` +
			`"""${question}"""\n\n` +
			`3. After the post call returns, your TURN IS OVER. Do not call any other tools. Output a one-line text response with the entry id and STOP.`,
		60_000,
	);
	log("orch", "  settling both agents...");
	await settleBoth(alice, bob);

	// --- Discussion rounds. ---
	for (let round = 1; round <= ROUNDS; round++) {
		log("orch", `=== round ${round}: bob responds ===`);
		await promptAndWait(
			bob,
			`This is round ${round} of ${ROUNDS} in a discussion in topic "${TOPIC_ID}".\n` +
				`Do EXACTLY this, in order, with no extra steps:\n` +
				`1. Call read_inbox ONCE to see the new entry from alice.\n` +
				`2. Call post ONCE with your response (under 300 words, focused on the point of disagreement or addition).\n` +
				`3. After the post call returns, your TURN IS OVER. Do not call read_inbox again. Do not call post again. Do not call any other tools. Output a one-line text response with the entry id and STOP.\n` +
				`No more tool calls after the post.`,
			90_000,
		);
		log("orch", `  settling both agents...`);
		await settleBoth(alice, bob);

		log("orch", `=== round ${round}: alice replies ===`);
		await promptAndWait(
			alice,
			`This is round ${round} of ${ROUNDS} in a discussion in topic "${TOPIC_ID}".\n` +
				`Do EXACTLY this, in order, with no extra steps:\n` +
				`1. Call read_inbox ONCE to see bob's response.\n` +
				`2. Call post ONCE with your reply (under 300 words).\n` +
				`3. After the post call returns, your TURN IS OVER. Do not call read_inbox again. Do not call post again. Do not call any other tools. Output a one-line text response with the entry id and STOP.\n` +
				`No more tool calls after the post.`,
			90_000,
		);
		log("orch", `  settling both agents...`);
		await settleBoth(alice, bob);
	}

	// --- Final: bob synthesizes the discussion into a final answer. ---
	log("orch", "=== final: bob gives the answer ===");
	await promptAndWait(
		bob,
		`The 3-round discussion in topic "${TOPIC_ID}" is wrapping up. ` +
			`Do EXACTLY this, in order, with no extra steps:\n` +
			`1. Call read_topic ONCE to see the full thread (your entries and alice's entries).\n` +
			`2. Call post ONCE with your FINAL ANSWER to the original question. Make it self-contained.\n` +
			`3. After the post call returns, your TURN IS OVER. Do not call any other tools. Output a one-line text response with the entry id and STOP.`,
		90_000,
	);
	log("orch", "  settling both agents...");
	await settleBoth(alice, bob);

	const elapsed = Date.now() - t0;

	// --- Print everything. ---
	const entries = orch.db
		.prepare(
			`SELECT seq, id, author, body, ts FROM entries WHERE topic_id = ? ORDER BY seq ASC`,
		)
		.all(TOPIC_ID) as Array<{ seq: number; id: string; author: string; body: string; ts: number }>;

	const stats = {
		question,
		topicId: TOPIC_ID,
		totalEntries: entries.length,
		byAuthor: entries.reduce<Record<string, number>>((acc, e) => {
			acc[e.author] = (acc[e.author] ?? 0) + 1;
			return acc;
		}, {}),
		elapsedMs: elapsed,
	};

	console.log("\n" + "=".repeat(72));
	console.log("TWO-AGENT DISCUSSION REPORT");
	console.log("=".repeat(72));
	console.log(`\nQUESTION (asked to alice):\n  ${question}\n`);
	console.log(`TOPIC: ${TOPIC_ID}`);
	console.log(`ENTRIES: ${stats.totalEntries} (${JSON.stringify(stats.byAuthor)})`);
	console.log(`ELAPSED: ${(stats.elapsedMs / 1000).toFixed(1)}s`);

	console.log("\n--- DISCUSSION (in order) ---\n");
	for (const e of entries) {
		const preview = e.body.length > 400 ? e.body.slice(0, 400) + "..." : e.body;
		console.log(`[seq ${e.seq}] ${e.author} (${new Date(e.ts).toISOString()}):`);
		console.log(`  ${preview}`);
		console.log(`  id: ${e.id}`);
		console.log("");
	}

	// The final answer is the last bob entry (he posts it at the end).
	const finalBobEntries = entries.filter((e) => e.author === "bob");
	const finalAnswer = finalBobEntries[finalBobEntries.length - 1];
	console.log("--- BOB'S FINAL ANSWER ---\n");
	console.log(finalAnswer?.body ?? "(no final answer found)");

	console.log("\n" + "=".repeat(72));

	await orch.shutdown();
}

main().catch((err) => {
	console.error("fatal:", err);
	process.exit(1);
});
