// Proposing work from a project's board (#389): the form and what it sends.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { readFileSync } from 'node:fs';
import { proposeForm, proposal } from '../web/propose.js';
import { NEW } from '../web/new.js';

describe('propose from the board', () => {
  test('one field and one button at first; done means, context and priority open on demand', () => {
    const closed = proposeForm();
    assert.match(closed, /id="nw-title"/);
    assert.match(closed, /data-action="add-work">Propose</);
    assert.match(closed, /data-action="nw-more"/);
    assert.doesNotMatch(closed, /nw-acceptance|nw-summary|nw-priority/);
    const open = proposeForm({ more: true, priority: 'now' });
    assert.match(open, /id="nw-acceptance"/);
    assert.match(open, /id="nw-summary"/);
    assert.match(open, /class="on" data-action="nw-priority" data-p="now"/);
    assert.doesNotMatch(open, /data-action="nw-more"/);
  });

  test('wired in: the board\'s + Work opens it and is tagged new', () => {
    const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    assert.match(app, /proposeForm\(\{ more: S\.addMore/);
    assert.match(app, /data-action="toggle-add"[^>]*data-new="propose-work"/);
    assert.match(app, /human\('create', body/);
    assert.ok(NEW['propose-work']);
  });

  test('it says what happens next, by the project\'s autonomy', () => {
    assert.match(proposeForm({ autonomy: 'full' }), /shapes it into work, then it gets built/);
    assert.match(proposeForm({ autonomy: 'ask' }), /waits for your OK/);
  });

  test('it always sends a proposal; no title, nothing to send', () => {
    assert.equal(proposal({ title: '  ' }), null);
    assert.deepEqual(proposal({ title: ' Users can reset their password ' }), { title: 'Users can reset their password', acceptance: '', summary: '', priority: 'soon', stage: 'proposed' });
    assert.equal(proposal({ title: 'x', acceptance: 'A reset email arrives', priority: 'now' }).acceptance, 'A reset email arrives');
  });

  // Over HTTP, as the board sends it: the person's proposal, then shaped or waiting per the project's autonomy.
  async function viaBoard(autonomy, form) {
    const hub = new Hub();
    hub.tx(() => hub.project('w', { create: true }));
    hub.humanOp('w', 'settings', { autonomy });
    const server = createServer(hub, { sweepMs: 3_600_000 });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/p/w/human/create`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proposal(form)),
      });
      assert.equal(res.status, 200);
      const { item } = await res.json();
      const it = () => hub.item(hub.project('w'), item);
      assert.equal(it().stage, 'proposed', 'a proposal, even with done means');
      assert.ok(!it().created_by.startsWith('claude'), 'by the person');
      return { hub, item, it };
    } finally { server.close(); }
  }

  test('full autonomy: an agent shapes it into ready work', async () => {
    const { hub, item, it } = await viaBoard('full', { title: 'Users can reset their password', acceptance: 'A reset email arrives' });
    const job = hub.agentOp('w', 'next', 'claude-a', {});
    assert.equal(job.item, item);
    assert.equal(job.mode, 'shape');
    hub.agentOp('w', 'submit', 'claude-a', { item, headline: 'Shaped' });
    assert.equal(it().stage, 'ready');
  });

  test('"ask": a title alone is shaped, then waits for an OK; with done means it waits at once', async () => {
    const bare = await viaBoard('ask', { title: 'Users can reset their password' });
    const job = bare.hub.agentOp('w', 'next', 'claude-a', {});
    assert.equal(job.item, bare.item);
    assert.equal(job.mode, 'shape');
    bare.hub.agentOp('w', 'submit', 'claude-a', { item: bare.item, headline: 'Shaped', acceptance: 'A reset email arrives' });
    assert.equal(bare.it().stage, 'proposed');
    assert.ok(!bare.it().holder);

    const full = await viaBoard('ask', { title: 'Users can reset their password', acceptance: 'A reset email arrives' });
    assert.equal(full.hub.agentOp('w', 'next', 'claude-a', {}).mode, 'idle', 'nothing to shape: it waits for the person');
    assert.equal(full.it().stage, 'proposed');
  });
});
