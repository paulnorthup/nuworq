// The weekly guide walk-through (#386): the getting-started guide (/guide, src/userguide.js) must match the running
// version. Once a week, in a project whose repository has the guide, the hub looks at what landed on main since the
// last walk-through. If anything changed in an area the guide's steps depend on (COVERED), it opens one item for an
// agent with a browser: follow /guide on a fresh workspace, fix what no longer matches, propose what's bigger.
// A quiet week opens nothing, and while one is open no second one opens. The hub only reads git and sends the item.
import { DAY, SYSTEM } from './core.js';
import { baseOf, shaOf, hasFile, changedUnder } from './git.js';

export const WALK_EVERY = 7 * DAY;

// The guide's source, and every file its steps depend on. Keep this list in step with the guide: a file a new
// user's path runs through belongs here.
export const GUIDE = 'src/userguide.js';
export const COVERED = [
  GUIDE,
  'web/guide.css',
  'src/getstarted.js', 'web/getstarted.js', // Get started's steps
  'src/workspaces.js', // sign-in, workspaces and invites
  'src/ghapp.js', // connecting GitHub
  'src/connect.js', 'bin/nuworq.js', // install, connect and the CLI
  'src/setup.js', // connect's questions: the plugin, staffing, an operator, then the shaper (#490)
  'src/runner.js', // nuworq run
  'scripts/setup-walkthrough.js', // the setup, measured against docs/evals/setup.md's targets (#492)
];

const MAX_LISTED = 10;

const ACCEPTANCE = [
  '- Follow /guide from the first step on a fresh workspace (a hub with no data, not the demo), in a browser at 375px and at desktop width, doing each step as a new user would.',
  '- Run node scripts/setup-walkthrough.js: it times and counts the setup from a signed-in workspace to the three sessions, and must end with every target met. Record its numbers in docs/evals/setup.md, and compare each step\'s words with the guide\'s.',
  '- Every step that no longer matches is fixed on this branch: the guide when it is out of date, the product when it is what\'s wrong. npm test passes.',
  '- Anything bigger than a fix is its own proposal, saying which step it affects, instead of being done here.',
  '- Evidence: the steps you followed, where they differed and what you changed, with 375px and desktop screenshots. Nothing differed: submit "guide matches" with the screenshots.',
].join('\n');

const listed = (xs) => xs.slice(0, MAX_LISTED).join('; ') + (xs.length > MAX_LISTED ? `; and ${xs.length - MAX_LISTED} more` : '');
const summary = ({ files, subjects }) =>
  `Something the getting-started guide (/guide) depends on changed since the last walk-through. Landed: ${listed(subjects)}. Files: ${listed(files)}. Walk the guide as a new user and make it match.`;

// The project's open walk-through, if any.
export const openWalk = (hub, p) => hub.q(`SELECT * FROM items WHERE project_id = ? AND walk = 1 AND stage NOT IN ('done', 'dropped') LIMIT 1`).get(p.id);

// Opens this week's walk-throughs that are due. Run on the hub's timer; returns the items it opened.
export function walkthrough(hub) {
  const t = hub.now();
  const due = hub.q('SELECT * FROM projects WHERE parked = 0 AND archived_at = 0 AND walk_at <= ?').all(t - WALK_EVERY);
  const opened = [];
  for (const p of due) {
    const repo = hub.repoFor(p);
    const base = repo && baseOf(repo.path);
    const head = base && shaOf(repo.path, base);
    // Not a repository with the guide in it (or git can't say yet): look again next week.
    const guided = head && hasFile(repo.path, head, GUIDE);
    const changed = guided && p.walk_sha ? changedUnder(repo.path, p.walk_sha, head, COVERED) : null;
    const item = hub.tx(() => {
      const looked = (sha = p.walk_sha) => hub.q('UPDATE projects SET walk_at = ?, walk_sha = ? WHERE id = ?').run(t, sha, p.id);
      if (!guided) return looked(), null;
      // The first look, or the last walk's commit is gone (a force-push): count from here.
      if (!changed || !changed.files.length) return looked(head), null;
      // Last week's is still open: it walks the guide as it is now. What changed stays counted until one opens.
      if (openWalk(hub, p)) return looked(), null;
      const it = hub.createItem(p, SYSTEM, { title: 'Walk through the getting-started guide on a fresh workspace', summary: summary(changed), acceptance: ACCEPTANCE, priority: 'later', needs: ['browser'] });
      hub.patch(it, { walk: 1 });
      if (it.stage !== 'ready') hub.move(it, 'ready', SYSTEM); // the hub's own work: there's nothing to shape or approve
      looked(head);
      return it;
    });
    if (item) { opened.push(item); hub.changed(p); }
  }
  return opened;
}
