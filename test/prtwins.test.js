import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { Hub, HOUR } from '../src/core.js';
import { receive } from '../src/github.js';

const SECRET = 'webhook-secret';
const BRANCH = 'nuworq/1-add-it';

// #261: GitHub's "opened" delivery for a PR the hub just opened can arrive while the land step still awaits
// GitHub. The webhook records it under the repository's own name (acme/api), the land step under the remote
// (github.com/acme/api): two records, and a conflict marked on one hid behind the other, so no agent was ever
// offered the rebase (#228 sat 12 hours).
function world(file = ':memory:') {
  let t = Date.UTC(2026, 9, 31, 9);
  const hub = new Hub({ file, clock: () => t });
  hub.tx(() => hub.project('demo', { create: true }));
  hub.humanOp('demo', 'remote', { add: 'https://github.com/acme/api.git' });
  hub.humanOp('demo', 'settings', { github_secret: SECRET });
  const p = () => hub.project('demo');
  const deliver = (action, over = {}) => {
    const raw = Buffer.from(JSON.stringify({ action, repository: { full_name: 'acme/api' },
      pull_request: { number: 7, title: 'Add it', state: 'open', merged: false, html_url: 'https://github.com/acme/api/pull/7', head: { ref: BRANCH, sha: 'abc1234' }, base: { ref: 'main' }, ...over } }));
    return receive(hub, 'demo', { event: 'pull_request', raw, signature: 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex') });
  };
  const rows = () => hub.q('SELECT repo, number, blocked, head_sha, state FROM prs WHERE project_id = ? ORDER BY repo').all(p().id);
  return { hub, p, deliver, rows, tick: (ms) => (t += ms) };
}

describe('a pull request has one record (#261)', () => {
  test('"opened" handled while the land step awaits GitHub: one record; its conflict later gives a land job', async () => {
    const w = world();
    w.hub.humanOp('demo', 'create', { title: 'Add it', acceptance: 'x' });
    const it = w.hub.item(w.p(), '#1');
    w.hub.q("UPDATE items SET stage = 'landing', branch = ?, implementer = 'a1' WHERE id = ?").run(BRANCH, it.id);
    w.hub.github = {
      covers: () => true,
      // GitHub has opened it, and its webhook is handled before openPr returns.
      async openPr() { w.deliver('opened'); return { number: 7, url: 'https://github.com/acme/api/pull/7', node_id: 'PR_7', head_ref: BRANCH, head_sha: 'abc1234' }; },
      async autoMerge() {},
    };
    w.hub.openPr(w.p(), w.hub.item(w.p(), '#1'));
    await w.hub.prsSettled();
    assert.deepEqual(w.rows().map((r) => r.repo), ['github.com/acme/api'], 'one record, under the remote');

    // main moves: GitHub says it conflicts. The one record says so, and the builder is offered the rebase.
    w.deliver('synchronize', { mergeable_state: 'dirty' });
    assert.deepEqual(w.rows().map((r) => [r.repo, r.blocked]), [['github.com/acme/api', 'conflict']]);
    w.hub.agentOp('demo', 'checkin', 'a1', {});
    const job = w.hub.agentOp('demo', 'next', 'a1', {});
    assert.equal(job.mode, 'land');
    assert.equal(job.item, '#1');
  });

  test('twins already on record merge when the hub starts: the newest head, the blocked reason either has', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nuworq-prtwins-')), 'hub.db');
    const w = world(file);
    w.hub.humanOp('demo', 'create', { title: 'Add it', acceptance: 'x' });
    const it = w.hub.item(w.p(), '#1');
    const add = w.hub.q(`INSERT INTO prs (project_id, repo, number, item_id, url, title, state, head_ref, head_sha, updated_at, blocked)
      VALUES (?, ?, ?, ?, 'https://github.com/acme/api/pull/7', 'Add it', 'open', ?, ?, ?, ?)`);
    add.run(w.p().id, 'github.com/acme/api', 7, it.id, BRANCH, 'aaa1111', 1000, 'conflict');
    add.run(w.p().id, 'acme/api', 7, it.id, BRANCH, 'bbb2222', 2000, '');
    // Another PR on its own, and the same number in another repository: left alone.
    add.run(w.p().id, 'github.com/acme/api', 8, it.id, BRANCH, 'ccc3333', 1500, '');
    add.run(w.p().id, 'acme/web', 7, it.id, BRANCH, 'ddd4444', 1500, '');
    w.hub.db.close();

    const again = new Hub({ file });
    const rows = again.q('SELECT repo, number, blocked, head_sha, updated_at FROM prs ORDER BY repo, number').all().map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { repo: 'acme/web', number: 7, blocked: '', head_sha: 'ddd4444', updated_at: 1500 },
      { repo: 'github.com/acme/api', number: 7, blocked: 'conflict', head_sha: 'bbb2222', updated_at: 2000 },
      { repo: 'github.com/acme/api', number: 8, blocked: '', head_sha: 'ccc3333', updated_at: 1500 },
    ]);
    again.db.close();
  });
});
