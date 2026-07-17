/**
 * Constants, types, and re-exports for the orchestrator module.
 *
 * This file owns the values that have no dependencies on orchestrator
 * state — pure data, interfaces, and the default system-prompt fragment
 * that every spawned agent receives.
 */

import type { AgentOpts } from "../rpc.js";

export type { AgentOpts } from "../rpc.js";

export type SpawnOpts = {
	/** Path to a peer extension to load via `-e <path>`. */
	extensionPath?: string;
	/**
	 * Text to append to the agent's system prompt via
	 * `pi --append-system-prompt`. Use this to inject mesh-specific
	 * guidance (e.g. "share large content by file path, not body").
	 */
	appendSystemPrompt?: string;
	/**
	 * Directory containing per-agent prompt files. When set, the
	 * orchestrator reads `<promptDir>/<agent-name>.md` and uses its
	 * contents as the agent's custom system prompt. If the file is
	 * missing, falls back to `appendSystemPrompt` (or the default
	 * mesh guidance if neither is set).
	 */
	promptDir?: string;
};

/**
 * Default system-prompt fragment that every spawned agent gets.
 * Tells the agent how to behave on the mesh: prefer file paths for
 * large content, mention peers explicitly when you need their
 * attention, and use the inbox/notification pattern rather than
 * polling.
 */
export const DEFAULT_MESH_GUIDANCE = `
You are part of a peer-to-peer agent mesh. Communication goes through
the orchestrator via the post / read_inbox / read_entry / create_topic /
add_to_topic / remove_from_topic tools.

Guidelines:
- Entry bodies are capped at 16KB. For larger content (logs, files,
  long code), write to the filesystem and share the path in the body.
- Use the "mentions" parameter on the post tool to ping specific
  agents by name. Mentions always send a notification and never block
  you. Prefer this for "FYI / please look" pings.
- Use "requires_confirmation_from" ONLY when you actually intend to
  block your next action on an explicit sign-off. Setting it on a
  casual ping causes a 30-60s timeout (the entry sits waiting for a
  "confirm" call that may never come), and you'll be re-notified when
  it times out. When in doubt, use "mentions" instead.

READ_INBOX-FIRST RULE:
When you receive a [mesh notify] or [mesh mention] notification,
the very first thing you do in your next turn is call read_inbox.
Do not produce a text response until you have called read_inbox at
least once. If you have nothing to add after seeing the entries,
you may produce a short text response after the read_inbox call,
but the read_inbox call must happen first. This rule is
non-negotiable: the orchestrator tracks whether you have read each
notification, and un-read notifications block downstream work.

TOOL-CALL BUDGET:
The orchestrator enforces a hard cap of 5 tool calls per turn. Your
6th tool call in a single turn will be cut off with a "budget
exhausted" error and you must respond with text only. Use your calls
wisely: the typical pattern is 1 read + 1 action + 1 ack, or 2 reads
+ 2 actions, or 1 read + 2 actions + 1 ack. If you need more than 5
calls, output a text response to end the turn; the next turn will
have a fresh budget.

TOPIC VS FILES:
A topic post is for navigation and decisions: verdicts, change
requests, milestone summaries, locked contract summaries, brief
feedback. A file (e.g. agents/<your-name>-report.md, code in the
project folder, a long-form review) is for documents: full reports,
code, review walkthroughs, anything multi-KB.
The reason is context. Every topic entry is pushed (via steer) to every
agent that has the topic open, and gets appended to their conversation
history. A 5KB topic post becomes 5KB in everyone's context. A 200-byte
topic post with a path to a file is 200 bytes plus a file the agent
reads on demand.
- **Topic posts**: short. Title + 3-10 bullets + a path if there's detail.
- **Files**: full content. The agent that needs the detail reads the file.

STEER BODY IS TRUNCATED:
When the orchestrator pushes a new topic entry to you (via the
[mesh notify] steer), it sends only a preview of the entry body
(first 1500 chars). The steer message ends with: action: call
read_inbox (or read_entry("<id>")) to see the full entry.
If you need the full body (e.g. to read a long contract doc or code
review), call read_entry("<id>") with the id from the steer. Do
not guess from the preview — the body might be cut off mid-sentence
and your response will be wrong.
If the body fits in the preview (under 1500 chars), the steer won't
say ... (no truncation indicator). When in doubt, call read_entry.

CHECKPOINTS (TIERED RETRIEVAL):
Topics grow. After 20+ entries, reading the full topic is expensive.
To keep your context small, use the checkpoint tools:
- write_checkpoint(topic_id, body, mentions?, parent_entry?): drop a
  self-contained state snapshot. Recommended structure:
  # Checkpoint N
  ## Locked decisions (the contract — re-state it so the chain is
    self-contained)
  ## Current state (done / in progress / pending)
  ## Open questions
  ## Next action (the next milestone you'll start)
  A checkpoint is a SNAPSHOT, not a delta. Reading one checkpoint +
  the entries after it should reconstruct the work state without
  needing earlier history.
- list_checkpoints(topic_id): see all checkpoints in a topic with a
  200-char preview of each. Use this to navigate: pick a checkpoint,
  then call read_entry(id) for the full body.
- read_topic defaults to a TIERED VIEW: it returns the most recent
  checkpoint + entries after it. If no checkpoint exists, it returns
  everything. Use all: true to opt into the full history (escape
  hatch for audits); use from_checkpoint: "<id>" to read a specific
  snapshot.

When to write a checkpoint:
- After finishing a milestone / phase / stage
- When a topic has 20+ entries since the last checkpoint
- Before a long, complex task that will produce a lot of entries
- When "stepping back" and the next turn will start fresh

Checkpoints are self-service: no confirmation gate, no author check.
They cannot be added to closed topics.

The orchestrator may nudge you with a hint like "this topic has
28 entries since the last checkpoint" in the steer message — that's
a soft suggestion, not a hard requirement. You decide when to
checkpoint based on your judgment.

- Don't poll read_inbox in a loop. Wait for the orchestrator to
  push you a notification; that means there's something new.
- Use the topic description to help other agents decide whether to
  subscribe to your topic.
- When handing off a conversation, transfer ownership explicitly
  via the add_to_topic / remove_from_topic tools.
`.trim();

/** Max chars of an entry body to include in a steer (push) prompt.
 *  Aggressive truncation keeps the agent's conversation history small when
 *  the topic has many large entries (e.g. contract docs, code reviews).
 *  The agent is told to call `read_entry(id)` for the full text.
 *
 *  This constant is duplicated in spirit (not value) in `peer-extension.ts`
 *  as `TOOL_BUDGET_PER_TURN`. They have to stay in sync. */
export const MAX_STEER_PREVIEW_CHARS = 1500;

/**
 * Auto-nudge configuration. When enabled, the orchestrator watches
 * each agent and sends a "please post a status" prompt to any agent
 * that has been silent for more than `afterMinutes` minutes. The
 * nudge is sent at most once per silence (so it doesn't flood).
 *
 * Defaults: enabled, 30 min, the standard nudge message.
 * Pass via `mesh start --auto-nudge-after 30` etc.
 */
export interface AutoNudgeOptions {
	/** Master switch. If false, no auto-nudging happens. */
	enabled: boolean;
	/** Threshold in minutes. An agent is nudged if their last entry
	 *  is older than this AND no nudge has been sent for the current
	 *  silence yet. Default 30. Set to 0 to disable. */
	afterMinutes: number;
	/** How often (in minutes) the background check runs. Default 1. */
	checkIntervalMinutes: number;
	/** The message sent to the agent. */
	message: string;
}

export const DEFAULT_AUTO_NUDGE_MESSAGE =
	"[mesh auto-nudge] you've been silent for a while. If you're stuck, post a status. " +
	"If you're done, post your checkpoint. If you're waiting on someone, say so. " +
	"Otherwise, the next action is yours — please continue.";

export const DEFAULT_AUTO_NUDGE: AutoNudgeOptions = {
	enabled: true,
	afterMinutes: 30,
	checkIntervalMinutes: 1,
	message: DEFAULT_AUTO_NUDGE_MESSAGE,
};
