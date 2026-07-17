/**
 * Test: --agent-prompt-dir flag and per-agent prompt file loading.
 *
 * The orchestrator should:
 *   1. Read <promptDir>/<agent-name>.md and use it as the custom prompt
 *      if the file exists.
 *   2. Fall back to opts.appendSystemPrompt if the file is missing.
 *   3. Fall back to the default mesh guidance if neither is set.
 *   4. Warn (to stderr) if the file is missing, but not error.
 *   5. File wins over explicit appendSystemPrompt if both are set, with
 *      a warning.
 *
 * These tests spawn real pi subprocesses; they verify the prompt was
 * passed to pi by inspecting AgentProcess.opts.appendSystemPrompt.
 *
 * No LLM calls are made — we just verify the prompt plumbing.
 */
import { Orchestrator } from "../src/orchestrator.js";
import { DEFAULT_MESH_GUIDANCE as DEFAULT_MESH_GUIDANCE_FROM_ORCHESTRATOR } from "../src/orchestrator/defaults.js";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail?: string): void {
	if (cond) {
		console.log(`  ✓ ${name}`);
		pass++;
	} else {
		console.error(`  ✗ ${name}${detail ? " — " + detail : ""}`);
		fail++;
	}
}

function section(name: string): void {
	console.log(`\n# ${name}`);
}

interface Harness {
	orch: Orchestrator;
	dir: string;
	promptDir: string;
	cleanup: () => Promise<void>;
}

async function makeHarness(suffix: string): Promise<Harness> {
	const dir = resolve(tmpdir(), `mesh-prompt-test-${suffix}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	const promptDir = join(dir, "agents");
	mkdirSync(promptDir, { recursive: true });
	const orch = new Orchestrator(dir);
	await orch.start();
	return {
		orch,
		dir,
		promptDir,
		cleanup: async () => {
			await orch.shutdown().catch(() => {});
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function defaultMeshFragment(): string {
	// Use the exported constant directly. The constant moved to
	// src/orchestrator/defaults.ts in the 4-way split; we import
	// it through the facade's re-export so this test stays decoupled
	// from the internal module structure.
	// (It's a stable string; we test for fragments rather than full
	// equality so this test doesn't break on cosmetic edits.)
	return DEFAULT_MESH_GUIDANCE_FROM_ORCHESTRATOR;
}

async function testFileLoaded(): Promise<void> {
	section("file loaded when present");
	const h = await makeHarness("file-loaded");
	const agentName = "alice";
	const customContent = "You are Alice, a specialist in cheese.\nYou only discuss cheese.";
	writeFileSync(join(h.promptDir, `${agentName}.md`), customContent);

	const agent = await h.orch.spawnAgent(
		{ name: agentName, provider: "minimax", model: "MiniMax-M3" },
		{ promptDir: h.promptDir },
	);

	const sent = agent.opts.appendSystemPrompt ?? "";
	ok("combined prompt includes the file content", sent.includes(customContent.trim()));
	ok("combined prompt includes DEFAULT_MESH_GUIDANCE", sent.includes(defaultMeshFragment().slice(0, 50)));
	ok("file content appears before the mesh guidance",
		sent.indexOf(customContent.trim()) < sent.indexOf(defaultMeshFragment().slice(0, 50)));

	await h.cleanup();
}

async function testFileMissingFallsBackToDefault(): Promise<void> {
	section("file missing → default mesh guidance only");
	const h = await makeHarness("file-missing");
	// No file written; just spawn.
	const agent = await h.orch.spawnAgent(
		{ name: "bob", provider: "minimax", model: "MiniMax-M3" },
		{ promptDir: h.promptDir },
	);

	const sent = agent.opts.appendSystemPrompt ?? "";
	ok("combined prompt equals DEFAULT_MESH_GUIDANCE", sent === defaultMeshFragment());

	await h.cleanup();
}

async function testFileMissingFallsBackToExplicit(): Promise<void> {
	section("file missing + explicit appendSystemPrompt → use the explicit one");
	const h = await makeHarness("file-missing-explicit");
	const explicit = "You are a generic agent.";
	const agent = await h.orch.spawnAgent(
		{ name: "carol", provider: "minimax", model: "MiniMax-M3" },
		{ promptDir: h.promptDir, appendSystemPrompt: explicit },
	);

	const sent = agent.opts.appendSystemPrompt ?? "";
	ok("explicit prompt is used", sent.includes(explicit));
	ok("default mesh guidance is still appended", sent.includes(defaultMeshFragment().slice(0, 50)));

	await h.cleanup();
}

async function testFileBeatsExplicit(): Promise<void> {
	section("file present + explicit appendSystemPrompt → file wins");
	const h = await makeHarness("file-beats-explicit");
	const fileContent = "You are a file-defined agent.";
	const explicitContent = "You are an explicit-prompt agent.";
	writeFileSync(join(h.promptDir, "dave.md"), fileContent);

	const agent = await h.orch.spawnAgent(
		{ name: "dave", provider: "minimax", model: "MiniMax-M3" },
		{ promptDir: h.promptDir, appendSystemPrompt: explicitContent },
	);

	const sent = agent.opts.appendSystemPrompt ?? "";
	ok("file content used", sent.includes(fileContent));
	ok("explicit content not used", !sent.includes(explicitContent));

	await h.cleanup();
}

async function testNoPromptDirNoExplicit(): Promise<void> {
	section("no promptDir + no appendSystemPrompt → default mesh guidance only");
	const h = await makeHarness("no-prompt");
	const agent = await h.orch.spawnAgent(
		{ name: "eve", provider: "minimax", model: "MiniMax-M3" },
	);
	const sent = agent.opts.appendSystemPrompt ?? "";
	ok("default mesh guidance only", sent === defaultMeshFragment());

	await h.cleanup();
}

async function testUnderscoreFilesIgnored(): Promise<void> {
	section("underscore-prefixed files are not loaded (template convention)");
	const h = await makeHarness("underscore");
	// Even if alice.md doesn't exist, the orchestrator should not try to
	// load _TEMPLATE.md.
	const templateContent = "This is a template, not an agent prompt.";
	writeFileSync(join(h.promptDir, "_TEMPLATE.md"), templateContent);

	const agent = await h.orch.spawnAgent(
		{ name: "frank", provider: "minimax", model: "MiniMax-M3" },
		{ promptDir: h.promptDir },
	);

	const sent = agent.opts.appendSystemPrompt ?? "";
	ok("template content not loaded", !sent.includes(templateContent));
	ok("default mesh guidance used", sent === defaultMeshFragment());

	await h.cleanup();
}

async function testMalformedPromptDir(): Promise<void> {
	section("promptDir that doesn't exist → warn, fall back to default");
	const h = await makeHarness("missing-dir");
	// No agents/ dir created; spawn with a path that doesn't exist.
	const agent = await h.orch.spawnAgent(
		{ name: "grace", provider: "minimax", model: "MiniMax-M3" },
		{ promptDir: "/tmp/definitely-does-not-exist-12345" },
	);
	const sent = agent.opts.appendSystemPrompt ?? "";
	ok("default mesh guidance used", sent === defaultMeshFragment());

	await h.cleanup();
}

async function main(): Promise<void> {
	console.log("agent-prompt-test: --agent-prompt-dir behavior");
	await testFileLoaded();
	await testFileMissingFallsBackToDefault();
	await testFileMissingFallsBackToExplicit();
	await testFileBeatsExplicit();
	await testNoPromptDirNoExplicit();
	await testUnderscoreFilesIgnored();
	await testMalformedPromptDir();
	console.log(`\nresult: ${pass} pass, ${fail} fail`);
	if (fail > 0) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
