/**
 * @pi-agent-mesh — pi extension entry point.
 *
 * Re-exports the default function from src/peer-extension.ts so that
 * pi's package loader can find it via the manifest:
 *
 *   "pi": { "extensions": ["./index.ts"] }
 *
 * pi loads this file at startup, calls the default function with its
 * ExtensionAPI, and the extension registers all the mesh tools
 * (post, read_topic, write_checkpoint, etc.) and message handlers.
 *
 * The same code is used two ways:
 *   1. Auto-loaded by pi when this package is installed.
 *   2. Explicitly loaded by `mesh start` when spawning agent
 *      subprocesses (the CLI passes the path to the agent via flag).
 */

export { default } from "./src/peer-extension.js";