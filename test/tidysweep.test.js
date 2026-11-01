import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

// Drift detection runs on the sweep timer, not on every claim (#536).
function drifted() {
  const hub = new Hub();
  hub.tx(() => hub.project('p', { create: true, name: 'App' }));
  hub.humanOp('p', 'create', { title: 'Workers', acceptance: 'x' });
  hub.humanOp('p', 'create', { title: 'Start workers', acceptance: 'x', parent: '#1' });
  hub.humanOp('p', 'create', { title: 'Loose end', acceptance: 'x' }); // #3, in no milestone: drift
  const tidies = () => hub.q("SELECT * FROM items WHERE tidy != '' AND stage NOT IN ('done', 'dropped')").all();
  return { hub, tidies };
}

describe('drift becomes a tidy job on the sweep, not on next', () => {
  test("next runs no drift scan: it neither opens a tidy job nor queries for one", () => {
    const { hub, tidies } = drifted();
    const sql = [];
    const q = hub.q.bind(hub);
    hub.q = (s) => { sql.push(s); return q(s); };
    const r = hub.agentOp('p', 'next', 'w1');
    hub.q = q;
    assert.equal(r.mode, 'work');
    assert.equal(tidies().length, 0);
    // tidyUp's own reads: what finished tidy jobs listed, and pull requests no item tracks.
    assert.deepEqual(sql.filter((s) => /untracked_prs|notes_review = 0 AND stage = 'done'/.test(s)), []);
  });

  test('tidyAll opens it, and the next claim gets it first', () => {
    const { hub, tidies } = drifted();
    hub.tidyAll();
    assert.equal(tidies().length, 1);
    assert.equal(hub.agentOp('p', 'next', 'w1').mode, 'tidy');
  });

  test('a hub opens it at start, and within one sweep for drift that comes later', async () => {
    const { hub, tidies } = drifted();
    const server = createServer(hub, { sweepMs: 50 });
    try {
      assert.equal(tidies().length, 1, 'at start');
      hub.agentOp('p', 'claim', 'w1', { item: `#${tidies()[0].seq}` });
      hub.agentOp('p', 'submit', 'w1', { item: `#${tidies()[0].seq}`, headline: 'Left it alone on purpose' });
      assert.equal(tidies().length, 0, 'a tidy job is done once submitted');
      hub.humanOp('p', 'create', { title: 'Another loose end', acceptance: 'x' });
      for (let i = 0; i < 100 && !tidies().length; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(tidies().length, 1, 'within a sweep');
      assert.match(tidies()[0].summary, /Another loose end/);
    } finally { server.close(); }
  });
});
