import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, DAY, MIN } from '../src/core.js';
import { Notifier, addChannel, listChannels, setWeekly } from '../src/notify.js';
import { outcomes } from '../src/outcomes.js';

// Once a week, one push says what you got (#178).
function world() {
  let t = Date.UTC(2026, 9, 26, 9);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('app', { create: true }));
  hub.tx(() => hub.project('quiet', { create: true }));
  const pushed = [];
  const start = t;
  addChannel(hub.db, 'webhook', 'http://phone.test/hook', t);
  const n = new Notifier(hub, { baseUrl: 'http://hub.test', fetch: async (url, o) => { pushed.push(JSON.parse(o.body)); return new Response(null, { status: 200 }); } });
  const op = (agent, name, args = {}) => hub.agentOp('app', name, agent, args);
  return { hub, n, pushed, op, start, tick: (ms) => { t += ms; } };
}

// One item built, verified by the person and landed; another landed and then fixed by a third (an escape).
function aBusyWeek({ hub, op, tick }) {
  for (const title of ['Login works', 'Logout works']) {
    const it = hub.humanOp('app', 'create', { title, acceptance: 'x' }).item;
    op('a1', 'claim', { item: it });
    op('a1', 'submit', { item: it, headline: 'done', evidence: [{ label: 'tests pass' }], usage: { model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 200, cost_usd: 1.5 } });
    hub.humanOp('app', 'accept', { item: it });
    const landed = hub.item(hub.project('app'), it);
    if (landed.stage !== 'done') hub.tx(() => hub.move(landed, 'done', 'you'));
    tick(MIN);
  }
  hub.humanOp('app', 'create', { title: 'Fix logout', acceptance: 'x', fixes: '#2' });
  hub.humanOp('app', 'steer', { body: 'Keep it small' });
}

describe('the weekly line (#178)', () => {
  test("once a week, one line per busy project, with the outcomes API's numbers and a link", async () => {
    const w = world();
    aBusyWeek(w);
    w.tick(6 * DAY);
    assert.deepEqual(await w.n.weekly(), [], 'not a week yet');
    w.tick(1 * DAY);
    await w.n.weekly();
    assert.equal(w.pushed.length, 1);
    const [msg] = w.pushed;
    const o = outcomes(w.hub, 'app', { since: w.start, until: w.hub.now() });
    const landed = o.items.filter((i) => i.outcome === 'landed').length;
    const escapes = o.items.filter((i) => i.escaped).length;
    assert.deepEqual([landed, o.human_actions.total, escapes], [2, o.human_actions.total, 1]);
    assert.ok(o.human_actions.total > 0, `the person acted this week (${o.human_actions.total})`);
    assert.equal(msg.text, `nuworq: this week\napp: ${landed} landed, ${o.human_actions.total} of your actions, $3.00, 1 escape → http://hub.test/#/p/app`);
    assert.equal(msg.url, 'http://hub.test/#/p/app');
    assert.ok(!msg.text.includes('quiet'), 'a project with nothing going on sends nothing');

    await w.n.weekly();
    assert.equal(w.pushed.length, 1, 'once a week, not every scan');
  });

  test('a quiet week sends nothing, and the next week counts from there', async () => {
    const w = world();
    w.tick(7 * DAY);
    assert.deepEqual(await w.n.weekly(), []);
    assert.equal(w.pushed.length, 0);
    aBusyWeek(w);
    w.tick(7 * DAY);
    await w.n.weekly();
    assert.equal(w.pushed.length, 1);
  });

  test('turned off on a channel, it sends nothing there', async () => {
    const w = world();
    aBusyWeek(w);
    const [c] = listChannels(w.hub.db);
    assert.equal(c.weekly, true, 'on by default');
    setWeekly(w.hub.db, c.id, false);
    assert.equal(listChannels(w.hub.db)[0].weekly, false);
    w.tick(8 * DAY);
    await w.n.weekly();
    assert.equal(w.pushed.length, 0);
  });
});
