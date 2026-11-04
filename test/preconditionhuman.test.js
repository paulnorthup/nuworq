import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Hub, PERSON_CAN } from '../src/core.js';
import { createServer } from '../src/server.js';
import { itemView, view } from '../src/insight.js';
import { runChecks, WAIT_DAYS } from '../src/precondition.js';
import { preconditionSection, preconditionText, toPrecondition } from '../web/precondition.js';

const MIN = 60_000, DAY = 86_400_000;

function setup() {
  let t = Date.UTC(2026, 9, 29, 9);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('w', { create: true }));
  hub.humanOp('w', 'settings', { autonomy: 'full' });
  return { hub, advance: (ms) => (t += ms), item: (n) => hub.item(hub.project('w'), `#${n}`) };
}
const overdue = (hub) => view(hub, 'w').attention.filter((a) => a.kind === 'outside-overdue');

describe('preconditions: the human sees and sets them', () => {
  test('past the wait limit, one worth-knowing card per item with the last result; "check now" checks on the next sweep', async () => {
    let hits = 0;
    const server = http.createServer((req, res) => { hits++; res.writeHead(503); res.end('not yet'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const { hub, advance, item } = setup();
      hub.agentOp('w', 'propose', 'a', { title: 'A', acceptance: 'x', precondition: `${url}/a` });
      hub.agentOp('w', 'propose', 'a', { title: 'B', acceptance: 'x', precondition: 'https://vendor.test/b' });
      await runChecks(hub);
      advance(WAIT_DAYS * DAY - MIN);
      assert.deepEqual(overdue(hub), [], 'not yet past the limit');
      advance(2 * MIN);
      // A sweep in between doesn't add a second card for the same item.
      await runChecks(hub);
      const cards = overdue(hub);
      assert.deepEqual(cards.map((c) => c.item).sort(), ['#1', '#2']);
      const a = cards.find((c) => c.item === '#1');
      assert.equal(a.level, 'know');
      assert.match(a.headline, /#1 has waited 7d on something outside the hub/);
      assert.match(a.sub, /last check .* ago: answered 503, not 200/);

      // Check now: the backoff is forgotten; the next sweep asks.
      assert.equal(item(1).check_fails, 2);
      assert.equal(item(1).next_check, hub.now() + 2 * MIN);
      hub.humanOp('w', 'check', { item: '#1' });
      assert.equal(item(1).next_check, hub.now());
      assert.equal(item(1).check_fails, 0);
      advance(20_000); // past the per-host spacing
      const n = hits;
      await runChecks(hub);
      assert.equal(hits, n + 1);
      assert.throws(() => hub.humanOp('w', 'check', { item: '#3' }), /No item|#3/);
      hub.humanOp('w', 'create', { title: 'C' });
      assert.throws(() => hub.humanOp('w', 'check', { item: '#3' }), /isn't waiting on anything outside/);

      // Got it hides it; the project can wait longer.
      hub.humanOp('w', 'dismiss', { key: a.key });
      assert.deepEqual(overdue(hub).map((c) => c.item), ['#2']);
      hub.humanOp('w', 'settings', { wait_days: 30 });
      assert.deepEqual(overdue(hub), []);
      assert.throws(() => hub.humanOp('w', 'settings', { wait_days: 0 }), /1 to 365/);
    } finally { server.closeAllConnections(); server.close(); }
  });

  test('the human update op sets, edits and clears a precondition', () => {
    const { hub, item } = setup();
    hub.humanOp('w', 'create', { title: 'Later', acceptance: 'x' });
    assert.equal(item(1).stage, 'ready');
    hub.humanOp('w', 'update', { item: '#1', precondition: 'https://vendor.test/v1' });
    assert.equal(item(1).stage, 'outside');
    assert.equal(itemView(hub, 'w', '#1').precondition.waits_for, 'https://vendor.test/v1 answers 200');
    hub.humanOp('w', 'update', { item: '#1', precondition: { url: 'https://vendor.test/v2', contains: 'on' } });
    assert.equal(item(1).stage, 'outside');
    assert.equal(itemView(hub, 'w', '#1').precondition.waits_for, 'https://vendor.test/v2 answers 200, contains "on"');
    hub.humanOp('w', 'update', { item: '#1', precondition: {} });
    assert.equal(item(1).stage, 'ready');
    assert.equal(itemView(hub, 'w', '#1').precondition, null);
    // The New-item form can set one.
    hub.humanOp('w', 'create', { title: 'Gated', precondition: 'https://vendor.test/x' });
    assert.equal(item(2).stage, 'outside');
  });

  test('an "ask" precondition is a question to the human: the item waits on you, and answering makes it ready', () => {
    const { hub, item } = setup();
    hub.agentOp('w', 'propose', 'a', { title: 'Use the export', acceptance: 'x', precondition: { kind: 'ask', question: 'Has the vendor enabled v2 for us?' } });
    assert.equal(item(1).stage, 'waiting');
    const card = view(hub, 'w').attention.find((a) => a.kind === 'question');
    assert.equal(card.headline, 'Has the vendor enabled v2 for us?');
    assert.equal(card.item, '#1');
    assert.notEqual(hub.agentOp('w', 'next', 'b').item, '#1');
    assert.equal(hub.agentOp('w', 'look', 'b', { item: '#1' }).precondition.waits_for, 'a person answers "Has the vendor enabled v2 for us?"');
    // Never checked over the network.
    assert.equal(hub.q(`SELECT COUNT(*) AS n FROM items WHERE stage = 'outside'`).get().n, 0);

    hub.humanOp('w', 'answer', { question: card.question.id, answer: 'Yes, since Monday' });
    assert.equal(item(1).stage, 'ready');
    const pre = itemView(hub, 'w', '#1').precondition;
    assert.equal(pre.met, true);
    assert.match(pre.last_check.detail, /you answered: Yes, since Monday/);
    assert.equal(hub.agentOp('w', 'next', 'b').item, '#1');
  });

  test('an "ask" from refine or shaping asks once; changing or removing it withdraws the question', () => {
    const { hub, item } = setup();
    const open = () => hub.q(`SELECT * FROM questions WHERE status = 'open'`).all();
    hub.agentOp('w', 'propose', 'a', { title: 'T', acceptance: 'x' });
    hub.agentOp('w', 'refine', 'a', { item: '#1', precondition: { kind: 'ask', question: 'Go?' } });
    assert.equal(item(1).stage, 'waiting');
    assert.equal(open().length, 1);
    hub.agentOp('w', 'refine', 'a', { item: '#1', precondition: { kind: 'ask', question: 'Go now?' } });
    assert.equal(item(1).stage, 'waiting');
    assert.deepEqual(open().map((q) => q.question), ['Go now?']);
    hub.agentOp('w', 'refine', 'a', { item: '#1', precondition: 'https://vendor.test/x' });
    assert.equal(item(1).stage, 'outside');
    assert.equal(open().length, 0);
    hub.agentOp('w', 'refine', 'a', { item: '#1', precondition: { kind: 'ask', question: 'Go?' } });
    hub.agentOp('w', 'refine', 'a', { item: '#1', precondition: {} });
    assert.equal(item(1).stage, 'ready');
    assert.equal(open().length, 0);
    assert.throws(() => hub.agentOp('w', 'refine', 'a', { item: '#1', precondition: { kind: 'ask' } }), /question is required/);

    // A proposal shaped into ready work asks when it becomes ready, not before.
    hub.humanOp('w', 'settings', { autonomy: 'ask' });
    hub.agentOp('w', 'propose', 'a', { title: 'P', precondition: { kind: 'ask', question: 'Approved budget?' } });
    assert.equal(item(2).stage, 'proposed');
    assert.equal(open().length, 0);
    hub.humanOp('w', 'update', { item: '#2', acceptance: 'y' });
    assert.equal(item(2).stage, 'waiting');
    assert.deepEqual(open().map((q) => q.question), ['Approved budget?']);
  });

  test('the item detail renders the precondition, its last check and the human actions', () => {
    const now = Date.UTC(2026, 9, 29, 9);
    const it = { item: '#4', stage: 'outside', precondition: { kind: 'http', url: 'https://v.test/x', status: 200, waits_for: 'https://v.test/x answers 200', met: false, last_check: { ok: false, detail: 'answered 503, not 200', at: now - 5 * MIN } } };
    const html = preconditionSection(it, { now });
    assert.match(html, /Waits on/);
    assert.match(html, /https:\/\/v\.test\/x answers 200/);
    assert.match(html, /last check 5m ago: answered 503, not 200/);
    assert.match(html, /data-action="check-now" data-item="#4"/);
    assert.match(html, /data-action="edit-pre"/);
    assert.match(html, /data-action="remove-pre"/);
    const editing = preconditionSection(it, { now, editing: true });
    assert.match(editing, /value="https:\/\/v\.test\/x"/);
    assert.match(editing, /data-action="save-pre"/);
    assert.equal(preconditionSection({ item: '#5', stage: 'ready' }), '', 'nothing to show');
    assert.doesNotMatch(preconditionSection({ ...it, stage: 'done' }), /data-action/, 'no actions on finished work');
    const ask = preconditionSection({ item: '#6', stage: 'waiting', precondition: { kind: 'ask', question: 'Go?', waits_for: 'a person answers "Go?"', met: false, last_check: null } });
    assert.match(ask, /waiting for your answer/);
    assert.doesNotMatch(ask, /check-now/);
    assert.match(preconditionSection({ ...it, precondition: { ...it.precondition, waits_for: '<b>x</b>' } }), /&lt;b&gt;x/);

    assert.deepEqual(toPrecondition(''), {});
    assert.equal(toPrecondition(' https://v.test/x '), 'https://v.test/x');
    assert.equal(toPrecondition('{"url":"https://v.test"}'), '{"url":"https://v.test"}');
    assert.deepEqual(toPrecondition('Has legal signed off?'), { kind: 'ask', question: 'Has legal signed off?' });
    assert.equal(preconditionText({ kind: 'http', url: 'https://v.test/y', status: 200, contains: 'on', waits_for: '', met: false, last_check: null }), '{"url":"https://v.test/y","status":200,"contains":"on"}');
    assert.equal(preconditionText({ kind: 'ask', question: 'Go?' }), 'Go?');
  });

  test('"Check now" works over HTTP, the way the UI asks: stewards and owners may, members may not', async () => {
    const { hub, item } = setup();
    hub.agentOp('w', 'propose', 'a', { title: 'A', acceptance: 'x', precondition: 'https://vendor.test/a' });
    hub.patch(item(1), { check_fails: 3, next_check: hub.now() + DAY });
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/p/w/human/check`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${server.personKey}` }, body: JSON.stringify({ item: '#1' }) });
      assert.equal(r.status, 200, await r.clone().text());
      assert.equal(item(1).next_check, hub.now());
      assert.equal(item(1).check_fails, 0);
    } finally { server.close(); }
    assert.ok(PERSON_CAN.steward.includes('check') && PERSON_CAN.owner.includes('check'));
    assert.ok(!PERSON_CAN.member.includes('check'));
  });
});
