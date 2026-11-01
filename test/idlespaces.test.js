// Many workspaces cost little (#525): a workspace opens when it's used and closes when idle, a notifier runs only
// where channels exist and holds its workspace open while a push is on the way, and old packages are pruned.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspaces, IDLE_MS, WAKE_MS } from '../src/workspaces.js';
import { notifyWorkspaces, addChannel } from '../src/notify.js';
import { prunePackages } from '../src/package.js';

const MIN = 60_000;
function world() {
  let t = Date.UTC(2026, 10, 1, 9);
  const spaces = new Workspaces({ dir: realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-idle-'))), clock: () => t });
  for (const w of ['acme', 'beta', 'gamma']) spaces.create(w);
  return { spaces, tick: (ms) => { t += ms; }, open: () => spaces.hubs().map((h) => h.workspace).sort() };
}

describe('workspaces open on use and close when idle', () => {
  test('nothing is open until used; a used one closes after the idle period, its hub let go', () => {
    const { spaces, tick, open } = world();
    try {
      assert.deepEqual(open(), []);
      const hub = spaces.get('acme');
      let closed = false;
      hub.once('closed', () => { closed = true; });
      assert.deepEqual(open(), ['acme']);
      tick(IDLE_MS - MIN);
      spaces.get('acme'); // used again: the clock starts over
      tick(IDLE_MS - MIN);
      assert.deepEqual(spaces.closeIdle(IDLE_MS), []);
      tick(2 * MIN);
      assert.deepEqual(spaces.closeIdle(IDLE_MS), ['acme']);
      assert.ok(closed, 'its timers and listeners hear it close');
      assert.deepEqual(open(), []);
      assert.notEqual(spaces.get('acme'), hub, 'opens again, fresh, on the next request');
    } finally { spaces.close(); }
  });

  test('the hub\'s own bookkeeping doesn\'t count as use', () => {
    const { spaces, tick } = world();
    try {
      spaces.overview();
      assert.equal(spaces.hubs().length, 3);
      tick(IDLE_MS);
      assert.deepEqual(spaces.closeIdle(IDLE_MS).sort(), ['acme', 'beta', 'gamma']);
    } finally { spaces.close(); }
  });

  test('a lease in progress, or anything that holds it, keeps it open', () => {
    const { spaces, tick } = world();
    try {
      const hub = spaces.get('acme');
      hub.tx(() => hub.project('p', { create: true }));
      hub.humanOp('p', 'create', { title: 'Build', acceptance: 'x' });
      hub.agentOp('p', 'checkin', 'a');
      hub.agentOp('p', 'claim', 'a', { item: '#1' });
      tick(IDLE_MS);
      assert.deepEqual(spaces.closeIdle(IDLE_MS), [], 'the lease must be seen to lapse');
      hub.agentOp('p', 'handoff', 'a', { item: '#1', headline: 'later' });
      let streaming = true;
      spaces.holdOpen((h) => h === hub && streaming);
      assert.deepEqual(spaces.closeIdle(IDLE_MS), [], 'a browser is streaming it');
      streaming = false;
      assert.deepEqual(spaces.closeIdle(IDLE_MS), ['acme']);
    } finally { spaces.close(); }
  });

  test('closed workspaces are woken one at a time for their sweep, the longest-waiting first', () => {
    const { spaces, tick, open } = world();
    try {
      spaces.get('beta');
      tick(WAKE_MS);
      const first = spaces.wake(WAKE_MS);
      assert.equal(first.workspace, 'acme');
      assert.equal(spaces.wake(WAKE_MS).workspace, 'gamma');
      assert.equal(spaces.wake(WAKE_MS), null, 'beta is open; the others were just woken');
      assert.deepEqual(open(), ['acme', 'beta', 'gamma']);
      tick(IDLE_MS);
      spaces.closeIdle(IDLE_MS);
      assert.deepEqual(open(), [], 'woken, not used: they close again');
    } finally { spaces.close(); }
  });
});

describe('push notifiers only where channels exist', () => {
  test('a channel still delivers: the push goes out, and holds its workspace open until it has', async () => {
    const { spaces, tick, open } = world();
    const sent = [];
    const fetch = async (url, init) => { sent.push({ url, body: String(init?.body ?? '') }); return new Response('', { status: 200 }); };
    const acme = spaces.get('acme');
    addChannel(acme.db, 'ntfy', 'https://ntfy.sh/acme-x');
    acme.tx(() => acme.project('p', { create: true }));
    spaces.close();
    const pushes = notifyWorkspaces(spaces, (n) => `https://hub.example/w/${n}`, { every: 60_000, windowMs: 20, debounce: 1, interval: 60_000, guard: false, fetch });
    try {
      assert.deepEqual(open(), [], 'starting opens nothing');
      // Something needs a person while nobody has the workspace open: an agent asks, blocking.
      const hub = spaces.get('acme');
      hub.agentOp('p', 'checkin', 'a');
      hub.agentOp('p', 'ask', 'a', { question: 'Which database?', blocking: true, to: 'human' });
      assert.ok(pushes.notifiers.has('acme') && !pushes.notifiers.has('beta'));
      tick(IDLE_MS);
      await new Promise((r) => setTimeout(r, 5));
      assert.deepEqual(spaces.closeIdle(IDLE_MS).includes('acme'), false, 'the push on its way holds it open');
      for (let i = 0; i < 100 && !sent.length; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(sent.length, 1);
      assert.match(sent[0].body, /Which database/);
      for (let i = 0; i < 50 && spaces.closeIdle(IDLE_MS).length === 0 && open().includes('acme'); i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(!open().includes('acme'), 'sent: it closes');
      assert.ok(!pushes.notifiers.has('acme'), 'and its notifier with it');
    } finally { pushes.stop(); spaces.close(); }
  });
});

describe('old packages are pruned', () => {
  test('keeps the running commit, the newest signed releases and anything recent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuworq-pkgs-'));
    const now = Date.UTC(2026, 10, 1);
    const pkg = (n, ageDays, signed) => {
      const name = `nuworq-${String(n).repeat(40).slice(0, 40)}.tgz`;
      const file = join(dir, name);
      writeFileSync(file, 'x');
      if (signed) writeFileSync(`${file}.sig`, 's');
      const at = (now - ageDays * 86_400_000) / 1000;
      utimesSync(file, at, at);
      return name;
    };
    const current = pkg(1, 30, false);
    const rel = [pkg(2, 20, true), pkg(3, 15, true), pkg(4, 10, true), pkg(5, 5, true)];
    const oldBuild = pkg(6, 3, false);
    const fresh = pkg(7, 0, false);
    const removed = prunePackages(dir, '1'.repeat(40), { now });
    assert.deepEqual(removed.sort(), [rel[0], oldBuild].sort());
    const left = readdirSync(dir);
    for (const n of [current, rel[1], rel[2], rel[3], fresh]) assert.ok(left.includes(n), n);
    assert.ok(!left.includes(`${rel[0]}.sig`), 'its signature goes with it');
  });
});
