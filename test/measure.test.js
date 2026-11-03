import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { fromFile } from '../scripts/measure.js';

// #514: the review's timings and sizes, taken from a copy of a workspace's file, never a word of it.
describe('scripts/measure.js', () => {
  test("times the view, checkin and next, sizes a repeat checkin, and leaves the hub's file as it was", () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nuworq-measure-')), 'ws.db');
    const hub = new Hub({ file });
    hub.tx(() => hub.project('p', { create: true }));
    hub.humanOp('p', 'decide', { body: 'SECRET-DECISION about ZZQ' });
    for (let k = 0; k < 5; k++) hub.humanOp('p', 'create', { title: `SECRET-TITLE-${k}`, acceptance: 'x' });
    hub.agentOp('p', 'checkin', 'secret-agent-1', {});
    hub.agentOp('p', 'learn', 'secret-agent-1', { note: 'SECRET-NOTE: run the ZZQ check first' });
    hub.db.close();
    const before = readFileSync(file);

    const r = fromFile(file, 'p', { runs: 3 });
    assert.deepEqual(r.project, { items: 5, agents: 1, events: r.project.events });
    for (const k of ['median', 'p95', 'max']) {
      assert.ok(r.view_ms.cold[k] >= 0 && r.view_ms.cached[k] >= 0 && r.checkin_ms.first[k] >= 0 && r.next_ms.peek[k] >= 0);
    }
    assert.ok(r.view_ms.statements > 0 && r.checkin_ms.statements > 0 && r.next_ms.statements > 0);
    assert.ok(r.view_chars['30s'] < r.view_chars['30m']);
    assert.ok(r.checkin_chars.repeat.max < r.checkin_chars.first.median, 'a repeat checkin leaves out what the session was sent');
    assert.equal(r.next_ms.claimed_a_job, true);
    assert.doesNotMatch(JSON.stringify(r), /SECRET|secret-agent|ZZQ/, 'timings and sizes only');
    assert.ok(readFileSync(file).equals(before), "the hub's own file is never written");
  });
});
