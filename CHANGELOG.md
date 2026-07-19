# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-17

### Added

- **Persistent agent registry** — agent metadata is now persisted to a new `agents` table in SQLite. The orchestrator runs a `reconcileAgents` step on startup that uses `process.kill(pid, 0)` to check liveness and marks dead agents as `'exited'`. Agents that survive an orchestrator restart are discoverable across sessions.
- **Structured handoff convention** — agents can now post a `kind='handoff'` entry with a YAML-style body that names the target agent in a `to:` field. The orchestrator validates the `to:` agent is in the topic's `topic_involved` list and routes the handoff to them. A new `request_changes` peer-extension tool records formal review rejections as `kind='rejection'` (separate from user reactions). The `react` tool continues to work for user reactions (acks, +1s).
- **Per-(agent, topic) auto-nudge** — auto-nudge now tracks a separate cooldown per (agent, topic) pair. An agent silent in N topics can be nudged up to N times per overall silence. Each nudge includes topic-specific context: the topic id, the agent's last entry in that topic, up to 3 recent entries from other agents, and a "pick one or post a status" prompt.
- **Auto-checkpoint and auto-close** — a new background tick (every 5 minutes) automatically writes a `kind='checkpoint'` entry for any open topic with 30+ entries since the last checkpoint, and auto-closes any open topic idle for 24+ hours with no live agents. Auto-generated entries use `author='orchestrator'` as a sentinel.
- **Kind-react schema cleanup** — a new `kind='rejection'` value in the `entries.kind` CHECK constraint separates formal review rejections from user reactions (which keep `kind='react'`). A one-time migration moves historical REQUEST_CHANGES reaction rows to the new kind. The `adminReputationStatus` calculation now reads from `kind='rejection'`.

### Changed

- **Orchestrator split into 4 modules** — `src/orchestrator.ts` (1394 lines) is now a thin facade plus four focused modules: `src/orchestrator/defaults.ts` (constants, types), `src/orchestrator/lifecycle.ts` (agent registry, auto-nudge, cost & reputation, persistent registry, auto topic-lifecycle), `src/orchestrator/topic-bus.ts` (entry notifications, confirmation protocol, handoff routing), and `src/orchestrator/admin.ts` (admin CLI dispatch). Public API unchanged.

### Internal

- `cli.ts` now accepts a `kind` parameter on the `post` RPC (default `'post'`, also `'handoff'`) and validates `kind='handoff'` posts at write time.
- `topic-bus.ts#handleNewEntry` parses `to:` on `kind='handoff'` entries and adds the named agent to the notify set.

## [0.1.0] - 2026-06-29

### Added

- Initial release of `@pi-agent-mesh`.
- Peer-to-peer mesh for pi agents with a durable scratchpad, topic bus, and status UI.
- Multi-agent coordination via topic-based message passing with notifications and confirmations.
- Checkpoint-based context management for long-running topics.
- Auto-nudge background tick for silent agents in open topics.
- Admin CLI for inspecting orchestrator state, agents, topics, and entries.
- Live TUI dashboard for monitoring the mesh in real time.
- SQLite-backed storage with WAL mode for durability.
- Three default agent prompt archetypes: `backend`, `frontend`, `tech-lead`.
- MIT licensed.
