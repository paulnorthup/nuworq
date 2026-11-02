import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, MIN } from '../src/core.js';
import { view } from '../src/insight.js';
import { createServer } from '../src/server.js';

describe('agents that arrive and leave with nothing', () => {
  function setup() {
    let t = Date.UTC(2026, 9, 1, 9);
    const hub = new Hub({ clock: () => t });
    hub.tx(() => hub.project('demo', { create: true }));
    hub.humanOp('demo', 'create', { title: 'Needs a GPU', acceptance: 'x' });
    const op = (agent, name, args = {}) => hub.agentOp('demo', name, agent, args);
    const churn = () => view(hub, 'demo').attention.filter((a) => a.kind === 'churn');
    return { hub, op, churn, tick: (ms) => { t += ms; } };
  }

  test('3 agents check in within 15 minutes and claim nothing: one worth-knowing entry with the count', () => {
    const { op, churn, tick } = setup();
    op('w1', 'checkin');
    tick(2 * MIN);
    op('w2', 'checkin');
    assert.equal(churn().length, 0, 'two is not yet a pattern');
    tick(2 * MIN);
    op('w3', 'checkin');
    const [entry, ...rest] = churn();
    assert.equal(rest.length, 0);
    assert.equal(entry.level, 'know');
    assert.match(entry.headline, /^3 agents checked in to demo .* none took any work/);
    assert.equal(entry.sub, 'w1, w2, w3');
  });

  test('one claim there clears it', () => {
    const { op, churn } = setup();
    for (const a of ['w1', 'w2', 'w3']) op(a, 'checkin');
    assert.equal(churn().length, 1);
    op('w4', 'claim', { item: '#1' });
    assert.equal(churn().length, 0);
  });

  test('15 quiet minutes clear it', () => {
    const { op, churn, tick } = setup();
    for (const a of ['w1', 'w2', 'w3']) op(a, 'checkin');
    assert.equal(churn().length, 1);
    tick(15 * MIN + 1);
    assert.equal(churn().length, 0);
  });

  test('the hub counts claims per agent since a moment, for nuworq run', () => {
    const { hub, op, tick } = setup();
    const t0 = hub.now();
    op('w1', 'checkin');
    assert.equal(hub.claimsSince('w1', t0), 0);
    tick(1000);
    op('w1', 'claim', { item: '#1' });
    assert.equal(hub.claimsSince('w1', t0), 1);
    assert.equal(hub.claimsSince('w1', hub.now() + 1), 0);
    assert.equal(hub.claimsSince('w1', t0, { scope: ['other'] }), 0);
  });

  test('and what each handed in (#764): a claim alone is not a submit', () => {
    const { hub, op, tick } = setup();
    const t0 = hub.now();
    op('w1', 'claim', { item: '#1' });
    assert.equal(hub.submitsSince('w1', t0), 0);
    tick(1000);
    op('w1', 'submit', { item: '#1', headline: 'Done', evidence: [{ label: 'tests pass' }] });
    assert.equal(hub.submitsSince('w1', t0), 1);
    assert.equal(hub.submitsSince('w2', t0), 0);
    assert.equal(hub.submitsSince('w1', t0, { scope: ['other'] }), 0);
  });

  test("an agent token may ask (nuworq run uses one), and sees only its projects' claims", async () => {
    const hub = new Hub();
    hub.tx(() => { hub.project('alpha', { create: true }); hub.project('beta', { create: true }); });
    hub.humanOp('alpha', 'create', { title: 'A', acceptance: 'x' });
    hub.humanOp('beta', 'create', { title: 'B', acceptance: 'x' });
    hub.agentOp('alpha', 'claim', 'w1', { item: '#1' });
    hub.agentOp('beta', 'claim', 'w1', { item: '#1' });
    const server = createServer(hub, { auth: 'required' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const ask = async (token) => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/claims?agent=w1&since=0`, { headers: { authorization: `Bearer ${token}` } });
        const body = await res.json();
        return [res.status, body.claims, body.submitted];
      };
      assert.deepEqual(await ask(server.auth.createToken('box', 'agent')), [200, 2, 0]);
      assert.deepEqual(await ask(server.auth.createToken('alpha-box', 'agent', { projects: ['alpha'] })), [200, 1, 0]);
    } finally {
      server.close();
    }
  });
});
