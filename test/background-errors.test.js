// One background error doesn't stop the hub (#740): a notifier whose database went away, a workspace file that
// won't open, and a stray rejection are each logged and the hub keeps serving.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { Notifier, addChannel } from '../src/notify.js';
import { Workspaces, WAKE_MS } from '../src/workspaces.js';
import { createServer, keepServing } from '../src/server.js';

// console.error, captured while fn runs; and any rejection nobody handled in that time.
async function watch(fn) {
  const logged = [], stray = [];
  const error = console.error;
  const onStray = (e) => stray.push(e);
  console.error = (...a) => logged.push(a);
  process.on('unhandledRejection', onStray);
  try { await fn(); } finally {
    console.error = error;
    process.off('unhandledRejection', onStray);
  }
  return { logged, stray };
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

describe('one background error does not stop the hub (#740)', () => {
  test('a notifier whose hub db closes before its window fires logs the error, and nothing is left unhandled', async () => {
    let t = Date.UTC(2026, 10, 1, 9);
    const hub = new Hub({ clock: () => t });
    const op = (o, agent, args = {}) => hub.agentOp('app', o, agent, args);
    op('checkin', 'a');
    hub.humanOp('app', 'create', { title: 'Build the thing', acceptance: 'it works' });
    op('next', 'a');
    addChannel(hub.db, 'webhook', 'http://127.0.0.1:9/hook', t);
    const n = new Notifier(hub, { baseUrl: 'http://hub.test', windowMs: 20, debounce: 5, retryDelay: 0 });
    op('ask', 'a', { item: '#1', question: 'Postgres or SQLite?', blocking: true });
    const { logged, stray } = await watch(async () => {
      n.scan();
      assert.ok(n.batch, 'a batch is waiting for its window');
      hub.db.close();
      await settle(80);
    });
    n.stop();
    assert.deepEqual(stray, [], 'the failed flush is caught, not left to end the process');
    assert.ok(logged.some((a) => /notify/.test(String(a[0]))), `logged: ${JSON.stringify(logged.map((a) => String(a[0])))}`);
  });

  test('wake logs and skips a workspace whose file is garbage, and wakes the next one', async () => {
    const spaces = new Workspaces({ dir: realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-bg-'))) });
    try {
      spaces.create('beta');
      writeFileSync(spaces.file('alpha'), 'not a database, just bytes '.repeat(200));
      const { logged } = await watch(() => {
        assert.equal(spaces.wake(WAKE_MS)?.workspace, 'beta', 'the broken one is skipped, the next one woken');
        assert.equal(spaces.wake(WAKE_MS), null, 'the broken one waits its turn like the rest');
      });
      assert.ok(logged.some((a) => /alpha/.test(String(a[0]))), 'the log names the workspace that failed');
    } finally { spaces.close(); }
  });

  test('the sweeper keeps running past a garbage workspace file', async () => {
    let t = Date.UTC(2026, 10, 1, 9);
    const spaces = new Workspaces({ dir: realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-bg-'))), clock: () => t });
    spaces.create('beta');
    spaces.create('gamma');
    writeFileSync(spaces.file('alpha'), 'not a database, just bytes '.repeat(200));
    const woken = new Set(); // a woken workspace closes again on a later sweep, so count the opens
    spaces.onOpen((name) => woken.add(name));
    const server = createServer(spaces, { sweepMs: 10 });
    try {
      const { stray } = await watch(async () => {
        for (let i = 0; i < 4; i++) { t += WAKE_MS; await settle(30); }
      });
      assert.deepEqual(stray, []);
      assert.deepEqual([...woken].sort(), ['beta', 'gamma'], 'the good workspaces were woken');
    } finally { server.close(); spaces.close(); }
  });

  test('serve keeps serving past an unhandled rejection: logged once, with an id', () => {
    const proc = new EventEmitter();
    const logged = [];
    const error = console.error;
    console.error = (...a) => logged.push(a);
    try {
      keepServing(proc);
      keepServing(proc);
      assert.equal(proc.listenerCount('unhandledRejection'), 1, 'installed once');
      proc.emit('unhandledRejection', new Error('boom'), Promise.resolve());
    } finally { console.error = error; }
    assert.equal(logged.length, 1);
    assert.match(String(logged[0][0]), /^error [0-9a-f]{12}: /);
    assert.equal(logged[0][1].message, 'boom');
  });
});
