// The app's state lives in web/store.js (#600): every field declared up front with its default, changed only through
// its setters, each naming the regions (rail, main, drawer) a change redraws.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { FIELDS, regionsOf, createStore } from '../web/store.js';
import { appSource } from './appsource.js';

const WEB = new URL('../web/', import.meta.url);
const sources = [...readdirSync(WEB), ...readdirSync(new URL('views/', WEB)).map((f) => `views/${f}`)]
  .filter((f) => f.endsWith('.js') && f !== 'store.js').map((f) => [f, readFileSync(new URL(f, WEB), 'utf8')]);

// A write to S that bypasses the setters: an assignment (=, +=, ??= …) to S.x or anything inside it, ++/--, a Set's
// or Map's mutating call, delete, or Object.assign onto S.
const WRITES = [
  /\bS(?:\s*\.\s*[A-Za-z_$][\w$]*|\[[^\]]*\])+\s*(?:[-+*/%&|^]|\*\*|\?\?|\|\||&&|<<|>>>?)?=(?!=)/,
  /(?:\+\+|--)\s*S\s*[.[]/,
  /\bS(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\])+\s*(?:\+\+|--)/,
  /\bS\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.(?:add|delete|clear|set|push|pop|shift|unshift|splice|sort|reverse|fill)\(/,
  /\bdelete\s+S\s*[.[]/,
  /Object\.assign\(\s*S\s*[,)]/,
];
const directWrites = (src) => src.split('\n').flatMap((line, i) => (WRITES.some((re) => re.test(line)) ? [`${i + 1}: ${line.trim()}`] : []));

describe('the app state store (#600)', () => {
  test('no file but web/store.js writes S directly: the setters do', () => {
    for (const bad of ['S.zoom = z;', 'S.sending++;', '--S.sending', 'S.drafts[k] = v', "S.pages['all'] += 1", 'S.open.add(k)', 'S.reveal.delete(k)', 'S.views.set(s, v)',
      'delete S.drafts[k]', 'Object.assign(S, before)', 'S.info ??= x', 'S.a.b = 1', 'S[k] = v']) {
      assert.equal(directWrites(bad).length, 1, `the check catches ${bad}`);
    }
    for (const ok of ['if (S.zoom === z)', 'S.open.has(k)', 'S.views.get(s)', 'x = S.view', 'S.a !== b', "setState({ zoom: 'x' })"]) {
      assert.deepEqual(directWrites(ok), [], `a read is fine: ${ok}`);
    }
    for (const [f, src] of sources) assert.deepEqual(directWrites(src), [], `web/${f} changes S only through web/store.js`);
  });

  test('every field the app reads is declared, and nothing is declared that the app never uses', () => {
    const app = appSource();
    const read = new Set([...app.matchAll(/\bS\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
    assert.deepEqual([...read].filter((k) => !Object.hasOwn(FIELDS, k)), [], 'read but not declared in web/store.js');
    // Used: read as S.x, or named to a collection's setter (views is read by held() in web/switching.js).
    const named = new Set([...app.matchAll(/\b(?:toggleIn|addTo|putIn|removeFrom)\('([\w$]+)'/g)].map((m) => m[1]));
    assert.deepEqual(Object.keys(FIELDS).filter((k) => !read.has(k) && !named.has(k)), [], 'declared but never used');
  });

  test('a store starts with every field at its default; collections are its own', () => {
    const a = createStore(), b = createStore();
    assert.deepEqual(Object.keys(a.S).sort(), Object.keys(FIELDS).sort());
    assert.equal(a.S.zoom, '30s');
    assert.equal(a.S.sending, 0);
    assert.deepEqual(a.S.pages, { all: 100, agents: 50 });
    assert.ok(a.S.open instanceof Set && a.S.views instanceof Map);
    a.addTo('open', 'x');
    assert.equal(b.S.open.has('x'), false, 'another store has a Set of its own');
  });

  test('the setters change what they name, and refuse a field nobody declared', () => {
    const { S, setState, toggleIn, addTo, putIn, removeFrom } = createStore();
    setState({ zoom: '5m', stage: 'ready' });
    assert.deepEqual([S.zoom, S.stage], ['5m', 'ready']);
    assert.throws(() => setState({ zooom: '5m' }), /no state field "zooom": declare it in web\/store\.js/);
    assert.equal(S.zooom, undefined, 'and nothing of it is applied');
    toggleIn('open', 'k'); assert.ok(S.open.has('k'));
    toggleIn('open', 'k'); assert.ok(!S.open.has('k'));
    addTo('reveal', 'dsb'); removeFrom('reveal', 'dsb', 'other'); assert.equal(S.reveal.size, 0);
    putIn('drafts', 'compose', 'hi'); assert.equal(S.drafts.compose, 'hi');
    removeFrom('drafts', 'compose'); assert.ok(!('compose' in S.drafts));
    putIn('views', 'p', { v: 1 }); assert.deepEqual(S.views.get('p'), { v: 1 });
    putIn('pages', 'all', 200); assert.equal(S.pages.all, 200);
    assert.throws(() => putIn('zoom', 'x', 1), /"zoom" isn't a collection/);
  });

  test('each setter names the regions its change redraws', () => {
    const { setState, toggleIn, putIn } = createStore();
    assert.deepEqual(setState({ railMenu: true }), ['rail']);
    assert.deepEqual(setState({ itemRef: '#4', item: null }), ['drawer']);
    assert.deepEqual(setState({ slug: 'p' }), ['rail', 'main', 'drawer']);
    assert.deepEqual(setState({ stage: null, editItem: false }), ['main', 'drawer']);
    assert.deepEqual(setState({ sending: 1 }), [], 'bookkeeping redraws nothing');
    assert.deepEqual(toggleIn('open', 'k'), ['main', 'drawer']);
    assert.deepEqual(putIn('prefetched', 'p #4', {}), []);
    // The whole table, pinned: a field that moves between regions is a change someone meant.
    const table = Object.fromEntries(Object.keys(FIELDS).map((k) => [k, regionsOf(k).join(' ')]));
    assert.deepEqual(table, {
      projects: 'rail main', slug: 'rail main drawer', view: 'main drawer', views: '', loading: 'main', shellOnly: 'main', missing: 'main', listStale: '',
      pages: 'main', zoom: 'main drawer', home: 'main', homeFresh: '', gs: 'main', gsFresh: '',
      analytics: 'rail main', period: 'main', outcomes: 'main',
      me: 'rail main drawer', person: 'main', info: 'rail drawer', billing: 'rail', checkoutDone: '', feedback: 'rail main', feedbackCtx: '',
      notifyPerson: '', offline: '',
      itemRef: 'drawer', item: 'drawer', deep: 'drawer', editItem: 'drawer', editPre: 'drawer', prefetched: '',
      open: 'main drawer', reveal: 'main drawer', drafts: 'main drawer', composeKind: 'main', stage: 'main', addWork: 'main',
      addMore: 'main', addRemote: 'main', linkRepo: '', editMission: 'main', feedAll: 'main', onlyFeedback: 'main',
      railMenu: 'rail', orgOpen: 'rail', actSlug: '', pending: '', sending: '',
    });
  });
});
