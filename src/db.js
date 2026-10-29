import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY,
  slug       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  mission    TEXT NOT NULL DEFAULT '',
  autonomy   TEXT NOT NULL DEFAULT 'balanced',  -- ask | balanced | full
  seen_at    INTEGER NOT NULL DEFAULT 0,         -- when the human last marked the project seen
  parked     INTEGER NOT NULL DEFAULT 0,         -- the human paused it: silence is intended, no new work starts
  path       TEXT NOT NULL DEFAULT '',           -- where the code lives on disk (the main git checkout)
  next_seq   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Agents are per project: a name, what model/tool it runs on, and a one-line status.
CREATE TABLE IF NOT EXISTS agents (
  project_id  INTEGER NOT NULL,
  name        TEXT NOT NULL,
  model       TEXT NOT NULL DEFAULT '',
  client      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT '',
  signed_off  INTEGER NOT NULL DEFAULT 0,
  last_checkin INTEGER NOT NULL DEFAULT 0,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  PRIMARY KEY (project_id, name)
);

CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '',
  acceptance  TEXT NOT NULL DEFAULT '',
  stage       TEXT NOT NULL,                  -- proposed | ready | active | waiting | verifying | done | dropped
  priority    TEXT NOT NULL DEFAULT 'soon',   -- now | soon | later
  parent_id   INTEGER,
  created_by  TEXT NOT NULL,
  holder      TEXT,                           -- agent holding the lease
  lease_until INTEGER,
  last_worker TEXT,                           -- affinity: who touched it last
  implementer TEXT,                           -- who submitted it for verification
  handoff     TEXT NOT NULL DEFAULT '',       -- JSON: latest "where I left off" / "sent back because"
  touching    TEXT NOT NULL DEFAULT '[]',     -- JSON: paths the current holder says it is changing
  attempts    INTEGER NOT NULL DEFAULT 0,
  stalls      INTEGER NOT NULL DEFAULT 0,
  rejections  INTEGER NOT NULL DEFAULT 0,
  stage_since INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (project_id, seq)
);
CREATE INDEX IF NOT EXISTS items_stage ON items (project_id, stage);

CREATE TABLE IF NOT EXISTS deps (
  item_id    INTEGER NOT NULL,
  depends_on INTEGER NOT NULL,
  PRIMARY KEY (item_id, depends_on)
);

-- Every stage change, so we can show the lifecycle and where time goes.
CREATE TABLE IF NOT EXISTS transitions (
  id      INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL,
  stage   TEXT NOT NULL,
  actor   TEXT,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transitions_item ON transitions (item_id, at);

-- The record. Every event is written in layers: headline (30s), summary (5m), detail (30m).
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  item_id    INTEGER,
  actor      TEXT NOT NULL,
  type       TEXT NOT NULL,
  headline   TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  data       TEXT NOT NULL DEFAULT '{}',
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_project ON events (project_id, at);
CREATE INDEX IF NOT EXISTS events_item ON events (item_id, at);

-- Questions from agents. Non-blocking questions carry an assumption the agent proceeds with.
CREATE TABLE IF NOT EXISTS questions (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL,
  item_id       INTEGER,
  asked_by      TEXT NOT NULL,
  question      TEXT NOT NULL,
  context       TEXT NOT NULL DEFAULT '',
  detail        TEXT NOT NULL DEFAULT '',
  options       TEXT NOT NULL DEFAULT '[]',
  blocking      INTEGER NOT NULL,
  assumption    TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'open',  -- open | answered | confirmed | withdrawn
  answer        TEXT NOT NULL DEFAULT '',
  answered_by   TEXT,
  answered_at   INTEGER,
  seen_by_asker INTEGER NOT NULL DEFAULT 0,
  at            INTEGER NOT NULL
);

-- What the human says that agents must take in: steers (acknowledge once) and decisions (standing rules).
CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  item_id    INTEGER,
  kind       TEXT NOT NULL,          -- steer | decision (from the human) | learning (field notes from agents)
  target     TEXT,                   -- a steer meant for one agent only
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  at         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS acks (
  note_id  INTEGER NOT NULL,
  agent    TEXT NOT NULL,
  response TEXT NOT NULL DEFAULT '',
  at       INTEGER NOT NULL,
  PRIMARY KEY (note_id, agent)
);

CREATE TABLE IF NOT EXISTS dismissals (
  project_id INTEGER NOT NULL,
  key        TEXT NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY (project_id, key)
);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  for (const sql of [
    'ALTER TABLE notes ADD COLUMN target TEXT',
    "ALTER TABLE items ADD COLUMN touching TEXT NOT NULL DEFAULT '[]'",
    'ALTER TABLE agents ADD COLUMN last_checkin INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE projects ADD COLUMN parked INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE projects ADD COLUMN path TEXT NOT NULL DEFAULT ''",
  ]) {
    try { db.exec(sql); } catch { /* already there */ }
  }
  return db;
}
