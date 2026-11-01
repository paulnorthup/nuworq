import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { view, homeView, withEntry } from '../src/insight.js';

const MIN = 60_000;

// Needs you ranks the way agents' work does (#505): a person's pick, priority, what a card holds up, then age.
function setup() {
  let t = Date.UTC(2026, 10, 1, 9);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('x', { create: true }));
  return { hub, advance: (ms) => (t += ms) };
}
const acts = (v) => v.attention.filter((a) => a.level === 'act');
const ask = (hub, slug, agent, item, question) => {
  hub.agentOp(slug, 'claim', agent, { item });
  hub.agentOp(slug, 'ask', agent, { item, question, blocking: true });
};

describe('each Needs you card carries the priority of the work it holds up', () => {
  test('mixed priorities rank now, soon, later, whatever their age; a milestone lends its priority to its parts', () => {
    const { hub, advance } = setup();
    hub.humanOp('x', 'create', { title: 'Milestone', acceptance: 'x', priority: 'now' }); // #1
    hub.humanOp('x', 'create', { title: 'Part', acceptance: 'x', priority: 'later', parent: '#1' }); // #2
    hub.humanOp('x', 'create', { title: 'Lone soon', acceptance: 'x', priority: 'soon' }); // #3
    hub.humanOp('x', 'create', { title: 'Lone later', acceptance: 'x', priority: 'later' }); // #4
    ask(hub, 'x', 'a4', '#4', 'Later one?');
    advance(MIN);
    ask(hub, 'x', 'a3', '#3', 'Soon one?');
    advance(MIN);
    ask(hub, 'x', 'a2', '#2', 'Part one?');
    const cards = acts(view(hub, 'x'));
    assert.deepEqual(cards.map((c) => [c.headline, c.priority, c.priority_why]), [
      ['Part one?', 'now', 'now: part of #1'],
      ['Soon one?', 'soon', "soon: #3's own priority"],
      ['Later one?', 'later', "later: #4's own priority"],
    ], 'the newest first: its milestone is now');
  });

  test("a dependent's priority counts too, and a person's pick comes before everything", () => {
    const { hub, advance } = setup();
    hub.humanOp('x', 'create', { title: 'Base', acceptance: 'x', priority: 'later' }); // #1
    hub.humanOp('x', 'create', { title: 'Needs base', acceptance: 'x', priority: 'now', depends_on: ['#1'] }); // #2
    hub.humanOp('x', 'create', { title: 'Picked', acceptance: 'x', priority: 'now' }); // #3
    hub.humanOp('x', 'pick', { item: '#3' });
    ask(hub, 'x', 'a1', '#1', 'Base?');
    advance(MIN);
    ask(hub, 'x', 'a3', '#3', 'Picked?');
    const cards = acts(view(hub, 'x'));
    assert.deepEqual(cards.map((c) => [c.headline, c.priority, c.picked ?? false]), [['Picked?', 'now', true], ['Base?', 'now', false]]);
    assert.equal(cards[1].priority_why, 'now: #2 waits on it');
  });

  test('a card that holds up all the work is now; at the same priority, a question parking work comes first', () => {
    const { hub, advance } = setup();
    hub.humanOp('x', 'create', { title: 'Urgent', acceptance: 'x', priority: 'now' }); // #1
    hub.humanOp('x', 'create', { title: 'Later', acceptance: 'x', priority: 'later' }); // #2
    hub.agentOp('x', 'ask', 'a0', { question: 'Can you open port 22?', to: 'operator' }); // no operator here: a card for the person
    advance(MIN);
    ask(hub, 'x', 'a2', '#2', 'Later?');
    ask(hub, 'x', 'a1', '#1', 'Urgent?');
    const cards = acts(view(hub, 'x'));
    const missing = cards.find((c) => c.kind === 'operator-missing');
    assert.ok(missing, cards.map((c) => c.kind).join());
    assert.deepEqual([missing.priority, missing.priority_why], ['now', "now: it holds up all of x's work"]);
    assert.deepEqual(cards.map((c) => c.headline.split(';')[0]), ['Urgent?', '1 question waits for an operator', 'Later?'],
      'the parked question before the hub-wide card, though newer; both before later work');
  });

  test('a question about no item takes the highest priority of the items it names, else soon', () => {
    const { hub, advance } = setup();
    hub.humanOp('x', 'create', { title: 'A', acceptance: 'x', priority: 'later' }); // #1
    hub.humanOp('x', 'create', { title: 'B', acceptance: 'x', priority: 'now' }); // #2
    hub.agentOp('x', 'ask', 'a', { question: 'Drop #1 and #2?', blocking: true });
    advance(MIN);
    hub.agentOp('x', 'ask', 'b', { question: 'Rename the project?', blocking: true });
    const cards = acts(view(hub, 'x')).filter((c) => c.kind === 'question');
    assert.deepEqual(cards.map((c) => [c.headline, c.priority, c.priority_why]), [
      ['Drop #1 and #2?', 'now', "now: #2's own priority"],
      ['Rename the project?', 'soon', 'soon: it is about no item'],
    ]);
  });

  test("the home ranks across projects by the same rule, not oldest first; the workspace's own entry is now", () => {
    const { hub, advance } = setup();
    hub.tx(() => hub.project('y', { create: true }));
    hub.humanOp('x', 'create', { title: 'Old soon', acceptance: 'x', priority: 'soon' });
    hub.humanOp('y', 'create', { title: 'New now', acceptance: 'x', priority: 'now' });
    ask(hub, 'x', 'a', '#1', 'Old soon?');
    advance(10 * MIN);
    ask(hub, 'y', 'b', '#1', 'New now?');
    const h = homeView(hub);
    const qs = h.needs.filter((n) => n.kind === 'question');
    assert.deepEqual(qs.map((n) => [n.headline, n.project.slug]), [['New now?', 'y'], ['Old soon?', 'x']]);
    const paid = withEntry(h, { key: 'payment-failed:s', level: 'act', kind: 'payment-failed', at: hub.now(), headline: 'Payment failed' });
    const at = paid.needs.findIndex((n) => n.kind === 'payment-failed');
    assert.equal(paid.needs[at].priority, 'now');
    assert.ok(at < paid.needs.findIndex((n) => n.headline === 'Old soon?'), 'before soon work');
  });

  test('worth knowing keeps its own order: oldest first', () => {
    const { hub, advance } = setup();
    hub.humanOp('x', 'create', { title: 'Later', acceptance: 'x', priority: 'later' });
    hub.humanOp('x', 'create', { title: 'Now', acceptance: 'x', priority: 'now' });
    hub.agentOp('x', 'ask', 'a', { item: '#1', question: 'Q1', assumption: 'yes' });
    advance(MIN);
    hub.agentOp('x', 'ask', 'b', { item: '#2', question: 'Q2', assumption: 'yes' });
    const know = view(hub, 'x').attention.filter((a) => a.kind === 'assumption');
    assert.deepEqual(know.map((a) => a.headline), ['a assumed: yes', 'b assumed: yes']);
  });
});
