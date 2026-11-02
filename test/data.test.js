import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dataCache, affects } from '../web/data.js';
import { appSource } from './appsource.js';

// The app keeps each answer per URL until a change event says it changed (#601).
function world() {
  const asked = [];
  let fail = null;
  const data = dataCache(async (url) => { asked.push(url); if (fail) throw fail; return { url, n: asked.length }; });
  return { data, asked, failNext: (e) => { fail = e; }, ok: () => { fail = null; } };
}
const A = '/api/p/alpha/view?depth=30s', B = '/api/p/beta/view?depth=30s', ITEM = '/api/p/alpha/items/12', OTHER_ITEM = '/api/p/alpha/items/13';

describe('the app keeps each answer per URL until a change says it changed (#601)', () => {
  test('a second read of an unchanged URL makes no request; reads at once share one', async () => {
    const { data, asked } = world();
    const [x, y] = await Promise.all([data.read(A), data.read(A)]);
    assert.equal(x, y);
    await data.read(A);
    assert.deepEqual(asked, [A]);
  });

  test("a change event for project alpha leaves beta's view alone, and asks alpha's again", async () => {
    const { data, asked } = world();
    await Promise.all([data.read(A), data.read(B), data.read('/api/projects'), data.read('/api/home')]);
    data.changed({ project: 'alpha', item: '#12' });
    for (const u of [A, B, '/api/projects', '/api/home']) await data.read(u);
    assert.deepEqual(asked.slice(4), [A, '/api/projects', '/api/home'], "beta's view came from what was kept");
  });

  test('an open item is asked again only for a change naming it, or naming none in its project', async () => {
    const { data, asked } = world();
    await Promise.all([data.read(ITEM), data.read(OTHER_ITEM)]);
    data.changed({ project: 'alpha', item: '#13' });
    await Promise.all([data.read(ITEM), data.read(OTHER_ITEM)]);
    assert.deepEqual(asked.slice(2), [OTHER_ITEM]);
    data.changed({ project: 'alpha', item: null });
    await data.read(ITEM);
    assert.deepEqual(asked.slice(3), [ITEM]);
    data.changed({ project: 'beta', item: '#12' });
    await data.read(ITEM);
    assert.equal(asked.length, 4, "beta's #12 isn't alpha's");
  });

  test('a change in no project (workspace-wide) asks everything again', async () => {
    const { data, asked } = world();
    await Promise.all([data.read(A), data.read(B), data.read(ITEM)]);
    data.changed({ project: null });
    await Promise.all([data.read(A), data.read(B), data.read(ITEM)]);
    assert.equal(asked.length, 6);
  });

  test("an action refetches its own URL: fresh asks the hub even when it's kept", async () => {
    const { data, asked } = world();
    const first = await data.read(A);
    const again = await data.read(A, { fresh: true });
    assert.notEqual(first, again);
    assert.deepEqual(asked, [A, A]);
    assert.equal(await data.read(A), again, 'and keeps the fresh answer');
  });

  test("a failed request isn't kept; what the cache doesn't keep (settings, people) is asked each time", async () => {
    const { data, asked, failNext, ok } = world();
    failNext(new Error('offline'));
    await assert.rejects(data.read(A));
    ok();
    await data.read(A);
    assert.deepEqual(asked, [A, A]);
    await data.read('/api/people');
    await data.read('/api/people');
    assert.equal(asked.filter((u) => u === '/api/people').length, 2);
    assert.equal(affects('/api/people', { project: null }), false);
  });

  test('clear and forget drop what is kept: after a reconnect, and the views fetched at another depth', async () => {
    const { data, asked } = world();
    await Promise.all([data.read(A), data.read('/api/home')]);
    data.forget((u) => /\/view\?/.test(u));
    assert.equal(data.has(A), false);
    assert.equal(data.has('/api/home'), true);
    data.clear();
    assert.equal(data.has('/api/home'), false);
    assert.equal(asked.length, 2);
  });

  test('the app reads through it, and a live update reads what is kept', () => {
    const app = appSource();
    assert.match(app, /const data = dataCache\(\(url\) => api\(url\)\);/);
    assert.match(app, /const live = liveGate\(\{ run: \(\) => refresh\(\{ fresh: false \}\)/);
    assert.match(app, /data\.clear\(\); \/\/ back after a break/);
    assert.match(app, /item: ref \? \(\) => data\.read\(`\/api\/p\/\$\{encodeURIComponent\(slug\)\}\/items\//);
  });
});
