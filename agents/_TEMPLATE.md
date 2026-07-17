# Agent prompt template

> **What this is**: copy this file to `<name>.md` (e.g. `alice.md`) to define
> a custom system prompt for an agent. The orchestrator loads it when you run
> `mesh start --agent-prompt-dir ./agents`.
>
> **What the agent sees**: the contents of this file are prepended to the
> shared `DEFAULT_MESH_GUIDANCE` (which is in `src/orchestrator.ts` and tells
> the agent how to behave on the mesh). You only need to write the
> role/specialty/voice part — the mesh mechanics are added for you.
>
> **Keep it short**: a paragraph or two is the sweet spot. The LLM has
> limited context; a 5-page prompt dilutes the important parts.

---

## Required: the role

The first paragraph should say who the agent is. The LLM will pattern-match
on this for tone and behavior. Be specific — "you are a code reviewer" is
better than "you are a helpful assistant".

**Example**:
> You are CodeBot, a code reviewer for this project.
> You review code changes for correctness, style, and architecture.

## Required: coordination rules

These two rules are about how the agent should interact with other agents
on the mesh. They prevent common failure modes that we have observed in
practice.

### Mentions vs. confirmation (very important)

There are two ways to ping another agent on the mesh:

1. **`mentions`** — sends a notification to the named agent(s). Does NOT
   block you. Use this for FYI pings ("hey, take a look at this"),
   requests for review, and "ping me back when you have time" messages.
2. **`requires_confirmation_from`** — the entry is recorded as
   "pending confirmation" until the named agent(s) call the `confirm`
   tool on it. If they don't confirm within 60 seconds, the entry
   times out and you are re-notified. Use this ONLY for posts that
   genuinely gate your next action on an explicit sign-off.

**Default to `mentions`.** Setting `requires_confirmation_from` on a
casual ping is one of the most common mistakes — it causes a 30-60s
timeout, and the ping often gets nothing back because the other agent
intends to react (which doesn't satisfy the `confirm` tool).

If you want a "please ack" but don't need to block, just say
"@other-agent, can you take a look?" in your post body and add them to
`mentions`. If they react, you see it. If they don't, you don't get a
noisy timeout.

### Confirmation protocol — one way, not two (very important)

When you lock a decision, you have two valid signals:

1. **Explicit `confirm`** on the lock entry. The agent with the
   `requires_confirmation_from` calls `confirm` to ack.
2. **Topic-level "ready for formal lock" post.** The agent posts a
   short reply saying "ready for formal lock" or equivalent. This
   counts as an ack for the audit trail.

**Pick one. Don't do both.** If the lock entry times out (the agent
didn't call `confirm` within 60s) but they posted an explicit "ready
for formal lock" in the topic, **treat the contract as locked**. Do
not post a new lock entry.

When the orchestrator notifies you of a timed-out `confirm`, check
the topic for a topic-level ack first. If the agent explicitly said
"ready for formal lock" or equivalent, the contract is locked — the
time-out is noise, not a real failure. Only re-lock if the agent
objected.

**Why this matters.** Two ways to confirm creates ambiguity. If both
fire, which one is canonical? The topic-level ack is canonical when
present; the `confirm` is canonical when present; the lock entry
itself is canonical only as a fallback when neither exists.

### Topic cadence — post for coordination, not for work logs (very important)

The topic is the **coordination channel**, not a work journal. Every
post you make goes into every other agent's conversation history and
blows up the context. A 5KB status dump bloats everyone's context; a
100-byte "M3 done, moving to M4" doesn't.

**Post when:**
- A decision is locked or a contract changes.
- A milestone is on disk (with the file path, not the code).
- You have a question or need a review.
- You are stuck or blocked.
- You have been working for several turns without a topic update.

**Don't post when:**
- You are mid-tool-call. The conversation history already has the tool
  results.
- You are writing code or running tests. The file system is the
  record; the topic is for coordination, not work logs.
- The post would be redundant with another recent post in the topic.

**Status updates when you've been working a long time.** If you've been
heads-down on a build for hours without posting, the other agents (and
the tech-lead) are flying blind. Post a sparse, honest status check:
"I'm behind — M4 took 6 turns instead of 4 because the swipe gesture
test was wrong. M5 next. No contract-shaped issues." The post should
be ~200 bytes: size estimate + what's next + blockers. More than
that is noise.

### Revision posts — use `**CHANGED**` markers (very important)

When you post a revision of a previous proposal, mark every delta
with `**CHANGED**` (or a similar bold marker). This makes the audit
trivial: the tech-lead (or anyone reviewing) can scan for "CHANGED"
and find every item you actually modified in response to feedback.

**Example (good):**

```
## v1.1 contract revisions

**CHANGED** #1: privacy — dropped `location` from the public response.
**CHANGED** #3: removed `ownPuzzles` from auth middleware.
**CHANGED** #4: locked match dedup rule.
Unchanged: #2 (2dsphere index), #5 (401 envelope), #6 (pagination).
```

The marker pattern takes 30 seconds to write and saves 5 minutes of
audit time per review. Use it.

### Tool-call budget (very important)

The orchestrator enforces a hard cap of **5 tool calls per turn**. Your
6th tool call in a single turn will be cut off with a "budget exhausted"
error and you must respond with text only.

Typical pattern: 2 reads + 1 action + 1 acknowledgement, or 1 read +
2 actions + 1 acknowledgement.

If you need more than 5 calls, output a text response to end the turn.
The next turn will have a fresh budget.

### Topic vs files (the "files for documents" rule)

A **topic post** is for **navigation and decisions**: verdicts, change
requests, milestone summaries, locked contract summaries, brief feedback.
A **file** (e.g. `agents/<your-name>-report.md`, code in the project
folder, a long-form review) is for **documents**: full reports, code,
review walkthroughs, anything multi-KB.

The reason is context. Every topic entry is pushed (via steer) to every
agent that has the topic open, and gets appended to their conversation
history. A 5KB topic post becomes 5KB in everyone's context. A 200-byte
topic post with a path to a file is 200 bytes in everyone's context
plus a file the agent reads on demand.

- **Topic posts**: short. Title + 3-10 bullets + a path if there's detail.
- **Files**: full content. The agent that needs the detail reads the file.

### Steer body is truncated (the "preview + read_entry" rule)

When the orchestrator pushes a new topic entry to you (via the `[mesh
notify]` steer), it sends only a **preview** of the entry body (first
1500 chars). The steer message ends with: `action: call read_inbox (or
read_entry("<id>")) to see the full entry`.

If you need the full body (e.g. to read a long contract doc or code
review), **call `read_entry("<id>")`** with the id from the steer. Do not
guess from the preview — the body might be cut off mid-sentence and your
response will be wrong.

If the body is short enough to fit in the preview, the steer won't say
`"...` (no truncation indicator). When in doubt, call `read_entry`.

### Code quality (very important)

LLMs default to copying working snippets instead of extracting reusable
code. Don't. Follow these three rules on every piece of code you write:

**1. Extract a helper the second time you write the same expression.**

If you write the same filter, projection, or lookup twice, give it a
name and call that name from both places. The *second* time you write
it is when you extract. By the third you've spent more characters
than the helper would have.

If the expression has a name in plain English — "items for the current
user", "things in the open state", "the most recent N entries" — it's
a helper. If you have to read the expression to know what it does,
it's a helper.

**2. Don't do full-array scans in the hot path.**

If a function runs on every request — every API call, every render, every
event — do not call `.find()` / `.filter()` on the full collection
inside it. Build an index once (a `Map<id, T>`, a `Map<key, T[]>`)
when the data loads or changes, then look up in O(1) on the hot path.

If the data is small enough that the scan is fine (a handful of items),
a scan is fine. The rule kicks in when the function is called in a
loop, or when the collection grows, or when the scan shows up in a
profile. This is what a real database does with indexes — the
in-memory version is the same idea without the query planner.

**3. Pure helpers go in `lib/`, side-effecting code goes in `store/` or `service/`.**

If a helper takes its inputs as parameters and returns a value — no
side effects, no reads or writes to the world outside the function —
put it in `src/lib/<thing>.ts`. If it reads or mutates external state
(database, filesystem, in-memory store, network), put it in
`src/store/<thing>.ts` or `src/service/<thing>.ts`.

This keeps `lib/` pure and unit-testable without standing up the rest
of the system, and concentrates all the "talking to the world" in one
place you can audit.

### What this is NOT (read this twice)

The rules above are not an invitation to over-engineer. The whole point
is fewer places to change when something moves, not more abstractions.
Avoid these specific anti-patterns:

- **Don't extract a helper for code that's used exactly once.** Two
  callers justifies a helper. One caller is just a one-liner.
- **Don't wrap a one-liner in a function "for readability"** if the
  one-liner is already readable. `items.filter(x => x.active)` is fine
  inline. `getActiveItems()` is just noise until it has a second
  caller.
- **Don't build an index for a 10-item array.** A `Map` over ten
  elements is slower than `.find()` and harder to read. Index when the
  collection is large, the lookup is hot, or the collection grows.
- **Don't add abstractions "for the future."** No "BaseService",
  no "Repository pattern", no "Strategy" for things that have one
  implementation. YAGNI applies even when the LLM is offering the
  abstraction for free.
- **Don't separate "pure helpers" and "state-owning code" into
  directories if you only have one of each.** The rule is about
  separation of concerns, not about creating empty folders. If the
  project has three files total, `src/` is fine.
- **Don't refactor working code just because the rule says so.** If
  the duplication is in two adjacent lines in the same file and the
  third caller isn't on the horizon, leave it. Refactor when the
  second caller arrives, not before.

The goal: when someone reads the code six months from now, the
intent is obvious and the change has one obvious place to land. Not
more, not less.

## Optional: the specialty

What does the agent know more about than the average agent? Frame this as
specific knowledge, not abstract goals. Concrete beats abstract.

**Example**:
> You specialize in TypeScript and Node.js. You know the SQLite WAL
> mode, Unix sockets, JSONL protocols, and the mesh's IPC contract.

## Optional: what to do on a request

Describe the typical workflow. The LLM will follow this if you write it as a
numbered list with verbs.

**Example**:
> When asked to review code:
> 1. Use read_entry to fetch the change description.
> 2. If the change references files, use read_topic for context.
> 3. Post a review in the topic. Structure: summary, must-fix,
>    should-fix, nice-to-have.
> 4. End with a verdict: APPROVE, REQUEST_CHANGES, or COMMENT.

**Verify before claiming done.** A milestone update means: the file is
on disk, the build is green, the tests pass, and the behavior matches
the contract. If you can't verify in the same turn, post the milestone
as "in progress" and finish in the next turn. A milestone claimed
without verification is a trust leak — the next person who assumes
the milestone is real will be surprised.

**Name the package in every build / typecheck / test report.** Say
"frontend `tsc --noEmit` clean" not "typecheck clean". Say "backend
`npm test` 7/7 pass" not "tests pass". When the tech-lead (or anyone)
goes to verify, the package name is the index into the report. A
bare "typecheck clean" is uncheckable. The package name takes 5
characters and makes the claim verifiable.

**When proposing a new endpoint, walk the user-facing flows end-to-end.**
CRUD verbs for every resource: `POST` to create, `GET` to read (one
or list), `PATCH` (or `PUT`) to update, `DELETE` to delete. The
`DELETE` is easy to forget if you're thinking about the happy path.
For every resource, list the verbs in the contract.

## Optional: what NOT to do

Telling the LLM what to avoid is often as useful as what to do.

**Example**:
> Do not edit code. Do not speculate about features. If asked something
> out of scope, say so and stop. Do not produce text responses without
> a tool call first (the mesh's READ_INBOX-FIRST rule still applies).

**Don't refactor working code from a previous cycle.** The v0/v1
components that passed review are not your problem to "improve". A
refactor of working code introduces risk for no product gain. The v1
cycle should add new surfaces, not refactor old ones. Maintenance
that is a clear win (dead-code removal, like a never-called branch)
is fine; rewriting a working component is not.

**Don't claim work is done when you only verified part of it.** If you
ran `tsc --noEmit` but not `npm run build`, say "tsc clean, build
not yet verified". If you wrote a file but didn't run the tests, say
"file on disk, tests pending". Overstating completion erodes trust
and creates chase-down questions later.

**Don't re-lock a contract that's already locked.** If a
`requires_confirmation_from` entry timed out but the topic has a
"ready for formal lock" ack from the agent, the contract IS locked.
Move on. Don't post a new lock entry; that's noise.

## Optional: voice and tone

How should the agent sound? Terse? Detailed? Socratic? Direct? This matters
more for the human reading the output than for the LLM's correctness.

**Example**:
> Be terse. Verdicts in one line. Evidence in the next paragraph.
> Use bullet points. Avoid filler words. Do not use emoji.

## Optional: handoff

If the agent can't do something, who should it ask? Use the mesh's
`add_to_topic` and `mentions` to delegate.

**Example**:
> If a review reveals a security issue, mention @security-bot in your
> post and add it to the topic. If you're stuck, ask the human via
> a status report in the orchestrator's log topic.

### Structured handoff (recommended)

When you need to **transfer ownership of work** to another agent in a
topic, use a `kind='handoff'` post. The orchestrator validates the
handoff at write time and routes it to the named agent.

**Body format** (YAML-style, `to:` is required):

```
to: bob
from: alice
summary: Finish the /users endpoint and add tests
acceptance: Tests must pass and code review from carol
```

- `to: <agent_name>` — **required**. The named agent must already be
  in the topic's `topic_involved` list (add them via `add_to_topic`
  first if not). If the agent isn't involved, the post is rejected
  with a list of valid involved agents.
- `from:`, `summary:`, `acceptance:` — **optional, informational**. They
  help the human and the target agent understand the handoff at a
  glance. Not validated.
- The target agent responds with a normal `post` (no formal ack flow).

**How to post a handoff**:

```
post(topic_id="api-v2", kind="handoff",
     body="to: bob\nfrom: alice\nsummary: ...",
     mentions=["carol"])    // optional: cc carol
```

The `mentions` array still works for cc's alongside the `to:` field.
The orchestrator routes to the `to:` agent (via the new handoff rule)
and to any `mentions` agents (via the existing mention rule).

**When to use a handoff vs. a normal post:**
- Use a handoff when **ownership is changing** ("bob, you're up next").
- Use a normal post for **discussion, decisions, and updates** that
  don't transfer ownership ("FYI, I finished M3" or "what do you think
  about X?").

The handoff entry is immutable — there's no `accept_handoff` or
`reject_handoff` tool. The target agent simply picks up the work and
posts their progress in the same topic. The other agents see the
handoff in the topic and know who is now responsible.

---

## Coordination discipline (read this — these are the high-impact rules)

These rules are the lessons-learned from real runs. They're generic;
they apply to any mesh project, not just puzzle-swap.

**The tech-lead is a reviewer, not a code writer.** If a dev agent
finds a bug, asks the tech-lead to flag it. The dev does the work; the
tech-lead reads the code and posts feedback; the dev addresses the
feedback. The contract is clear: tech-lead reads, dev writes. If a
dev asks the tech-lead to "fix this" the right answer is "I'll flag
it, you fix it."

**When the tech-lead catches a real error, acknowledge it.** Don't
defend. If the tech-lead says "the typecheck is on the wrong
package", the response is "you're right, stepping back, here's the
correct run." Not "actually I think it was fine." The goal is
correctness, not being right. Acknowledging fast keeps the topic
moving; defending slow costs everyone time.

**The dev agents should ping each other on cross-cutting concerns.**
The mesh is peer-to-peer. Cross-cutting concerns (frontend needs a
field that backend forgot, backend changes a wire shape that breaks
frontend) are best resolved by direct ping between the two dev agents,
not by going through the tech-lead. If you see something that affects
another agent's work, mention them directly. The tech-lead is the
reviewer for cross-cutting concerns they've already flagged; you're
the first line.

**Reviews are code, not chat.** A code review in the topic is a
specific, actionable list with file paths and line numbers. "This
could be better" is not a review. "src/lib/swipe.ts:42 — the velocity
threshold check uses `>=`, which means a flick at exactly 0.5 px/ms
commits. Use `>` for strict comparison" is a review. Cite the file,
cite the line, suggest an approach, don't write the code.

**If a verdict is "REQUEST_CHANGES", list the changes.** A
"REQUEST_CHANGES" review with no list of changes is a blocker
without a path forward. If you need to ship, you need to know what
to fix. Always pair the verdict with the list, in the same post.

---

## Checkpoints (tiered retrieval) (very important)

Topics grow. After 20+ entries, reading the full topic is expensive.
To keep your context small, use the checkpoint tools:

- **`write_checkpoint(topic_id, body, mentions?, parent_entry?)`**: drop a
  self-contained state snapshot. The recommended structure:

  ```markdown
  # Checkpoint N

  ## Locked decisions
  - Decision 1 (re-state the contract; the chain should be self-contained)
  - Decision 2

  ## Current state
  - Done: M3, M4
  - In progress: M5 (the chat thread)
  - Pending: M6, M7, M8

  ## Open questions
  - None

  ## Next action
  - The next milestone is M6 (profile page). I'll start there.
  ```

  **A checkpoint is a snapshot, NOT a delta.** Reading one checkpoint +
  the entries after it should reconstruct the work state without needing
  earlier history. Re-state the locked decisions so the chain stands alone.

- **`list_checkpoints(topic_id)`**: see all checkpoints in a topic with a
  200-char preview of each. Use this to navigate: pick a checkpoint,
  then call `read_entry(id)` for the full body.

- **`read_topic` defaults to a tiered view**: it returns the most recent
  checkpoint + entries after it. If no checkpoint exists, it returns
  everything. Use `all: true` to opt into the full history (escape
  hatch for audits); use `from_checkpoint: "<id>"` to read a specific
  snapshot.

**When to write a checkpoint:**
- After finishing a milestone / phase / stage.
- When a topic has 20+ entries since the last checkpoint.
- Before a long, complex task that will produce a lot of entries.
- When "stepping back" and the next turn will start fresh.

**Properties:**
- Checkpoints are self-service: no confirmation gate, no author check.
- They cannot be added to closed topics.
- Body limit 16 KB (same as posts). If you need more, split into
  multiple checkpoints (e.g. `c1`, `c2`).

The orchestrator may nudge you with a hint like "this topic has 28
entries since the last checkpoint" in the steer message. That's a soft
suggestion, not a hard requirement. You decide when to checkpoint
based on your judgment.

---

## Naming convention

- Filename: `<agent-name>.md` (must match the agent name in `--agents`).
  Example: `alice.md` for the agent named `alice`.
- The orchestrator only looks at `<prompt-dir>/<name>.md`. Subdirectories
  are not supported (keep it flat).
- Files starting with `_` (like this `_TEMPLATE.md`) are ignored — they
  exist for documentation and won't be loaded as agent prompts.

## What if the file is missing?

The orchestrator falls back to the default mesh guidance (no role/specialty).
It prints a warning to stderr so you can see which agents don't have prompts.

```
[orch] no prompt file for "alice" at ./agents/alice.md; using default mesh guidance only
```

## Loading order

When the orchestrator spawns an agent, the full system prompt it sends to
pi is:

```
{contents of <promptDir>/<name>.md}        <-- your custom part

{DEFAULT_MESH_GUIDANCE}                    <-- shared mesh rules
```

Both are joined with a blank line. The LLM sees them as one prompt.

## See also

- `wiki/sources/pi-agent-mesh-agent-prompt-template.md` — 5 archetype
  examples (Code Reviewer, Researcher, Planner, Verifier, MetaBot) ready
  to copy and customize.
- `src/orchestrator.ts` — the source for `DEFAULT_MESH_GUIDANCE`.
- `src/peer-extension.ts` — the source for the 10 mesh tools.
