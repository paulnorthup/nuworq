import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, LEASE_MS, MIN } from '../src/core.js';
import { createServer } from '../src/server.js';
import { run } from '../src/runner.js';
import { tools, guide } from '../src/protocol.js';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
function hubWith(...titles) {
  let t = Date.UTC(2026, 10, 1, 9);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('p', { create: true }));
  const items = titles.map((title) => hub.agentOp('p', 'propose', 'w1', { title, acceptance: 'works' }).item);
  return { hub, items, later: (ms) => { t += ms; }, holder: (item) => hub.item(hub.project('p'), item).holder };
}

// Leases renew without the model (#540).
describe('leases renew without spending a model turn', () => {
  test("the runner's report renews its live workers' leases, not a lapsed one and not another's", async () => {
    const { hub, items: [a, b], later, holder } = hubWith('A', 'B');
    hub.agentOp('p', 'claim', 'w1', { item: a });
    hub.agentOp('p', 'claim', 'w2', { item: b });
    const server = createServer(hub, { sweepMs: 60_000 });
    const url = `http://127.0.0.1:${await listen(server)}`;
    const runner = server.auth.localRunnerToken('mac');
    const report = async (live) => (await (await fetch(`${url}/api/runner`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${runner.token}` }, body: JSON.stringify({ name: 'mac', running: live.length, workers: 2, live }) })).json());
    try {
      // A 30-minute test run: the runner reports every few minutes; w1 makes no call at all.
      for (let m = 0; m < 30; m += 5) {
        later(5 * MIN);
        if (m < 15) assert.equal((await report(['w1', 'w2'])).renewed, 2);
        else assert.equal((await report(['w1'])).renewed, 1, 'w2 exited: only w1 is vouched for');
        hub.sweep();
      }
      // w2 was last vouched for at minute 15, so its lease ends at 35; ten minutes on, it has.
      later(10 * MIN);
      await report(['w1']);
      hub.sweep();
      assert.equal(holder(a), 'w1', 'kept through 40 minutes');
      assert.equal(holder(b), null, "w2's lease lapsed once the runner stopped naming it");
      assert.equal((await report(['w2'])).renewed, 0, 'a lapsed lease is never revived');
      later(LEASE_MS + MIN);
      hub.sweep();
      assert.equal(holder(a), null, 'with no report and no call, it lapses as before');
    } finally { server.close(); server.closeAllConnections(); }
  });

  test('a session that keeps making calls keeps its lease; one that goes quiet loses it', () => {
    const { hub, items: [a], later, holder } = hubWith('A');
    hub.agentOp('p', 'claim', 'w1', { item: a });
    for (let m = 0; m < 40; m += 10) {
      later(10 * MIN);
      hub.agentOp('p', 'look', 'w1', {});
      hub.sweep();
    }
    assert.equal(holder(a), 'w1', 'calls every 10 minutes for 40 minutes, no progress');
    hub.agentOp('p', 'look', 'other', {});
    later(LEASE_MS + MIN);
    hub.sweep();
    assert.equal(holder(a), null, "another agent's calls renew nothing of w1's");
  });

  test('a token renews only the names it holds', () => {
    const { hub, items: [a] } = hubWith('A');
    hub.agentOp('p', 'claim', 'w1', { item: a });
    const p = hub.project('p');
    hub.q('UPDATE agents SET token_id = 7 WHERE project_id = ? AND name = ?').run(p.id, 'w1');
    assert.equal(hub.renewWorkers(['w1'], { identity: { id: 8 } }), 0, 'another token');
    assert.equal(hub.renewWorkers(['w1'], { identity: { id: 7, session: true } }), 0, 'a browser session');
    assert.equal(hub.renewWorkers(['w1'], { identity: { id: 7 }, scope: ['other'] }), 0, 'out of scope');
    assert.equal(hub.renewWorkers(['w1'], { identity: { id: 7 } }), 1);
  });

  test('the run loop names its live workers in every report', async () => {
    const reports = [];
    let polls = 0, interrupt, t = 0;
    await run({
      routes: async () => { polls++; return polls === 1 ? [{ project: 'p', name: 'p', item: '#1', title: 't', mode: 'work', claimable: 1 }] : []; },
      launch: async () => {
        let finish;
        const w = { name: 'w-a', project: 'p', exited: new Promise((r) => { finish = r; }) };
        w.kill = () => finish(0); // stopping it ends it, as a real worker does
        return w;
      },
      claimed: async () => true,
      report: (s) => { reports.push(s); }, log: () => {}, now: () => t,
      onInterrupt: (fn) => { interrupt = fn; },
      sleep: async (ms) => { t += ms; if (polls >= 2) interrupt(); await new Promise((r) => setImmediate(r)); },
      pollSeconds: 1,
    });
    assert.deepEqual(reports.find((r) => r.running === 1)?.live, ['w-a']);
  });

  test('the heartbeat rule has left the guide and the progress tool', () => {
    const progress = tools().find((t) => t.name === 'progress');
    assert.doesNotMatch(progress.description + JSON.stringify(progress.inputSchema), /heartbeat|every ~15 minutes/);
    assert.doesNotMatch(guide(), /heartbeat/);
    assert.match(guide(), /lease renews by itself/);
  });
});
