#!/usr/bin/env node
/**
 * Build the pi-agent-mesh package for publishing.
 *
 * 1. Compile src/*.ts → dist/*.js (TypeScript → JavaScript)
 * 2. Compile index.ts alongside (so dist/ has a full self-contained tree)
 * 3. Copy prompts/ to dist/prompts/ (so the CLI can find them at a known
 *    relative path)
 * 4. Copy bin/mesh into place
 * 5. Make bin/mesh executable
 *
 * Run: npm run build
 */

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dist = resolve(root, "dist");
const promptsSrc = resolve(root, "prompts");
const promptsDst = resolve(dist, "prompts");
const binDst = resolve(root, "bin");

console.log("[build] cleaning dist/...");
if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

console.log("[build] copying prompts/...");
if (existsSync(promptsSrc)) {
	mkdirSync(promptsDst, { recursive: true });
	cpSync(promptsSrc, promptsDst, { recursive: true });
}

console.log("[build] ensuring bin/ exists...");
if (!existsSync(binDst)) mkdirSync(binDst, { recursive: true });

// Copy the peer-extension.ts to dist/ so the CLI can find it locally
// when running from the installed package. tsx resolves the .js import
// in index.ts to this file.
console.log("[build] copying src/peer-extension.ts → dist/peer-extension.ts...");
cpSync(resolve(root, "src", "peer-extension.ts"), resolve(dist, "peer-extension.ts"));

// Copy src/rpc.ts to dist/ — peer-extension.ts imports from "../rpc.js"
// (relative to src/) so we need rpc.js in dist/ too.
console.log("[build] copying src/rpc.ts → dist/rpc.ts...");
cpSync(resolve(root, "src", "rpc.ts"), resolve(dist, "rpc.ts"));

console.log("[build] compiling TypeScript → dist/...");
execSync(
	`npx tsc --project tsconfig.build.json`,
	{ stdio: "inherit", cwd: root },
);

console.log("[build] copying bin/mesh...");
const binMeshSrc = resolve(root, "bin", "mesh");
if (existsSync(binMeshSrc)) {
	cpSync(binMeshSrc, resolve(dist, "mesh"));
}

// The extension (src/peer-extension.ts + index.ts) ships raw .ts and is
// loaded by pi via tsx. We don't compile it. The CLI loads the raw
// .ts at runtime via findExtensionPath() in src/cli.ts.
console.log("[build] verifying dist/cli.js...");
const compiledCli = resolve(dist, "cli.js");
if (!existsSync(compiledCli)) {
	console.error(`[build] FATAL: ${compiledCli} not found after tsc`);
	process.exit(1);
}

console.log("[build] copying bin/mesh to dist/bin/...");
const binDir = resolve(dist, "bin");
mkdirSync(binDir, { recursive: true });
const binMeshDst = resolve(binDir, "mesh");
cpSync(binMeshSrc, binMeshDst);
chmodSync(binMeshDst, 0o755);

console.log("[build] done. Output:");
console.log("  " + dist);
console.log("  " + promptsDst);
console.log("  " + binMeshDst);