import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hub } from '../src/core.js';
import { GitHubApp } from '../src/ghapp.js';
import { syncIssues, closeStale, closeLanded, CLOSE_ALL } from '../src/issues.js';
import { view } from '../src/insight.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

// GitHub for one repository with 3 open issues: listing, comments, and closing, as the app's token sees it.
function github() {
  const issues = new Map([1, 2, 3].map((n) => [n, { number: n, title: `Issue ${n}`, body: `Body ${n}`, state: 'open', labels: [], author_association: 'OWNER', html_url: `https://github.com/acme/api/issues/${n}` }]));
  const state = { comments: [], closes: [] };
  const server = http.createServer(async (req, res) => {
    const json = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    let raw = '';
    for await (const c of req) raw += c;
    let m;
    if (req.method === 'GET' && req.url === '/repos/acme/api/installation') return json(200, { id: 42 });
    if (req.method === 'POST' && req.url === '/app/installations/42/access_tokens') return json(201, { token: 'ghs_x', expires_at: '2099-01-01T00:00:00Z' });
    if (req.headers.authorization !== 'Bearer ghs_x') return json(401, {});
    if (req.method === 'GET' && (m = req.url.match(/^\/repos\/acme\/api\/issues\?state=open&per_page=100&page=(\d+)$/))) {
      return json(200, m[1] === '1' ? [...issues.values()].filter((i) => i.state === 'open') : []);
    }
    if ((m = req.url.match(/^\/repos\/acme\/api\/issues\/(\d+)(\/comments)?$/))) {
      const issue = issues.get(Number(m[1]));
      if (req.method === 'GET' && !m[2]) return json(200, issue);
      if (req.method === 'POST' && m[2]) { state.comments.push({ number: issue.number, body: JSON.parse(raw).body }); return json(201, { id: state.comments.length }); }
      if (req.method === 'PATCH' && !m[2]) { Object.assign(issue, JSON.parse(raw)); state.closes.push({ number: issue.number, reason: issue.state_reason }); return json(200, issue); }
    }
    json(404, {});
  });
  return { server, state, issues };
}

describe('an existing GitHub backlog moves onto nuworq', () => {
  test('install → 3 proposals; one duplicate, one stale → one card; the card closes the stale one; landing closes the other two', async () => {
    const gh = github();
    await new Promise((r) => gh.server.listen(0, '127.0.0.1', r));
    const app = new GitHubApp({ id: 1, key: PEM, api: `http://127.0.0.1:${gh.server.address().port}` });
    try {
      // The project lives in a checkout on this machine whose origin is the GitHub repository.
      const repo = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-backlog-')));
      const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/api.git');
      writeFileSync(join(repo, 'README'), 'api\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'init');
      const hub = new Hub();
      hub.tx(() => hub.project('api', { create: true }));
      hub.humanOp('api', 'settings', { path: repo });
      hub.addRemote(hub.project('api'), 'github.com/acme/api', 'you');
      const p = () => hub.project('api');
      const item = (n) => hub.item(p(), `#${n}`);
      const link = (it) => `https://hub.test/#/p/api/${it.seq}`;

      // 1. Install: three open issues, three proposals.
      const synced = await syncIssues(hub, p(), app, ['github.com/acme/api'], { link });
      assert.deepEqual(synced, { issues: 3, commented: 3 });
      assert.deepEqual([1, 2, 3].map((n) => item(n).stage), ['proposed', 'proposed', 'proposed']);

      // 2. Shaping: #2 duplicates #1; #3 is stale. One card for the human.
      hub.agentOp('api', 'refine', 'shaper', { item: '#2', duplicate_of: '#1' });
      hub.agentOp('api', 'refine', 'shaper', { item: '#3', stale: 'superseded by the v2 API' });
      const cards = view(hub, 'api').attention.filter((a) => a.kind === 'question');
      assert.equal(cards.length, 1, 'one card');
      assert.match(cards[0].headline, /Close these 1 stale issues\?/);

      // 3. The card: close them all.
      const q = hub.q("SELECT id FROM questions WHERE asked_by = 'nuworq' AND status = 'open'").get();
      const answered = hub.humanOp('api', 'answer', { question: q.id, answer: CLOSE_ALL });
      assert.equal(answered.closing, 1);
      assert.deepEqual(await closeStale(hub, p(), app), { closed: 1 });
      assert.equal(gh.issues.get(3).state, 'closed');
      assert.equal(item(3).stage, 'dropped');

      // 4. #1 is built and lands (locally, no PR): its issues, #1 and the duplicate #2, close on GitHub.
      hub.humanOp('api', 'update', { item: '#1', acceptance: 'it works' });
      const job = hub.agentOp('api', 'next', 'builder');
      assert.equal(job.item, '#1');
      const wt = `${repo}.worktrees/builder`;
      git(repo, 'worktree', 'add', '-q', '--detach', wt, 'main');
      git(wt, 'switch', '-q', '-c', job.branch, 'main');
      writeFileSync(join(wt, 'it.txt'), 'it\n');
      git(wt, 'add', '.');
      git(wt, 'commit', '-q', '-m', 'do it');
      hub.agentOp('api', 'submit', 'builder', { item: '#1', headline: 'Done' });
      hub.humanOp('api', 'accept', { item: '#1' });
      assert.equal(hub.agentOp('api', 'next', 'builder').mode, 'land');
      git(repo, 'merge', '-q', '--ff-only', job.branch);
      hub.agentOp('api', 'submit', 'builder', { item: '#1', headline: 'Landed' });
      assert.equal(item(1).stage, 'done');
      assert.deepEqual(await closeLanded(hub, p(), app, { link }), { closed: 2 });
      assert.deepEqual([1, 2, 3].map((n) => gh.issues.get(n).state), ['closed', 'closed', 'closed']);
      assert.deepEqual(gh.state.closes.map((c) => [c.number, c.reason]).sort(), [[1, 'completed'], [2, 'completed'], [3, 'not_planned']]);
      assert.deepEqual(await closeLanded(hub, p(), app, { link }), { closed: 0 }, 'nothing twice');
    } finally { gh.server.close(); }
  });
});
