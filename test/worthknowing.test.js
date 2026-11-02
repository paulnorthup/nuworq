import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, MIN, HOUR } from '../src/core.js';
import { view, homeView } from '../src/insight.js';

// #497: Worth knowing holds only what a person might confirm, redirect or fix. Seeded like nuworq's 2026-11-01:
// 95 cards then, of which 3 were worth a person's attention.
function day() {
  let now = Date.UTC(2026, 10, 1, 6);
  const hub = new Hub({ clock: () => now });
  const later = (ms) => { now += ms; };
  hub.tx(() => hub.project('nuworq', { create: true }));
  const p = () => hub.project('nuworq');
  const add = (title) => hub.humanOp('nuworq', 'create', { title, acceptance: 'x' }).item;
  const items = Array.from({ length: 6 }, (_, i) => add(`Item ${i + 1}`));
  hub.agentOp('nuworq', 'checkin', 'w1', { has: ['macos'] });
  hub.agentOp('nuworq', 'checkin', 'op', { has: ['operator'] });

  // 62 tidy results, 45 of them changing nothing, and 2 field-note reviews: all tidy events.
  for (let i = 0; i < 62; i++) {
    hub.event(p(), { actor: 'w2', type: 'tidied', headline: `w2 tidied the milestones: ${i < 45 ? 'No change; left alone on purpose' : `Moved #${i} under #1`}` });
    later(MIN);
  }
  for (let i = 0; i < 2; i++) hub.event(p(), { actor: 'w2', type: 'tidied', headline: 'w2 reviewed the field notes: retired 2' });

  // 26 operator answers, mostly live checks, each a long answer.
  for (let i = 0; i < 26; i++) {
    const q = hub.agentOp('nuworq', 'ask', 'w1', { item: items[i % 3], question: `Is check ${i} green on the live hub?`, blocking: true, to: 'operator' }).question;
    hub.agentOp('nuworq', 'answer', 'op', { question: q, answer: `Checked live: green. ${'Output follows. '.repeat(100)}` });
    later(10 * MIN);
  }

  // 2 steers made from answers ("Change of course"), on items that are done.
  for (const it of [items[3], items[4]]) {
    hub.humanOp('nuworq', 'update', { item: it, stage: 'done' });
    hub.addNote(p(), 'steer', `Change of course on ${it}: you assumed "skip it". Instead: run it.`, hub.item(p(), it), 'w1', 'op');
  }

  // A person's steer on open work, and 2 assumptions agents proceeded on.
  hub.humanOp('nuworq', 'steer', { item: items[5], body: 'Keep the release branch protected.' });
  hub.agentOp('nuworq', 'ask', 'w1', { item: items[0], question: 'Which address does SECURITY.md give for reports?', assumption: 'security@nuworq.com' });
  hub.agentOp('nuworq', 'ask', 'w1', { item: items[1], question: 'Land while the release branch is unprotected?', assumption: 'Yes; protection is a separate item' });
  later(30 * MIN);
  return { hub, later, items };
}

describe('Worth knowing holds only what a person might act on (#497)', () => {
  test("a day like nuworq's 2026-11-01 shows just the 2 assumptions and the person's steer, and the home says 3", () => {
    const { hub } = day();
    const know = view(hub, 'nuworq').attention.filter((a) => a.level === 'know');
    assert.deepEqual(know.map((a) => a.kind).sort(), ['assumption', 'assumption', 'steer-unseen']);
    assert.match(know.find((a) => a.kind === 'steer-unseen').sub, /Keep the release branch protected/);
    assert.equal(homeView(hub).worth_knowing.find((w) => w.slug === 'nuworq').count, 3);
  });

  test("a steer made from an answer is the answerer's: never \"your steer\", even on open work", () => {
    const { hub, later, items } = day();
    const p = hub.project('nuworq');
    hub.addNote(p, 'steer', 'Change of course: you assumed "a". Instead: b.', hub.item(p, items[2]), 'w1', 'op');
    later(HOUR);
    const unseen = view(hub, 'nuworq').attention.filter((a) => a.kind === 'steer-unseen');
    assert.equal(unseen.length, 1, "only the person's");
    assert.equal(view(hub, 'nuworq').steers.find((s) => /Instead: b/.test(s.body)).by, 'op', 'the steering list says whose it is');
  });

  test('an operator answer marked for people shows for a day; the operator skill and guide say when', async () => {
    const { hub, items } = day();
    const q = hub.agentOp('nuworq', 'ask', 'w1', { item: items[0], question: 'Rotate the hub token?', blocking: true, to: 'operator' }).question;
    hub.agentOp('nuworq', 'answer', 'op', { question: q, answer: 'Rotated it on the live hub; the old one is revoked.', for_people: true });
    const shown = view(hub, 'nuworq').attention.filter((a) => a.kind === 'operator-answered');
    assert.deepEqual(shown.map((a) => a.headline), ['Operator answered w1: Rotated it on the live hub; the old one is revoked.']);
    const { operatorSkill, skill, tools } = await import('../src/protocol.js');
    assert.equal(tools('mcp', '', { role: 'operator' }).find((t) => t.name === 'answer').inputSchema.properties.for_people.type, 'boolean');
    assert.match(operatorSkill(), /for_people: true` only when you changed a live system or made a call no decision covers/);
    assert.match(skill(), /Set `for_people` only when you changed a live system/, "the skill's operator section");
  });

  test('Got it, all clears every card in one call', () => {
    const { hub } = day();
    const keys = view(hub, 'nuworq').attention.filter((a) => a.level === 'know').map((a) => a.key);
    hub.humanOp('nuworq', 'dismiss', { keys });
    assert.equal(view(hub, 'nuworq').attention.filter((a) => a.level === 'know').length, 0);
  });
});
