import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub, DAY } from '../src/core.js';
import { view } from '../src/insight.js';
import { createServer } from '../src/server.js';
import { waitFor, operatorEvents, describeEvent } from '../src/wait.js';

// #283: an idle operator session waits on the hub, and hears the moment something is there for it.
function setup() {
  let now = Date.UTC(2026, 9, 31, 9);
  const hub = new Hub({ clock: () => now });
  hub.tx(() => hub.project('o', { create: true }));
  hub.tx(() => hub.project('other', { create: true }));
  hub.agentOp('o', 'checkin', 'op', { has: ['operator', 'infra'] });
  hub.agentOp('o', 'checkin', 'w1', { has: ['macos'] });
  return { hub, tick: (ms) => { now += ms; }, now: () => now };
}
const strip = (events) => events.map(({ at: _, ...e }) => e);

describe('an operator waits on the hub', () => {
  test('operator-only work it can take wakes it; work it lacks the tags for, or anyone can do, does not', async () => {
    const { hub, tick } = setup();
    const waiting = waitFor(hub, 'op', { ms: 5000 });
    tick(1);
    hub.humanOp('o', 'create', { title: 'Anyone', acceptance: 'x' });
    hub.humanOp('o', 'create', { title: 'GitHub settings', acceptance: 'x', needs: ['github-admin'] });
    hub.humanOp('o', 'create', { title: 'On the VM', acceptance: 'x', needs: ['infra'] });
    const r = await waiting;
    assert.deepEqual(r.events, [{ kind: 'item', project: 'o', item: '#3' }]);
    assert.equal(describeEvent(r.events[0]), 'nuworq: operator work waiting (#3 in o). Run next.');
    assert.deepEqual(strip(operatorEvents(hub, 'op', { since: r.at })), [], 'since the last answer: each event comes once');
  });

  test('a question to the operator, an answer to its own question, and steering each wake it', async () => {
    const { hub, tick } = setup();
    let since = hub.now();
    tick(1);
    const asked = hub.agentOp('o', 'ask', 'w1', { question: 'Does it run on the VM?', to: 'operator' });
    let r = await waitFor(hub, 'op', { since, ms: 5000 });
    assert.deepEqual(r.events, [{ kind: 'question', project: 'o', question: asked.question }]);
    assert.ok(!JSON.stringify(r.events).includes('VM'), 'ids and kinds, never the text');

    since = r.at;
    const mine = hub.agentOp('o', 'ask', 'op', { question: 'May I restart the hub?' });
    const answering = waitFor(hub, 'op', { since, ms: 5000 });
    tick(1);
    hub.humanOp('o', 'answer', { question: mine.question, answer: 'Yes' });
    r = await answering;
    assert.deepEqual(r.events, [{ kind: 'answer', project: 'o', question: mine.question }]);

    since = r.at;
    const steering = waitFor(hub, 'op', { since, ms: 5000 });
    tick(1);
    hub.humanOp('o', 'steer', { body: 'Restart only after 18:00' });
    r = await steering;
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].kind, 'steer');
    assert.match(describeEvent(r.events[0]), /^nuworq: steering for you \(steer \d+ in o\)\. Run checkin and ack it\.$/);
  });

  test('with nothing for it, the wait ends quietly and empty', async () => {
    const { hub } = setup();
    hub.humanOp('o', 'create', { title: 'Anyone', acceptance: 'x' });
    const r = await waitFor(hub, 'op', { since: hub.now(), ms: 30 });
    assert.deepEqual(r.events, []);
    assert.equal(hub.listenerCount('change'), 0, 'stops listening');
  });

  test('a worker, or a name never seen, is refused with a hint', () => {
    const { hub } = setup();
    assert.throws(() => waitFor(hub, 'w1'), (e) => e.status === 403 && /w1 isn't an operator here/.test(e.message) && /has: \["operator"/.test(e.hint));
    assert.throws(() => waitFor(hub, 'nobody'), (e) => e.status === 403);
  });

  test("unnamed, it waits for the token's operators seen in the last day; with none, it is refused", async () => {
    const { hub, tick } = setup();
    hub.q(`UPDATE agents SET token_id = 7 WHERE name = 'op'`).run();
    const since = hub.now();
    tick(1);
    hub.humanOp('o', 'create', { title: 'On the VM', acceptance: 'x', needs: ['infra'] });
    assert.deepEqual((await waitFor(hub, '', { since, tokenId: 7, ms: 50 })).events, [{ kind: 'item', project: 'o', item: '#1' }]);
    assert.deepEqual((await waitFor(hub, '', { since, ms: 50 })).events.length, 1, 'no token (no logins): every operator');
    assert.throws(() => waitFor(hub, '', { tokenId: 8 }), (e) => e.status === 403 && /no operator has checked in here with this token/.test(e.message) && /--as <name>/.test(e.hint));
    tick(2 * DAY);
    assert.throws(() => waitFor(hub, '', { tokenId: 7 }), (e) => e.status === 403, 'not seen for a day: not listening for it');
  });

  test('a listening operator counts as connected: Needs you says none is only when none has been here', async () => {
    const { hub, tick } = setup();
    hub.agentOp('o', 'ask', 'w1', { question: 'Prod check?', to: 'operator' });
    tick(2 * DAY);
    const missing = () => view(hub, 'o').attention.some((a) => a.kind === 'operator-missing');
    assert.ok(missing(), 'nobody seen for two days');
    await waitFor(hub, 'op', { since: hub.now(), ms: 10 });
    assert.ok(!missing(), 'the open wait is an operator present');
  });
});

describe('GET /api/wait and nuworq wait', () => {
  const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

  test("answers over HTTP, keeps to the token's projects, and refuses a worker", async () => {
    const { hub, tick } = setup();
    hub.agentOp('other', 'checkin', 'op', { has: ['operator', 'infra'] });
    hub.humanOp('other', 'create', { title: 'Elsewhere', acceptance: 'x', needs: ['infra'] });
    const server = createServer(hub, { auth: 'required' });
    const url = `http://127.0.0.1:${await listen(server)}`;
    try {
      const token = server.auth.createToken('ops', 'agent', { projects: ['o'] });
      const get = async (q, agent) => {
        const r = await fetch(`${url}/api/wait?${q}`, { headers: { authorization: `Bearer ${token}`, 'x-nuworq-agent': agent } });
        return { status: r.status, body: await r.json() };
      };
      let r = await get('for=operator&timeout=0.05', 'op');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.events, [], "other's work is outside the token");
      const pending = get(`for=operator&since=${r.body.at}&timeout=5`, 'op');
      await new Promise((res) => setTimeout(res, 50));
      tick(1);
      hub.humanOp('o', 'create', { title: 'Here', acceptance: 'x', needs: ['infra'] });
      r = await pending;
      assert.deepEqual(r.body.events, [{ kind: 'item', project: 'o', item: '#1' }]);

      r = await get('for=operator', 'w1');
      assert.equal(r.status, 403);
      assert.match(r.body.hint, /Workers find work with next/);
      r = await get('for=worker', 'op');
      assert.equal(r.status, 400);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  test('nuworq wait --operator prints one line and exits; a worker gets the hint and exit 1', async () => {
    const { hub } = setup();
    hub.humanOp('o', 'create', { title: 'On the VM', acceptance: 'x', needs: ['infra'] });
    const server = createServer(hub);
    const url = `http://127.0.0.1:${await listen(server)}`;
    const env = { ...process.env, NUWORQ_URL: url, NUWORQ_TOKEN: '', HOME: mkdtempSync(join(tmpdir(), 'nuworq-wait-')) };
    const run = (...args) => new Promise((resolve) => {
      execFile(process.execPath, [join(import.meta.dirname, '..', 'bin', 'nuworq.js'), 'wait', ...args], { env }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
    });
    try {
      const ok = await run('--operator', '--as', 'op');
      assert.equal(ok.code, 0, ok.stderr);
      assert.equal(ok.stdout, 'nuworq: operator work waiting (#1 in o). Run next.\n');
      const no = await run('--operator', '--as', 'w1');
      assert.equal(no.code, 1);
      assert.match(no.stderr, /w1 isn't an operator here/);
      assert.match(no.stderr, /hint: Waiting is for operator sessions/);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  test('--follow started before the operator checks in waits for it, then prints; without one it gives up with the hint', async () => {
    let now = Date.UTC(2026, 9, 31, 9);
    const hub = new Hub({ clock: () => now });
    hub.tx(() => hub.project('o', { create: true }));
    const server = createServer(hub);
    const url = `http://127.0.0.1:${await listen(server)}`;
    const env = { ...process.env, NUWORQ_URL: url, NUWORQ_TOKEN: '', NUWORQ_AGENT: '', HOME: mkdtempSync(join(tmpdir(), 'nuworq-wait-')) };
    const bin = join(import.meta.dirname, '..', 'bin', 'nuworq.js');
    try {
      const gaveUp = await new Promise((resolve) => execFile(process.execPath, [bin, 'wait', '--operator', '--follow', '--settle-ms', '300'], { env }, (err, _o, stderr) => resolve({ code: err?.code ?? 0, stderr })));
      assert.equal(gaveUp.code, 1);
      assert.match(gaveUp.stderr, /no operator has checked in here/);

      const child = execFile(process.execPath, [bin, 'wait', '--operator', '--follow', '--settle-ms', '6000'], { env });
      const line = new Promise((resolve) => child.stdout.on('data', (d) => resolve(String(d))));
      await new Promise((res) => setTimeout(res, 700));
      hub.agentOp('o', 'checkin', 'op', { has: ['operator', 'infra'] });
      now += 1;
      hub.humanOp('o', 'create', { title: 'On the VM', acceptance: 'x', needs: ['infra'] });
      assert.equal(await line, 'nuworq: operator work waiting (#1 in o). Run next.\n');
      child.kill();
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });
});
