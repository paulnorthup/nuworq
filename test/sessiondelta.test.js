import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { createClient } from '../src/client.js';

const MIN = 60_000;
// A project with a mission, 6 decisions, 12 field notes and an item, on a clock the test moves.
function setup() {
  let t = Date.UTC(2026, 10, 1, 12);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('p', { create: true }));
  hub.humanOp('p', 'settings', { mission: 'Agents first; the human facilitates.' });
  for (let i = 0; i < 6; i++) hub.humanOp('p', 'decide', { body: `Decision ${i}: a standing rule about how agents work here.` });
  for (let i = 0; i < 12; i++) hub.agentOp('p', 'learn', `n${i}`, { note: `Field note ${i}: run the build before the tests; they import from dist.` });
  hub.humanOp('p', 'create', { title: 'Fix the thing', acceptance: 'x' });
  // As the client does: each call echoes the cursor of the last reply its session got, and the agent never sees it.
  const got = {};
  const op = (o, args = {}, session = ['0123456789abcdef']) => {
    const r = hub.agentOp('p', o, 'w1', args, { session, cursor: got[session[0]] ?? '' });
    if (typeof r.cursor === 'string') { got[session[0]] = r.cursor; delete r.cursor; }
    return r;
  };
  // A reply the agent never got: the hub built it, but no cursor is echoed for it.
  const lost = (o, args = {}, session = ['0123456789abcdef']) => hub.agentOp('p', o, 'w1', args, { session, cursor: got[session[0]] ?? '' });
  return { hub, op, lost, tick: (ms) => { t += ms; } };
}
const size = (r) => JSON.stringify(r).length;

// After the first checkin, an agent session gets only what changed (#539).
describe('an agent session is sent the mission, decisions, field notes and who is here once', () => {
  test('the first checkin sends everything; a repeat sends what changed, under 1,000 characters, and says what it left out', () => {
    const { op } = setup();
    const first = op('checkin');
    assert.ok(first.mission && first.autonomy && first.decisions.length === 6 && first.field_notes.length === 10);
    assert.equal(first.unchanged, undefined);
    const again = op('checkin');
    assert.ok(size(again) < 1000, `${size(again)} characters`);
    for (const k of ['mission', 'autonomy', 'decisions', 'field_notes', 'field_notes_hidden']) assert.ok(!(k in again), k);
    assert.match(again.unchanged, /^mission, autonomy, 6 decisions, 10 notes.*look with notes: "all"/);
  });

  test('next leaves out the notes this session already has: smaller by all of them', () => {
    const { op } = setup();
    op('checkin');
    const without = setup().op('next', { claim: false }, []);
    const next = op('next', { claim: false });
    assert.equal(next.field_notes, undefined);
    assert.ok(size(without) - size(next) >= JSON.stringify(without.field_notes).length, `${size(without)} → ${size(next)}`);
  });

  test('a new or changed decision and a new field note arrive at the next call, alone', () => {
    const { hub, op } = setup();
    op('checkin');
    hub.humanOp('p', 'decide', { body: 'Decision 6: a new one.' });
    hub.agentOp('p', 'learn', 'n99', { note: 'Field note 99: something learned just now, about the build folder and the tests.' });
    const r = op('checkin');
    assert.deepEqual(r.decisions, ['Decision 6: a new one.']);
    assert.match(r.unchanged, /6 other decisions/);
    assert.ok(r.field_notes.some((n) => /Field note 99/.test(n.note)) && r.field_notes.length < 10);
  });

  test('who else is working is sent once, and whole again when any of it changes (#514)', () => {
    const { hub, op } = setup();
    hub.humanOp('p', 'create', { title: 'Another thing', acceptance: 'x' });
    hub.agentOp('p', 'claim', 'w2', { item: '#1', touching: ['src/a.js'] });
    const first = op('checkin');
    assert.equal(first.others_working.length, 1);
    const again = op('checkin');
    assert.ok(!('others_working' in again));
    assert.match(again.unchanged, /who else is working/);
    hub.agentOp('p', 'claim', 'w3', { item: '#2' });
    assert.equal(op('checkin').others_working.length, 2, 'one more at work: the whole list');
    hub.agentOp('p', 'handoff', 'w2', { item: '#1', headline: 'stopping' });
    hub.agentOp('p', 'handoff', 'w3', { item: '#2', headline: 'stopping' });
    assert.deepEqual(op('checkin').others_working ?? [], [], 'nobody else at work');
    hub.agentOp('p', 'claim', 'w3', { item: '#2' });
    assert.equal(op('checkin').others_working.length, 1, 'back after an empty spell: sent again');
  });

  test('a retired decision resends the whole list, so nothing stale is kept', () => {
    const { hub, op } = setup();
    op('checkin');
    const [first] = hub.decisions(hub.project('p'));
    hub.humanOp('p', 'retire', { note: first.id });
    assert.equal(op('checkin').decisions.length, 5);
  });

  test('look with notes: "all" sends everything, and the next checkin starts over', () => {
    const { op } = setup();
    op('checkin');
    const all = op('look', { notes: 'all' });
    assert.equal(all.decisions.length, 6);
    assert.equal(all.field_notes.length, 12);
    assert.equal(all.unchanged, undefined);
    assert.ok(op('checkin').mission, 'the mission again');
  });

  test('a checkin after a break, another session, or a call without one gets everything', () => {
    const { op, tick } = setup();
    op('checkin');
    tick(31 * MIN);
    assert.ok(op('checkin').mission, 'after 30 quiet minutes');
    assert.ok(op('checkin', {}, ['fedcba9876543210']).mission, 'another session');
    assert.equal(op('checkin', {}, []).decisions.length, 6, 'the CLI, which sends no session');
  });

  test('a reply that never arrived counts for nothing: its retry carries what it carried', () => {
    const { hub, op, lost } = setup();
    op('checkin');
    hub.humanOp('p', 'decide', { body: 'Decision 6: made while the agent worked.' });
    assert.deepEqual(lost('checkin').decisions, ['Decision 6: made while the agent worked.'], 'the reply a proxy dropped');
    const retry = op('checkin');
    assert.deepEqual(retry.decisions, ['Decision 6: made while the agent worked.'], 'the retry still has it');
    assert.ok(!('mission' in retry), 'and still leaves out what the session did get');
    assert.equal(op('checkin').decisions, undefined, 'once that reply is acknowledged, it is sent');
  });

  test('a session that never echoes a cursor (an older client) is sent everything every time', () => {
    const { hub } = setup();
    const call = () => hub.agentOp('p', 'checkin', 'w1', {}, { session: ['0123456789abcdef'] });
    call();
    assert.equal(call().decisions.length, 6);
  });
});

// Through HTTP (#539): the client echoes each reply's cursor, and a reply a proxy drops after the hub answered is
// retried with the old one.
describe('the cursor over HTTP', () => {
  test('a checkin whose reply a proxy turned into a 502 gets its decisions on the retry', async () => {
    const hub = new Hub();
    hub.tx(() => hub.project('p', { create: true }));
    hub.humanOp('p', 'decide', { body: 'Decision 0: the first.' });
    const server = createServer(hub, {});
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    let drop = false, seen = [];
    // A proxy in front of the hub: when told to, it lets the hub answer, then sends the agent a 502 instead.
    const proxy = http.createServer(async (req, res) => {
      const body = await new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
      seen.push(req.headers['x-nuworq-cursor'] ?? '');
      const answer = await fetch(`http://127.0.0.1:${server.address().port}${req.url}`, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host' && k !== 'content-length')), body: body || undefined });
      const text = await answer.text();
      if (drop) { drop = false; res.writeHead(502, { 'content-type': 'text/html' }); return res.end('<html>Bad gateway</html>'); }
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(text);
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    try {
      const c = createClient({ url: `http://127.0.0.1:${proxy.address().port}`, project: 'p', token: '', cwd: tmpdir(), session: ['0123456789abcdef'] });
      const first = await c.call('checkin', {}, { agent: 'w1' });
      assert.equal(first.decisions.length, 1);
      assert.equal(first.cursor, undefined, 'the agent never sees the cursor');
      hub.humanOp('p', 'decide', { body: 'Decision 1: made while the agent worked.' });
      drop = true;
      const retried = await c.call('checkin', {}, { agent: 'w1' });
      assert.deepEqual(retried.decisions, ['Decision 1: made while the agent worked.']);
      assert.equal(seen[1], seen[2], 'the retry echoed the cursor the lost reply never replaced');
      assert.ok(seen[1], 'the second call echoed the first reply\'s cursor');
      assert.equal((await c.call('checkin', {}, { agent: 'w1' })).decisions, undefined, 'then nothing new');
    } finally {
      proxy.close();
      server.close();
    }
  });
});
