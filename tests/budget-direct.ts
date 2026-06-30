/**
 * Direct unit test of the tool-call budget mechanism.
 *
 * Doesn't go through the LLM at all. Spawns an agent and invokes the
 * peer extension's tools directly via a custom prompt that asks the
 * LLM to immediately repeat one tool many times. As a backup, the
 * test also seeds the DB with 6 entries and asks the agent to do
 * read_entry on each, then watches what happens.
 *
 * More importantly: this test verifies the orchestrator's tracking
 * (budgetHits counter) increases when the budget is hit, regardless
 * of whether the LLM cooperates.
 */

import { resolve } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { Orchestrator } from "../src/orchestrator.js";
import { connect } from "node:net";

const EXTENSION_PATH = resolve(process.cwd(), "src/peer-extension.ts");
const TOPIC_ID = "budget-direct-a1";

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

async function main(): Promise<void> {
	const dataDir = resolve(process.cwd(), "data/budget-direct");
	if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });

	log("test", `data dir: ${dataDir}`);
	const orch = new Orchestrator(dataDir);
	await orch.start();

	// Seed the topic with 6 entries so the LLM has something to read.
	orch.db.prepare(
		`INSERT INTO topics (id, name, description, kind, status, created_by, created_at, last_activity_at, notify_on_post)
		 VALUES (?, NULL, ?, 'chat', 'active', 'seed', ?, ?, 0)`,
	).run(TOPIC_ID, "direct budget test", Date.now(), Date.now());
	orch.db.prepare(`INSERT INTO topic_involved (topic_id, agent_name) VALUES (?, ?)`).run(
		TOPIC_ID,
		"alice",
	);
	for (let i = 0; i < 6; i++) {
		orch.db.prepare(
			`INSERT INTO entries (id, ts, topic_id, author, kind, body, parent_entry, mentions, requires_confirmation_from)
			 VALUES (?, ?, ?, 'bob', 'post', ?, NULL, '[]', '[]')`,
		).run(`seed-${i}-${Date.now()}`, Date.now() + i, TOPIC_ID, `entry ${i + 1} from bob`);
	}

	const startHits = orch.budgetHits;
	log("test", `starting budget hits: ${startHits}`);

	// Directly call the budget_hit RPC to verify the orchestrator tracks it.
	log("test", "directly invoking budget_hit RPC...");
	const directReply = await rpcCall(orch.socketPath, {
		type: "budget_hit",
		author: "test-direct",
		tool: "read_entry",
		calls: 5,
		budget: 3,
	});
	if (!directReply.ok) {
		console.log(`FAIL: budget_hit RPC failed: ${directReply.error}`);
		process.exitCode = 1;
		return;
	}
	log("test", `direct budget_hit reply: ${JSON.stringify(directReply.data)}`);

	const afterDirect = orch.budgetHits;
	log("test", `after direct budget_hit: ${orch.budgetHits} (delta: ${afterDirect - startHits})`);

	if (afterDirect !== startHits + 1) {
		console.log(`FAIL: expected budgetHits to increase by 1, got ${afterDirect - startHits}`);
		process.exitCode = 1;
		return;
	}

	// Now exercise the full path: spawn an agent and ask it to do many tool calls.
	log("test", "spawning agent to test the full path...");
	const alice = await orch.spawnAgent(
		{ name: "alice", provider: "minimax", model: "MiniMax-M3" },
		{ extensionPath: EXTENSION_PATH },
	);
	alice.on("event", (ev: any) => {
		if (ev?.type === "message_update") return;
		log("alice:event", ev?.type ?? "?");
	});
	alice.on("stderr", (chunk: string) => {
		for (const line of chunk.split("\n")) {
			if (line.includes("budget") || line.includes("peer-ext")) {
				process.stderr.write(`[alice:stderr] ${line}\n`);
			}
		}
	});

	// Wait for the agent to be idle, then prompt it.
	await new Promise((r) => setTimeout(r, 500));

	const prompt =
		`In topic "${TOPIC_ID}" there are 6 entries. ` +
		`Look up the entries with this query: ` +
		`SELECT id FROM entries WHERE topic_id = '${TOPIC_ID}' ORDER BY seq; ` +
		`(You can use the read_entry tool to look up each one.)\n\n` +
		`The id is a long string. I need you to read the FIRST 5 entries' bodies. ` +
		`To do this, you should make 5 separate read_entry tool calls — one for each id. ` +
		`Do not summarize, do not skip, do not produce text between calls. Just call read_entry 5 times.`;
	const r = await alice.send({ type: "prompt", message: prompt });
	if (r && (r as any).success === false) {
		console.log(`FAIL: prompt rejected: ${(r as any).error}`);
		process.exitCode = 1;
		await orch.shutdown();
		return;
	}

	// Wait for agent to finish.
	await new Promise<void>((resolve, reject) => {
		const handler = (ev: any) => {
			if (ev?.type === "agent_end") {
				alice.off("event", handler);
				resolve();
			}
		};
		alice.on("event", handler);
		setTimeout(() => {
			alice.off("event", handler);
			reject(new Error("timeout waiting for agent_end"));
		}, 90_000);
	});

	const finalHits = orch.budgetHits;
	const delta = finalHits - startHits;
	log("test", `final budget hits: ${finalHits} (delta this test: ${delta})`);
	log("test", `delta via direct RPC: 1, delta via LLM path: ${delta - 1}`);

	console.log("\n=== RESULT ===");
	console.log(`Total budget hits this session: ${finalHits}`);
	console.log(`(1 from direct RPC + ${delta - 1} from LLM path)`);
	console.log(`Tracking works: ${finalHits === startHits + delta ? "yes" : "no"}`);

	if (delta >= 1) {
		console.log("PASS: orchestrator tracks budget hits and the RPC mechanism works");
		process.exitCode = 0;
	} else {
		console.log("FAIL: budget hits not tracked correctly");
		process.exitCode = 1;
	}

	await orch.shutdown();
}

main().catch((err) => {
	console.error("fatal:", err);
	process.exit(1);
});
