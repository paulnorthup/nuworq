import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { createClient } from '../src/client.js';
import { run } from '../src/runner.js';

// #542: a runner with nothing to start waits on /api/route?wait=, and the hub answers the moment work appears,
// so a worker starts about a second after it does instead of up to --poll seconds later.
async function hubAt() {
  const hub = new Hub();
  for (const p of ['p', 'q']) {
    hub.tx(() => hub.project(p, { create: true }));
    hub.humanOp(p, 'settings', { runner: true, autonomy: 'full' });
  }
  const server = createServer(hub);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = createClient({ url, token: '', cwd: tmpdir() });
  const close = () => { server.closeAllConnections?.(); server.close(); };
  return { hub, url, client, close };
}
const route = (url, q) => fetch(`${url}/api/route?runner=1&${q}`).then((r) => r.json());
const later = (ms, fn) => setTimeout(fn, ms);

describe('GET /api/route?wait= holds the answer until work appears', () => {
  test('work created while it waits answers it within a second', async () => {
    const h = await hubAt();
    try {
      const t0 = Date.now();
      later(300, () => h.hub.humanOp('p', 'create', { title: 'New work', acceptance: 'x' }));
      const list = await route(h.url, 'wait=20');
      const ms = Date.now() - t0;
      assert.deepEqual(list.map((r) => [r.project, r.item]), [['p', '#1']]);
      assert.ok(ms >= 300 && ms < 1300, `answered ${ms} ms after asking, about 300 ms after the work appeared`);
    } finally { h.close(); }
  });

  test('work there already, or no wait asked: it answers at once', async () => {
    const h = await hubAt();
    try {
      assert.deepEqual(await route(h.url, ''), [], 'no wait: the empty answer at once, as before');
      h.hub.humanOp('p', 'create', { title: 'Waiting', acceptance: 'x' });
      const t0 = Date.now();
      assert.equal((await route(h.url, 'wait=20')).length, 1);
      assert.ok(Date.now() - t0 < 500);
    } finally { h.close(); }
  });

  test('work only in a skipped project doesn\'t answer it; the wait ends with the whole list', async () => {
    const h = await hubAt();
    try {
      h.hub.humanOp('q', 'create', { title: 'Elsewhere', acceptance: 'x' });
      const t0 = Date.now();
      const list = await route(h.url, 'wait=1&skip=q');
      assert.ok(Date.now() - t0 >= 950, 'held for the whole second');
      assert.deepEqual(list.map((r) => r.project), ['q'], 'the answer is still the full list');
    } finally { h.close(); }
  });
});

describe('nuworq run waits for work on the hub', () => {
  // A runner on a real hub through the real client, as runCmd wires it; launch records when it was asked.
  // cant: a project this machine has no checkout of (launch says skip, as runCmd's does).
  const PATH = '/api/route?runner=1&has=&agent=claude';
  function runner(h, { waitRoutes, cant } = {}) {
    const launched = [];
    const lines = [];
    let stopNow;
    const done = run({
      routes: () => h.client.get(PATH),
      waitRoutes: waitRoutes ?? (({ skip, seconds, signal }) => h.client.get(`${PATH}&wait=${seconds}&skip=${skip.join(',')}`, { signal, deadline: (seconds + 15) * 1000 })),
      launch: async (r) => {
        if (r.project === cant) throw Object.assign(new Error(`no checkout of ${cant} here`), { skip: true });
        launched.push({ item: r.item, at: Date.now() });
        stopNow();
        return { name: 'w1', project: r.project, kill() {}, exited: new Promise((res) => later(20, () => res(0))) };
      },
      log: (l) => lines.push(l), pollSeconds: 30, workers: 1,
      onInterrupt: (fn) => { stopNow = fn; },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref()), // a poll sleep left behind holds no test open
    });
    return { done, launched, lines, stop: () => stopNow() };
  }

  test('work created while it waits starts a worker within about a second, not at the next 30 s poll', async () => {
    const h = await hubAt();
    try {
      const r = runner(h);
      await new Promise((res) => later(400, res)); // idle, its wait open on the hub
      const t0 = Date.now();
      h.hub.humanOp('p', 'create', { title: 'New work', acceptance: 'x' });
      await r.done;
      assert.equal(r.launched.length, 1);
      assert.equal(r.launched[0].item, '#1');
      assert.ok(r.launched[0].at - t0 < 1500, `started ${r.launched[0].at - t0} ms after the work appeared`);
      assert.ok(r.lines.some((l) => /Nothing is waiting in opted-in projects; starting a worker as soon as some is/.test(l)), r.lines.join('\n'));
    } finally { h.close(); }
  });

  test('a worker exiting ends the wait at once, so a stop isn\'t held up by it', async () => {
    const h = await hubAt();
    try {
      const r = runner(h);
      await new Promise((res) => later(300, res));
      const t0 = Date.now();
      r.stop();
      await r.done;
      assert.ok(Date.now() - t0 < 1000, 'stopped without waiting out the hub');
    } finally { h.close(); }
  });

  test('an older hub that answers at once: it sleeps --poll between looks, as before', async () => {
    let waits = 0, routes = 0;
    const lines = [];
    const sleeps = [];
    let stopNow;
    await run({
      routes: async () => { routes++; return []; },
      waitRoutes: async () => { waits++; return []; }, // ignores wait: empty, at once
      launch: async () => assert.fail('nothing to launch'),
      log: (l) => lines.push(l), pollSeconds: 30, workers: 1,
      onInterrupt: (fn) => { stopNow = fn; },
      sleep: async (ms) => { sleeps.push(ms); if (sleeps.length >= 3) stopNow(); },
    });
    assert.equal(waits, 1, 'asked to wait once, then fell back');
    assert.ok(routes >= 3, 'then polled');
    assert.ok(sleeps.every((ms) => ms > 29_000 && ms <= 30_000), `slept out each poll: ${sleeps}`);
  });

  test('with work only where it can\'t work, it waits with that project skipped, and starts when work appears elsewhere', async () => {
    const h = await hubAt();
    try {
      h.hub.humanOp('q', 'create', { title: 'Not here', acceptance: 'x' });
      const asked = [];
      const r = runner(h, {
        waitRoutes: ({ skip, seconds, signal }) => { asked.push(skip); return h.client.get(`${PATH}&wait=${seconds}&skip=${skip.join(',')}`, { signal }); },
        cant: 'q',
      });
      await new Promise((res) => later(400, res));
      assert.deepEqual(asked, [['q']], 'one wait, q skipped: its work doesn\'t answer it');
      const t0 = Date.now();
      h.hub.humanOp('p', 'create', { title: 'Here', acceptance: 'x' });
      await r.done;
      assert.equal(r.launched[0].item, '#1');
      assert.ok(r.launched[0].at - t0 < 1500, `started ${r.launched[0].at - t0} ms after the work appeared`);
    } finally { h.close(); }
  });
});
