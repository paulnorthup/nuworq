import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { view } from '../src/insight.js';
import { createServer } from '../src/server.js';

// #162: Needs you shows a question's steps as a checklist; each person ticks their own, and the last tick reports back.
const STEPS = [
  { do: "Open the repository's Actions secrets", where: 'https://github.com/acme/api/settings/secrets/actions' },
  { do: 'Add the secret', where: 'gh secret set NPM_TOKEN', check: 'NPM_TOKEN is listed' },
  { do: 'Tell me when it is there' },
];

function setup({ options } = {}) {
  const hub = new Hub({ clock: () => Date.UTC(2026, 9, 30, 9) });
  hub.tx(() => hub.project('o', { create: true }));
  hub.humanOp('o', 'create', { title: 'Publish to npm', acceptance: 'x' });
  hub.agentOp('o', 'checkin', 'w1', { has: ['macos'] });
  hub.agentOp('o', 'claim', 'w1', { item: '#1' });
  const q = hub.agentOp('o', 'ask', 'w1', { item: '#1', blocking: true, to: 'human', question: 'Can you add the NPM_TOKEN secret in GitHub?', steps: STEPS, options }).question;
  const card = (viewer) => view(hub, 'o', { viewer }).attention.find((a) => a.kind === 'question');
  const tick = (step, by, done = true) => hub.humanOp('o', 'step', { question: q, step, done }, by);
  return { hub, q, card, tick };
}

describe('ticking a question\'s steps (#162)', () => {
  test('a tick is kept for the person who ticked it, and unticking takes it back', () => {
    const { card, tick } = setup();
    assert.deepEqual(card().ticked, []);
    assert.deepEqual(tick(2), { ok: true, done: 1, of: 3, answered: false });
    tick(1);
    assert.deepEqual(card().ticked, [1, 2], 'a fresh view (a reload) still has them');
    tick(1, undefined, false);
    assert.deepEqual(card().ticked, [2]);
  });

  test("another person's ticks are separate", () => {
    const { card, tick } = setup();
    tick(1, '@ann');
    tick(3, '@ben');
    assert.deepEqual(card('@ann').ticked, [1]);
    assert.deepEqual(card('@ben').ticked, [3]);
    assert.deepEqual(card().ticked, []);
  });

  test("the last tick of a question without options answers it, the card leaves Needs you, and the asker hears it", () => {
    const { hub, card, tick } = setup();
    tick(1); tick(2);
    const stage = () => hub.item(hub.project('o'), '#1').stage;
    assert.equal(stage(), 'waiting');
    assert.deepEqual(tick(3), { ok: true, done: 3, of: 3, answered: true });
    assert.equal(card(), undefined);
    assert.equal(stage(), 'ready', 'the work moves again');
    const brief = hub.agentOp('o', 'checkin', 'w1', {});
    assert.equal(brief.answers.find((a) => /NPM_TOKEN/.test(a.question))?.answer, 'Done: all 3 steps completed');
    assert.throws(() => tick(3, undefined, false), /already answered/);
  });

  test('with options, every step ticked still leaves the card until an option is picked', () => {
    const { card, tick } = setup({ options: ['Added it', "Can't: no admin rights"] });
    tick(1); tick(2);
    assert.equal(tick(3).answered, false);
    assert.deepEqual(card().ticked, [1, 2, 3]);
  });

  test('a step that is not there is refused with a hint', () => {
    const { tick } = setup();
    assert.throws(() => tick(4), (e) => /steps 1 to 3, not 4/.test(e.message) && /counts from 1/.test(e.hint));
    assert.throws(() => tick(0), /not 0/);
  });

  test('the tick route: POST /api/p/:p/human/step, and the project view carries the ticks', async () => {
    const { hub, q } = setup();
    const server = createServer(hub, {});
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const step = (body) => fetch(`${base}/api/p/o/human/step`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const r = await step({ question: q, step: 1, done: true });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, done: 1, of: 3, answered: false });
      const v = await (await fetch(`${base}/api/p/o/view`)).json();
      assert.deepEqual(v.attention.find((a) => a.kind === 'question').ticked, [1]);
      assert.equal((await step({ question: q, step: 9 })).status, 400);
    } finally {
      server.close();
    }
  });
});
