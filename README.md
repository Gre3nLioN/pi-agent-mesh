# `@pi-agent-mesh`

> A peer-to-peer mesh for pi agents. Durable scratchpad, topic bus, status UI, cost tracking, reputation scoring. Run a small team of LLM agents that coordinate through SQLite instead of HTTP.

[![npm version](https://badge.fury.io/js/%40pi-agent-mesh.svg)](https://www.npmjs.com/package/@pi-agent-mesh)
[![pi package](https://img.shields.io/badge/pi-package-blue)](https://pi.dev/packages)

---

## Why a mesh

Most multi-agent setups look like an org chart with one boss.
A single coordinator agent sits at the top, breaks the work into
tasks, and dispatches each task to a subagent. Subagents report
back to the coordinator. The coordinator decides the next step.
Everything flows up and down. That works for some problems, but
it has limits: it's sequential by nature, the coordinator is a
bottleneck, and subagents are isolated from each other.

A mesh is different. It's **peer-to-peer**. Every agent is a
first-class participant. They post to shared topics, read each
other's work, react, lock decisions, write checkpoints. There is
no central dispatcher — the work flows between agents directly.

What we get:

- **Parallel by default** — three agents work on three parts of
  the system at the same time. No waiting for the coordinator's
  next instruction.
- **Resilient** — if one agent goes silent, the others keep going.
  No single point of failure.
- **How real teams work** — a flat, parallel approach. Agents
  read each other's posts, react, and pick up tasks without
  being told, no top-level order; they collaborate directly.
  There is no central bottleneck routing every conversation.
- **Emergent coordination** — the right agent picks up the next
  task. (Like a research team where postdocs read papers and
  discuss findings without waiting for the PI.)
- **Auditable** — the topic is the log; every decision, every
  lock, every review is recorded.

A mesh gives LLM agents the same shape.

---

## Quickstart

```bash
# One-time install
pi install npm:@pi-agent-mesh

# Per project
mkdir my-project && cd my-project
mesh start --agents alice,bob,carol
```

That's it. Three commands. The orchestrator runs in the foreground; open another terminal for `mesh tui` to see what's happening.

---

## Key features

- **Durable scratchpad with checkpoints** — every post, reaction,
  lock, and confirmation is persisted in SQLite. The orchestrator
  can crash and restart without losing work; agents reconnect and
  pick up where they left off. Checkpoints compress the topic
  history so long-running projects don't blow up the context
  window.

- **Mixed-model agents** — each agent picks its own LLM. Run a
  cheap, fast model for the builder agents and a stronger, slower
  model for the reviewer.

- **Multi-agent review** — any agent can request review from any
  other agent in the mesh, not just the tech-lead. Two backend
  devs cross-review each other's API designs.

- **Background nudges** — silent agents get pinged automatically
  (default 30 min, once per silence). You don't need to babysit
  the mesh; the orchestrator keeps things moving.

- **Live TUI** — `mesh tui` is a real-time dashboard. Watch agents
  work, see costs accumulate, spot who's stuck.

---

## Concepts

- **Topic** — a named conversation container with metadata and a sequence of entries. Usually scoped to a project, feature, or phase.
- **Entry** — a message in a topic. Has a kind (`post`, `react`, `confirmation`, `summary`, `handoff`, `checkpoint`) and an author.
- **Agent** — an LLM subprocess with a name and a role. Spawned by the orchestrator.
- **Orchestrator** — the long-lived process that owns SQLite + the Unix socket. Runs in the background.
- **Cursors** — per-(agent, topic) read position. New entries wake the agents that haven't read them.
- **Auto-nudge** — background task that pings silent agents. Default 30 min, once per silence.
- **Checkpoint** — a self-contained state snapshot. `read_topic` returns the latest checkpoint + entries after it. Compresses context for long topics.

---

## CLI reference

### Orchestrator

```bash
mesh start --agents NAME[,NAME...] [--data-dir DIR] [--agent-prompt-dir DIR]
mesh stop [--data-dir DIR]
```

Starts or stops the orchestrator. The orchestrator is the long-lived process.

### Topic operations

```bash
mesh inject --agent NAME --message "..." [--data-dir DIR]
mesh checkpoint TOPIC --agent NAME [--body "..." | --message-file PATH]
mesh list-topics [--data-dir DIR]
mesh list-agents [--data-dir DIR]
mesh get-topic TOPIC [--data-dir DIR]
mesh get-entry ID [--data-dir DIR]
```

### Observability

```bash
mesh status [--data-dir DIR]              # one-shot snapshot
mesh tui [--data-dir DIR] [--interval N] # live TUI (default 10s refresh)
mesh cost [--agent] [--topic] [--since]  # LLM cost (tokens + USD)
mesh reputation [--json]                 # per-agent score 0-10
mesh wrap-up TOPIC [--json]              # post-mortem of a topic
```

### Development

```bash
mesh dev      # run end-to-end tests
mesh watch    # stream events as they happen
```

---

## Configuration

| Var | Default | Description |
|---|---|---|
| `MESH_DATA_DIR` | `./data` | Where the SQLite + socket live |
| `MESH_AUTO_NUDGE_AFTER` | `30` | Minutes before auto-nudge fires |
| `MESH_AUTO_NUDGE_DISABLED` | `false` | Disable auto-nudge entirely |
| `MESH_AUTO_NUDGE_MESSAGE` | (default) | Override the nudge message |
| `MESH_AUTO_NUDGE_CHECK_INTERVAL` | `1` | How often to check (minutes) |

CLI flags override env vars. Example:

```bash
mesh start --agents alice \
  --auto-nudge-after 15 \
  --auto-nudge-message "ping — anything to do?"
```

---

## Agent prompts

The mesh ships with three default prompts in `prompts/`:

- **backend** — owns API, schemas, database, auth, seed data
- **frontend** — owns UI, design system, screens, tests
- **tech-lead** — owns decisions, reviews, contract locks

To customize, copy a prompt and edit it. Place your customized version in your project's `agents/` dir and pass `--agent-prompt-dir` to `mesh start`.

### The universal rules (from `_TEMPLATE.md`)

All prompts share these (truncated):

```markdown
# What this template enforces

1. **READ_INBOX-FIRST RULE** — when an agent receives a [mesh notify]
   or [mesh mention], the very first thing it does is call `read_inbox`.

2. **MENTIONS VS CONFIRMATION** — `mentions` is a non-blocking ping;
   `requires_confirmation_from` is a gate. Use mentions for FYI,
   confirmation only when you actually intend to wait.

3. **TOPIC VS FILES** — topic posts are for navigation and decisions
   (verdicts, change requests, locked summaries). Files are for documents
   (full reports, code, review walkthroughs).

4. **CHECKPOINTS** — when finishing a phase or when context gets big,
   write a self-contained state snapshot. A checkpoint is a SNAPSHOT,
   not a delta — re-state the locked decisions so the chain stands alone.

5. **TOPIC CADENCE** — post for coordination, not for work logs.
   Don't poll `read_inbox` in a loop. Wait for the orchestrator to push.

6. **REVISION POSTS** — when posting a revision of a previous proposal,
   mark every delta with `**CHANGED**` so the audit is trivial.

7. **CODE QUALITY** — DRY, no full-array scans, pure-vs-side-effecting
   separation, write functions that are easy to test.

8. **STEER BODY IS TRUNCATED** — the orchestrator pushes previews
   (first 1500 chars). Call `read_entry("<id>")` for full text.

9. **COORDINATION DISCIPLINE** — tech-lead is a reviewer, not a code
   writer. When the TL catches a real error, acknowledge it; don't defend.
```

---

## Live TUI

```bash
$ mesh tui

pi Agent Mesh  (refresh 10s, [q]uit)

  orchestrator  ✓ running  PID 27989  uptime 4h 12m
  totals       3 open / 1 closed  17 entries  3/3 agents  0 pending
  auto-nudge   on (>30m)
  cost         $1.23  51 turns

  AGENTS
    ▶ ✓ alice        2m  Building M5 chat endpoint
      ⚠ bob          47m  Idle - waiting for review
      ✗ tech-lead    2h   OFFLINE (process down)

  TOPICS
      ✓ puzzle-v1-ship-2026   2m ago   open, 28 entries (3 ck)
      ✓ infra-bug-tracker     1d ago   open, 5 entries (0 ck)
      ✗ spike-react-native    3d ago   closed, 12 entries (1 ck)

  [↑↓] select  [n]udge  [r]esume  [enter] view  [q]uit
```

- `↑/↓` or `j/k` — select
- `n` — nudge the selected agent
- `r` — resume (sends "please continue")
- `enter` — view the selected topic
- `q` — quit

---

## Auto-nudge

By default, the orchestrator watches for silent agents and pings them after 30 minutes. The nudge:

- Fires **once per silence** (not a flood)
- Skips agents with no open topic
- Logs `[orch:auto-nudge] nudging <agent> in <topic> (silent for 31m)` to stderr
- Sends a configurable message that asks the agent to post a status or checkpoint

```bash
mesh start --agents alice \
  --auto-nudge-after 15 \
  --auto-nudge-disabled
```

---

## Cost tracking

```bash
$ mesh cost

pi Agent Mesh — costs

  totals      $1.23 USD  •  51 turns  •  6.2K input  •  0.8K output

  per agent
    frontend      $0.58  (47%)   22 turns
    backend       $0.42  (34%)   18 turns
    tech-lead     $0.23  (19%)   11 turns
```

Filter:

```bash
mesh cost --agent backend --since 1d
mesh cost --topic puzzle-v1-ship-2026
mesh cost --json | jq '.totals'
```

---

## Reputation tracking

```bash
$ mesh reputation

pi Agent Mesh — agent reputation

  agent        score  posts  cks  resp%  acc%  last-active
  tech-lead     9.70     42   12   100%   98%    14m ago
  backend       8.30     36   10    82%   95%     2m ago
  frontend      5.10     18    5    67%   88%    47m ago
```

The score is computed from checkpoint discipline, nudge responsiveness, rejection rate, and activity. It's a hint, not a verdict — use it to identify agents that need prompt or process changes.

---

## Post-mortem: `mesh wrap-up`

```bash
$ mesh wrap-up puzzle-v1-ship-2026

pi Agent Mesh — wrap-up

  topic        puzzle-v1-ship-2026
  status       closed  (sealed)
  description  puzzle-swap v1: 3-agent build
  involved     alice, bob, carol
  duration     3d 4h

  activity
    entries       28 (3 checkpoints)
    lock events   2
    reactions     8
    pace          8.6 entries/day
    longest gap   14h

  cost
    total         $1.23 USD  (51 turns)

  reputation (agents involved)
    alice        8.30  posts=14 cks=2
    bob          5.10  posts=8  cks=1
    carol        9.70  posts=6  cks=0

  verdict
    ✓ shipped cleanly — all agents scored 7+
    total cost: $1.23  •  avg reputation: 7.70/10
```

The verdict auto-classifies the run: shipped cleanly, with friction, despite problems, on track, or in progress.

---

## Possible usage

- **Distributed teams** — two teams, two meshes, bridge agents cross-posting
  between them. Like an org chart of meshes.
- **Team mimics** — a "marketing team mesh", "research team mesh",
  "engineering team mesh", each with its own roles and prompts.
- **Many agents, one project** — 10+ agents on a single complex build
  (PM + architect + backend + frontend + QA + tech-lead) in one mesh.
- **Domain libraries** — pre-built role packages for common workflows:
  research, support, content creation, code review.
- **Personal AI team** — 3-5 agents running on your laptop, persistent
  across runs, tuned to your work.

---

## License

MIT