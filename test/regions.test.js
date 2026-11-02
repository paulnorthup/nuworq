// The app draws region by region (#602): the rail, the page and the drawer are pure views (web/views/), a change to
// the state marks the regions it affects (web/store.js), and render draws only those. Run here on a seeded hub's real
// answers, with the page's elements stood in for.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FIELDS, createStore } from '../web/store.js';
import { dataCache } from '../web/data.js';
import { seedHub, SLUG } from './seedhub.js';
import { view, itemView, projectList } from '../src/insight.js';

const read = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const reads = (src) => new Set([...src.matchAll(/\bS\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));

describe('each view reads only the fields that redraw its region', () => {
  // A region's fields: its own module's, and web/views/parts.js's when it draws with them.
  const parts = reads(read('views/parts.js'));
  for (const region of ['rail', 'main', 'drawer']) {
    test(region, () => {
      const src = read(`views/${region}.js`);
      const fields = new Set([...reads(src), ...(/from '\.\/parts\.js'/.test(src) ? parts : [])]);
      assert.ok(fields.size > 3, 'it reads the store');
      const missed = [...fields].filter((k) => !FIELDS[k]?.[1].includes(region));
      assert.deepEqual(missed, [], `read by web/views/${region}.js but a change to them doesn't redraw ${region} (web/store.js)`);
    });
  }
  test('the markup helpers read no state', () => assert.deepEqual([...reads(read('views/html.js'))], []));
  test('a view touches no page: no document, no requests, no setters', () => {
    for (const f of ['views/html.js', 'views/parts.js', 'views/rail.js', 'views/main.js', 'views/drawer.js']) {
      assert.doesNotMatch(read(f), /\bdocument\b|\$\(|fetch\(|\bapi\(|setState|toggleIn|addTo\(|putIn|removeFrom|from '\.\.\/ui\.js'/, f);
    }
  });
});

describe('the store marks what a change redraws', () => {
  test('a drawer-only change marks only the drawer; a field set to what it holds marks nothing', () => {
    const { S, setState, toggleIn, putIn, removeFrom, markDirty, takeDirty } = createStore();
    assert.deepEqual(takeDirty(), ['rail', 'main', 'drawer'], 'everything, the first time');
    assert.deepEqual(takeDirty(), [], 'then nothing until a change');
    setState({ item: { title: 'x' }, deep: true });
    assert.deepEqual(takeDirty(), ['drawer']);
    setState({ item: S.item, zoom: S.zoom, slug: S.slug });
    assert.deepEqual(takeDirty(), [], 'the same values');
    setState({ sending: 2 });
    assert.deepEqual(takeDirty(), [], 'bookkeeping');
    toggleIn('open', 'k');
    putIn('prefetched', 'p #1', {});
    assert.deepEqual(takeDirty(), ['main', 'drawer']);
    removeFrom('drafts', 'never-typed');
    assert.deepEqual(takeDirty(), [], 'nothing to remove');
    putIn('drafts', 'a', 'x');
    takeDirty();
    removeFrom('drafts', 'a', 'b');
    assert.deepEqual(takeDirty(), ['main', 'drawer']);
    markDirty('rail', 'nowhere');
    assert.deepEqual(takeDirty(), ['rail']);
  });

  test('an answer asked again that says the same is the same object, so it redraws nothing (web/data.js)', async () => {
    let n = 0;
    const answers = { '/api/p/a/view?depth=30s': () => ({ project: { slug: 'a' }, n: n <= 2 ? 0 : 1 }) };
    const data = dataCache(async (url) => { n++; return answers[url](); });
    const first = await data.read('/api/p/a/view?depth=30s');
    data.changed({ project: 'a' });
    const again = await data.read('/api/p/a/view?depth=30s');
    assert.equal(again, first, 'unchanged: the object already held');
    data.changed({ project: 'a' });
    const changed = await data.read('/api/p/a/view?depth=30s');
    assert.notEqual(changed, first);
    assert.equal(changed.n, 1);
  });
});

describe('render draws only the regions a change marked (#602)', () => {
  let ui, store, drawn, html, hub, served;
  before(async () => {
    // The page's elements, stood in for: nothing focused, nothing scrolled, no "new" tags.
    const el = () => ({ querySelectorAll: () => [], classList: { toggle() {}, add() {}, remove() {} }, hidden: false });
    const els = { '#rail': el(), '#main': el(), '#drawer': el(), '#scrim': el() };
    globalThis.document = { activeElement: null, scrollingElement: null, hidden: false, querySelectorAll: () => [], querySelector: (s) => els[s] ?? null };
    ({ hub } = seedHub({ items: 40, agents: 12, progress: 4 }));
    // The hub's answers, as the app asks for them; the item's can be told to differ.
    served = { item: (ref) => itemView(hub, SLUG, ref) };
    globalThis.fetch = async (path) => {
      const u = new URL(path, 'http://hub/');
      const m = u.pathname.match(/^\/api\/p\/([^/]+)\/(view|items\/(\d+))$/);
      const body = u.pathname === '/api/projects' ? projectList(hub)
        : m?.[2] === 'view' ? view(hub, SLUG, { depth: u.searchParams.get('depth') })
        : m?.[3] ? served.item(`#${m[3]}`) : {};
      return { status: 200, ok: true, json: async () => JSON.parse(JSON.stringify(body)) };
    };
    store = await import('../web/store.js');
    ui = await import('../web/ui.js');
    // Each region's real view, counted, painted into nothing.
    const views = { rail: (await import('../web/views/rail.js')).railHtml, main: (await import('../web/views/main.js')).mainHtml, drawer: (await import('../web/views/drawer.js')).drawerHtml };
    drawn = []; html = {};
    for (const r of Object.keys(views)) ui.REGIONS[r] = () => { drawn.push(r); html[r] = views[r](); return els[`#${r}`]; };
  });

  test('a project with an item open: all three the first time, then only the drawer for what only the drawer shows', async () => {
    store.setState({ slug: SLUG, itemRef: '#2', zoom: '30m' });
    await ui.refresh({ force: true });
    assert.deepEqual(drawn, ['rail', 'main', 'drawer'], 'the first draw');
    assert.match(html.rail, /class="rail-item on" href="#\/p\/big"/);
    assert.match(html.main, /<h1>big/);
    assert.match(html.drawer, /<h2 class="title">Item 2: /);

    // A live change in the open item that only its drawer shows: the list and the view come back the same.
    drawn = [];
    served.item = (ref) => ({ ...itemView(hub, SLUG, ref), title: 'Item 2, renamed' });
    ui.data.changed({ project: SLUG, item: '#2' });
    await ui.refresh({ fresh: false });
    assert.deepEqual(drawn, ['drawer'], 'the rail and the page are not drawn');
    assert.match(html.drawer, /Item 2, renamed/);

    // The person opens the deep dive: the drawer only. Then a change that says nothing new: nothing at all.
    drawn = [];
    store.setState({ deep: true });
    ui.render({ force: true });
    assert.deepEqual(drawn, ['drawer']);
    drawn = [];
    ui.data.changed({ project: SLUG, item: '#2' });
    await ui.refresh({ fresh: false });
    assert.deepEqual(drawn, [], 'the same answers: nothing is drawn');

    // Another depth changes the page and the drawer, not the rail.
    drawn = [];
    store.setState({ zoom: '5m' });
    ui.render({ force: true });
    assert.deepEqual(drawn, ['main', 'drawer']);
  });

  test('Analytics draws (its durations once threw: dur was never imported)', async () => {
    const { workspaceOutcomes } = await import('../src/outcomes.js');
    store.setState({ analytics: true, outcomes: JSON.parse(JSON.stringify(workspaceOutcomes(hub, { period: '14d' }))) });
    drawn = [];
    ui.render({ force: true });
    assert.deepEqual(drawn, ['rail', 'main']);
    assert.match(html.main, /Analytics/);
    store.setState({ analytics: false, outcomes: null });
  });
});
