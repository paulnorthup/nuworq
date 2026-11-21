// "Needs you" means you: a person's push channels and Needs you hold only what only a person can do. Everything an
// operator can settle goes to the operator first; it answers, withdraws or hands it back, and escalates only what it
// can't (with only_person). The questions here are ones a homelab hub pushed to its person on 2026-11-20, who said
// most were things an operator could do.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Hub, HOUR, DAY } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { view } from '../src/insight.js';
import { Notifier, addChannel, forPerson } from '../src/notify.js';
import { operatorFirst, STAFF_ASK } from '../src/operatorfirst.js';

// One receiver records what every channel was sent, by path.
let sink, base;
const got = [];
before(async () => {
  sink = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    got.push({ path: req.url, headers: req.headers, body });
    res.end('ok');
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${sink.address().port}`;
});
after(() => { sink.closeAllConnections(); sink.close(); });

const EVIDENCE = [
  'Please run one git push for the #93 audit branch',
  'OK the ops-broker firewall, and run its deploy yourself over Tailscale SSH',
  'For homelab-ui v2.7.0: tag it by hand, or let a release item land it so the hub pushes the tag itself?',
  'Command A Plus gave 2 empty answers in the eval run. Does that count as meeting "no answer is cut off"?',
  'OK to commit and push the operator\'s uncommitted homelab-ops changes to main?',
  'Is homelab-ui tagged v2.6.0 on the git server?',
  'Drop #75? Your answer on #69 already said to drop it',
];

// A hub with ann as its one person, a hub-wide webhook, an ntfy topic and ann's own webhook, workers busy (so "no
// agent working" stays quiet) and an operator checked in.
function setup({ operator = true } = {}) {
  got.length = 0;
  let t = Date.UTC(2026, 10, 20, 9);
  const hub = new Hub({ clock: () => t });
  new Auth(hub.db).addPerson('ann', 'steward');
  hub.tx(() => hub.project('homelab', { create: true }));
  hub.humanOp('homelab', 'stewards', { set: ['@ann'] });
  for (let i = 0; i < 9; i++) hub.humanOp('homelab', 'create', { title: `Item ${i + 1}`, acceptance: 'works' });
  const op = (o, agent, args = {}) => hub.agentOp('homelab', o, agent, args);
  for (let i = 1; i <= 8; i++) { op('checkin', `w${i}`); op('claim', `w${i}`, { item: `#${i}` }); }
  if (operator) op('checkin', 'op', { has: ['operator', 'infra'] });
  addChannel(hub.db, 'webhook', `${base}/all`, t);
  addChannel(hub.db, 'ntfy', `${base}/topic`, t);
  addChannel(hub.db, 'webhook', `${base}/ann`, t, { person: 'ann' });
  const n = new Notifier(hub, { baseUrl: 'http://hub.test', windowMs: 10, debounce: 1, retryDelay: 0 });
  const acts = () => view(hub, 'homelab', { viewer: '@ann' }).attention.filter((a) => a.level === 'act');
  const sent = (path) => got.filter((g) => g.path === `/${path}`);
  return { hub, op, n, acts, sent, advance: (ms) => (t += ms) };
}

describe('needs you means you', () => {
  test('the evidence, asked by workers as before: every one goes to the operator, and no channel hears of any', async () => {
    const { hub, op, n, acts, sent } = setup();
    EVIDENCE.forEach((question, i) => {
      const r = op('ask', `w${i + 1}`, { item: `#${i + 1}`, question, blocking: true, to: i % 2 ? 'human' : undefined });
      assert.equal(r.to, 'operator', question);
    });
    assert.deepEqual(acts(), [], 'nothing in Needs you');
    n.scan();
    assert.equal(n.pending.size, 0, 'nothing for a person to push');
    assert.deepEqual(await n.flush(), []);
    assert.equal(got.length, 0);
    // The operator gets them one by one, and settles each its own way.
    const first = op('next', 'op');
    assert.equal(first.mode, 'answer');
    assert.equal(first.question.question, EVIDENCE[0]);
    op('answer', 'op', { question: first.question.id ?? hub.q("SELECT id FROM questions WHERE question = ?").get(EVIDENCE[0]).id, answer: 'Pushed the audit branch from the operator checkout.' });
    assert.equal(hub.item(hub.project('homelab'), '#1').stage, 'ready', 'answered: back to work');
    const moot = hub.q('SELECT id FROM questions WHERE question = ?').get(EVIDENCE[6]).id;
    op('withdraw', 'op', { question: moot, reason: 'The person already said to drop #75 (q134); dropped there.' });
    assert.equal(hub.q('SELECT status FROM questions WHERE id = ?').get(moot).status, 'withdrawn');
    assert.equal(sent('all').length + sent('topic').length + sent('ann').length, 0);
  });

  test('what only a person can do reaches every channel of theirs, with why; the rest still does not', async () => {
    const { hub, op, n, acts, sent } = setup();
    const flushed = new Promise((resolve) => { const f = n.flush.bind(n); n.flush = () => { const p = f(); resolve(p); return p; }; });
    n.start();
    op('ask', 'w1', { item: '#1', question: EVIDENCE[1], blocking: true });
    const enrol = op('ask', 'w2', {
      item: '#2', question: 'Please enrol your iPhone\'s passkey with the ops broker', blocking: true, only_person: 'sign-in',
      steps: [{ do: 'Open the enrolment link on your iPhone', where: 'https://broker.example/enrol', check: 'It says enrolled' }],
    });
    await flushed;
    n.stop();
    assert.deepEqual(acts().map((a) => a.key), [`q:${enrol.question}`]);
    for (const path of ['all', 'ann']) {
      const [one] = sent(path);
      const body = JSON.parse(one.body);
      assert.deepEqual(body.entries.map((e) => e.key), [`q:${enrol.question}`], path);
      assert.match(body.text, /#2 question: Please enrol your iPhone's passkey/);
      assert.doesNotMatch(body.text, /firewall/);
    }
    const [push] = sent('topic');
    assert.equal(push.headers.title, 'nuworq: 1 soon');
    assert.doesNotMatch(push.body, /firewall/);
    assert.equal(hub.q('SELECT audience FROM questions WHERE id = ?').get(enrol.question).audience, 'person:sign-in');
  });

  test('the operator escalates only what it can\'t settle, saying why; that one reaches the person', async () => {
    const { hub, op, n, acts, sent } = setup();
    const q = op('ask', 'w1', { item: '#1', question: 'Drop #75?', blocking: true }).question;
    assert.deepEqual(acts(), []);
    assert.throws(() => op('ask', 'op', { escalates: q, question: 'Drop #75?', evidence: ['three workers built it'] }), /says why only a person can/);
    const up = op('ask', 'op', { escalates: q, question: 'Drop #75? No decision covers it', evidence: ['three workers built it; no answer names #75'], only_person: 'call', options: ['drop', 'keep'] }).question;
    const card = acts().find((a) => a.key === `q:${up}`);
    assert.equal(card.only_person, 'call');
    assert.match(card.sub, /only a person: a product call/);
    n.scan();
    await n.flush();
    assert.deepEqual(JSON.parse(sent('ann')[0].body).entries.map((e) => e.key), [`q:${up}`]);
    hub.humanOp('homelab', 'answer', { question: up, answer: 'drop' });
    assert.equal(hub.q('SELECT status FROM questions WHERE id = ?').get(q).status, 'answered', "the person's answer answers the worker's too");
  });

  test('with no operator here, nobody else can: what would be its card is the person\'s, and is pushed', async () => {
    const { op, n, acts, sent } = setup({ operator: false });
    const r = op('ask', 'w1', { item: '#1', question: EVIDENCE[0], blocking: true });
    assert.equal(r.to, 'operator');
    const [card] = acts();
    assert.match(card.sub, /no operator connected, so you can do it/);
    n.scan();
    await n.flush();
    assert.equal(sent('ann').length, 1);
  });

  test('forPerson: act-level, and not an operator\'s', () => {
    assert.equal(forPerson({ level: 'act' }), true);
    assert.equal(forPerson({ level: 'act', to: 'person' }), true);
    assert.equal(forPerson({ level: 'act', to: 'operator' }), false);
    assert.equal(forPerson({ level: 'know' }), false);
  });
});

describe('"no agent working" goes to an operator first', () => {
  // Ready work and nobody on it: the workers signed off, the operator stayed.
  function idle({ operator = true } = {}) {
    let t = Date.UTC(2026, 10, 20, 2);
    const hub = new Hub({ clock: () => t });
    hub.tx(() => hub.project('homelab', { create: true }));
    for (let i = 0; i < 3; i++) hub.humanOp('homelab', 'create', { title: `Item ${i + 1}`, acceptance: 'works' });
    if (operator) hub.agentOp('homelab', 'checkin', 'op', { has: ['operator'] });
    t += 2 * HOUR;
    const open = () => hub.q(`SELECT * FROM questions WHERE asked_by = 'nuworq' AND audience = 'operator' AND status = 'open' AND question LIKE ?`).all(`${STAFF_ASK}%`);
    return { hub, open, advance: (ms) => (t += ms) };
  }

  test('with an operator here: not in a person\'s Needs you, and the hub asks the operator once', () => {
    const { hub, open, advance } = idle();
    const people = view(hub, 'homelab').attention;
    assert.ok(!people.some((a) => a.kind === 'no-agents'), "left out of a person's page");
    const theirs = view(hub, 'homelab', { operator: true }).attention.find((a) => a.kind === 'no-agents');
    assert.deepEqual([theirs.to, theirs.level, theirs.cause], ['operator', 'know', 'no-runner']);
    operatorFirst(hub);
    const [q] = open();
    assert.match(q.question, /^No agent is working here: 3 items ready, but no agent is working/);
    assert.match(q.context, /No runner has ever reported here/);
    assert.match(q.context, /What starts it again:\n1\. On a machine connected to this hub, start a runner that staffs this project: nuworq run --workers 1 --staff homelab/);
    assert.equal(hub.agentOp('homelab', 'next', 'op').mode, 'answer');
    operatorFirst(hub);
    assert.equal(open().length, 1, 'once while it is open');
    hub.agentOp('homelab', 'answer', 'op', { question: q.id, answer: 'The Mac Studio is off; started a runner on the MacBook.' });
    advance(HOUR);
    operatorFirst(hub);
    assert.equal(open().length, 0, 'not again within 6 hours');
    advance(6 * HOUR);
    operatorFirst(hub);
    assert.equal(open().length, 1, 'still nobody working 6 hours on: asked again');
  });

  test('once agents work again, the hub withdraws its question', () => {
    const { hub, open } = idle();
    operatorFirst(hub);
    assert.equal(open().length, 1);
    hub.agentOp('homelab', 'checkin', 'w1', {});
    hub.agentOp('homelab', 'claim', 'w1', { item: '#1' });
    operatorFirst(hub);
    assert.equal(open().length, 0);
    assert.match(hub.q(`SELECT closed_reason FROM questions WHERE asked_by = 'nuworq'`).get().closed_reason, /agents are working again/);
  });

  test('with no operator here, it is the person\'s, as before, and the hub asks nobody', () => {
    const { hub, open } = idle({ operator: false });
    const card = view(hub, 'homelab').attention.find((a) => a.kind === 'no-agents');
    assert.equal(card.level, 'act');
    assert.equal(card.to, undefined);
    operatorFirst(hub);
    assert.equal(open().length, 0);
  });

  test('an operator gone for a day hands it back to the person; the hub withdraws its question', () => {
    const { hub, open, advance } = idle();
    operatorFirst(hub);
    assert.equal(open().length, 1);
    advance(DAY + HOUR);
    assert.equal(view(hub, 'homelab').attention.find((a) => a.kind === 'no-agents').level, 'act');
    operatorFirst(hub);
    assert.equal(open().length, 0);
  });
});
