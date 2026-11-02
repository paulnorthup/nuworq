// GitHub webhooks: pull requests and CI results link to items without agents typing them.
// POST /api/hooks/github/<project>, signed with the project's secret (X-Hub-Signature-256), or the
// GitHub App's webhook, POST /api/hooks/github-app, signed with the app's secret (receiveApp).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { UserError, normRemote } from './core.js';
import { issueEvent, issueComment, installedRepos } from './issues.js';
import { alertEvent } from './alerts.js';
import { untrackedPr } from './tidy.js';
import { tagRelease } from './releases.js';
import { baseOf, contains, headOf, holdsChange, shaOf } from './git.js';

const ACTOR = 'github';
const OK = new Set(['success', 'neutral', 'skipped']);
const FAIL = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'error']);
const clip = (s, n = 100) => { const line = String(s ?? '').split('\n')[0]; return line.length > n ? line.slice(0, n - 1).trimEnd() + '…' : line; };

export function verify(secret, raw, header) {
  if (!secret || !header) return false;
  const want = Buffer.from('sha256=' + createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(String(header));
  return got.length === want.length && timingSafeEqual(got, want);
}

// The item a pull request is about: "#N" in its title, then the item whose own branch it is
// (nuworq/<seq>-<title>, as the hub names it), then the item the branch's agent holds or last
// submitted (a race attempt's nuworq/<agent>), then "#N" in its body.
function itemFor(hub, p, pr) {
  const bySeq = (text) => {
    const n = String(text ?? '').match(/(?:^|[^\w&])#(\d+)\b/)?.[1];
    return n ? hub.q('SELECT * FROM items WHERE project_id = ? AND seq = ?').get(p.id, Number(n)) : null;
  };
  const ref = String(pr.head?.ref ?? '');
  const own = () => ref && hub.q('SELECT * FROM items WHERE project_id = ? AND branch = ? ORDER BY updated_at DESC LIMIT 1').get(p.id, ref);
  const agent = ref.match(/^(?:nuworq|trellis)\/(.+)$/)?.[1]; // trellis/: from before the rename
  const byBranch = () => agent && hub.q(`SELECT * FROM items WHERE project_id = ? AND (holder = ? OR implementer = ? OR last_worker = ?)
      ORDER BY (holder = ?) DESC, (stage IN ('active', 'verifying')) DESC, updated_at DESC LIMIT 1`).get(p.id, agent, agent, agent, agent);
  return bySeq(pr.title) || own() || byBranch() || bySeq(pr.body);
}

// Whether a pull request's branch is the item's own (#478): only that one's CI or closing sends landing work back.
// An item that names no branch takes any of its pull requests, as before.
const ownBranch = (item, ref) => !item.branch || item.branch === String(ref ?? '');

// pass | fail | pending, over every check reported for a commit.
export function ciState(hub, p, sha) {
  const rows = hub.q('SELECT * FROM checks WHERE project_id = ? AND sha = ? ORDER BY name').all(p.id, sha);
  if (!rows.length) return { state: null, checks: [] };
  const state = rows.some((r) => FAIL.has(r.conclusion)) ? 'fail' : rows.every((r) => OK.has(r.conclusion)) ? 'pass' : 'pending';
  return { state, checks: rows.map((r) => ({ name: r.name, conclusion: r.conclusion, url: r.url || null })) };
}

export function prsOf(hub, p, item) {
  return hub.q('SELECT * FROM prs WHERE project_id = ? AND item_id = ? ORDER BY updated_at DESC').all(p.id, item.id).map((r) => {
    const ci = ciState(hub, p, r.head_sha);
    return { repo: r.repo, number: r.number, url: r.url, title: r.title, state: r.state, branch: r.head_ref, sha: r.head_sha.slice(0, 7), ci: ci.state, checks: ci.checks };
  });
}

// A pull request from a fork (#478): anyone can open one, so it never links to an item or moves one. A fork deleted
// since has head.repo null. Payloads the hub writes itself (prMerged) carry no head.repo: they're its own.
const fromFork = (pr, full) => pr.head && 'repo' in pr.head && (!pr.head.repo || String(pr.head.repo.full_name ?? '').toLowerCase() !== full.toLowerCase());

function pullRequest(hub, p, body) {
  const pr = body.pull_request;
  if (!pr) return { ignored: 'no pull_request' };
  const full = body.repository?.full_name ?? '';
  if (fromFork(pr, full)) return { ignored: "a fork's pull request" };
  const state = pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
  // A PR the hub opened is on record under the normalized remote (github.com/o/r); others under o/r.
  const old = hub.q('SELECT * FROM prs WHERE project_id = ? AND repo IN (?, ?) AND number = ? ORDER BY repo DESC').get(p.id, full, `github.com/${full}`.toLowerCase(), pr.number);
  const repo = old?.repo ?? full;
  const item = old ? hub.itemById(old.item_id) : itemFor(hub, p, pr);
  // No item tracks it: on record for the next tidy job to attach (#202).
  if (!item) return untrackedPr(hub, p, full, pr, state);
  hub.q(`INSERT INTO prs (project_id, repo, number, item_id, url, title, state, head_ref, head_sha, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id, repo, number) DO UPDATE SET url = excluded.url, title = excluded.title, state = excluded.state,
        head_ref = excluded.head_ref, head_sha = excluded.head_sha, updated_at = excluded.updated_at`)
    .run(p.id, repo, pr.number, item.id, pr.html_url ?? '', pr.title ?? '', state, pr.head?.ref ?? '', pr.head?.sha ?? '', hub.now());
  // Only changes of state go on the record; pushes to the branch just move the head.
  if (!old || old.state !== state) {
    const verb = !old ? (state === 'open' ? 'opened' : state) : state === 'open' ? 'reopened' : state;
    hub.event(p, {
      item, actor: ACTOR, type: 'pr',
      headline: `PR #${pr.number} ${verb}: ${clip(pr.title)}`,
      summary: [pr.head?.ref && `Branch ${pr.head.ref}`, pr.user?.login && `by ${pr.user.login}`].filter(Boolean).join(' · '),
      data: { url: pr.html_url, repo, number: pr.number, state },
    });
    // The merge lands it. Accepted work waits for it in landing; but a PR whose check failed keeps its
    // auto-merge, so the builder's fix merges as soon as it's green, while the item is still with them.
    const before = item.stage, holder = item.holder;
    const withFix = old && ['ready', 'active', 'verifying'].includes(before) && hub.prMode(p, item); // the hub's PR, auto-merge on
    if (state === 'merged' && (before === 'landing' || withFix)) {
      const base = pr.base?.ref ?? 'main';
      hub.move(item, 'done', ACTOR, { holder: null, lease_until: null, touching: '[]' });
      hub.event(p, {
        item, actor: ACTOR, type: 'landed',
        headline: `GitHub merged PR #${pr.number}: #${item.seq} is on ${base}`,
        summary: before === 'landing' ? '' : `It was ${before}${holder ? ` with ${holder}` : ''}: its pull request merged once its checks passed, so it is done${holder ? '; nothing more to do on it' : ''}.`,
        data: { pr: pr.number, url: pr.html_url, branch: pr.head?.ref ?? item.branch, base, head: pr.merge_commit_sha ?? '' },
      });
      if (item.release) tagRelease(hub, p, item, pr.merge_commit_sha ?? ''); // its merge is the release (#400)
    } else if (item.stage === 'landing' && state === 'closed' && ownBranch(item, pr.head?.ref)
      && heldAlready(hub, p, item, { number: pr.number, url: pr.html_url })) {
      // Main already held it: done, not sent back (#686).
    } else if (item.stage === 'landing' && state === 'closed' && ownBranch(item, pr.head?.ref)) {
      const headline = `PR #${pr.number} was closed without merging`;
      const summary = 'Read the pull request for why, rework it on the same branch, and submit again.';
      hub.move(item, 'ready', ACTOR, { holder: null, lease_until: null, handoff: JSON.stringify({ kind: 'sent_back', by: ACTOR, headline, summary, at: hub.now() }) });
      hub.event(p, { item, actor: ACTOR, type: 'sent_back', headline: `${headline}; #${item.seq} is back in the queue`, summary, data: { pr: pr.number, url: pr.html_url } });
    }
  }
  if (state === 'open' && item.stage === 'landing') blocked(hub, p, item, repo, pr);
  return { item: `#${item.seq}`, pr: pr.number, state };
}

// A pull request on record merged without a webhook saying so (the hub merged it, or saw GitHub had): the
// record and the item move exactly as the merged webhook moves them, so that webhook, arriving later,
// changes nothing. row: its prs row. In a transaction.
export function prMerged(hub, p, row, { sha = '', base = 'main' } = {}) {
  return pullRequest(hub, p, {
    repository: { full_name: row.repo },
    pull_request: {
      number: row.number, title: row.title, state: 'closed', merged: true, html_url: row.url,
      head: { ref: row.head_ref, sha: row.head_sha }, base: { ref: base }, merge_commit_sha: sha,
    },
  });
}

// A landing item's pull request closed unmerged, but its base already holds the change its review accepted (#686):
// it reached main another way, a squash under another item say, so the land rebase left the branch equal to main
// and GitHub closed the PR for having no diff. That is landed: the item is done, and a release is tagged. Judged by
// reviewed_sha, never the PR's head: a rebase gone wrong (main's side taken, the branch reset) also leaves the head
// on main, with the accepted work lost, and that close is sent back as before. So is one with no reviewed head on
// record. Read from the mirror as it is, since a webhook doesn't wait on the network. True when it marked the item
// done. In a transaction.
function heldAlready(hub, p, item, { number, url }) {
  const repo = item.reviewed_sha && hub.repoFor(p, item);
  const base = repo && baseOf(repo.path);
  if (!base || !holdsChange(repo.path, base, item.reviewed_sha)) return false;
  hub.move(item, 'done', ACTOR, { holder: null, lease_until: null, touching: '[]' });
  hub.event(p, {
    item, actor: ACTOR, type: 'landed',
    headline: `PR #${number} closed with nothing to merge: ${base} already holds the change #${item.seq}'s review accepted, so it is done`,
    summary: `GitHub closed it unmerged, and ${base} already has ${item.reviewed_sha.slice(0, 7)}'s change, so there is nothing left to land.`,
    data: { pr: number, url, branch: item.branch, base, head: headOf(repo.path, base), reviewed: item.reviewed_sha, held: true },
  });
  // The release is the reviewed commit when main has it; else main as it is, which holds the change.
  if (item.release) tagRelease(hub, p, item, (contains(repo.path, base, item.reviewed_sha) ? item.reviewed_sha : shaOf(repo.path, base)) ?? '');
  return true;
}

// What the hub's own look at a landing item's open pull request found (its periodic pass, which a hub needs
// because no webhook may reach it), as pull() in src/ghapp.js says: merged lands it, as the merged webhook
// does; closed without merging leaves it in landing, a land job again, saying so; conflicting with main
// (dirty, or behind it) makes it a land job to rebase the branch (see landHint). In a transaction.
// True when it changed something.
export function prSeen(hub, p, row, pr) {
  row = hub.q('SELECT * FROM prs WHERE project_id = ? AND repo = ? AND number = ?').get(p.id, row.repo, row.number);
  if (row?.state !== 'open') return false; // a webhook got here first
  if (pr.state === 'merged') return !!prMerged(hub, p, row, pr);
  const item = hub.itemById(row.item_id);
  if (item?.stage !== 'landing') return false;
  if (pr.state === 'closed') {
    hub.q(`UPDATE prs SET state = 'closed', updated_at = ? WHERE project_id = ? AND repo = ? AND number = ?`).run(hub.now(), p.id, row.repo, row.number);
    if (heldAlready(hub, p, item, { number: row.number, url: row.url })) return true;
    if (item.holder) hub.patch(item, { holder: null, lease_until: null });
    hub.event(p, {
      item, actor: ACTOR, type: 'pr', headline: `PR #${row.number} was closed without merging; #${item.seq} is a land job again`,
      summary: `Someone closed it on GitHub (${row.url}). The work is still accepted: the next land job puts ${item.branch || 'its branch'} through a new pull request.`,
      data: { url: row.url, repo: row.repo, number: row.number, state: 'closed' },
    });
    return true;
  }
  if (['dirty', 'behind'].includes(pr.mergeable_state) && row.blocked !== 'conflict') {
    // Offered as a land job from now on, to whoever is free: a hold from before the conflict doesn't count.
    if (item.holder) hub.patch(item, { holder: null, lease_until: null });
    setBlocked(hub, p, item, row, 'conflict', row.url);
    return true;
  }
  return false;
}

// Why an open landing PR can't merge, as GitHub says: its branch conflicts with (or is behind) main, which
// a rebase fixes; or it waits for a person's approval. Checks that fail are handled per check (below).
// Only a change goes on the record. mergeable_state "unknown" (still computing) leaves things as they are.
const BLOCKED_HEADLINE = {
  conflict: (n) => `PR #${n} can't merge: its branch conflicts with main (or is behind it); an agent rebases it`,
  review: (n) => `PR #${n} waits for a person's approval on GitHub`,
  '': (n) => `PR #${n} can merge again`,
};
function blocked(hub, p, item, repo, pr) {
  const row = hub.q('SELECT * FROM prs WHERE project_id = ? AND repo = ? AND number = ?').get(p.id, repo, pr.number);
  const ms = pr.mergeable_state;
  const ci = ciState(hub, p, pr.head?.sha ?? '').state;
  const why = ['dirty', 'behind'].includes(ms) ? 'conflict'
    : pr.review_decision === 'REVIEW_REQUIRED' || (ms === 'blocked' && ci !== 'fail') ? 'review'
    : !ms || ms === 'unknown' || ms === 'blocked' ? row.blocked
    : '';
  setBlocked(hub, p, item, row, why, pr.html_url);
}

function setBlocked(hub, p, item, row, why, url) {
  if (why === row.blocked) return;
  hub.q('UPDATE prs SET blocked = ? WHERE project_id = ? AND repo = ? AND number = ?').run(why, p.id, row.repo, row.number);
  hub.event(p, {
    item, actor: ACTOR, type: 'pr_blocked', headline: BLOCKED_HEADLINE[why](row.number),
    summary: why === 'review' ? `Approve it on GitHub (${url || row.url}); auto-merge then merges it and #${item.seq} is done.` : '',
    data: { pr: row.number, url: url || row.url, blocked: why },
  });
}

// An approving review clears "waits for approval"; GitHub's next pull_request event says the rest.
function review(hub, p, body) {
  const pr = body.pull_request, state = String(body.review?.state ?? '').toLowerCase();
  if (!pr || body.action !== 'submitted') return { ignored: body.action || 'no review' };
  const full = body.repository?.full_name ?? '';
  const row = hub.q(`SELECT * FROM prs WHERE project_id = ? AND repo IN (?, ?) AND number = ? AND state = 'open'`).get(p.id, full, `github.com/${full}`.toLowerCase(), pr.number);
  if (!row) return { ignored: 'no pull request on record' };
  const item = hub.itemById(row.item_id);
  if (state === 'approved' && row.blocked === 'review') setBlocked(hub, p, item, row, '', pr.html_url);
  return { item: `#${item.seq}`, pr: pr.number, review: state };
}

// A completed check (check_suite, check_run or commit status) for a commit.
function check(hub, p, { sha, name, conclusion, url }) {
  if (!sha || !conclusion) return { ignored: 'not completed' };
  const prs = hub.q('SELECT * FROM prs WHERE project_id = ? AND head_sha = ?').all(p.id, sha);
  if (!prs.length) return { ignored: 'no pull request for this commit' };
  const before = ciState(hub, p, sha).state;
  hub.q(`INSERT INTO checks (project_id, sha, name, conclusion, url, at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id, sha, name) DO UPDATE SET conclusion = excluded.conclusion, url = excluded.url, at = excluded.at`)
    .run(p.id, sha, name, conclusion, url ?? '', hub.now());
  const after = ciState(hub, p, sha);
  // One line on the record when the overall result changes, not one per check.
  if (after.state !== before && after.state !== 'pending') {
    for (const pr of prs) {
      const failed = after.checks.filter((c) => FAIL.has(c.conclusion)).map((c) => c.name);
      const item = hub.itemById(pr.item_id);
      hub.event(p, {
        item, actor: ACTOR, type: 'ci',
        headline: after.state === 'pass' ? `CI passed on PR #${pr.number}` : `CI failed on PR #${pr.number}: ${failed.join(', ')}`,
        data: { sha, state: after.state, url, pr: pr.number },
      });
      // Accepted work whose pull request fails a check goes back to its builder, like a send-back: the fix
      // goes on the same branch, the PR stays, and its auto-merge merges it once checks pass.
      if (after.state === 'fail' && pr.state === 'open' && item?.stage === 'landing' && ownBranch(item, pr.head_ref)) {
        const bad = after.checks.filter((c) => FAIL.has(c.conclusion));
        const headline = `${bad.map((c) => c.name).join(', ')} failed on PR #${pr.number}`;
        const summary = `${bad.map((c) => `${c.name}: ${c.conclusion}${c.url ? ` (${c.url})` : ''}`).join('\n')}\n\nFix it on ${item.branch || 'the same branch'} and push: the pull request stays open, and it merges once its checks pass. Then submit again.`;
        hub.move(item, 'ready', ACTOR, {
          holder: null, lease_until: null, rejections: item.rejections + 1, last_worker: item.implementer || item.last_worker,
          handoff: JSON.stringify({ kind: 'sent_back', by: ACTOR, headline, summary, at: hub.now() }),
        });
        hub.event(p, { item, actor: ACTOR, type: 'sent_back', headline: `${headline}; #${item.seq} goes back to ${item.implementer || 'its builder'}`, summary, data: { pr: pr.number, checks: bad } });
      }
    }
  }
  return { sha: sha.slice(0, 7), ci: after.state };
}

// GitHub delivery ids this hub acted on (#478), so a replay changes nothing. A delivery is marked once it was
// handled, so one that failed can still be redelivered. No id (not from GitHub): new each time.
const WEEK = 7 * 24 * 3600_000;
const seen = (hub, id) => !!id && !!hub.q('SELECT 1 FROM deliveries WHERE id = ?').get(String(id));
function mark(hub, id) {
  if (!id) return;
  hub.q('DELETE FROM deliveries WHERE at < ?').run(hub.now() - WEEK);
  hub.q('INSERT OR IGNORE INTO deliveries (id, at) VALUES (?, ?)').run(String(id), hub.now());
}

export function receive(hub, slug, { event, signature, raw, delivery }) {
  let p;
  try { p = hub.project(slug); } catch { p = null; }
  // Unknown project, no secret, bad signature: all the same answer, and nothing is recorded.
  if (!p || !verify(p.github_secret, raw, signature)) {
    throw new UserError('signature check failed', { status: 401, hint: "Set the same secret in the project (UI: GitHub, under the mission) and in the GitHub webhook's settings, with content type application/json." });
  }
  const body = parse(raw);
  if (seen(hub, delivery)) return { ok: true, ignored: 'a delivery already acted on' };
  const result = handle(hub, p, event, body);
  mark(hub, delivery);
  if (!result.ignored && !result.pong) hub.changed(p);
  return { ok: true, ...result };
}

// The app's webhook (POST /api/hooks/github-app), signed with the app's webhook secret: one address for
// every repository the app is installed on, so no project needs a secret of its own. A delivery goes to
// each project, on the hubs hubsOf(body) names, that has the repository it is about (an installation
// event: any repository it lists). [{ hub, p, result }]; none when no project has it.
export function receiveApp(hubsOf, { secret, event, signature, raw, delivery }) {
  if (!verify(secret, raw, signature)) {
    throw new UserError('signature check failed', { status: 401, hint: "The hub checks app deliveries with the app's webhook secret: the one in its saved app file, or NUWORQ_GITHUB_APP_WEBHOOK_SECRET. Set the same one in the app's settings on GitHub." });
  }
  const body = parse(raw);
  const full = [body.repository, ...(body.repositories ?? []), ...(body.repositories_added ?? [])].map((r) => r?.full_name).filter(Boolean);
  const named = new Set(full.map((f) => normRemote(`github.com/${f}`)));
  const out = [];
  if (event === 'ping' || !named.size) return out;
  for (const hub of hubsOf(body)) {
    const ps = hub.projects().filter((p) => hub.remotesOf(p).some((r) => named.has(r)));
    // Recorded only where some project takes it, so a delivery dropped (no project yet) can be redelivered.
    if (seen(hub, delivery)) {
      for (const p of ps) out.push({ hub, p, result: { ignored: 'a delivery already acted on' } });
      continue;
    }
    for (const p of ps) {
      const result = handle(hub, p, event, body);
      if (!result.ignored) hub.changed(p);
      out.push({ hub, p, result });
    }
    if (ps.length) mark(hub, delivery);
  }
  return out;
}

function parse(raw) {
  try { return JSON.parse(raw.toString('utf8')); } catch { throw new UserError('payload must be JSON', { hint: 'Set the webhook content type to application/json.' }); }
}

// One genuine delivery, for one project.
function handle(hub, p, event, body) {
  return hub.tx(() => {
    if (event === 'ping') return { pong: true };
    if (event === 'pull_request') return pullRequest(hub, p, body);
    if (event === 'pull_request_review') return review(hub, p, body);
    if (event === 'issues') return issueEvent(hub, p, body);
    if (event === 'issue_comment') return issueComment(hub, p, body);
    if (event === 'dependabot_alert') return alertEvent(hub, p, body);
    // The app was installed on (or added to) repositories: their open issues and alerts come in, after this answer.
    if (event === 'installation' || event === 'installation_repositories') {
      const repos = installedRepos(hub, p, body);
      return repos.length ? { sync: repos } : { ignored: `none of ${p.name}'s repositories` };
    }
    // Only finished results count; "queued", "in progress" and "pending" are noise here.
    if (event === 'check_suite') {
      const s = body.check_suite ?? {};
      return body.action === 'completed' ? check(hub, p, { sha: s.head_sha, name: s.app?.name ?? 'checks', conclusion: s.conclusion, url: s.url }) : { ignored: 'pending' };
    }
    if (event === 'check_run') {
      const r = body.check_run ?? {};
      return body.action === 'completed' ? check(hub, p, { sha: r.head_sha, name: r.name ?? 'check', conclusion: r.conclusion, url: r.html_url }) : { ignored: 'pending' };
    }
    if (event === 'status') {
      return body.state === 'pending' ? { ignored: 'pending' } : check(hub, p, { sha: body.sha, name: body.context ?? 'status', conclusion: body.state, url: body.target_url });
    }
    return { ignored: event || 'unknown event' };
  });
}
