// GitHub issues come in as proposals: on install (every open issue of the project's repos), and through
// the issues webhook after that. One item per issue, ever; one comment back on the issue with the item's
// link, and nothing else goes to GitHub. Closing an issue drops its item while nobody has started it.
// takeIssue() is synchronous (inside the webhook's transaction); syncing and commenting call GitHub
// through the app (src/ghapp.js) and run after it.
import { normRemote } from './core.js';

const ACTOR = 'github';
const MAX_BODY = 2000;
// What the hub's token for intake may do: read issues and leave its one comment.
export const ISSUE_PERMISSIONS = { issues: 'write', metadata: 'read' };

const repoOf = (full) => normRemote(`github.com/${full}`);
const labelsOf = (issue) => (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
const clip = (s, n) => { s = String(s ?? '').trim(); return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; };

// One issue as GitHub says it is now (from a webhook or a listing). Creates, reopens, renames or drops
// its item. Returns what happened, or { ignored } with why.
export function takeIssue(hub, p, repo, issue) {
  if (!issue) return { ignored: 'no issue' };
  if (issue.pull_request) return { ignored: 'a pull request, not an issue' };
  repo = normRemote(repo);
  if (!hub.remotesOf(p).includes(repo)) return { ignored: `${repo} isn't one of ${p.name}'s repositories` };
  const row = hub.q('SELECT * FROM issues WHERE project_id = ? AND repo = ? AND number = ?').get(p.id, repo, issue.number);
  const item = row ? hub.itemById(row.item_id) : null;
  const t = hub.now();
  if (issue.state === 'closed') {
    if (!row || row.state === 'closed') return { ignored: 'closed' };
    hub.q('UPDATE issues SET state = ?, updated_at = ? WHERE project_id = ? AND repo = ? AND number = ?').run('closed', t, p.id, repo, issue.number);
    if (['proposed', 'ready'].includes(item.stage) && !item.holder) {
      hub.move(item, 'dropped', ACTOR, { holder: null, lease_until: null });
      hub.event(p, { item, actor: ACTOR, type: 'issue', headline: `#${item.seq} dropped: its issue was closed on GitHub`, summary: `${row.url} was closed before anyone started on it. Reopening the issue brings the item back.`, data: { url: row.url, state: 'closed' } });
      return { item: `#${item.seq}`, dropped: true };
    }
    if (!['done', 'dropped'].includes(item.stage)) {
      hub.event(p, { item, actor: ACTOR, type: 'issue', headline: `#${item.seq}'s issue was closed on GitHub; the work here goes on`, summary: `${row.url} was closed while #${item.seq} is ${item.stage}. Nothing changed here: decide whether it is still worth finishing.`, data: { url: row.url, state: 'closed' } });
    }
    return { item: `#${item.seq}`, noted: true };
  }
  const wanted = !p.issue_label || labelsOf(issue).includes(p.issue_label);
  if (!row) {
    if (!wanted) return { ignored: `no "${p.issue_label}" label` };
    const created = hub.createItem(p, ACTOR, {
      title: clip(issue.title, 160) || `Issue #${issue.number}`,
      summary: [clip(issue.body, MAX_BODY), `From ${issue.html_url}`].filter(Boolean).join('\n\n'),
      repo, stage: 'proposed',
    });
    hub.q(`INSERT INTO issues (project_id, repo, number, item_id, state, url, title, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`)
      .run(p.id, repo, issue.number, created.id, issue.html_url ?? '', issue.title ?? '', t);
    return { item: `#${created.seq}`, created: true };
  }
  const changes = [];
  if (row.state === 'closed') {
    changes.push('reopened');
    if (item.stage === 'dropped') {
      hub.move(item, 'proposed', ACTOR);
      hub.event(p, { item, actor: ACTOR, type: 'issue', headline: `#${item.seq} is back: its issue was reopened on GitHub`, data: { url: row.url, state: 'open' } });
    }
  }
  // Renamed on GitHub: follow it while the item is still a proposal; after that the item's title is ours.
  if (issue.title && issue.title !== row.title && item.stage === 'proposed') {
    hub.patch(item, { title: clip(issue.title, 160) });
    changes.push('renamed');
  }
  hub.q('UPDATE issues SET state = ?, title = ?, url = ?, updated_at = ? WHERE project_id = ? AND repo = ? AND number = ?')
    .run('open', issue.title ?? row.title, issue.html_url ?? row.url, t, p.id, repo, issue.number);
  return { item: `#${item.seq}`, ...(changes.length ? { changes } : { ignored: 'already in' }) };
}

// The issues webhook: { action, issue, repository }. labeled is how an issue passes the filter later.
export function issueEvent(hub, p, body) {
  const repo = repoOf(body.repository?.full_name ?? '');
  if (!['opened', 'reopened', 'labeled', 'edited', 'closed'].includes(body.action)) return { ignored: body.action || 'no action' };
  return takeIssue(hub, p, repo, body.issue);
}

// The repositories an installation event is about, among this project's: added or listed ones.
export function installedRepos(hub, p, body) {
  if (['deleted', 'suspend'].includes(body.action)) return [];
  const listed = [...(body.repositories ?? []), ...(body.repositories_added ?? [])].map((r) => repoOf(r.full_name));
  return [...new Set(listed)].filter((r) => hub.remotesOf(p).includes(r));
}

// GitHub's REST API with an installation token for one repository.
async function asRepo(app, repo) {
  const { token } = await app.mint(repo, ISSUE_PERMISSIONS);
  const [, owner, name] = repo.match(/^github\.com\/([^/]+)\/([^/]+)$/);
  return async (method, path, body) => {
    const r = await fetch(`${app.api}/repos/${owner}/${name}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'nuworq', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
}

// Every open issue of these repositories comes in (pull requests skipped), then the comments go out.
export async function syncIssues(hub, p, app, repos, { link }) {
  let seen = 0;
  for (const repo of repos) {
    const gh = await asRepo(app, repo);
    for (let page = 1; page <= 50; page++) {
      const r = await gh('GET', `/issues?state=open&per_page=100&page=${page}`);
      if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`GitHub listed no issues for ${repo} (${r.status})`);
      hub.tx(() => { for (const issue of r.json) takeIssue(hub, p, repo, issue); });
      seen += r.json.filter((i) => !i.pull_request).length;
      if (r.json.length < 100) break;
    }
  }
  hub.changed(p);
  return { issues: seen, ...(await commentIssues(hub, p, app, { link })) };
}

// The one comment per issue: the item's link. Recorded as soon as GitHub has it, so it is never posted
// twice; one that fails is tried again at the next webhook or sync.
export async function commentIssues(hub, p, app, { link }) {
  const rows = hub.q(`SELECT * FROM issues WHERE project_id = ? AND commented = 0 AND state = 'open' ORDER BY repo, number`).all(p.id);
  let posted = 0;
  const failed = [];
  for (const repo of [...new Set(rows.map((r) => r.repo))]) {
    let gh;
    try { gh = await asRepo(app, repo); } catch (e) { failed.push(`${repo}: ${e.message}`); continue; }
    for (const row of rows.filter((r) => r.repo === repo)) {
      const where = [p.id, repo, row.number];
      // Taken first (-1), so a webhook handled meanwhile doesn't post it too; given back if GitHub says no.
      if (hub.q('UPDATE issues SET commented = -1 WHERE project_id = ? AND repo = ? AND number = ? AND commented = 0').run(...where).changes !== 1) continue;
      const item = hub.itemById(row.item_id);
      let r;
      try {
        r = await gh('POST', `/issues/${row.number}/comments`, {
          body: `This issue is tracked in nuworq as [#${item.seq}](${link(item)}). Agents shape it into work there; it closes when the work lands.`,
        });
      } catch (e) { r = { status: e.message }; }
      if (r.status !== 201) {
        hub.q('UPDATE issues SET commented = 0 WHERE project_id = ? AND repo = ? AND number = ?').run(...where);
        failed.push(`${repo}#${row.number}: ${r.status}`);
        continue;
      }
      hub.q('UPDATE issues SET commented = ? WHERE project_id = ? AND repo = ? AND number = ?').run(r.json?.id || 1, ...where);
      posted++;
    }
  }
  return { commented: posted, ...(failed.length ? { failed } : {}) };
}
