import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Hub } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { view, projectList } from '../src/insight.js';
import { createServer } from '../src/server.js';

// Project P, with people @ann (steward of P), @ben (steward, not of P) and @cy (owner).
function setup() {
  const hub = new Hub({ clock: () => Date.UTC(2026, 9, 1, 9) });
  const auth = new Auth(hub.db);
  auth.addPerson('ann', 'steward');
  auth.addPerson('ben', 'steward');
  auth.addPerson('cy', 'owner');
  hub.tx(() => hub.project('p', { create: true }));
  hub.humanOp('p', 'stewards', { set: ['@ann'] }, '@cy');
  hub.humanOp('p', 'create', { title: 'Build it', acceptance: 'x' });
  hub.humanOp('p', 'create', { title: 'Other', acceptance: 'x' });
  const agent = (op, args) => hub.agentOp('p', op, 'bot', args);
  const entry = (viewer, kind = 'question') => view(hub, 'p', { viewer }).attention.find((a) => a.kind === kind);
  return { hub, auth, agent, entry };
}

describe('"needs you" is per person', () => {
  test("a stewarded project's question is act for its steward and worth knowing for others", () => {
    const { hub, agent, entry } = setup();
    agent('claim', { item: '#2' });
    agent('ask', { item: '#2', question: 'Which database?', blocking: true });
    assert.equal(entry('@ann').level, 'act');
    assert.deepEqual(entry('@ann').owners, ['@ann']);
    const bens = entry('@ben');
    assert.equal(bens.level, 'know');
    assert.match(bens.sub, /^needs @ann/);
    const pulse = view(hub, 'p', { viewer: '@ben' }).pulse;
    assert.equal(pulse.act, 0);
    assert.match(pulse.sentence, /^Nothing needs you\./);
    assert.match(view(hub, 'p', { viewer: '@ann' }).pulse.sentence, /^1 thing needs you\./);
  });

  test('whoever steered an item owns what comes up on it', () => {
    const { hub, agent, entry } = setup();
    hub.humanOp('p', 'steer', { item: '#1', body: 'Use SQLite' }, '@ben');
    agent('claim', { item: '#1' });
    agent('ask', { item: '#1', question: 'WAL mode?', blocking: true });
    assert.deepEqual(entry('@ben').owners, ['@ben']);
    assert.equal(entry('@ben').level, 'act');
    assert.equal(entry('@ann').level, 'know', 'the steward is not the owner once someone steered it');
  });

  test('steers from two people: the agent is told, and a question goes to both', () => {
    const { hub, agent, entry } = setup();
    hub.humanOp('p', 'steer', { item: '#1', body: 'Keep it small' }, '@ben');
    hub.humanOp('p', 'steer', { item: '#1', body: 'Cover every case' }, '@ann');
    const ctx = agent('claim', { item: '#1' });
    assert.match(ctx.steered_by, /Steers from @ben and @ann\. If they disagree, ask/);
    agent('ask', { item: '#1', question: 'Small or complete?', blocking: true });
    assert.equal(entry('@ann').level, 'act');
    assert.equal(entry('@ben').level, 'act');
    assert.deepEqual(entry('@ann').owners, ['@ben', '@ann']);
  });

  test('without named stewards, owners and stewards share it; the project list counts only your own', () => {
    const { hub, agent } = setup();
    hub.humanOp('p', 'stewards', { set: [] }, '@cy');
    agent('claim', { item: '#2' });
    agent('ask', { item: '#2', question: 'Q?', blocking: true });
    const needs = (viewer) => projectList(hub, { viewer }).find((x) => x.slug === 'p').needs;
    assert.equal(needs('@cy'), 1);
    assert.equal(needs('@ann'), 1);
    hub.humanOp('p', 'stewards', { set: ['@ann'] }, '@cy');
    assert.equal(needs('@cy'), 0);
    assert.equal(needs('@ann'), 1);
    assert.ok(view(hub, 'p', { viewer: '@cy' }).attention.some((a) => a.kind === 'question' && a.level === 'know'), 'still visible as worth knowing');
  });

  test('only owners name stewards, and only real people', async () => {
    const { hub, auth } = setup();
    assert.throws(() => hub.humanOp('p', 'stewards', { set: ['@nobody'] }, '@cy'), /No person @nobody/);
    const tok = { ann: auth.createToken('ann-l', 'human', { person: 'ann' }), cy: auth.createToken('cy-l', 'human', { person: 'cy' }) };
    const server = createServer(hub, { auth: 'required' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const post = (t, body) => new Promise((resolve) => {
      const data = JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/api/p/p/human/stewards', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.end(data);
    });
    try {
      assert.equal(await post(tok.ann, { set: ['@ann'] }), 403);
      assert.equal(await post(tok.cy, { set: ['@ben'] }), 200);
      assert.deepEqual(hub.stewardsOf(hub.project('p')), ['@ben']);
    } finally {
      server.close();
    }
  });

  test('with no people (local mode) nothing changes: every act entry is yours', () => {
    const hub = new Hub();
    hub.tx(() => hub.project('p', { create: true }));
    hub.humanOp('p', 'create', { title: 'X', acceptance: 'x' });
    hub.agentOp('p', 'claim', 'bot', { item: '#1' });
    hub.agentOp('p', 'ask', 'bot', { item: '#1', question: 'Q?', blocking: true });
    const q = view(hub, 'p').attention.find((a) => a.kind === 'question');
    assert.equal(q.level, 'act');
    assert.equal(q.owners, undefined);
  });
});
