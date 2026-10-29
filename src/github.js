// GitHub webhooks: pull requests and CI results link to items without agents typing them.
// POST /api/hooks/github/<project>, signed with the project's secret (X-Hub-Signature-256).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { UserError } from './core.js';

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

// The item a pull request is about: "#N" in its title, then the item the branch's agent holds
// (or last submitted), then "#N" in its body.
function itemFor(hub, p, pr) {
  const bySeq = (text) => {
    const n = String(text ?? '').match(/(?:^|[^\w&])#(\d+)\b/)?.[1];
    return n ? hub.q('SELECT * FROM items WHERE project_id = ? AND seq = ?').get(p.id, Number(n)) : null;
  };
  const agent = String(pr.head?.ref ?? '').match(/^trellis\/(.+)$/)?.[1];
  const byBranch = () => agent && hub.q(`SELECT * FROM items WHERE project_id = ? AND (holder = ? OR implementer = ? OR last_worker = ?)
      ORDER BY (holder = ?) DESC, (stage IN ('active', 'verifying')) DESC, updated_at DESC LIMIT 1`).get(p.id, agent, agent, agent, agent);
  return bySeq(pr.title) || byBranch() || bySeq(pr.body);
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
  const repo = body.repository?.full_name ?? '';
  const state = pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
  const old = hub.q('SELECT * FROM prs WHERE project_id = ? AND repo = ? AND number = ?').get(p.id, repo, pr.number);
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
  }
  return { item: `#${item.seq}`, pr: pr.number, state };
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
      hub.event(p, {
        item: hub.itemById(pr.item_id), actor: ACTOR, type: 'ci',
        headline: after.state === 'pass' ? `CI passed on PR #${pr.number}` : `CI failed on PR #${pr.number}: ${failed.join(', ')}`,
        data: { sha, state: after.state, url, pr: pr.number },
      });
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
