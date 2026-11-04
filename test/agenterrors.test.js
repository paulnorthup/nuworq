import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { OPS } from '../src/protocol.js';
import { missingField } from '../src/agentargs.js';

const single = () => { const hub = new Hub(); hub.tx(() => hub.project('demo', { create: true })); return hub; };
const refused = (fn) => { try { fn(); } catch (e) { return e; } assert.fail('expected an error'); };

// #715: every agent error names what's wrong and carries a hint; none says "undefined".
describe('agent errors name the field and say what to send', () => {
  const ops = OPS.filter((o) => o.required?.length);

  // feedback is served by the server (see the HTTP test below); every other operation is the hub's.
  for (const op of ops.filter((o) => o.name !== 'feedback')) {
    for (const field of op.required) {
      test(`${op.name} without ${field}: 400 "${field} is required", with an example body`, () => {
        const hub = single();
        hub.agentOp('demo', 'checkin', 'w1', {});
        const args = JSON.parse(missingField(op.name, {}).example);
        delete args[field];
        for (const blank of [undefined, '', '  ']) {
          const e = refused(() => hub.agentOp('demo', op.name, 'w1', blank === undefined ? args : { ...args, [field]: blank }));
          assert.equal(e.status, 400);
          assert.equal(e.message, `${field} is required`);
          assert.ok(e.hint, 'carries a hint');
          assert.match(e.hint, new RegExp(`e\\.g\\. ${op.name} \\{.*"${field}":`), 'shows a whole valid body');
          assert.doesNotMatch(`${e.message} ${e.hint}`, /undefined|null/);
        }
      });
    }
  }

  test('the example body is one the operation takes: all its required fields', () => {
    for (const op of ops) assert.deepEqual(Object.keys(JSON.parse(missingField(op.name, {}).example)), op.required);
  });

  test('an unknown item: 404 saying how to find a real one', () => {
    const hub = single();
    hub.agentOp('demo', 'checkin', 'w1', {});
    for (const [name, args] of [['claim', { item: '#99' }], ['progress', { item: '#99' }], ['comment', { item: '#99', headline: 'h' }]]) {
      const e = refused(() => hub.agentOp('demo', name, 'w1', args));
      assert.equal(e.status, 404);
      assert.equal(e.message, 'No item #99 in demo');
      assert.match(e.hint, /look lists the items/);
    }
  });

  test('an item ref left blank where no tool checks it first: "item is required", not "undefined"', () => {
    const hub = single();
    const e = refused(() => hub.item(hub.project('demo'), undefined));
    assert.equal(e.message, 'item is required');
    assert.match(e.hint, /"#12"/);
  });

  test('an unknown steer: 404 pointing at checkin', () => {
    const hub = single();
    hub.agentOp('demo', 'checkin', 'w1', {});
    const e = refused(() => hub.agentOp('demo', 'ack', 'w1', { steer: 4242 }));
    assert.equal(e.status, 404);
    assert.equal(e.message, 'No steer 4242 in demo');
    assert.match(e.hint, /checkin/);
  });

  test('ack without steer says so, never "No steer undefined"', () => {
    const hub = single();
    hub.agentOp('demo', 'checkin', 'w1', {});
    const e = refused(() => hub.agentOp('demo', 'ack', 'w1', {}));
    assert.equal(e.message, 'steer is required');
    assert.match(e.hint, /checkin's steering/);
    assert.match(e.hint, /e\.g\. ack \{"steer":7\}/);
  });

  test('over HTTP: a missing field and a body that is not JSON both answer with a hint', async () => {
    const hub = single();
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    // An agent operation needs an agent to speak: the runner token a local hub mints (#892).
    const runner = server.auth.localRunnerToken('box');
    const post = (op, body) => fetch(`http://127.0.0.1:${server.address().port}/api/p/demo/agent/${op}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-nuworq-agent': 'w1', authorization: `Bearer ${runner.token}` }, body,
    }).then(async (r) => ({ status: r.status, json: await r.json() }));
    try {
      await post('checkin', '{}');
      const gap = await post('claim', '{}');
      assert.equal(gap.status, 400);
      assert.equal(gap.json.error, 'item is required');
      assert.match(gap.json.hint, /e\.g\. claim \{"item":"#12"\}/);
      // feedback is the server's own route, not the hub's: the same check runs there.
      const fb = await post('feedback', '{}');
      assert.equal(fb.status, 400);
      assert.equal(fb.json.error, 'text is required');
      assert.match(fb.json.hint, /e\.g\. feedback \{"text":/);
      const bad = await post('claim', '{item: 12');
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error, 'Request body must be JSON');
      assert.match(bad.json.hint, /\{"item": "#12", "headline": "Retries added"\}/);
    } finally { server.close(); }
  });
});
