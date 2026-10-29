// GitHub webhooks: pull requests and CI results link to items without agents typing them.
// POST /api/hooks/github/<project>, signed with the project's secret (X-Hub-Signature-256).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { UserError } from './core.js';
import { issueEvent, issueComment, installedRepos } from './issues.js';

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

function pullRequest(hub, p, body) {
  const pr = body.pull_request;
  if (!pr) return { ignored: 'no pull_request' };
  const full = body.repository?.full_name ?? '';
  const state = pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
  // A PR the hub opened is on record under the normalized remote (github.com/o/r); others under o/r.
  const old = hub.q('SELECT * FROM prs WHERE project_id = ? AND repo IN (?, ?) AND number = ? ORDER BY repo DESC').get(p.id, full, `github.com/${full}`.toLowerCase(), pr.number);
  const repo = old?.repo ?? full;
  const item = old ? hub.itemById(old.item_id) : itemFor(hub, p, pr);
  if (!item) return { ignored: 'no matching item' };
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
    } else if (item.stage === 'landing' && state === 'closed') {
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
      if (after.state === 'fail' && pr.state === 'open' && item?.stage === 'landing') {
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

export function receive(hub, slug, { event, signature, raw }) {
  let p;
  try { p = hub.project(slug); } catch { p = null; }
  // Unknown project, no secret, bad signature: all the same answer, and nothing is recorded.
  if (!p || !verify(p.github_secret, raw, signature)) {
    throw new UserError('signature check failed', { status: 401, hint: "Set the same secret in the project (UI: GitHub, under the mission) and in the GitHub webhook's settings, with content type application/json." });
  }
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { throw new UserError('payload must be JSON', { hint: 'Set the webhook content type to application/json.' }); }
  const result = hub.tx(() => {
    if (event === 'ping') return { pong: true };
    if (event === 'pull_request') return pullRequest(hub, p, body);
    if (event === 'pull_request_review') return review(hub, p, body);
    if (event === 'issues') return issueEvent(hub, p, body);
    if (event === 'issue_comment') return issueComment(hub, p, body);
    // The app was installed on (or added to) repositories: their open issues come in, after this answer.
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
  if (!result.ignored && !result.pong) hub.changed(p);
  return { ok: true, ...result };
}
