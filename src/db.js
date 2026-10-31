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
  runner     INTEGER NOT NULL DEFAULT 0,         -- the human lets "nuworq run" start headless workers here
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
  status        TEXT NOT NULL DEFAULT 'open',  -- open | answered | confirmed | shipped (its item landed on the assumption) | withdrawn
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

-- A question's steps a person has ticked off (#162), each person's own; step counts from 1.
CREATE TABLE IF NOT EXISTS step_ticks (
  project_id  INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  person      TEXT NOT NULL,
  step        INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  PRIMARY KEY (question_id, person, step)
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
-- Pull requests on the project's repos that no item tracks (#202): the next tidy job attaches each to an item.
CREATE TABLE IF NOT EXISTS untracked_prs (
  project_id INTEGER NOT NULL,
  repo       TEXT NOT NULL,                   -- as GitHub names it: owner/name
  number     INTEGER NOT NULL,
  url        TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  head_ref   TEXT NOT NULL DEFAULT '',
  head_sha   TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL,                   -- open | merged | closed
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, repo, number)
);
-- GitHub issues that came in as proposals (src/issues.js): one item per issue, and at most one comment back.
CREATE TABLE IF NOT EXISTS issues (
  project_id INTEGER NOT NULL,
  repo       TEXT NOT NULL,                   -- normalized: github.com/acme/api
  number     INTEGER NOT NULL,
  item_id    INTEGER NOT NULL,
  state      TEXT NOT NULL,                   -- open | closed
  url        TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  commented  INTEGER NOT NULL DEFAULT 0,      -- the hub's one comment (its id on GitHub), 0 until posted
  stale      TEXT NOT NULL DEFAULT '',        -- an agent flagged it stale: why, in one line ('' = not flagged)
  closing    INTEGER NOT NULL DEFAULT 0,      -- 1: the human said close it, not yet closed on GitHub; 2: closed
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, repo, number)
);
-- Dependabot alerts that came in as items (src/alerts.js): one item per alert, ever.
CREATE TABLE IF NOT EXISTS alerts (
  project_id INTEGER NOT NULL,
  repo       TEXT NOT NULL,                   -- normalized: github.com/acme/api
  number     INTEGER NOT NULL,
  item_id    INTEGER NOT NULL,
  state      TEXT NOT NULL,                   -- open | fixed | dismissed
  url        TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, repo, number)
);
-- Whether the hub can read a repository's Dependabot alerts: '' yes, 'off' (alerts are off for the repo),
-- 'permission' (the app's installation hasn't accepted "Dependabot alerts: read"), 'error' (anything else).
CREATE TABLE IF NOT EXISTS alert_access (
  project_id INTEGER NOT NULL,
  repo       TEXT NOT NULL,
  problem    TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL DEFAULT '',        -- where a person fixes it
  detail     TEXT NOT NULL DEFAULT '',        -- what GitHub said
  at         INTEGER NOT NULL,
  PRIMARY KEY (project_id, repo)
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

-- Tokens and cost, per item (src/usage.js). cost_usd NULL: unknown (a local model), not free.
CREATE TABLE IF NOT EXISTS usage (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL,
  item_id       INTEGER,                      -- NULL: a run that held no item
  agent         TEXT NOT NULL,
  model         TEXT NOT NULL DEFAULT '',
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL,
  source        TEXT NOT NULL,                -- agent: reported by the agent | runner: read from its CLI | llm-proxy: measured (src/llmproxy.js)
  at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_item ON usage (item_id);
CREATE INDEX IF NOT EXISTS usage_project ON usage (project_id, at);

-- nuworq run, as each runner last said on its poll (POST /api/runner, #171). Bookkeeping: no agent is touched.
CREATE TABLE IF NOT EXISTS runners (
  name     TEXT PRIMARY KEY,                  -- its token's runner name, else what it calls itself (the machine)
  machine  TEXT NOT NULL DEFAULT '',
  scope    TEXT NOT NULL DEFAULT '',          -- the projects its token reaches, comma-separated; '' = all
  state    TEXT NOT NULL DEFAULT '{}',        -- { running, workers, skipping: [{ project, reason, until? }], paused: { until, reason } | null, spent, stopped }
  poll_ms  INTEGER NOT NULL,                  -- how often it polls: silent for 3 of these, it is down
  seen_at  INTEGER NOT NULL
);

-- Get started (src/getstarted.js): who finished the checklist or hid it, so it never shows for them again.
CREATE TABLE IF NOT EXISTS get_started (
  who TEXT PRIMARY KEY,                       -- "@handle", or "you" on a hub without logins
  how TEXT NOT NULL,                          -- complete | hidden
  at  INTEGER NOT NULL
);
`;

// One record per pull request (#261). The hub records a PR it opens under the normalized remote
// (github.com/o/r), and GitHub's webhook one it doesn't know yet under o/r. When "opened" arrives while the land
// step still awaits GitHub, both get written. Fold the o/r twin into the hub's record, keeping the newest head
// and state and a blocked reason either has, then drop it. Run at start and after the land step writes.
export const PR_TWINS = [
  `UPDATE prs AS g SET
     head_ref = CASE WHEN s.updated_at > g.updated_at THEN s.head_ref ELSE g.head_ref END,
     head_sha = CASE WHEN s.updated_at > g.updated_at THEN s.head_sha ELSE g.head_sha END,
     state = CASE WHEN s.updated_at > g.updated_at THEN s.state ELSE g.state END,
     blocked = CASE WHEN g.blocked != '' THEN g.blocked ELSE s.blocked END,
     updated_at = MAX(g.updated_at, s.updated_at)
   FROM prs AS s
   WHERE s.project_id = g.project_id AND s.number = g.number AND lower(g.repo) = 'github.com/' || lower(s.repo)`,
  `DELETE FROM prs WHERE EXISTS (SELECT 1 FROM prs g WHERE g.project_id = prs.project_id AND g.number = prs.number
     AND lower(g.repo) = 'github.com/' || lower(prs.repo))`,
];

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
    "ALTER TABLE items ADD COLUMN branch TEXT NOT NULL DEFAULT ''", // the git branch the item is built on, landed from
    "ALTER TABLE items ADD COLUMN repo TEXT NOT NULL DEFAULT ''", // the repository it lands in (a normalized remote); '': the project's first
    "ALTER TABLE projects ADD COLUMN issue_label TEXT NOT NULL DEFAULT ''", // only issues with this label come in ('' = all)
    'ALTER TABLE projects ADD COLUMN archived_at INTEGER NOT NULL DEFAULT 0', // archived: out of lists and routing, history kept
    'ALTER TABLE issues ADD COLUMN landed_comment INTEGER NOT NULL DEFAULT 0', // the hub's comment when its item landed (its id on GitHub)
    "ALTER TABLE issues ADD COLUMN close_error TEXT NOT NULL DEFAULT ''", // why the hub couldn't close it after its item landed
    "ALTER TABLE prs ADD COLUMN blocked TEXT NOT NULL DEFAULT ''", // why an open landing PR can't merge: '' | conflict | review
    // An outside fact the item waits on (src/precondition.js): JSON, '' for none; the last check { at, ok, detail };
    // when to check next; failures in a row (the backoff)
    "ALTER TABLE items ADD COLUMN precondition TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE items ADD COLUMN last_check TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE items ADD COLUMN next_check INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE items ADD COLUMN check_fails INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE items ADD COLUMN parked_by TEXT NOT NULL DEFAULT ''", // who answered and kept it waiting ('' = not kept parked)
    'ALTER TABLE projects ADD COLUMN wait_days INTEGER NOT NULL DEFAULT 0', // how long work waits outside before you hear; 0: the default (src/precondition.js)
    // What llm-proxy measured (source 'llm-proxy'; 0 on reported rows): model time, requests, failed ones, cold model loads
    'ALTER TABLE usage ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE usage ADD COLUMN requests INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE usage ADD COLUMN failures INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE usage ADD COLUMN cold_loads INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE channels ADD COLUMN person TEXT NOT NULL DEFAULT ''", // "@handle": a personal channel (only what they own); '' = hub-wide
    "ALTER TABLE issues ADD COLUMN stale TEXT NOT NULL DEFAULT ''", // an agent flagged it stale: why ('' = not flagged)
    'ALTER TABLE issues ADD COLUMN closing INTEGER NOT NULL DEFAULT 0', // 1: the human said close it; 2: closed on GitHub
    // Questions to an issue's reporter (ask to: "reporter"): who wrote the issue, and the newest comment on it already handled
    "ALTER TABLE issues ADD COLUMN author TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE issues ADD COLUMN last_comment INTEGER NOT NULL DEFAULT 0',
    // A question put to an issue's reporter on GitHub: their login, the issue, and the hub's comment there (its id; 0 until posted, -1 posting)
    "ALTER TABLE questions ADD COLUMN reporter TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE questions ADD COLUMN issue_repo TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE questions ADD COLUMN issue_number INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE questions ADD COLUMN issue_comment INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE projects ADD COLUMN reporter_wait INTEGER NOT NULL DEFAULT 48', // hours a reporter has to answer before the human is asked
    "ALTER TABLE questions ADD COLUMN audience TEXT NOT NULL DEFAULT ''", // 'operator' (ask to: "operator"): an operator session answers, not the human; '' otherwise
    'ALTER TABLE questions ADD COLUMN escalates INTEGER', // an operator's escalation to the human: the operator question it carries up
    "ALTER TABLE questions ADD COLUMN evidence TEXT NOT NULL DEFAULT '[]'", // an escalation's evidence: [{ label, url? }]
    "ALTER TABLE questions ADD COLUMN steps TEXT NOT NULL DEFAULT '[]'", // what the person must do, in order: [{ do, where?, check? }]
    'ALTER TABLE items ADD COLUMN fixes INTEGER', // the landed item this one repairs (its id): that one counts as an escape (#176)
    'ALTER TABLE projects ADD COLUMN fresh INTEGER NOT NULL DEFAULT 1', // the weekly freshness sweep is on (src/freshness.js)
    'ALTER TABLE projects ADD COLUMN fresh_at INTEGER NOT NULL DEFAULT 0', // when the sweep timer last fired (or the project began)
    'ALTER TABLE items ADD COLUMN sweep INTEGER NOT NULL DEFAULT 0', // 1: a "keep <project> fresh" item the hub opened
    // The weekly guide walk-through (#386, src/walkthrough.js): when it last looked, main's commit then, and its items.
    'ALTER TABLE projects ADD COLUMN walk_at INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE projects ADD COLUMN walk_sha TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE items ADD COLUMN walk INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE questions ADD COLUMN closed_reason TEXT NOT NULL DEFAULT ''", // why a question closed with nobody answering (shipped, withdrawn), e.g. "#112 landed"
    // Staffing, set on the hub and carried out by nuworq run (#174): at most this many agents working at once (NULL:
    // each runner's own --workers), paused (no new workers), a daily budget in dollars (NULL: none, UTC days), and
    // whether the person was asked if run may staff it (1 for projects from before #174; a new one starts at 0).
    'ALTER TABLE projects ADD COLUMN run_workers INTEGER',
    'ALTER TABLE projects ADD COLUMN run_paused INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE projects ADD COLUMN run_budget REAL',
    'ALTER TABLE projects ADD COLUMN staff_asked INTEGER NOT NULL DEFAULT 1',
    "ALTER TABLE items ADD COLUMN tidy TEXT NOT NULL DEFAULT ''", // a tidy job the hub opened (src/tidy.js): JSON, the drift it listed; '' otherwise
    "ALTER TABLE items ADD COLUMN priority_by TEXT NOT NULL DEFAULT ''", // the person who set its priority ('' = nobody did): a tidy job leaves it alone
    'ALTER TABLE projects ADD COLUMN runner_polled_at INTEGER NOT NULL DEFAULT 0', // when a nuworq run last asked where work is, for this project (#185)
    // The weekly line (#178): on unless turned off on the channel, and when it last went (0: count from created_at).
    'ALTER TABLE channels ADD COLUMN weekly INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE channels ADD COLUMN weekly_at INTEGER NOT NULL DEFAULT 0',
    // Each session's role (#238), fixed for its life: operator | shaper | worker | session. A worker carries its
    // runner's name; any session may say which machine it runs on. Claims (event data) and usage record the role.
    "ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT 'session'",
    "ALTER TABLE agents ADD COLUMN runner TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE agents ADD COLUMN machine TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE usage ADD COLUMN role TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE items ADD COLUMN feedback INTEGER', // the hub directory's feedback id an owner approved into this proposal (#295)
    "ALTER TABLE agents ADD COLUMN session TEXT NOT NULL DEFAULT ''", // its Claude Code session's keys, from checkin (#335)
    'ALTER TABLE items ADD COLUMN gate INTEGER NOT NULL DEFAULT 0', // 1: once shaped, it waits for a person's OK whatever the autonomy (#296)
    // Model routing (#347, src/models.js): on or off (off by default), the tiers per agent (JSON, cheapest first),
    // and how many tiers an item's next attempt steps up after failed ones.
    'ALTER TABLE projects ADD COLUMN model_routing INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE projects ADD COLUMN model_tiers TEXT NOT NULL DEFAULT '{}'",
    'ALTER TABLE items ADD COLUMN tier_up INTEGER NOT NULL DEFAULT 0',
    // Difficulty and trials (#348): how hard an item is ('' counts as standard) and why, rated when shaped; the
    // trial its building got ('': not decided yet, 'none', 'down': one tier down, 'race': cheaper against top);
    // and the share of eligible jobs (whole percents) that try one tier down and that race.
    "ALTER TABLE items ADD COLUMN difficulty TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE items ADD COLUMN difficulty_why TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE items ADD COLUMN trial TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE projects ADD COLUMN model_trial INTEGER NOT NULL DEFAULT 10',
    'ALTER TABLE projects ADD COLUMN model_race INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE projects ADD COLUMN live INTEGER NOT NULL DEFAULT 0', // anyone may watch it, read-only, at /live/<slug> (#358; src/live.js)
    // Routing by results (#349): the project's quality bar (best | balanced | cheapest, src/models.js QUALITY), and
    // the one line an item last got on which model its job runs on and why.
    "ALTER TABLE projects ADD COLUMN model_quality TEXT NOT NULL DEFAULT 'balanced'",
    "ALTER TABLE items ADD COLUMN route_why TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE items ADD COLUMN breaking TEXT NOT NULL DEFAULT ''", // who must do what when it lands; '' breaks nobody (#398)
    // When an item's needs last changed, and when an agent last gained a tag (#406): a ready item that newly
    // matches an operator is pushed to its listener once, from then.
    'ALTER TABLE items ADD COLUMN needs_since INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE agents ADD COLUMN has_since INTEGER NOT NULL DEFAULT 0',
    // Sessions from before roles that declared the operator tag were operators.
    `UPDATE agents SET role = 'operator' WHERE role = 'session' AND has LIKE '%"operator"%'`,
    ...PR_TWINS,
  ]) {
    try { db.exec(sql); } catch { /* already there */ }
  }
  return db;
}
