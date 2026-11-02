import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { view, homeView, VIEW_TTL, PAGE } from '../src/insight.js';
import { createServer } from '../src/server.js';
import { seedHub, SLUG } from './seedhub.js';

const MIN = 60_000;
const STATEMENTS_30S = 356; // what a 30s view ran on seedHub() before #750

// #501: a project's page is built once per change and shared; what differs per viewer goes on top; the depth
// decides what's sent. P1 is stewarded by @a, P2 by @b, each with a blocking question for its steward.
function setup() {
  let t = Date.UTC(2026, 10, 1, 9);
  const hub = new Hub({ clock: () => t });
  const auth = new Auth(hub.db);
  auth.addPerson('a', 'steward');
  auth.addPerson('b', 'steward');
  for (const [slug, steward] of [['p1', '@a'], ['p2', '@b']]) {
    hub.tx(() => hub.project(slug, { create: true }));
    hub.humanOp(slug, 'settings', { autonomy: 'full' });
    hub.humanOp(slug, 'stewards', { set: [steward] });
    hub.humanOp(slug, 'create', { title: `Build ${slug}`, acceptance: 'x' });
    hub.agentOp(slug, 'claim', `bot-${slug}`, { item: '#1' });
    hub.agentOp(slug, 'ask', `bot-${slug}`, { item: '#1', question: `Which way for ${slug}?`, blocking: true });
  }
  hub.cacheViews = true; // as the server runs it
  const built = (slug) => hub._views.get(hub.project(slug).id);
  return { hub, built, advance: (ms) => (t += ms) };
}

describe("a project's page is built once per change (#501)", () => {
  test('a change in one project rebuilds only that one; one that names no project rebuilds every one', () => {
    const { hub, built } = setup();
    view(hub, 'p1'); view(hub, 'p2');
    const [one, two] = [built('p1'), built('p2')];
    view(hub, 'p1', { viewer: '@a' }); homeView(hub, { viewer: '@b' });
    assert.equal(built('p1'), one, 'the same build for another viewer and for the home');
    assert.equal(built('p2'), two);

    hub.humanOp('p2', 'create', { title: 'New in p2', acceptance: 'x' });
    const v2 = view(hub, 'p2');
    view(hub, 'p1');
    assert.equal(built('p1'), one, "p2's change leaves p1's build alone");
    assert.notEqual(built('p2'), two, 'p2 is built again');
    assert.ok(v2.all.some((i) => i.title === 'New in p2'), 'and shows the change');

    hub.changed(null, { kind: 'runner' });
    view(hub, 'p1'); view(hub, 'p2');
    assert.notEqual(built('p1'), one, 'a change for every project rebuilds p1 too');
  });

  test('times stay true: a build is kept at most 15 seconds', () => {
    const { hub, built, advance } = setup();
    view(hub, 'p1');
    const first = built('p1');
    advance(VIEW_TTL - 1);
    view(hub, 'p1');
    assert.equal(built('p1'), first);
    advance(1);
    view(hub, 'p1');
    assert.notEqual(built('p1'), first);
  });

  test("each viewer's needs you is their own, laid on the shared build, the same as a page built for them alone", () => {
    const { hub } = setup();
    for (const viewer of ['@a', '@b', undefined]) {
      const cached = view(hub, 'p1', { viewer });
      hub.cacheViews = false;
      const fresh = view(hub, 'p1', { viewer });
      hub.cacheViews = true;
      assert.deepEqual(cached, fresh, `the same page for ${viewer ?? 'no viewer'}`);
    }
    const a = view(hub, 'p1', { viewer: '@a' }), b = view(hub, 'p1', { viewer: '@b' });
    assert.deepEqual(a.attention.filter((x) => x.kind === 'question').map((x) => x.level), ['act']);
    assert.deepEqual(b.attention.filter((x) => x.kind === 'question').map((x) => x.level), ['know']);
    assert.match(b.attention.find((x) => x.kind === 'question').sub, /^needs @a/);
    assert.equal(a.pulse.act, 1);
    assert.equal(b.pulse.act, 0);
    assert.match(a.pulse.sentence, /^1 thing needs you\./);
    assert.match(b.pulse.sentence, /^Nothing needs you\./);
    assert.equal(view(hub, 'p1', { viewer: '@a' }).attention[0].level, 'act', "@b's look didn't change @a's page");
  });
});

describe('the page takes the depth (#501)', () => {
  const { hub } = seedHub();
  hub.cacheViews = true;
  const full = view(hub, SLUG);
  const at = (depth, pages) => view(hub, SLUG, { depth, pages });

  test('30s: the pulse, needs you, motion, flow and milestones, with counts of the rest', () => {
    const v = at('30s');
    for (const k of ['pulse', 'since', 'attention', 'motion', 'flow', 'groups', 'project', 'stages', 'counts']) assert.ok(k in v, k);
    for (const k of ['stage_items', 'all', 'queue', 'done', 'notes', 'steers', 'decisions', 'activity', 'proposed', 'waiting', 'verifying']) assert.ok(!(k in v), `no ${k}`);
    assert.deepEqual(v.attention, full.attention);
    assert.deepEqual(v.counts, {
      items: full.all.length, board: full.all.filter((i) => i.stage !== 'dropped' && !i.old).length,
      dropped: full.all.filter((i) => i.stage === 'dropped').length, old: full.all.filter((i) => i.old).length,
      agents: full.agents.length, agents_gone: full.agents.filter((a) => !a.present).length,
      queue: full.queue.length, done: full.done.length, notes: full.notes.length,
    });
    assert.ok(v.since.finished.length <= 6);
    assert.equal(v.since.counts.finished, full.since.counts.finished);
    // Agents (#750): a line each for the ones here now, and the others the sections 30s draws name; not the rest.
    const gone = new Set(full.agents.filter((a) => !a.present).map((a) => a.name));
    const drawn = JSON.stringify([v.attention, v.motion, v.groups, v.project]);
    assert.deepEqual(v.agents.map((a) => a.name), full.agents.filter((a) => a.present || drawn.includes(`"${a.name}"`)).map((a) => a.name));
    assert.ok(v.agents.some((a) => gone.has(a.name)) && v.agents.length < full.agents.length, 'some who are gone, not all');
    assert.ok(v.agents.every((a) => Object.keys(a).join() === 'name,model,role,where,job,present'));
    // Each agent Needs you names has its model, for the provider dot and the tooltip.
    const asks = v.attention.filter((a) => a.agent);
    assert.ok(asks.some((a) => gone.has(a.agent)), 'Needs you names someone who is gone');
    for (const a of asks) assert.equal(v.agents.find((x) => x.name === a.agent)?.model, full.agents.find((x) => x.name === a.agent).model, a.agent);
    // In motion without the last words, files and heads-up.
    assert.deepEqual(v.motion.map((m) => m.item), full.motion.map((m) => m.item));
    assert.ok(v.motion.every((m) => !('touching' in m) && !('heads_up' in m) && Object.keys(m.last ?? {}).join() === 'ago,at'));
  });

  test('30s is at most half what it was (123,212 bytes), and 5m and 30m carry the stage lists and agents', (t) => {
    const bytes = JSON.stringify(at('30s')).length;
    t.diagnostic(`${bytes} bytes at 30s`);
    assert.ok(bytes <= 61_606, `${bytes} bytes at 30s`);
    for (const depth of ['5m', '30m']) {
      const v = at(depth);
      // Flow's stage pills open to the last 25 items of each stage.
      const ready = full.all.filter((i) => i.stage === 'ready');
      assert.deepEqual(v.stage_items.ready.map((i) => i.item), ready.slice(-25).map((i) => i.item));
      // Agents: the ones here now, and the others the page names, as a line each.
      assert.deepEqual(v.agents.filter((a) => a.present), full.agents.filter((a) => a.present));
      const named = v.agents.filter((a) => !a.present);
      const { agents, ...rest } = v;
      const said = JSON.stringify(rest);
      if (depth === '5m') assert.ok(named.every((a) => Object.keys(a).join() === 'name,model,role,where,job,present'));
      assert.ok(named.every((a) => said.includes(`"${a.name}"`)), 'each one is named elsewhere on the page');
      assert.deepEqual(v.motion, full.motion);
    }
  });

  test('a 30s view runs no more statements than it did before #750, nor more than 5m', (t) => {
    const statements = (fn) => {
      let n = 0;
      const q = hub.q;
      hub.q = (sql) => {
        const s = q.call(hub, sql);
        return { get: (...a) => (n++, s.get(...a)), all: (...a) => (n++, s.all(...a)), run: (...a) => (n++, s.run(...a)), iterate: (...a) => (n++, s.iterate(...a)) };
      };
      try { fn(); } finally { hub.q = q; }
      return n;
    };
    hub.cacheViews = false; // built fresh, as after a change
    try {
      const [s30, s5] = ['30s', '5m'].map((depth) => statements(() => at(depth)));
      t.diagnostic(`30s ${s30}, 5m ${s5} statements`);
      assert.ok(s30 <= STATEMENTS_30S, `30s ran ${s30} statements, more than ${STATEMENTS_30S}`);
      assert.ok(s30 <= s5, `30s ran ${s30}, 5m ${s5}`);
    } finally { hub.cacheViews = true; }
  });

  test('5m: the first of Up next, Recently finished and the field notes, steering and decisions; under 150 KB', () => {
    const v = at('5m');
    assert.deepEqual(v.queue, full.queue.slice(0, 5));
    assert.deepEqual(v.done, full.done.slice(0, 5));
    assert.deepEqual(v.notes, full.notes.slice(0, 3));
    assert.deepEqual([v.steers, v.decisions], [full.steers, full.decisions]);
    assert.ok(!('activity' in v) && !('all' in v));
    const kb = JSON.stringify(v).length / 1024;
    assert.ok(kb < 150, `${kb.toFixed(0)} KB at 5m`);
    assert.ok(kb < JSON.stringify(full).length / 1024 / 3, 'a third of everything, at most');
  });

  test('30m: everything, with All work and earlier agents a page at a time', () => {
    const v = at('30m');
    assert.deepEqual([v.queue, v.done, v.notes, v.activity], [full.queue, full.done, full.notes, full.activity]);
    const board = full.all.filter((i) => i.stage !== 'dropped' && !i.old).sort((a, b) => b.item.slice(1) - a.item.slice(1));
    assert.deepEqual(v.all.map((i) => i.item), board.slice(0, PAGE.all).map((i) => i.item), 'newest first, one page');
    assert.deepEqual(Object.keys(v.all[0]).filter((k) => k !== 'feedback'), ['item', 'title', 'stage', 'priority', 'last_worker', 'repo', 'at', 'ago']);
    const gone = full.agents.filter((a) => !a.present);
    assert.deepEqual(v.earlier, gone.slice(0, PAGE.agents).map((a) => a.name));
    assert.deepEqual(v.agents.filter((a) => v.earlier.includes(a.name)), gone.slice(0, PAGE.agents), 'earlier agents in full');

    const more = at('30m', { all: '200', agents: '100' });
    assert.equal(more.all.length, Math.min(200, board.length));
    assert.equal(more.earlier.length, Math.min(100, gone.length));
  });

  test('over HTTP: /view takes depth, all and agents, and the hub the server runs caches', async () => {
    const { hub: h } = seedHub({ items: 60, agents: 80, progress: 1 });
    const server = createServer(h, {});
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const get = (q) => fetch(`http://127.0.0.1:${server.address().port}/api/p/${SLUG}/view${q}`).then((r) => r.json());
    try {
      const five = await get('?depth=5m');
      assert.equal(five.depth, '5m');
      assert.ok(!('all' in five) && five.queue.length <= 5);
      assert.ok(h.cacheViews, 'the server turned the cache on');
      const deep = await get('?depth=30m&all=10');
      assert.equal(deep.all.length, Math.min(PAGE.all, deep.counts.board), 'never less than a page');
      const all = await get('');
      assert.ok(!('depth' in all) && all.all.length === deep.counts.items, 'no depth: everything');
    } finally { server.close(); }
  });

  test('no depth: everything, as before', () => {
    assert.deepEqual(view(hub, SLUG), full);
    assert.equal(full.all.length, 500);
  });
});
