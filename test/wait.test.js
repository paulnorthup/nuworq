import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub, DAY } from '../src/core.js';
import { view } from '../src/insight.js';
import { createServer } from '../src/server.js';
import { waitFor, operatorEvents, describeEvent } from '../src/wait.js';
import { serverKeys, listenerKeys, parseKeys } from '../src/session.js';

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

  // #281: Paul's answer to an operator's escalation reached its idle terminal only ~114 s later.
  test("the human's answer to an operator's escalation wakes that operator at once", async () => {
    const { hub, tick } = setup();
    const orig = hub.agentOp('o', 'ask', 'w1', { question: 'Will you sign the release?', to: 'operator' });
    const up = hub.agentOp('o', 'ask', 'op', { question: 'Will you sign it?', escalates: orig.question, evidence: [{ label: 'built' }] });
    const since = hub.now();
    const waiting = waitFor(hub, 'op', { since, ms: 5000 });
    tick(1);
    hub.humanOp('o', 'answer', { question: up.question, answer: 'Signed' });
    const t = Date.now();
    const r = await waiting;
    assert.ok(Date.now() - t < 1000, 'not at the timeout');
    assert.deepEqual(r.events, [{ kind: 'answer', project: 'o', question: up.question }]);
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

  // #329: a freshly started listener (since 0) woke a new operator for answers and steering it already had.
  test('a fresh listener replays nothing already delivered: a seen answer or an acked steer; new ones still come once', async () => {
    const { hub, tick } = setup();
    const old = hub.agentOp('o', 'ask', 'op', { question: 'May I restart the hub?' });
    hub.humanOp('o', 'answer', { question: old.question, answer: 'Yes' });
    hub.humanOp('o', 'steer', { body: 'Restart only after 18:00' });
    const steer = hub.agentOp('o', 'checkin', 'op', { has: ['operator', 'infra'] }).steers[0].steer;
    hub.agentOp('o', 'ack', 'op', { steer });
    assert.deepEqual((await waitFor(hub, 'op', { ms: 30 })).events, [], 'the checkin delivered the answer; the steer is acked');

    const mine = hub.agentOp('o', 'ask', 'op', { question: 'And the VM?' });
    tick(1);
    hub.humanOp('o', 'answer', { question: mine.question, answer: 'Also yes' });
    const r = await waitFor(hub, 'op', { ms: 30 });
    assert.deepEqual(r.events, [{ kind: 'answer', project: 'o', question: mine.question }]);
    assert.deepEqual(strip(operatorEvents(hub, 'op', { since: r.at })), [], 'once');
  });

  test("unnamed, operator-only work wakes it only when one operator has all its needs, not the operators' tags together", async () => {
    const { hub, tick } = setup();
    hub.agentOp('o', 'checkin', 'op2', { has: ['operator', 'claude-cli'] });
    hub.q(`UPDATE agents SET token_id = 7 WHERE name IN ('op', 'op2')`).run();
    const since = hub.now();
    tick(1);
    hub.humanOp('o', 'create', { title: 'Both', acceptance: 'x', needs: ['infra', 'claude-cli'] });
    assert.deepEqual((await waitFor(hub, '', { since, tokenId: 7, ms: 30 })).events, [], 'op has infra, op2 has claude-cli, neither has both');
    hub.humanOp('o', 'create', { title: 'CLI', acceptance: 'x', needs: ['claude-cli'] });
    assert.deepEqual((await waitFor(hub, '', { since, tokenId: 7, ms: 30 })).events, [{ kind: 'item', project: 'o', item: '#2' }]);
  });

  test("two operator sessions on one token: each listener wakes for its own session's answers, and keeps only it present", async () => {
    const { hub, tick } = setup();
    const KA = ['aaaaaaaaaaaaaaaa'], KB = ['bbbbbbbbbbbbbbbb'];
    hub.agentOp('o', 'checkin', 'opa', { has: ['operator'] }, { session: KA });
    hub.agentOp('o', 'checkin', 'opb', { has: ['operator'] }, { session: KB });
    hub.q(`UPDATE agents SET token_id = 7 WHERE name IN ('op', 'opa', 'opb')`).run();
    hub.q(`UPDATE agents SET signed_off = 1 WHERE name = 'op'`).run();
    const since = hub.now();
    tick(1);
    const b = hub.agentOp('o', 'ask', 'opb', { question: 'May I restart the VM?' });
    hub.humanOp('o', 'answer', { question: b.question, answer: 'Yes' });
    assert.deepEqual(strip(operatorEvents(hub, '', { since, tokenId: 7, session: KA })), [], "B's answer doesn't wake A");
    assert.deepEqual(strip(operatorEvents(hub, '', { since, tokenId: 7, session: KB })), [{ kind: 'answer', project: 'o', question: b.question }]);
    assert.equal(strip(operatorEvents(hub, '', { since, tokenId: 7 })).length, 1, 'without keys: every operator on the token, as before');

    tick(1);
    const q = hub.agentOp('o', 'ask', 'w1', { question: 'Is the VM up?', to: 'operator' });
    for (const session of [KA, KB]) {
      assert.deepEqual(strip(operatorEvents(hub, '', { since, tokenId: 7, session })).filter((e) => e.kind === 'question'), [{ kind: 'question', project: 'o', question: q.question }], 'an operator question still wakes either');
    }

    const before = hub.q(`SELECT name, last_seen FROM agents WHERE name IN ('opa', 'opb') ORDER BY name`).all();
    tick(1000);
    await waitFor(hub, '', { since: hub.now(), tokenId: 7, session: KA, ms: 10 });
    const after = hub.q(`SELECT name, last_seen FROM agents WHERE name IN ('opa', 'opb') ORDER BY name`).all();
    assert.ok(after[0].last_seen > before[0].last_seen, "A's wait keeps A present");
    assert.equal(after[1].last_seen, before[1].last_seen, 'and not B');
  });

  test('a listener whose session no operator named yet serves the operators from before session keys, never another session', () => {
    const { hub, tick } = setup();
    hub.agentOp('o', 'checkin', 'opb', { has: ['operator'] }, { session: ['bbbbbbbbbbbbbbbb'] });
    const since = hub.now();
    tick(1);
    const mine = hub.agentOp('o', 'ask', 'op', { question: 'Old client?' });
    hub.humanOp('o', 'answer', { question: mine.question, answer: 'Yes' });
    const theirs = hub.agentOp('o', 'ask', 'opb', { question: 'New client?' });
    hub.humanOp('o', 'answer', { question: theirs.question, answer: 'Yes' });
    const fresh = ['cccccccccccccccc'];
    assert.deepEqual(strip(operatorEvents(hub, '', { since, session: fresh })).map((e) => e.question), [mine.question], 'op said no keys: it keeps its listener');
    hub.agentOp('o', 'checkin', 'opc', { has: ['operator'] }, { session: fresh });
    assert.deepEqual(strip(operatorEvents(hub, '', { since, session: fresh })), [], 'once its own operator checked in, only that one');
  });

  // #406: an item already ready that newly matches the operator was never pushed: the wait keyed on stage_since.
  test('a ready item that newly matches comes once: its needs changed, its last dependency finished, or the operator gained the tag', async () => {
    const { hub, tick } = setup();
    hub.humanOp('o', 'create', { title: 'Anyone for now', acceptance: 'x' });
    hub.humanOp('o', 'create', { title: 'GitHub settings', acceptance: 'x', needs: ['github-admin'] });
    hub.humanOp('o', 'create', { title: 'First', acceptance: 'x' });
    hub.humanOp('o', 'create', { title: 'After it', acceptance: 'x', needs: ['infra'], depends_on: ['#3'] });
    let since = hub.now();
    tick(1);
    assert.deepEqual(strip(operatorEvents(hub, 'op', { since })), [], 'nothing it can take yet');

    const waiting = waitFor(hub, 'op', { since, ms: 5000 });
    hub.agentOp('o', 'refine', 'w1', { item: '#1', needs: ['infra'] });
    let r = await waiting;
    assert.deepEqual(r.events, [{ kind: 'item', project: 'o', item: '#1' }], 'needs refined onto a tag it has');
    since = r.at;
    tick(1);
    hub.move(hub.q('SELECT * FROM items WHERE seq = 3').get(), 'done', 'w1');
    r = await waitFor(hub, 'op', { since, ms: 5000 });
    assert.deepEqual(r.events, [{ kind: 'item', project: 'o', item: '#4' }], 'its dependency finished');
    since = r.at;
    tick(1);
    hub.agentOp('o', 'checkin', 'op', { has: ['operator', 'infra'] });
    assert.deepEqual(strip(operatorEvents(hub, 'op', { since })), [], 'checking in again with the same tags pushes nothing');
    hub.agentOp('o', 'checkin', 'op', { has: ['operator', 'infra', 'github-admin'] });
    r = await waitFor(hub, 'op', { since, ms: 5000 });
    assert.deepEqual(r.events.map((e) => e.item).sort(), ['#1', '#2', '#4'], 'a tag gained: what it can take now, once');
    assert.deepEqual(strip(operatorEvents(hub, 'op', { since: r.at })), [], 'once');
  });

  test("an item that became ready without a change event still reaches the next answer, not skipped by its since", async () => {
    const { hub, tick } = setup();
    const since = hub.now();
    tick(1);
    const waiting = waitFor(hub, 'op', { since, ms: 30 });
    hub.emit = () => true; // a write path that forgot to announce itself
    hub.humanOp('o', 'create', { title: 'On the VM', acceptance: 'x', needs: ['infra'] });
    delete hub.emit;
    const r = await waiting;
    assert.deepEqual(r.events, [{ kind: 'item', project: 'o', item: '#1' }], 'the last look before the empty answer finds it');
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

  test("waits on the folder's project; ?project= names one, ?all=1 takes every one", async () => {
    const { hub, tick } = setup();
    hub.agentOp('other', 'checkin', 'op', { has: ['operator', 'infra'] });
    hub.q('INSERT INTO project_remotes (project_id, remote, at) VALUES (?, ?, ?)').run(hub.project('o').id, 'github.com/acme/o', hub.now());
    const server = createServer(hub);
    const url = `http://127.0.0.1:${await listen(server)}`;
    try {
      const get = async (q, headers = {}) => (await (await fetch(`${url}/api/wait?for=operator&timeout=0.05&${q}`, { headers: { 'x-nuworq-agent': 'op', ...headers } })).json()).events;
      tick(1);
      hub.humanOp('other', 'create', { title: 'Elsewhere', acceptance: 'x', needs: ['infra'] });
      const inO = { 'x-nuworq-remote': encodeURIComponent('github.com/acme/o') };
      assert.deepEqual(await get('', inO), [], "run in o's folder: other's work doesn't wake it");
      assert.deepEqual(await get('all=1', inO), [{ kind: 'item', project: 'other', item: '#1' }]);
      assert.deepEqual(await get('project=other', inO), [{ kind: 'item', project: 'other', item: '#1' }]);
      assert.deepEqual(await get(''), [{ kind: 'item', project: 'other', item: '#1' }], 'a folder no project knows: every project');
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  test('x-nuworq-session: the checkin stores it, and a wait that sends it hears only its own operator', async () => {
    const { hub, tick } = setup();
    const server = createServer(hub);
    const url = `http://127.0.0.1:${await listen(server)}`;
    const KA = serverKeys({ env: { CLAUDE_CODE_SESSION_ID: 'session-a' }, host: 'mac', ppid: 501 });
    const KB = serverKeys({ env: {}, host: 'mac', ppid: 502 });
    try {
      const call = (path, agent, session, body) => fetch(`${url}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', 'x-nuworq-agent': agent, 'x-nuworq-session': session.join(',') },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }).then((r) => r.json());
      await call('/api/p/o/agent/checkin', 'opa', KA, { has: ['operator'] });
      await call('/api/p/o/agent/checkin', 'opb', KB, { has: ['operator'] });
      hub.q(`UPDATE agents SET signed_off = 1 WHERE name = 'op'`).run();
      assert.equal(hub.q(`SELECT session FROM agents WHERE name = 'opa'`).get().session, KA.join(','));
      const since = hub.now();
      tick(1);
      const asked = hub.agentOp('o', 'ask', 'opa', { question: 'May I restart the hub?' });
      hub.humanOp('o', 'answer', { question: asked.question, answer: 'Yes' });
      // The listener of session A, two processes below it (a shell, then nuworq): its ancestors include 501.
      const listenA = listenerKeys({ env: {}, host: 'mac', ppid: 900, table: '900 501\n501 77\n77 1\n' });
      assert.deepEqual((await call(`/api/wait?for=operator&since=${since}&timeout=0.05`, '', listenA)).events, [{ kind: 'answer', project: 'o', question: asked.question }]);
      const listenB = listenerKeys({ env: {}, host: 'mac', ppid: 901, table: '901 502\n502 77\n77 1\n' });
      assert.deepEqual((await call(`/api/wait?for=operator&since=${since}&timeout=0.05`, '', listenB)).events, [], "A's answer doesn't wake B");
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  // #281: the live check's shape. An unnamed listener of the escalating operator's session, and the
  // human's answer to the escalation through the human API, as Needs you sends it.
  test("over HTTP, the human's answer to an escalation wakes the escalating operator's listener at once", async () => {
    const { hub, tick } = setup();
    const server = createServer(hub);
    const url = `http://127.0.0.1:${await listen(server)}`;
    const KA = serverKeys({ env: { CLAUDE_CODE_SESSION_ID: 'session-a' }, host: 'mac', ppid: 501 });
    try {
      const call = (path, agent, session, body) => fetch(`${url}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', 'x-nuworq-agent': agent, 'x-nuworq-session': session.join(',') },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }).then((r) => r.json());
      await call('/api/p/o/agent/checkin', 'opa', KA, { has: ['operator'] });
      hub.q(`UPDATE agents SET signed_off = 1 WHERE name = 'op'`).run();
      const orig = hub.agentOp('o', 'ask', 'w1', { question: 'Will you sign the release?', to: 'operator' });
      const up = await call('/api/p/o/agent/ask', 'opa', KA, { question: 'Will you sign it?', escalates: orig.question, evidence: [{ label: 'built' }], blocking: true });
      const listenA = listenerKeys({ env: {}, host: 'mac', ppid: 900, table: '900 501\n501 77\n77 1\n' });
      const first = await call('/api/wait?for=operator&timeout=0.05', '', listenA);
      assert.deepEqual(first.events, [], 'the escalated question waits for the human, so it wakes nobody');
      const pending = call(`/api/wait?for=operator&since=${first.at}&timeout=5`, '', listenA);
      await new Promise((res) => setTimeout(res, 50));
      tick(1);
      const t = Date.now();
      const answered = await call('/api/p/o/human/answer', '', [], { question: up.question, answer: 'Signed' });
      assert.equal(answered.ok, true, JSON.stringify(answered));
      const r = await pending;
      assert.ok(Date.now() - t < 1000, 'not at the timeout');
      assert.deepEqual(r.events, [{ kind: 'answer', project: 'o', question: up.question }]);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  test('session keys: a listener below its session meets the MCP server beside it, and not one of a sibling session', () => {
    const table = '700 600\n600 500\n500 400\n400 1\n710 610\n610 500\n';
    const server = serverKeys({ env: {}, host: 'mac', ppid: 600 });
    const sibling = serverKeys({ env: {}, host: 'mac', ppid: 610 });
    const listener = listenerKeys({ env: {}, host: 'mac', ppid: 700, table });
    assert.ok(server.some((k) => listener.includes(k)), 'the session (600) is an ancestor of its listener');
    assert.ok(!sibling.some((k) => listener.includes(k)), 'a sibling session in the same terminal (500) is not');
    assert.ok(!listener.some((k) => /mac|600/.test(k)), 'hashed: no host or process id goes to the hub');
    assert.deepEqual(serverKeys({ env: { CLAUDE_CODE_SESSION_ID: 'x' }, host: 'mac', ppid: 1 }), listenerKeys({ env: { CLAUDE_CODE_SESSION_ID: 'x' }, host: 'mac', ppid: 1, table: '' }), 'the session id alone matches');
    assert.deepEqual(listenerKeys({ env: {}, host: 'mac', ppid: 700, table: '' }).length, 1, 'no ps: the parent only');
    assert.deepEqual(parseKeys(`${server.join(',')},nothex,${'f'.repeat(17)}`), server, 'the hub keeps only well-formed keys');
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

  // #342: the live hub restarts on every merge; a listener that exits on the proxy's 502 leaves the operator deaf.
  describe('--follow outlives a hub restart', () => {
    const bin = join(import.meta.dirname, '..', 'bin', 'nuworq.js');
    // A fake hub: answer(n, req, res) handles the n-th /api/wait; `asked` keeps each one's since.
    const fake = async (answer) => {
      const asked = [];
      const server = http.createServer((req, res) => {
        asked.push(new URL(req.url, 'http://x').searchParams.get('since'));
        answer(asked.length, req, res);
      });
      const url = `http://127.0.0.1:${await listen(server)}`;
      const env = { ...process.env, NUWORQ_URL: url, NUWORQ_TOKEN: '', NUWORQ_AGENT: '', HOME: mkdtempSync(join(tmpdir(), 'nuworq-wait-')) };
      return { server, asked, env, close: () => { server.close(); server.closeAllConnections(); } };
    };
    const gateway = (res, status = 502) => res.writeHead(status, { 'content-type': 'text/html' }).end('<html>Bad gateway</html>');
    const event = (res, at) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ at, events: [{ kind: 'item', project: 'o', item: '#1' }] }));
    // Runs the listener until done(stdout) holds (or 10 s pass), then stops it: what it printed, and whether it
    // had exited on its own. Waits for the outcome rather than a fixed time: on some Node versions each fetch
    // after a 502 waits for undici's next 500 ms timer tick, so rounds take longer than the backoff alone.
    const listenUntil = (hub, done, ...args) => new Promise((resolve) => {
      const child = execFile(process.execPath, [bin, 'wait', '--operator', '--follow', '--retry-ms', '50', ...args], { env: hub.env });
      let stdout = '', stderr = '', exited = null;
      const check = () => { if (exited === null && done(stdout)) child.kill(); };
      child.stdout.on('data', (d) => { stdout += d; check(); });
      child.stderr.on('data', (d) => { stderr += d; });
      const poll = setInterval(check, 20), timer = setTimeout(() => child.kill(), 10_000);
      child.on('exit', (code) => { clearInterval(poll); clearTimeout(timer); exited = code; });
      child.on('close', () => resolve({ stdout, stderr, exited }));
    });
    const line = 'nuworq: operator work waiting (#1 in o). Run next.\n';

    test("a 502 twice (and Cloudflare's 530), then an event: exactly that one line, the same since, and no exit", async () => {
      const hub = await fake((n, _req, res) => (n <= 2 ? gateway(res) : n === 3 ? gateway(res, 530) : n === 4 ? event(res, 5) : null));
      try {
        const r = await listenUntil(hub, (out) => out.includes(line) && hub.asked.length >= 5, '--as', 'op');
        assert.equal(r.stdout, line, r.stderr);
        assert.equal(r.exited, null, 'still listening');
        assert.deepEqual(hub.asked.slice(0, 5), ['0', '0', '0', '0', '5'], 'since kept through the 502s, then moved on');
      } finally { hub.close(); }
    });

    test('a dropped connection is waited out too', async () => {
      const hub = await fake((n, req, res) => (n === 1 ? req.socket.destroy() : n === 2 ? event(res, 5) : null));
      try {
        const r = await listenUntil(hub, (out) => out.includes(line), '--as', 'op');
        assert.equal(r.stdout, line, r.stderr);
        assert.equal(r.exited, null);
      } finally { hub.close(); }
    });

    // #406: a wait that never answers (left hanging across a restart) is given up and asked again with the same since.
    test('an answer long overdue is asked again with the same since', async () => {
      const hub = await fake((n, _req, res) => (n === 1 ? null : n === 2 ? event(res, 5) : null));
      try {
        const r = await listenUntil(hub, (out) => out.includes(line), '--as', 'op', '--timeout', '0.2', '--grace-ms', '200');
        assert.equal(r.stdout, line, r.stderr);
        assert.equal(r.exited, null);
        assert.deepEqual(hub.asked.slice(0, 2), ['0', '0']);
      } finally { hub.close(); }
    });

    // #406: the listener waits on one hub process; the hub restarts (a new process on the same database and port,
    // as serve --follow does it), then an item becomes ready there.
    test('a real hub restarted under a waiting listener: the item that becomes ready on the new one reaches it', async () => {
      const file = join(mkdtempSync(join(tmpdir(), 'nuworq-wait-')), 'hub.db');
      const first = new Hub({ file });
      first.tx(() => first.project('o', { create: true }));
      first.agentOp('o', 'checkin', 'op', { has: ['operator', 'infra'] });
      let server = createServer(first);
      const port = await listen(server);
      const env = { ...process.env, NUWORQ_URL: `http://127.0.0.1:${port}`, NUWORQ_TOKEN: '', NUWORQ_AGENT: '', HOME: mkdtempSync(join(tmpdir(), 'nuworq-wait-')) };
      const child = execFile(process.execPath, [bin, 'wait', '--operator', '--follow', '--as', 'op', '--retry-ms', '50'], { env });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      const until = async (ok, what) => {
        for (const end = Date.now() + 10_000; !ok();) {
          if (Date.now() > end) throw new Error(`timed out waiting for ${what}; printed ${JSON.stringify(stdout)}`);
          await new Promise((res) => setTimeout(res, 20));
        }
      };
      let second;
      try {
        await until(() => first.listenerCount('change') > 0, 'the listener to wait on the first hub');
        server.close();
        server.closeAllConnections(); // the old process exits
        first.db.close();
        second = new Hub({ file });
        server = createServer(second);
        await new Promise((res) => server.listen(port, '127.0.0.1', res));
        await until(() => second.listenerCount('change') > 0, 'the listener to wait on the new hub');
        const ready = Date.now();
        second.humanOp('o', 'create', { title: 'On the VM', acceptance: 'x', needs: ['infra'] });
        await until(() => stdout.includes(line), 'the line');
        assert.equal(stdout, line);
        assert.ok(Date.now() - ready < 1000, `within a second (${Date.now() - ready} ms)`);
      } finally {
        child.kill();
        server.close();
        server.closeAllConnections();
        second?.db.close();
      }
    });

    test('away for long, it says so once and keeps trying', async () => {
      const hub = await fake((_n, _req, res) => gateway(res));
      try {
        const r = await listenUntil(hub, (out) => /still trying/.test(out) && hub.asked.length >= 3, '--as', 'op', '--down-ms', '300');
        assert.match(r.stdout, /^nuworq: hub at http:\/\/127\.0\.0\.1:\d+ unreachable for 1 min; still trying\.\n$/);
        assert.equal(r.exited, null);
        assert.ok(hub.asked.length >= 3, 'kept asking');
      } finally { hub.close(); }
    });

    test('a 401 or an unknown agent ends it at once with the hint; without --follow a 502 ends it too', async () => {
      const refuse = (status, error, hint) => (res) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error, hint }));
      for (const [status, error, hint] of [[401, 'not logged in', 'Run nuworq connect.'], [403, "nobody isn't an operator here", 'Check in with has: ["operator"].']]) {
        const hub = await fake((_n, _req, res) => refuse(status, error, hint)(res));
        try {
          const r = await listenUntil(hub, () => false, '--as', 'nobody');
          assert.equal(r.exited, 1, `${status} exits`);
          assert.ok(r.stderr.includes(error) && r.stderr.includes(`hint: ${hint}`), r.stderr);
          assert.equal(hub.asked.length, 1);
        } finally { hub.close(); }
      }
      const hub = await fake((_n, _req, res) => gateway(res));
      try {
        const r = await new Promise((resolve) => execFile(process.execPath, [bin, 'wait', '--operator', '--as', 'op'], { env: hub.env }, (err, _o, stderr) => resolve({ code: err?.code ?? 0, stderr })));
        assert.equal(r.code, 1);
        assert.match(r.stderr, /restarting or unreachable \(HTTP 502/);
      } finally { hub.close(); }
    });
  });
});
