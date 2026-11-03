import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { run } from '../src/runner.js';
import { createServer } from '../src/server.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));

function hubWith(...titles) {
  const hub = new Hub();
  hub.tx(() => hub.project('p', { create: true }));
  const items = titles.map((title) => hub.agentOp('p', 'propose', 'w0', { title, acceptance: 'works' }).item);
  const p = () => hub.project('p');
  return {
    hub, items,
    item: (seq) => hub.item(p(), seq),
    listed: (name) => hub.q('SELECT 1 FROM agents WHERE project_id = ? AND name = ? AND signed_off = 0').get(p().id, name) !== undefined,
    signoffs: (name) => hub.q(`SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND actor = ? AND type = 'signoff'`).get(p().id, name).n,
  };
}

// A session that ends signs itself off (#558): what it held goes back at once, and the hub stops listing it.
describe('an ended session signs off once', () => {
  test("the runner signs off a worker that exited without doing so: its item goes back, and it isn't listed", async () => {
    const { hub, items: [a], item, listed } = hubWith('A');
    let interrupt, polls = 0;
    const signedOff = [];
    await run({
      routes: async () => (++polls === 1 ? [{ project: 'p', name: 'p', item: a, title: 'A', mode: 'work', claimable: 1 }] : []),
      launch: async () => {
        hub.agentOp('p', 'checkin', 'w-a', {});
        hub.agentOp('p', 'claim', 'w-a', { item: a });
        return { name: 'w-a', project: 'p', kill: () => {}, exited: Promise.resolve(1) }; // it crashed, holding #1
      },
      signoff: async (w) => { signedOff.push(w.name); hub.agentOp(w.project, 'signoff', w.name, { headline: 'Worker exited' }); },
      claimed: async () => true, log: () => {}, report: async () => {},
      onInterrupt: (fn) => { interrupt = fn; },
      sleep: async () => { if (polls >= 2) interrupt(); await new Promise((r) => setImmediate(r)); },
      pollSeconds: 1,
    });
    assert.deepEqual(signedOff, ['w-a']);
    assert.equal(item(a).holder, null, 'its item is back in the queue, not waiting out the lease');
    assert.equal(item(a).stage, 'ready');
    assert.ok(!listed('w-a'));
  });

  test("a sign-off that fails doesn't stop the runner", async () => {
    let interrupt, polls = 0;
    const out = await run({
      routes: async () => (++polls === 1 ? [{ project: 'p', name: 'p', item: '#1', title: 'A', mode: 'work', claimable: 1 }] : []),
      launch: async () => ({ name: 'w-b', project: 'p', kill: () => {}, exited: Promise.resolve(0) }),
      signoff: async () => { throw new Error('hub down'); },
      claimed: async () => true, log: () => {}, report: async () => {},
      onInterrupt: (fn) => { interrupt = fn; },
      sleep: async () => { if (polls >= 2) interrupt(); await new Promise((r) => setImmediate(r)); },
      pollSeconds: 1,
    });
    assert.deepEqual(out.done.map((d) => d.name), ['w-b']);
  });

  test("a real hub: an MCP session that closes leaves the hub's list within seconds, handing its item back", async () => {
    const { hub, items: [a], item, listed } = hubWith('A');
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NUWORQ_/.test(k))), NUWORQ_URL: `http://127.0.0.1:${server.address().port}`, NUWORQ_PROJECT: 'p' };
    const child = spawn(process.execPath, [BIN, 'mcp'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const answers = [];
    let buf = '';
    child.stdout.on('data', (c) => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { answers.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); } });
    let id = 0;
    const ask = async (method, params) => {
      const n = ++id;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
      for (;;) { const m = answers.find((x) => x.id === n); if (m) return m.result; await new Promise((r) => setTimeout(r, 20)); }
    };
    try {
      await ask('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });
      const me = JSON.parse((await ask('tools/call', { name: 'checkin', arguments: {} })).content[0].text).you;
      await ask('tools/call', { name: 'claim', arguments: { item: a } });
      assert.ok(listed(me) && item(a).holder === me);
      const t = Date.now();
      child.stdin.end(); // the client closed the session
      await new Promise((r) => child.on('exit', r));
      assert.ok(Date.now() - t < 2500, `${Date.now() - t}ms`);
      assert.ok(!listed(me), 'off the list at once');
      assert.equal(item(a).holder, null, 'its item handed back');
      assert.equal(hub.q(`SELECT headline FROM events WHERE type = 'signoff' AND actor = ?`).get(me).headline, `${me} signed off: Session ended`);
    } finally { child.kill(); server.close(); server.closeAllConnections(); }
  });

  test('the hub puts a second sign-off on the record only when there is something to hand back', () => {
    const { hub, items: [a], item, listed, signoffs } = hubWith('A');
    hub.agentOp('p', 'checkin', 'w-c', {});
    hub.agentOp('p', 'claim', 'w-c', { item: a });
    // The worker signed off itself, then its session ended, then the runner saw it exit.
    assert.deepEqual(hub.agentOp('p', 'signoff', 'w-c', { headline: 'Done' }).handed_off, [`#${item(a).seq}`]);
    assert.deepEqual(hub.agentOp('p', 'signoff', 'w-c', { headline: 'Session ended' }), { ok: true, handed_off: [] });
    hub.agentOp('p', 'signoff', 'w-c', { headline: 'Worker exited' });
    assert.equal(signoffs('w-c'), 1, 'once on the record');
    assert.ok(!listed('w-c'), 'still not listed: the repeat touched nothing');
    // A worker that never checked in here: nothing to sign off, and no agent made for it.
    hub.agentOp('p', 'signoff', 'w-never', { headline: 'Worker exited' });
    assert.equal(signoffs('w-never'), 0);
    assert.equal(hub.q('SELECT COUNT(*) AS n FROM agents WHERE name = ?').get('w-never').n, 0);
    // Back again: a checkin puts it on the list, and its next sign-off counts.
    hub.agentOp('p', 'checkin', 'w-c', {});
    assert.ok(listed('w-c'));
    hub.agentOp('p', 'signoff', 'w-c', { headline: 'Session ended' });
    assert.equal(signoffs('w-c'), 2);
  });
});
