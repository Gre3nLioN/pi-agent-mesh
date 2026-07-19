/**
 * SQLite schema and connection.
 *
 * The schema is created up front for all stages, even though stage 1
 * only needs the empty tables to exist. This avoids migrations later.
 */

import Database, { type Database as DB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
-- Topics: the conversation container.
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  name TEXT,
  description TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('chat', 'task', 'decision', 'handoff')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'active', 'closed', 'archived')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  notify_on_post INTEGER NOT NULL DEFAULT 0
);

-- Many-to-many: which agents are involved in which topics.
CREATE TABLE IF NOT EXISTS topic_involved (
  topic_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  PRIMARY KEY (topic_id, agent_name),
  FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
);

-- Entries: a single message in a topic. Append-only log.
--
-- seq is the auto-incrementing ordering key, used by cursors and for
-- ordering reads. id is a UUID and is the external identifier the
-- LLM uses to reference specific entries.
CREATE TABLE IF NOT EXISTS entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  ts INTEGER NOT NULL,
  topic_id TEXT NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('post', 'react', 'confirmation', 'summary', 'handoff', 'checkpoint')),
  body TEXT NOT NULL,
  parent_entry TEXT,
  mentions TEXT NOT NULL DEFAULT '[]',                  -- JSON array
  requires_confirmation_from TEXT NOT NULL DEFAULT '[]' -- JSON array
);

CREATE INDEX IF NOT EXISTS idx_entries_topic_seq ON entries(topic_id, seq);
CREATE INDEX IF NOT EXISTS idx_entries_id        ON entries(id);
CREATE INDEX IF NOT EXISTS idx_entries_author   ON entries(author, seq);
CREATE INDEX IF NOT EXISTS idx_entries_parent   ON entries(parent_entry);

-- Per-agent, per-topic read cursor. Tracks the highest seq the agent
-- has already read in that topic. 0 means "hasn't read anything yet".
CREATE TABLE IF NOT EXISTS cursors (
  agent_name TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_name, topic_id)
);

-- Tracks which agents still owe a confirmation for a given request entry.
CREATE TABLE IF NOT EXISTS pending_confirmations (
  entry_id TEXT NOT NULL,
  required_agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'timed_out')),
  confirmed_at INTEGER,
  PRIMARY KEY (entry_id, required_agent)
);

CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_confirmations(status);
CREATE INDEX IF NOT EXISTS idx_pending_agent  ON pending_confirmations(required_agent, status);

-- Cost tracking: every LLM turn gets a row so the user can see
-- token usage and USD cost over time. The pi LLM SDK already
-- returns usage.cost in USD on every assistant message, so we
-- just persist it.
CREATE TABLE IF NOT EXISTS costs (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,
  topic_id TEXT,
  turn_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_input_usd REAL NOT NULL,
  cost_output_usd REAL NOT NULL,
  cost_cache_read_usd REAL NOT NULL DEFAULT 0,
  cost_cache_write_usd REAL NOT NULL DEFAULT 0,
  cost_total_usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_costs_agent_ts ON costs(agent, ts);
CREATE INDEX IF NOT EXISTS idx_costs_topic ON costs(topic_id);
CREATE INDEX IF NOT EXISTS idx_costs_turn ON costs(turn_id);

-- Nudge log: every nudge (auto or manual) is recorded so reputation
-- can compute response rates and times.
CREATE TABLE IF NOT EXISTS nudges (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,
  topic_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('auto', 'manual'))
);
CREATE INDEX IF NOT EXISTS idx_nudges_agent_ts ON nudges(agent, ts);
CREATE INDEX IF NOT EXISTS idx_nudges_topic ON nudges(topic_id);

-- Agent registry: persists the orchestrator's in-memory agent map so
-- agents that survive an orchestrator restart are still discoverable.
-- The orchestrator writes here on spawn and exit, and reconciles on
-- startup via process.kill(pid, 0). See design § D1, D2.
CREATE TABLE IF NOT EXISTS agents (
  name        TEXT PRIMARY KEY,
  pid         INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('alive', 'exited')),
  started_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
`;

/**
 * Tiny in-line migrations. Each migration is a function that takes the
 * open db and is a no-op if it has already been applied. The list is
 * checked in order on every openDb() call. Migrations are designed to
 * be cheap on the common path (a single SELECT).
 */
const MIGRATIONS: Array<{ name: string; run: (db: DB) => void }> = [
	{
		name: "add-costs-and-nudges-tables",
		run: (db) => {
			// Check if the `costs` table exists; if not, the CREATE TABLE
			// IF NOT EXISTS in SCHEMA will create it. So this migration
			// is a no-op for fresh DBs and idempotent for existing ones.
			const costsExists = db
				.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'costs'")
				.get();
			const nudgesExists = db
				.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nudges'")
				.get();
			if (costsExists && nudgesExists) return; // already applied
			// SCHEMA already created the tables via CREATE TABLE IF NOT EXISTS.
			// Nothing else to do.
		},
	},
	{
		name: "add-checkpoint-kind",
		run: (db) => {
			// Detect old kind constraint (no 'checkpoint').
			const row = db
				.prepare(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entries'",
				)
				.get() as { sql?: string } | undefined;
			if (!row || !row.sql) return;
			if (row.sql.includes("'checkpoint'")) return; // already applied
			// Recreate the entries table with the new constraint.
			// This preserves all data; the kind column gets the new
			// CHECK constraint applied to existing rows.
			db.exec(`
				BEGIN;
				CREATE TABLE entries_new (
					seq INTEGER PRIMARY KEY AUTOINCREMENT,
					id TEXT UNIQUE NOT NULL,
					ts INTEGER NOT NULL,
					topic_id TEXT NOT NULL,
					author TEXT NOT NULL,
					kind TEXT NOT NULL CHECK (kind IN ('post', 'react', 'confirmation', 'summary', 'handoff', 'checkpoint')),
					body TEXT NOT NULL,
					parent_entry TEXT,
					mentions TEXT NOT NULL DEFAULT '[]',
					requires_confirmation_from TEXT NOT NULL DEFAULT '[]',
					FOREIGN KEY (topic_id) REFERENCES topics(id)
				);
				INSERT INTO entries_new SELECT * FROM entries;
				DROP TABLE entries;
				ALTER TABLE entries_new RENAME TO entries;
				CREATE INDEX IF NOT EXISTS idx_entries_topic_seq ON entries(topic_id, seq);
				CREATE INDEX IF NOT EXISTS idx_entries_id        ON entries(id);
				CREATE INDEX IF NOT EXISTS idx_entries_author   ON entries(author, seq);
				CREATE INDEX IF NOT EXISTS idx_entries_parent   ON entries(parent_entry);
				COMMIT;
			`);
		},
	},
	{
		name: "add-rejection-kind-and-backfill",
		run: (db) => {
			// Detect whether the entries.kind CHECK constraint already
			// includes 'rejection'. If so, this migration has already
			// run; bail out.
			const row = db
				.prepare(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entries'",
				)
				.get() as { sql?: string } | undefined;
			if (!row || !row.sql) return;
			if (row.sql.includes("'rejection'")) return; // already applied

			// Recreate the entries table with 'rejection' in the CHECK
			// constraint, then backfill historical rows that were
			// written with `kind='react'` and a REQUEST_CHANGES body.
			// See design § D1, D2 in the kind-react-schema-cleanup change.
			db.exec(`
				BEGIN;
				CREATE TABLE entries_new (
					seq INTEGER PRIMARY KEY AUTOINCREMENT,
					id TEXT UNIQUE NOT NULL,
					ts INTEGER NOT NULL,
					topic_id TEXT NOT NULL,
					author TEXT NOT NULL,
					kind TEXT NOT NULL CHECK (kind IN ('post', 'react', 'confirmation', 'summary', 'handoff', 'checkpoint', 'rejection')),
					body TEXT NOT NULL,
					parent_entry TEXT,
					mentions TEXT NOT NULL DEFAULT '[]',
					requires_confirmation_from TEXT NOT NULL DEFAULT '[]',
					FOREIGN KEY (topic_id) REFERENCES topics(id)
				);
				INSERT INTO entries_new SELECT * FROM entries;
				DROP TABLE entries;
				ALTER TABLE entries_new RENAME TO entries;
				CREATE INDEX IF NOT EXISTS idx_entries_topic_seq ON entries(topic_id, seq);
				CREATE INDEX IF NOT EXISTS idx_entries_id        ON entries(id);
				CREATE INDEX IF NOT EXISTS idx_entries_author   ON entries(author, seq);
				CREATE INDEX IF NOT EXISTS idx_entries_parent   ON entries(parent_entry);

				-- Backfill: historical REQUEST_CHANGES reactions become kind='rejection'.
				UPDATE entries SET kind = 'rejection' WHERE kind = 'react' AND body LIKE '%REQUEST_CHANGES%';
				COMMIT;
			`);
		},
	},
];

export function openDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  for (const m of MIGRATIONS) m.run(db);
  return db;
}
