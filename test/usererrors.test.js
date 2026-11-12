import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { hintlessUserErrors } from './helpers/usererrors.js';

// #930: every UserError carries a hint saying what to do instead (docs/ARCHITECTURE.md, "Every error carries a hint").
// An exemption names the start of the call's source and why a hint would be wrong; none is needed today.
const EXEMPT = [];

describe('every UserError in src carries a hint', () => {
  test('no new UserError( goes without one, outside the named exemptions', () => {
    const bare = hintlessUserErrors(new URL('../src', import.meta.url).pathname)
      .filter((e) => !EXEMPT.some((x) => e.call.startsWith(x.call)));
    assert.deepEqual(bare.map((e) => `${e.file}:${e.line} ${e.call}`), [], 'add { hint: "what to do instead" }');
  });

  test('the scanner sees a hintless call, one in a nested template, and a hinted one', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'usererrors-'));
    writeFileSync(join(dir, 'a.js'), [
      'throw new UserError("bare");',
      'throw new UserError(`x ${a ? `y ${b}` : ""} ")`);',
      'throw new UserError("ok", { hint: "do this" });',
    ].join('\n'));
    assert.deepEqual(hintlessUserErrors(dir).map((e) => e.line), [1, 2]);
  });
});

const single = () => { const hub = new Hub(); hub.tx(() => hub.project('demo', { create: true })); return hub; };
const refused = (fn) => { try { fn(); } catch (e) { return e; } assert.fail('expected an error'); };

describe('refusals an agent hits in ordinary work say what to do', () => {
  test('review: your own work', () => {
    const hub = single();
    hub.agentOp('demo', 'checkin', 'w1', {});
    hub.agentOp('demo', 'propose', 'w1', { title: 'T', acceptance: 'it works' });
    hub.agentOp('demo', 'claim', 'w1', { item: '#1' });
    hub.agentOp('demo', 'submit', 'w1', { item: '#1', headline: 'done' });
    const own = refused(() => hub.agentOp('demo', 'review', 'w1', { item: '#1', verdict: 'accept', headline: 'ok' }));
    assert.equal(own.status, 403);
    assert.ok(own.hint);
  });

  test('submit: work that is not active, and an item in no state to be claimed', () => {
    const hub = single();
    hub.agentOp('demo', 'checkin', 'w1', {});
    hub.agentOp('demo', 'propose', 'w1', { title: 'T', acceptance: 'it works' });
    const e = refused(() => hub.agentOp('demo', 'submit', 'w1', { item: '#1', headline: 'done' }));
    assert.ok(e.hint, e.message);
  });

  test('field notes: an unknown one is a 404 with a hint', () => {
    const hub = single();
    hub.agentOp('demo', 'checkin', 'w1', {});
    const e = refused(() => hub.humanOp('demo', 'retire', { note: 4242 }));
    assert.equal(e.status, 404);
    assert.ok(e.hint, e.message);
  });

  test('a name that is too long or reserved', () => {
    const hub = single();
    for (const name of ['x'.repeat(61), 'you', 'nuworq']) {
      const e = refused(() => hub.requireAgent(name));
      assert.ok(e.hint, e.message);
    }
  });

  test('refine: an item cannot duplicate itself', () => {
    const hub = single();
    hub.agentOp('demo', 'checkin', 'w1', {});
    hub.agentOp('demo', 'propose', 'w1', { title: 'T', acceptance: 'it works' });
    const e = refused(() => hub.agentOp('demo', 'refine', 'w1', { item: '#1', duplicate_of: '#1' }));
    assert.ok(e.hint, e.message);
  });

  test('over HTTP, the hint reaches the body (and so MCP, which forwards it)', async () => {
    const hub = single();
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const runner = server.auth.localRunnerToken('box');
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/p/demo/agent/checkin`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-nuworq-agent': 'x'.repeat(61), authorization: `Bearer ${runner.token}` }, body: '{}',
      });
      const json = await r.json();
      assert.equal(r.status, 400);
      assert.match(json.error, /too long/);
      assert.ok(json.hint);
    } finally { server.close(); }
  });
});
