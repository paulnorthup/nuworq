import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hub } from '../src/core.js';
import { liveGate, onScreen } from '../web/pace.js';

// #502: a live update refreshes only what changed, one refetch at a time.
function clock() {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  return { tick: (ms) => mock.timers.tick(ms), done: () => mock.timers.reset() };
}
const flush = () => new Promise((r) => setImmediate(r));

describe('the change stream names what changed', () => {
  test('its project, and the item its events were about', () => {
    const hub = new Hub();
    hub.tx(() => { hub.project('a', { create: true }); hub.project('b', { create: true }); });
    const seen = [];
    hub.on('change', ({ at: _, ...e }) => seen.push(e));
    hub.humanOp('a', 'create', { title: 'One', acceptance: 'x' });
    hub.humanOp('b', 'steer', { body: 'Keep it small' });
    assert.deepEqual(seen, [{ project: 'a', item: '#1', items: ['#1'] }, { project: 'b', items: [] }]);
  });

  test('a change touching several items names them all, each once', () => {
    const hub = new Hub();
    hub.tx(() => hub.project('a', { create: true }));
    hub.humanOp('a', 'create', { title: 'One', acceptance: 'x' });
    hub.humanOp('a', 'create', { title: 'Two', acceptance: 'x' });
    const seen = [];
    hub.on('change', (e) => seen.push(e));
    const p = hub.project('a');
    for (const seq of [1, 2, 1]) hub.event(p, { item: hub.item(p, `#${seq}`), actor: 'you', type: 'comment', headline: 'h' });
    hub.changed(p);
    assert.deepEqual(seen[0].items, ['#1', '#2']);
    assert.equal('item' in seen[0], false);
  });
});

describe('the page refetches only what is on screen', () => {
  const msg = (e) => JSON.stringify({ at: 1, ...e });
  test("a change in another project doesn't refetch a project's page; its own, or one about no project, does", () => {
    assert.equal(onScreen(msg({ project: 'llm-proxy', item: '#3', items: ['#3'] }), { slug: 'nuworq' }), false);
    assert.equal(onScreen(msg({ project: 'nuworq', item: '#3', items: ['#3'] }), { slug: 'nuworq' }), true);
    assert.equal(onScreen(msg({ project: null }), { slug: 'nuworq' }), true, 'runners and channels are everyone\'s');
    assert.equal(onScreen('not json', { slug: 'nuworq' }), true, 'unsure: refetch');
  });

  test('the home (and analytics) show every project, so every change is theirs', () => {
    assert.equal(onScreen(msg({ project: 'llm-proxy' }), { slug: null }), true);
    assert.equal(onScreen(msg({ project: 'llm-proxy' })), true);
  });

  test('the app filters its stream with it, treating analytics and a missing project as screens of everything', () => {
    const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    assert.match(app, /import \{ liveGate, onScreen \} from '\.\/pace\.js';/);
    assert.match(app, /es\.onmessage = \(m\) => \{ if \(onScreen\(m\.data, \{ slug: S\.analytics \|\| S\.missing \? null : S\.slug \}\)\) scheduleRefresh\(\); \};/);
  });
});

describe('refetches are coalesced', () => {
  test('one in flight at a time; changes meanwhile make exactly one more once it is back', async () => {
    const c = clock();
    try {
      const pending = [];
      let started = 0;
      const gate = liveGate({ run: () => { started++; return new Promise((r) => pending.push(r)); } });
      gate.poke();
      c.tick(200);
      assert.equal(started, 1);
      // A slow refetch (a big project): ten more changes and five seconds pass while it is out.
      for (let i = 0; i < 10; i++) { gate.poke(); c.tick(500); }
      assert.equal(started, 1, 'never two at once');
      pending.shift()();
      await flush();
      c.tick(1000);
      assert.equal(started, 2, 'exactly one more, for everything that came in meanwhile');
      pending.shift()();
      await flush();
      c.tick(5000);
      assert.equal(started, 2, 'nothing new came in: nothing more');
    } finally { c.done(); }
  });

  test('a refetch that fails frees the gate too', async () => {
    const c = clock();
    try {
      let started = 0;
      const gate = liveGate({ run: () => { started++; return Promise.reject(new Error('offline')); } });
      gate.poke();
      c.tick(200);
      await flush();
      gate.poke();
      c.tick(1200);
      assert.equal(started, 2);
    } finally { c.done(); }
  });
});
