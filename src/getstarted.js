// Get started (#117): from sign-in to a first landed item, each step checked off from what the hub already
// knows. getStarted() is pure; facts() asks the database. Once every step is done (or the person hides the
// card) that is recorded, and the card never comes back for them, even if a step later comes undone.

export const RECENT_MS = 7 * 24 * 3600_000; // "an agent is running": one checked in within a week

// Who to ask for the GitHub App when the viewer can't create it: the hub's owners by handle, or whoever runs a
// shared hub (its app is the host's to set up).
const askFor = (s) => (s.workspaces ? 'Ask whoever runs this hub to set up its GitHub App'
  : `Ask ${s.owners?.length ? `an owner (${s.owners.map((h) => `@${h}`).join(', ')})` : 'an owner of this hub'} to set up GitHub`);

// s: what the hub knows (see facts()). Returns { complete, steps: [{ key, label, done, action? }] };
// every step that isn't done carries an action: a label, and an href or a ui action the page knows, or
// note: true when it's something to ask someone else for. GitHub comes after the project, and only while some
// project is on github.com (or there's none yet): a project elsewhere finishes without it.
export function getStarted(s) {
  const github = s.app === 'installed' ? null
    : s.app === 'none'
      ? (s.canCreateApp ? { label: 'Create the GitHub App', href: 'api/github/app/new' } : { label: askFor(s), note: true })
      : (s.installUrl ? { label: 'Install the GitHub App', href: s.installUrl } : { label: 'Install the GitHub App', ui: 'connect' });
  const steps = [
    s.workspaces && { key: 'org', label: 'Create your organization', done: !!s.org, action: { label: 'Create your organization', href: s.root || '/' } },
    { key: 'project', label: 'Add a project', done: !!s.project, action: { label: '+ Project', ui: 'new-project' } },
    s.github !== false && { key: 'github', label: 'Connect GitHub', done: s.app === 'installed', action: github },
    { key: 'machine', label: 'Install and connect your machine', done: !!s.machine, action: { label: 'Connect your machine', ui: 'connect' } },
    { key: 'agent', label: 'Start an agent', done: !!s.agent, action: { label: 'Start an agent', ui: 'connect', command: 'worker' } },
    { key: 'landed', label: 'Watch your first item land', done: !!s.landed, action: s.board ? { label: 'Open the board', href: `#/p/${encodeURIComponent(s.board)}` } : { label: '+ Project', ui: 'new-project' } },
  ].filter(Boolean).map(({ action, ...step }) => (step.done ? step : { ...step, action }));
  return { complete: steps.every((x) => x.done), steps };
}

// What the hub's database says, for one viewer ("@handle", or "you" on a hub without logins).
// app ('none' | 'uninstalled' | 'installed') comes from GitHub, so the caller passes it in.
export function facts(hub, { viewer = 'you', workspaces = false, app = 'none', canCreateApp = false, installUrl = '', root = '' } = {}) {
  const q = (sql, ...a) => hub.q(sql).get(...a);
  const live = 'SELECT id FROM projects WHERE archived_at = 0';
  const person = viewer.startsWith('@') ? q('SELECT id FROM people WHERE handle = ?', viewer.slice(1)) : null;
  // Signed in: an agent token this person approved (nuworq connect) or minted. No logins: any agent has checked in.
  let machine = false;
  if (person) {
    try { machine = !!q(`SELECT 1 FROM tokens WHERE role = 'agent' AND minted_by = ?`, person.id); } catch { /* no tokens table yet */ }
  } else {
    machine = !!q(`SELECT 1 FROM agents WHERE last_checkin > 0 AND project_id IN (${live})`);
  }
  // GitHub matters while some live project is on github.com, or before any project says where its code is.
  const project = !!q(`SELECT 1 FROM projects WHERE archived_at = 0 AND (path != '' OR id IN (SELECT project_id FROM project_remotes))`);
  const github = !project || !!q(`SELECT 1 FROM project_remotes WHERE remote LIKE 'github.com/%' AND project_id IN (${live})`);
  let owners = [];
  try { owners = hub.q(`SELECT handle FROM people WHERE role = 'owner' ORDER BY id`).all().map((r) => r.handle); } catch { /* no people table yet */ }
  // The board to watch: the project most recently worked on.
  const board = q(`SELECT p.slug FROM projects p LEFT JOIN agents a ON a.project_id = p.id WHERE p.archived_at = 0
    GROUP BY p.id ORDER BY MAX(COALESCE(a.last_seen, 0)) DESC, p.id LIMIT 1`)?.slug ?? null;
  return {
    workspaces, org: workspaces && !!person, root, app, canCreateApp, installUrl, github, owners,
    project, machine,
    agent: !!q(`SELECT 1 FROM agents WHERE last_seen >= ? AND project_id IN (${live})`, hub.now() - RECENT_MS),
    landed: !!q(`SELECT 1 FROM events WHERE type = 'landed' AND project_id IN (${live})`),
    board,
  };
}

// Finished or hidden: { at, how } once recorded for this viewer, else null.
export const finished = (db, who) => db.prepare('SELECT at, how FROM get_started WHERE who = ?').get(who) ?? null;
export function finish(db, who, how, at = Date.now()) {
  db.prepare('INSERT OR IGNORE INTO get_started (who, how, at) VALUES (?, ?, ?)').run(who, how, at);
  return finished(db, who);
}
