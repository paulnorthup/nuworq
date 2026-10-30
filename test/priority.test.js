import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, MIN } from '../src/core.js';
import { itemView } from '../src/insight.js';
import { createServer } from '../src/server.js';

// A group's priority reaches everything in it and everything it waits on (#198).
describe('effective priority', () => {
  function setup(slugs = ['demo']) {
    let t = Date.UTC(2026, 9, 30, 9);
    const hub = new Hub({ clock: () => t });
    for (const s of slugs) hub.tx(() => hub.project(s, { create: true }));
    const create = (args, slug = slugs[0]) => { const r = hub.humanOp(slug, 'create', { acceptance: 'x', ...args }); t += MIN; return r; };
    const order = (slug = slugs[0]) => hub.claimable(hub.project(slug), 'a1').map((o) => `#${o.item.seq}`);
    const look = (ref, slug = slugs[0]) => hub.agentOp(slug, 'look', 'a1', { item: ref });
    const done = (ref, slug = slugs[0]) => hub.tx(() => hub.move(hub.item(hub.project(slug), ref), 'done', 'you'));
    return { hub, create, order, look, done };
  }

  test('a "soon" child of a "now" parent ranks with "now" work; lowering the parent re-ranks it at once', () => {
    const { hub, create, order, look } = setup();
    create({ title: 'Unrelated, oldest', priority: 'soon' }); // #1
    create({ title: 'Urgent', priority: 'now' }); // #2
    create({ title: 'The group', priority: 'now' }); // #3
    create({ title: 'In the group', priority: 'soon', parent: '#3' }); // #4
    assert.deepEqual(order(), ['#2', '#4', '#1'], 'the child ranks "now", ahead of the older unrelated "soon" item');
    assert.equal(hub.agentOp('demo', 'next', 'a1', { claim: false }).item, '#2');
    assert.equal(look('#4').priority, 'soon', 'its own priority is unchanged');
    assert.equal(look('#4').effective_priority, 'now (from #3)');
    assert.equal(look('#2').effective_priority, undefined, 'nothing to say when it ranks as its own');
    assert.ok(hub.agentOp('demo', 'look', 'a1', {}).board.ready.includes('#4 [now (from #3)] In the group'));
    assert.equal(itemView(hub, 'demo', '#4').effective_priority, 'now (from #3)', 'the item drawer shows it too');

    hub.agentOp('demo', 'refine', 'a1', { item: '#3', priority: 'soon' });
    assert.deepEqual(order(), ['#2', '#1', '#4'], 'back to its own priority, then by age');
    assert.equal(look('#4').effective_priority, undefined);
    assert.equal(itemView(hub, 'demo', '#4').effective_priority, null);
  });

  test('what an open "now" item waits on ranks "now", two levels down; once it is done, its own priority again', () => {
    const { create, order, look, done } = setup();
    create({ title: 'Foundation', priority: 'later' }); // #1
    create({ title: 'Middle', priority: 'later', depends_on: ['#1'] }); // #2
    create({ title: 'The goal', priority: 'now', depends_on: ['#2'] }); // #3
    create({ title: 'Something else', priority: 'soon' }); // #4
    assert.deepEqual(order(), ['#1', '#4'], 'only #1 and #4 can start; #1 ranks "now" because #3 waits on it through #2');
    assert.equal(look('#1').effective_priority, 'now (from #3)');
    assert.equal(look('#2').effective_priority, 'now (from #3)');

    done('#3');
    assert.deepEqual(order(), ['#4', '#1'], 'nothing open waits on it now: "later" again');
    assert.equal(look('#1').effective_priority, undefined);
  });

  test("the runner's routes rank by the same effective priority", async () => {
    const { hub, create } = setup(['alpha', 'beta']);
    for (const s of ['alpha', 'beta']) hub.humanOp(s, 'settings', { runner: true });
    create({ title: 'Older, on its own', priority: 'soon' }, 'alpha');
    create({ title: 'The group', priority: 'now' }, 'beta');
    create({ title: 'In the group', priority: 'soon', parent: '#1' }, 'beta');
    const server = createServer(hub, { sweepMs: 0 });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const routes = await (await fetch(`http://127.0.0.1:${server.address().port}/api/route?runner=1`)).json();
      assert.deepEqual(routes.map((r) => [r.project, r.item, r.priority]), [['beta', '#2', 'now'], ['alpha', '#1', 'soon']]);
    } finally { server.close(); server.closeAllConnections(); }
  });
});
