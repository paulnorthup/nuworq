import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bootData } from '../web/boot.js';

// #599: the app's first requests start together, and each URL is asked for once.

// An api() whose answers wait until release(): what boot asks for before any answer comes is what it didn't wait for.
function stub(answers) {
  const calls = [], waiting = [];
  const api = (url) => {
    calls.push(url);
    return new Promise((resolve, reject) => waiting.push(() => (url in answers ? resolve(answers[url]) : reject(new Error(`404 ${url}`)))));
  };
  const release = async () => { while (waiting.length) { waiting.shift()(); await new Promise((r) => setImmediate(r)); } };
  return { api, calls, release };
}

describe("the app's boot asks for everything at once (#599)", () => {
  test('on a project: who, version, feedback, the list and the view start before any answer; each once', async () => {
    const { api, calls, release } = stub({ '/api/me': { org: null }, '/api/people/me': null, '/api/info': { commit: 'abc' }, '/api/feedback': { on: false }, '/api/projects': [{ slug: 'acme' }], '/api/p/acme/view?depth=30s': { project: {} } });
    const done = bootData(api, { view: () => api('/api/p/acme/view?depth=30s') });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual([...calls].sort(), ['/api/feedback', '/api/info', '/api/me', '/api/p/acme/view?depth=30s', '/api/people/me', '/api/projects'],
      'every request is out before the first answer');
    await release();
    const b = await done;
    assert.deepEqual(b.projects, [{ slug: 'acme' }]);
    assert.equal(b.info.commit, 'abc');
    assert.equal(b.billing, undefined, 'not a workspace hub: no billing asked for');
    assert.equal(new Set(calls).size, calls.length, 'no URL twice');
    assert.ok(!calls.includes('/api/get-started'), 'not on the home: no Get started');
  });

  test("on the home: Get started too; on a workspace hub, billing follows who you are, and only that", async () => {
    const { api, calls, release } = stub({ '/api/me': { org: 'acme' }, '/api/billing': { plan: 'free' }, '/api/get-started': { show: true }, '/api/projects': [] });
    const done = bootData(api, { home: true });
    await new Promise((r) => setImmediate(r));
    assert.ok(calls.includes('/api/get-started'));
    assert.ok(!calls.includes('/api/billing'), 'billing waits for /api/me');
    await release();
    const b = await done;
    assert.deepEqual(calls.filter((c) => c === '/api/billing'), ['/api/billing']);
    assert.deepEqual(b.billing, { plan: 'free' });
    assert.deepEqual(b.gs, { show: true });
    // What failed is null, as the app had it: the page still comes up.
    assert.equal(b.person, null);
    assert.equal(b.feedback, null);
    assert.equal(new Set(calls).size, calls.length);
  });
});
