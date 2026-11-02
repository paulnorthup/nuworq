// Get started (#117): from sign-in to a first landed item, each step checked off from what the hub already
// knows. getStarted() is pure; facts() asks the database. Once every step is done (or the person hides the
// card) that is recorded, and the card never comes back for them, even if a step later comes undone.
import { SETUP } from '../web/connect.js';

export const RECENT_MS = 7 * 24 * 3600_000; // "it's running": it reported or checked in within a week

// Who to ask for the GitHub App when the viewer can't create it: the hub's owners by handle, or whoever runs a
// shared hub (its app is the host's to set up).
const askFor = (s) => (s.workspaces ? 'Ask whoever runs this hub to set up its GitHub App'
  : `Ask ${s.owners?.length ? `an owner (${s.owners.map((h) => `@${h}`).join(', ')})` : 'an owner of this hub'} to set up GitHub`);

// s: what the hub knows (see facts()). Returns { complete, steps: [{ key, label, done, action? }] };
// every step that isn't done carries an action: a label, and an href or a ui action the page knows, or
// note: true when it's something to ask someone else for. Once there is a project, linking one to its repository
// is a step of its own (#147), opened on the newest project. GitHub comes after, and only while some project is
// on github.com (or none says where its code is yet): a project elsewhere finishes without it.
export function getStarted(s) {
  const github = s.app === 'installed' ? null
    : s.app === 'none'
      ? (s.canCreateApp ? { label: 'Create the GitHub App', href: 'api/github/app/new' } : { label: askFor(s), note: true })
      : (s.installUrl ? { label: 'Install the GitHub App', href: s.installUrl } : { label: 'Install the GitHub App', ui: 'connect' });
  const steps = [
    s.workspaces && { key: 'org', label: 'Create your workspace', done: !!s.org, action: { label: 'Create your workspace', href: s.root || '/' } },
    { key: 'project', label: 'Add a project', done: !!s.project, action: { label: '+ Project', ui: 'new-project' } },
    s.project && { key: 'repo', label: 'Link a project to its repository', done: !!s.repo, action: { label: '+ repo', ui: 'link-repo', slug: s.recent } },
    s.github !== false && { key: 'github', label: 'Connect GitHub', done: s.app === 'installed', action: github },
    { key: 'machine', label: 'Install and connect your machine', done: !!s.machine, action: { label: 'Connect your machine', ui: 'connect' } },
    // The setup that works (#489, web/connect.js's SETUP): each step shows its session's commands while it's next.
    ...SETUP.map(({ key, title }) => ({ key, label: title, done: !!s[key], action: { label: title, ui: 'connect', command: key } })),
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
  // Any live project counts as added; it has a repository once it has a path on disk or a remote.
  const project = !!q(live);
  const repo = !!q(`SELECT 1 FROM projects WHERE archived_at = 0 AND (path != '' OR id IN (SELECT project_id FROM project_remotes))`);
  // GitHub matters while some live project is on github.com, or before any project says where its code is.
  const github = !repo ||!!q(`SELECT 1 FROM project_remotes WHERE remote LIKE 'github.com/%' AND project_id IN (${live})`);
  let owners = [];
  try { owners = hub.q(`SELECT handle FROM people WHERE role = 'owner' ORDER BY id`).all().map((r) => r.handle); } catch { /* no people table yet */ }
  // The board to watch: the project most recently worked on.
  const board = q(`SELECT p.slug FROM projects p LEFT JOIN agents a ON a.project_id = p.id WHERE p.archived_at = 0
    GROUP BY p.id ORDER BY MAX(COALESCE(a.last_seen, 0)) DESC, p.id LIMIT 1`)?.slug ?? null;
  // Where to link a repository: the newest project.
  const recent = q(`SELECT slug FROM projects WHERE archived_at = 0 ORDER BY created_at DESC, id DESC LIMIT 1`)?.slug ?? null;
  // The setup that works: a runner reported for one of these projects (its scope: their slugs, '' for all) within a
  // week; an operator checked in within a week; a shaper ever checked in, or proposed.
  const week = hub.now() - RECENT_MS;
  const slugs = new Set(hub.q('SELECT slug FROM projects WHERE archived_at = 0').all().map((r) => r.slug));
  const workers = hub.q('SELECT scope FROM runners WHERE seen_at >= ?').all(week).some((r) => !r.scope || r.scope.split(',').some((x) => slugs.has(x)));
  return {
    workspaces, org: workspaces && !!person, root, app, canCreateApp, installUrl, github, owners,
    project, repo, recent, machine, workers,
    operator: !!q(`SELECT 1 FROM agents WHERE role = 'operator' AND last_seen >= ? AND project_id IN (${live})`, week),
    shaper: !!q(`SELECT 1 FROM agents a WHERE role = 'shaper' AND project_id IN (${live})
      AND (last_checkin > 0 OR EXISTS (SELECT 1 FROM items i WHERE i.project_id = a.project_id AND i.created_by = a.name))`),
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
