import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hub } from '../src/core.js';
import { view, projectList } from '../src/insight.js';
import { held, viewLoader, loadProject, shell, paintInTwo } from '../web/switching.js';
import { placeholder } from '../web/instant.js';

// #503: a project appears the moment it's picked, from what the app holds; the hub's answer then fills it in place.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const deps = { esc, stateDot: (s) => `<i class="dot ${s}"></i>`, labels: { 'needs-you': 'Needs you', idle: 'Idle' }, placeholder, depth: '<div class="seg">30s</div>', updating: '<span class="updating">Updating</span>' };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function hub() {
  const h = new Hub({ clock: () => Date.UTC(2026, 10, 1, 9) });
  h.tx(() => { h.project('api', { create: true }); h.project('web', { create: true }); });
  h.humanOp('api', 'settings', { mission: 'Payments <fast>' });
  h.agentOp('api', 'checkin', 'w1', {});
  h.agentOp('api', 'ask', 'w1', { question: 'Which region?', blocking: true });
  return h;
}

describe('a project shows the moment it is picked (#503)', () => {
  test('before any fetch: the header from its line in the project list, with its pulse and needs-you count', () => {
    const h = hub();
    const projects = projectList(h);
    const got = held('api', { views: new Map(), projects });
    assert.ok(got.line && !got.view, 'nothing seen yet this visit: its line');
    const html = shell(got.line, deps);
    assert.match(html, /<h1>api<span class="updating">Updating<\/span><\/h1>/, 'the name at once, marked as updating');
    assert.match(html, /Payments &#60;fast&#62;/, 'the mission, escaped');
    assert.match(html, new RegExp(`class="pulse state-${got.line.pulse.state}"`), 'its pulse');
    assert.match(html, /<span class="badge" title="1 thing needs you">1<\/span>/, 'and the needs-you count, as the rail shows it');
    assert.match(html, /aria-busy="true"/, 'quiet blocks where the rest goes, no spinner');
    assert.doesNotMatch(html, /spinner|shimmer|animation/);
    assert.equal(held('gone', { views: new Map(), projects }), null, 'a project the app knows nothing of: nothing held');
  });

  test('laid out as the page is: two columns when wide, the pulse beside the work', () => {
    const line = projectList(hub()).find((p) => p.slug === 'web');
    const wide = shell(line, { ...deps, columns: (a, b) => `<main-col>${a}</main-col><side-col>${b}</side-col>` });
    assert.match(wide, /<main-col><div class="ph-block"[^]*<\/main-col><side-col><div class="pulse/);
    assert.doesNotMatch(wide, /class="badge"/, 'nothing needs you: no count');
    const phone = shell(line, deps);
    assert.ok(phone.indexOf('class="pulse') < phone.indexOf('ph-block'), 'on a phone the pulse first, as on the page');
  });

  test('a project seen earlier this visit opens as last seen, until the hub answers', () => {
    const h = hub();
    const v = view(h, 'api');
    const got = held('api', { views: new Map([['api', v]]), projects: projectList(h) });
    assert.equal(got.view, v);
  });

  test('a hover, a focus and the click share one request; fresh asks again; a failure is not kept', async () => {
    let t = 0, calls = 0;
    const gets = [];
    const loader = viewLoader((slug) => { calls++; const d = deferred(); gets.push(d); return d.promise; }, { now: () => t, keep: 1000 });
    const a = loader.load('api');
    const b = loader.load('api');
    assert.equal(a, b, 'the click picks up the request the hover started');
    assert.equal(calls, 1);
    gets[0].resolve({ project: { slug: 'api' } });
    assert.deepEqual(await b, { project: { slug: 'api' } });
    loader.load('api', { fresh: true });
    assert.equal(calls, 2, 'a live change or an action asks the hub again');
    t = 2000;
    loader.load('api');
    assert.equal(calls, 3, 'kept only a few seconds');
    loader.forget();
    loader.load('api');
    assert.equal(calls, 4, 'a change on the hub drops what was fetched ahead');
    gets[3].reject(new Error('offline'));
    await assert.rejects(gets[3].promise);
    await new Promise((r) => setImmediate(r));
    loader.load('api');
    assert.equal(calls, 5, 'a failed fetch is tried again, not kept');
  });

  test('the list, the view and the item are asked for together, not one after another', async () => {
    const started = [];
    const pending = { list: deferred(), view: deferred(), item: deferred() };
    const ask = (k) => () => { started.push(k); return pending[k].promise; };
    const done = loadProject({ list: ask('list'), view: ask('view'), item: ask('item') });
    assert.deepEqual(started, ['list', 'view', 'item'], 'all three are on their way before any answers');
    pending.item.resolve({ ref: '#1' });
    pending.view.resolve({ project: { slug: 'api' } });
    pending.list.resolve([{ slug: 'api' }]);
    assert.deepEqual(await done, { projects: [{ slug: 'api' }], view: { project: { slug: 'api' } }, error: null, item: { ref: '#1' } });
  });

  test('without a list to fetch, only the view; a view that fails comes back as its error', async () => {
    const err = new Error('Not found');
    const r = await loadProject({ list: null, view: () => Promise.reject(err), item: null });
    assert.deepEqual(r, { projects: null, view: null, error: err, item: null });
  });

  test('the app draws the held project on the click, then fetches without the list unless a live change marked it', () => {
    const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    assert.match(app, /loading: slug, view: slug \? held\(slug, S\)\?\.view \?\? null : S\.view \}\);/, 'the last view seen, else the shell');
    assert.match(app, /shellOnly = slug;\n\s*paintInTwo\(\(\) => render\(\{ force: true \}\), [^]*?\n\s*refresh\(\{ force: true, fresh: !moved, list: false \}\)/, 'drawn before the fetch');
    assert.match(app, /list: list \|\| S\.listStale \|\| !S\.projects\.length \? \(\) => data\.read\('\/api\/projects', \{ fresh \}\) : null/);
    assert.match(app, /es\.onmessage = \(m\) => \{ data\.changed\(changeOf\(m\.data\)\); setState\(\{ listStale: true \}\); scheduleRefresh\(\); \};/, 'a change drops only what it touched (#601)');
    assert.match(app, /if \(slug !== S\.slug\) return; \/\/ they moved on/, 'an answer for a project left behind never draws over the one picked');
    assert.match(app, /addEventListener\('focusin', \(e\) => prefetchView\(projectTarget\(e\)\)\)/, 'focus starts loading');
    assert.match(app, /const run = L\.results\[L\.sel\]\?\.run;[^]*?prefetchView\(/, 'so does the launcher\'s highlighted result');
  });
});

describe('a big project paints its header first, the rest after (#637)', () => {
  test('the first paint runs now; the rest waits for a later task', () => {
    const order = [], queued = [];
    paintInTwo(() => order.push('header'), () => order.push('page'), (fn) => queued.push(fn));
    assert.deepEqual(order, ['header'], 'only the header in this frame');
    assert.equal(queued.length, 1);
    queued[0]();
    assert.deepEqual(order, ['header', 'page'], 'then the whole page, in place');
  });

  test("with a held view, route() paints only the shell first, and a refresh that answers at once doesn't draw the page early", () => {
    const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    assert.match(app, /if \(S\.slug && S\.view\?\.project\.slug === S\.slug && shellOnly !== S\.slug\) return project\(S\.view\);/, 'a held view waits for the second paint');
    assert.match(app, /if \(shellOnly !== slug\) return;\n\s*shellOnly = null;\n\s*if \(S\.slug === slug\) render\(\{ force: true \}\);/, 'the second paint draws the page, once, for the project still picked');
    assert.match(app, /if \(S\.slug && shellOnly === S\.slug\) return; \/\/ the switch's second paint draws it/, 'refresh leaves the drawing to it');
    assert.match(readFileSync(new URL('../web/switching.js', import.meta.url), 'utf8'), /export const afterPaint = \(fn\) => requestAnimationFrame\(\(\) => setTimeout\(fn, 0\)\);/, 'after the frame has painted, in a task of its own');
  });
});
