/**
 * Wraps a `pi --mode rpc` subprocess.
 *
 * pi reads JSONL commands on stdin and writes JSONL events on stdout.
 * Each command can carry an `id`; the matching response has the same `id`
 * and `type: "response"`. Non-response lines are events we surface via
 * the inherited EventEmitter.
 *
 * NOTE: per pi's RPC docs, we MUST NOT use `readline` because it splits
 * on U+2028 and U+2029, which are valid inside JSON strings. We split
 * on \n manually with a buffer.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

export type AgentOpts = {
	name: string;
	provider?: string;
	model?: string;
	/** Extra env vars passed to the spawned process. */
	env?: Record<string, string>;
	/** Path to a peer extension to load via `-e <path>`. */
	extensionPath?: string;
	/** Text appended to the agent's system prompt via `--append-system-prompt`. */
	appendSystemPrompt?: string;
	/**
	 * How long to wait for the agent to respond to a `send()` call
	 * before rejecting the promise. Default 30s. Prevents unbounded
	 * growth of the pending-responses map when an agent is wedged.
	 */
	responseTimeoutMs?: number;
	/**
	 * Hard cap on the number of in-flight requests to this agent.
	 * `send()` rejects immediately when reached. Default 50. Each
	 * pending entry holds ~300 bytes; the cap bounds orchestrator
	 * memory under sustained agent unresponsiveness.
	 */
	maxPending?: number;
};

/** Default response timeout for AgentProcess.send(). */
const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;
/** Default hard cap on the number of pending responses per agent. */
const DEFAULT_MAX_PENDING = 50;
/** When pending count exceeds this, log a warning. Hard cap is `DEFAULT_MAX_PENDING`. */
const SOFT_PENDING_WARNING = 10;

export type RpcResponse = {
	id: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
};

type Pending = {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	command: string;
};

/**
 * Resolve the `pi` binary, preferring the user's actual shell PATH
 * over Node's PATH (which `tsx`/`npm exec` prepend with local
 * `node_modules/.bin` entries that can shadow the global install).
 */
function resolvePiBinary(): string {
	if (process.env.PI_BIN && process.env.PI_BIN.length > 0) {
		return process.env.PI_BIN;
	}

	// Strip any node_modules/.bin entries that npm/tsx prepended.
	// That ensures we find the user's globally-installed `pi`, not
	// a workspace-local older version.
	const userPath = (process.env.PATH ?? "")
		.split(":")
		.filter((p) => !p.includes("node_modules/.bin"))
		.join(":");

	const result = spawnSync("sh", ["-c", "command -v pi"], {
		encoding: "utf8",
		env: { ...process.env, PATH: userPath },
	});
	const found = result.stdout?.trim();
	if (!found) {
		throw new Error(
			"could not find `pi` in PATH (after stripping node_modules/.bin). " +
				"Set PI_BIN env var to its absolute path.",
		);
	}
	return found;
}

export class AgentProcess extends EventEmitter {
	readonly name: string;
	readonly opts: AgentOpts;

	private proc: ChildProcess | null = null;

	/** Process id of the underlying pi subprocess, or undefined if the
	 *  agent hasn't been started yet. Exposed for the orchestrator's
	 *  persistent agent registry (`agents` table) so reconcile can
	 *  check liveness via `process.kill(pid, 0)`. */
	get pid(): number | undefined {
		return this.proc?.pid;
	}
	private idCounter = 0;
	private pending = new Map<string, Pending>();
	private lineBuffer = "";
	private exited = false;
	private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
	private exitWaiters: Array<() => void> = [];
	private readonly responseTimeoutMs: number;
	private readonly maxPending: number;

	constructor(opts: AgentOpts) {
		super();
		this.name = opts.name;
		this.opts = opts;
		this.responseTimeoutMs = opts.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
		this.maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
	}

	/** Spawn the pi subprocess and wire up stdio. */
	async start(): Promise<void> {
		const args = ["--mode", "rpc", "--no-session", "--name", this.opts.name];
		if (this.opts.provider) args.push("--provider", this.opts.provider);
		if (this.opts.model) args.push("--model", this.opts.model);
		if (this.opts.extensionPath) args.push("-e", this.opts.extensionPath);
		if (this.opts.appendSystemPrompt) {
			args.push("--append-system-prompt", this.opts.appendSystemPrompt);
		}

		const piBin = resolvePiBinary();

		this.proc = spawn(piBin, args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...(this.opts.env ?? {}) },
		});

		const proc = this.proc;
		if (!proc.stdout || !proc.stdin || !proc.stderr) {
			throw new Error("failed to open stdio on pi subprocess");
		}

		proc.stderr.on("data", (chunk: Buffer) => {
			this.emit("stderr", chunk.toString("utf8"));
		});

		this.attachStdout(proc.stdout);

		proc.on("exit", (code, signal) => {
			this.exited = true;
			this.exitInfo = { code, signal };
			const err = new Error(
				`agent "${this.name}" exited (code=${code}, signal=${signal})`,
			);
			for (const p of this.pending.values()) {
				p.reject(err);
			}
			this.pending.clear();
			this.emit("exit", { code, signal });
			for (const w of this.exitWaiters) w();
		});

		proc.on("error", (err) => {
			this.emit("error", err);
		});
	}

	/**
	 * Buffer-based line splitter. Honors \n as the only record delimiter;
	 * strips a trailing \r if present (some pipes add CRLF).
	 */
	private attachStdout(stream: Readable): void {
		stream.on("data", (chunk: Buffer) => {
			this.lineBuffer += chunk.toString("utf8");
			let idx: number;
			while ((idx = this.lineBuffer.indexOf("\n")) !== -1) {
				const raw = this.lineBuffer.slice(0, idx);
				this.lineBuffer = this.lineBuffer.slice(idx + 1);
				const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
				if (line.length > 0) this.handleLine(line);
			}
		});
		stream.on("end", () => {
			if (this.lineBuffer.length > 0) {
				const tail = this.lineBuffer;
				this.lineBuffer = "";
				if (tail.length > 0) this.handleLine(tail);
			}
		});
	}

	private handleLine(line: string): void {
		let parsed: any;
		try {
			parsed = JSON.parse(line);
		} catch (err) {
			this.emit("parse_error", { line, error: err });
			return;
		}

		if (parsed && parsed.type === "response" && typeof parsed.id === "string") {
			const p = this.pending.get(parsed.id);
			if (!p) return; // late response for an already-cancelled request
			this.pending.delete(parsed.id);
			if (parsed.success) {
				p.resolve(parsed.data);
			} else {
				p.reject(new Error(`command "${p.command}" failed: ${parsed.error}`));
			}
			return;
		}

		// Anything else is a streamed event.
		this.emit("event", parsed);
	}

	/**
	 * Send a command and await its response. Throws if:
	 *   - the agent has exited
	 *   - stdin is not writable
	 *   - the pending-responses map is at the hard cap (rejects immediately)
	 *   - backpressure on stdin doesn't drain within `responseTimeoutMs`
	 *   - the agent doesn't respond within `responseTimeoutMs`
	 *
	 * The response timer is cleared when a reply arrives or on exit.
	 * Pending entries are bounded by `maxPending` to keep orchestrator
	 * memory under control when an agent is wedged.
	 */
	async send<T = unknown>(command: Record<string, unknown>): Promise<T> {
		if (this.exited) {
			throw new Error(`agent "${this.name}" has exited`);
		}
		const proc = this.proc;
		if (!proc || !proc.stdin || !proc.stdin.writable) {
			throw new Error(`agent "${this.name}" stdin not writable`);
		}

		// Hard cap on the number of in-flight requests. Prevents memory
		// growth when the agent is wedged: every caller sees a clear
		// "overloaded" error instead of silently queuing.
		if (this.pending.size >= this.maxPending) {
			throw new Error(
				`agent "${this.name}" overloaded (${this.pending.size} pending); ` +
					`max ${this.maxPending}, try again later`,
			);
		}

		// Soft warning when the pending count is climbing but not yet at
		// the cap. Gives the operator visibility into a degrading agent.
		if (this.pending.size > SOFT_PENDING_WARNING) {
			process.stderr.write(
				`[mesh-rpc] agent "${this.name}" has ${this.pending.size} pending responses\n`,
			);
		}

		const id = String(++this.idCounter);
		const line = JSON.stringify({ id, ...command }) + "\n";

		// Backpressure: if the write can't be accepted (kernel pipe full
		// or stream's internal buffer above high-water mark), wait for
		// 'drain' before queuing more. Race against the response timeout
		// so a permanently-hung agent doesn't block the caller forever.
		const writeOk = proc.stdin.write(line);
		if (!writeOk) {
			await Promise.race<void>([
				new Promise<void>((resolve) => proc.stdin!.once("drain", () => resolve())),
				new Promise<void>((_, reject) => {
					setTimeout(
						() =>
							reject(
								new Error(
									`agent "${this.name}" stdin did not drain within ${this.responseTimeoutMs}ms (process likely hung)`,
								),
							),
						this.responseTimeoutMs,
					);
				}),
			]);
		}

		// Set up the response promise + timer. The timer rejects if the
		// agent doesn't reply within `responseTimeoutMs`. The wrapper
		// resolve/reject clear the timer on success/normal-failure paths
		// (exit handler clears via the same wrapper).
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) {
					process.stderr.write(
						`[mesh-rpc] agent "${this.name}" did not respond to command ` +
							`"${String(command.type ?? "?")}" within ${this.responseTimeoutMs}ms; ` +
							`pending=${this.pending.size}\n`,
					);
					reject(
						new Error(
							`agent "${this.name}" did not respond to command ` +
								`"${String(command.type ?? "?")}" within ${this.responseTimeoutMs}ms`,
						),
					);
				}
			}, this.responseTimeoutMs);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v as T);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
				command: String(command.type ?? "?"),
			});
		});
	}

	/** Wait for the agent process to exit. */
	waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
		if (this.exited && this.exitInfo) return Promise.resolve(this.exitInfo);
		return new Promise((resolve) => {
			this.exitWaiters.push(() => resolve(this.exitInfo!));
		});
	}

	/** Graceful shutdown: send abort, close stdin, wait for exit, force-kill on timeout. */
	async shutdown(timeoutMs = 5000): Promise<void> {
		if (!this.proc || this.exited) return;

		try {
			await this.send({ type: "abort" });
		} catch {
			// already exiting; ignore
		}

		try {
			this.proc.stdin?.end();
		} catch {
			// ignore
		}

		const exited = this.waitForExit();
		const timeout = new Promise<void>((_, reject) =>
			setTimeout(() => reject(new Error("shutdown timeout")), timeoutMs),
		);
		try {
			await Promise.race([exited, timeout]);
		} catch {
			this.proc?.kill("SIGTERM");
			await this.waitForExit().catch(() => {});
		}
	}
}
