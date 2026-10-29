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
  runner     INTEGER NOT NULL DEFAULT 0,         -- the human lets "trellis run" start headless workers here
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
  tokens      TEXT NOT NULL DEFAULT '',        -- names of the tokens that have acted as this agent
  token_id    INTEGER,                        -- the agent token it last called with (required mode)
  has         TEXT NOT NULL DEFAULT '[]',     -- JSON: what the agent's machine can do, e.g. ["docker", "macos"]
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
  needs       TEXT NOT NULL DEFAULT '[]',     -- JSON: tags an agent must have to take it, e.g. ["docker"]
  size        TEXT NOT NULL DEFAULT '',       -- '' | small | large
  attempts    INTEGER NOT NULL DEFAULT 0,
  stalls      INTEGER NOT NULL DEFAULT 0,
  rejections  INTEGER NOT NULL DEFAULT 0,
  race        INTEGER NOT NULL DEFAULT 1,     -- how many agents may attempt it at once (>1: leases live in attempts)
  stage_since INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (project_id, seq)
);
CREATE INDEX IF NOT EXISTS items_stage ON items (project_id, stage);

-- Race items: one row per agent attempting it, each with its own lease. Non-race items never use this.
CREATE TABLE IF NOT EXISTS attempts (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL,
  agent       TEXT NOT NULL,
  model       TEXT NOT NULL DEFAULT '',
  stage       TEXT NOT NULL DEFAULT 'active',  -- active | submitted | abandoned
  lease_until INTEGER,
  touching    TEXT NOT NULL DEFAULT '[]',
  submission  INTEGER,                         -- the 'submitted' event
  closed      INTEGER NOT NULL DEFAULT 0,      -- 1 once the item leaves this race round (back to ready, done, dropped)
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_item ON attempts (item_id, closed);

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

-- The humans, when there are accounts (src/auth.js manages them). None in local mode: the one human is "you".
CREATE TABLE IF NOT EXISTS people (
  id         INTEGER PRIMARY KEY,
  handle     TEXT UNIQUE NOT NULL,        -- acts as "@handle" on the record
  name       TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL,               -- owner | steward | member | viewer
  created_at INTEGER NOT NULL
);
-- Who looks after a project: its "needs you" entries go to them (else to the owners and stewards).
CREATE TABLE IF NOT EXISTS project_stewards (
  project_id INTEGER NOT NULL,
  handle     TEXT NOT NULL,
  PRIMARY KEY (project_id, handle)
);

CREATE TABLE IF NOT EXISTS dismissals (
  project_id INTEGER NOT NULL,
  key        TEXT NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY (project_id, key)
);

-- The git repositories a project is (normalized remotes: github.com/acme/api). One repository, one project.
CREATE TABLE IF NOT EXISTS project_remotes (
  project_id INTEGER NOT NULL,
  remote     TEXT UNIQUE NOT NULL,
  at         INTEGER NOT NULL
);

-- Push channels (hub-wide) and which act-level attention entries were already pushed (src/notify.js).
CREATE TABLE IF NOT EXISTS channels (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,                -- ntfy | slack | webhook
  url           TEXT UNIQUE NOT NULL,         -- holds the secret: never shown back in full
  failing_since INTEGER,
  last_error    TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notified (
  project_id INTEGER NOT NULL,
  key        TEXT NOT NULL,
  at         INTEGER NOT NULL,
  seen_at    INTEGER NOT NULL,                -- last time the entry was still there
  PRIMARY KEY (project_id, key)
);

-- GitHub pull requests linked to items, and CI results per commit (src/github.js).
CREATE TABLE IF NOT EXISTS prs (
  project_id INTEGER NOT NULL,
  repo       TEXT NOT NULL,
  number     INTEGER NOT NULL,
  item_id    INTEGER NOT NULL,
  url        TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL,                   -- open | merged | closed
  head_ref   TEXT NOT NULL DEFAULT '',
  head_sha   TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, repo, number)
);
CREATE TABLE IF NOT EXISTS checks (
  project_id INTEGER NOT NULL,
  sha        TEXT NOT NULL,
  name       TEXT NOT NULL,
  conclusion TEXT NOT NULL,                   -- GitHub's: success | failure | neutral | skipped | timed_out | … (or a status state)
  url        TEXT NOT NULL DEFAULT '',
  at         INTEGER NOT NULL,
  PRIMARY KEY (project_id, sha, name)
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
    'ALTER TABLE projects ADD COLUMN runner INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE agents ADD COLUMN tokens TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE items ADD COLUMN race INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE agents ADD COLUMN token_id INTEGER',
    "ALTER TABLE projects ADD COLUMN github_secret TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE agents ADD COLUMN has TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE items ADD COLUMN needs TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE items ADD COLUMN size TEXT NOT NULL DEFAULT ''",
  ]) {
    try { db.exec(sql); } catch { /* already there */ }
  }
  return db;
}
