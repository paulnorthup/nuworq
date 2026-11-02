import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { MIGRATIONS } from '../src/db.js';
import { view, itemView, plainSteer } from '../src/insight.js';

// Your steering shows only what people wrote (#550): an operator's answer to a worker and the hub's own notices reach
// agents as before, but show on their item ("Agents told each other") or as facts in the history.
const MIN = 60_000;
function world(file) {
  let t = Date.UTC(2026, 10, 1, 9);
  const hub = new Hub({ ...(file ? { file } : {}), clock: () => t });
  hub.tx(() => hub.project('p', { create: true }));
  const add = (title) => hub.humanOp('p', 'create', { title, acceptance: 'x' }).item;
  return { hub, add, later: (ms) => { t += ms; } };
}
const yours = (hub) => view(hub, 'p').steers.map((s) => s.body);
// What checkin and next hand the agent: unchanged by #550.
const steersFor = (hub, agent) => hub.pendingSteers(hub.project('p'), agent).map((s) => s.body);

describe('Your steering is what people wrote (#550)', () => {
  test("a person's steer is theirs: in the section and in the item's drawer, and the agent gets it", () => {
    const { hub, add } = world();
    const k = add('Exports');
    hub.agentOp('p', 'claim', 'w1', { item: k });
    hub.humanOp('p', 'steer', { item: k, body: 'Use the narrower allow-list.' });
    assert.deepEqual(yours(hub), ['Use the narrower allow-list.']);
    const it = itemView(hub, 'p', k);
    assert.deepEqual(it.steers.map((s) => s.body), ['Use the narrower allow-list.']);
    assert.deepEqual(it.told, []);
    assert.ok(steersFor(hub, 'w1').includes('Use the narrower allow-list.'));
  });

  test("an operator's answer that changes a worker's course shows on the item, one plain line, not as your steering", () => {
    const { hub, add } = world();
    const k = add('Push rule');
    hub.agentOp('p', 'checkin', 'op', { has: ['operator'] });
    hub.agentOp('p', 'claim', 'w1', { item: k });
    const { question } = hub.agentOp('p', 'ask', 'w1', { item: k, question: 'Is the push rule pattern confirmed?', assumption: 'the wide pattern works', to: 'operator' });
    hub.agentOp('p', 'answer', 'op', { question, answer: "the push rule's pattern isn't confirmed; use a narrower allow-list. Details in the log." });
    assert.deepEqual(yours(hub), [], 'nothing in Your steering');
    const it = itemView(hub, 'p', k);
    assert.deepEqual(it.steers, []);
    assert.equal(it.told.length, 1);
    const [s] = it.told;
    assert.equal(`${s.from} to ${s.to}: ${s.line} ${s.retires}`,
      `Operator to w1: The push rule's pattern isn't confirmed; use a narrower allow-list. Retires when ${k} lands.`);
    assert.match(s.body, /^Change of course on #\d+: you assumed "the wide pattern works"\. Instead: /, 'the whole text behind it');
    assert.ok(steersFor(hub, 'w1').some((b) => b.startsWith('Change of course')), 'the worker still gets it');
  });

  test("a drop notice to the holder shows on the dropped item as the hub's, and the holder still gets it", () => {
    const { hub, add } = world();
    const k = add('Old idea');
    hub.agentOp('p', 'claim', 'w1', { item: k });
    hub.humanOp('p', 'update', { item: k, stage: 'dropped' });
    assert.deepEqual(yours(hub), []);
    const it = itemView(hub, 'p', k);
    assert.deepEqual(it.steers, []);
    assert.deepEqual(it.told.map((s) => `${s.from} to ${s.to}: ${s.line}`), [`nuworq to w1: ${k} was dropped by the human; stop working on it.`]);
    assert.ok(steersFor(hub, 'w1').some((b) => b.startsWith(`${k} was dropped`)));
    const events = hub.q(`SELECT type FROM events WHERE type = 'steer'`).all();
    assert.deepEqual(events, [], 'no "You steered" line: the record already says it was dropped');
  });

  test('parked and autonomy notices are facts in the history, once, and never your steering; agents still get them', () => {
    const { hub } = world();
    hub.agentOp('p', 'checkin', 'w1', {});
    hub.humanOp('p', 'settings', { autonomy: 'full' });
    hub.humanOp('p', 'settings', { parked: true });
    assert.deepEqual(yours(hub), []);
    const history = hub.q(`SELECT type, headline FROM events WHERE type IN ('settings', 'parked', 'steer') ORDER BY id`).all();
    assert.deepEqual(history.map((e) => e.headline), ['You set autonomy to "Run with it"', 'You parked the project']);
    const got = steersFor(hub, 'w1');
    assert.ok(got.some((b) => b.startsWith('Autonomy is now')) && got.some((b) => b.startsWith('The project is parked')), got.join(' | '));
  });

  test('a steer nobody picked up is worth knowing only when a person wrote it', () => {
    const { hub, later } = world();
    hub.humanOp('p', 'settings', { autonomy: 'full' });
    hub.humanOp('p', 'steer', { body: 'Prefer small items.' });
    later(20 * MIN);
    const unseen = view(hub, 'p').attention.filter((a) => a.kind === 'steer-unseen').map((a) => a.sub);
    assert.deepEqual(unseen, ['"Prefer small items."']);
  });

  test('one plain line: an answer is what to do instead; anything else its first sentence', () => {
    assert.equal(plainSteer('Change of course on #4: you assumed "x". Instead: retry twice. Then stop.'), 'Retry twice.');
    assert.equal(plainSteer('#9 was dropped (the human said so); stop working on it.'), '#9 was dropped (the human said so); stop working on it.');
    assert.equal(plainSteer('a'.repeat(200)).length, 160);
  });

  test('on first start, the notices from before are found by their words; a person\'s steer stays theirs', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nuworq-notice-')), 'hub.db');
    const { hub, add } = world(file);
    const k = add('Gone');
    hub.agentOp('p', 'claim', 'w1', { item: k });
    hub.humanOp('p', 'update', { item: k, stage: 'dropped' });
    hub.humanOp('p', 'settings', { autonomy: 'full', parked: true });
    hub.humanOp('p', 'steer', { body: 'Autonomy matters: keep items small.' });
    hub.q('UPDATE notes SET notice = 0').run(); // as before #550
    hub.db.exec(`PRAGMA user_version = ${MIGRATIONS.findIndex((m) => m.name.startsWith('steers the hub wrote'))}`);
    hub.db.close();
    const again = new Hub({ file });
    const rows = again.q(`SELECT body, notice FROM notes WHERE kind = 'steer' ORDER BY id`).all().map((n) => [n.body.slice(0, 22), n.notice]);
    assert.deepEqual(rows, [[`${k} was dropped by the `, 1], ['The project is parked.', 1], ['Autonomy is now "Run w', 1], ['Autonomy matters: keep', 0]]);
    again.db.close();
  });

  test('the drawer lists them under "Agents told each other", each line opening to its whole text', () => {
    const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    assert.match(app, /<div class="label" data-new="agents-told">Agents told each other<\/div>/);
    assert.match(app, /data-action="toggle" data-key="\$\{key\}" aria-expanded="\$\{open\}"/);
    assert.match(app, /\$\{open \? `<div class="told-body">\$\{md\(s\.body\)\}<\/div>` : ''\}/);
  });
});
