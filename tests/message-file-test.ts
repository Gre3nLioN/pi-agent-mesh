/**
 * Test: --message-file flag and --message @file shortcut.
 *
 * The CLI should:
 *   1. With --message-file PATH, read the file and use it as the inject.
 *   2. With --message @PATH, also read the file.
 *   3. Error clearly when the file is missing.
 *   4. Prefer --message-file over --message if both are set.
 *
 * Uses waitForSocket (fast) rather than waiting for "ready" log (slow).
 * No LLM calls — just verify the CLI plumbing.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";

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

async function startOrch(dataDir: string): Promise<any> {
	const proc = spawn("npx", ["tsx", "src/cli.ts", "start", "--data-dir", dataDir, "--agents", "alice"], {
		cwd: process.cwd(),
		env: { ...process.env, FORCE_COLOR: "0" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stdout?.on("data", (d) => process.stderr.write(`[orch:stdout] ${d}`));
	proc.stderr?.on("data", (d) => process.stderr.write(`[orch:stderr] ${d}`));
	await waitForSocket(join(dataDir, "mesh.sock"), 15_000);
	// Let the orchestrator's start() promise fully resolve.
	await new Promise((r) => setTimeout(r, 200));
	return proc;
}

async function stopOrch(proc: any, dataDir: string): Promise<void> {
	const stopProc = spawn("npx", ["tsx", "src/cli.ts", "stop", "--data-dir", dataDir], {
		cwd: process.cwd(),
		env: { ...process.env, FORCE_COLOR: "0" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	await new Promise<void>((resolve) => {
		stopProc.on("exit", () => resolve());
		setTimeout(resolve, 6000);
	});
	if (proc && !proc.killed) proc.kill("SIGKILL");
}

interface Harness {
	dataDir: string;
	proc: any;
	cleanup: () => Promise<void>;
}

async function makeHarness(suffix: string): Promise<Harness> {
	const dataDir = resolve(process.cwd(), `data/msg-file-test-${suffix}-${Date.now()}`);
	mkdirSync(dataDir, { recursive: true });
	const proc = await startOrch(dataDir);
	return {
		dataDir,
		proc,
		cleanup: async () => {
			await stopOrch(proc, dataDir);
			rmSync(dataDir, { recursive: true, force: true });
		},
	};
}

async function injectViaCLI(dataDir: string, args: string[]): Promise<{ ok: boolean; out: string; err: string; code: number }> {
	return new Promise((resolve) => {
		const proc = spawn("npx", ["tsx", "src/cli.ts", "inject", "--data-dir", dataDir, ...args], {
			cwd: process.cwd(),
			env: { ...process.env, FORCE_COLOR: "0" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		proc.stdout?.on("data", (d) => { out += d.toString(); });
		proc.stderr?.on("data", (d) => { err += d.toString(); });
		proc.on("exit", (code) => resolve({ ok: code === 0, out, err, code: code ?? -1 }));
	});
}

async function testMessageFileFlag(): Promise<void> {
	section("--message-file reads from a file");
	const h = await makeHarness("msg-file");
	const filePath = "/tmp/test-message-file.txt";
	const content = "this is the message from a file\nit has multiple lines\nand special chars: \"quoted\" & <html>";
	writeFileSync(filePath, content);

	const result = await injectViaCLI(h.dataDir, [
		"--agent", "alice",
		"--message-file", filePath,
	]);
	ok("inject succeeded", result.ok, `out=${result.out} err=${result.err} code=${result.code}`);

	const parsed = JSON.parse(result.out.trim());
	ok("response is ok", parsed.ok === true);
	ok("response has data.agent", parsed.data?.agent === "alice");

	await h.cleanup();
}

async function testMessageAtShortcut(): Promise<void> {
	section("--message @PATH shortcut reads from a file");
	const h = await makeHarness("at-shortcut");
	const filePath = "/tmp/test-message-at.txt";
	const content = "shortcut message content";
	writeFileSync(filePath, content);

	const result = await injectViaCLI(h.dataDir, [
		"--agent", "alice",
		"--message", `@${filePath}`,
	]);
	ok("inject succeeded via @ shortcut", result.ok, `out=${result.out} err=${result.err}`);
	const parsed = JSON.parse(result.out.trim());
	ok("response is ok", parsed.ok === true);

	await h.cleanup();
}

async function testMessageFileMissing(): Promise<void> {
	section("--message-file with missing file errors clearly");
	const h = await makeHarness("missing");
	const result = await injectViaCLI(h.dataDir, [
		"--agent", "alice",
		"--message-file", "/tmp/definitely-does-not-exist-12345.txt",
	]);
	ok("inject failed", !result.ok);
	ok("error message mentions file not found", result.err.includes("file not found"), `err=${result.err}`);

	await h.cleanup();
}

async function testMessageFileBeatsMessage(): Promise<void> {
	section("--message-file wins over --message when both set");
	const h = await makeHarness("both");
	const filePath = "/tmp/test-both.txt";
	const fileContent = "FILE WINS";
	const inlineContent = "INLINE LOSES";
	writeFileSync(filePath, fileContent);

	const result = await injectViaCLI(h.dataDir, [
		"--agent", "alice",
		"--message", inlineContent,
		"--message-file", filePath,
	]);
	ok("inject succeeded with both flags", result.ok, `out=${result.out} err=${result.err}`);

	await h.cleanup();
}

async function testNoMessage(): Promise<void> {
	section("--message-file missing and no --message errors");
	const h = await makeHarness("no-msg");
	const result = await injectViaCLI(h.dataDir, [
		"--agent", "alice",
	]);
	ok("inject failed", !result.ok);
	ok("error mentions --message or --message-file",
		result.err.includes("--message") || result.err.includes("--message-file"),
		`err=${result.err}`);

	await h.cleanup();
}

async function testLargeMessageFromFile(): Promise<void> {
	section("large message (10KB) from a file works");
	const h = await makeHarness("large");
	const filePath = "/tmp/test-large.txt";
	// 10KB of text — bigger than typical CLI argv, but should work via --message-file.
	const content = "x".repeat(10_000);
	writeFileSync(filePath, content);

	const result = await injectViaCLI(h.dataDir, [
		"--agent", "alice",
		"--message-file", filePath,
	]);
	ok("10KB inject succeeded", result.ok, `out=${result.out.slice(0, 200)} err=${result.err}`);

	await h.cleanup();
}

async function main(): Promise<void> {
	console.log("message-file-test: --message-file / --message @file behavior");
	await testMessageFileFlag();
	await testMessageAtShortcut();
	await testMessageFileMissing();
	await testMessageFileBeatsMessage();
	await testNoMessage();
	await testLargeMessageFromFile();
	console.log(`\nresult: ${pass} pass, ${fail} fail`);
	if (fail > 0) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
