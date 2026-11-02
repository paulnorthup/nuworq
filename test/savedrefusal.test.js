import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hub, LEASE_MS } from '../src/core.js';

// A refusal that says "saved" keeps what it saved (#733).
describe('a refusal that says it saved something saved it', () => {
  test('progress after the lease ran out refuses, and its note stays on the record as a comment', () => {
    let t = Date.UTC(2026, 10, 1, 9);
    const hub = new Hub({ clock: () => t });
    hub.tx(() => hub.project('p', { create: true }));
    const { item } = hub.agentOp('p', 'propose', 'bob', { title: 'A', acceptance: 'works' });
    hub.agentOp('p', 'claim', 'alice', { item });
    t += LEASE_MS + 60_000;
    assert.throws(
      () => hub.agentOp('p', 'progress', 'alice', { item, headline: 'Last report: tests pass' }),
      (e) => e.status === 409 && /no longer hold/.test(e.message) && /saved as a comment/.test(e.message),
    );
    const p = hub.project('p');
    const row = hub.q("SELECT type, headline, actor FROM events WHERE item_id = ? AND type = 'comment'").get(hub.item(p, item).id);
    assert.deepEqual({ ...row }, { type: 'comment', headline: 'Last report: tests pass', actor: 'alice' });
  });

  test('every error that says something was saved as a comment is marked to keep it', () => {
    const src = readFileSync(new URL('../src/core.js', import.meta.url), 'utf8');
    const said = [...src.matchAll(/UserError\(`[^`]*saved as a comment[^`]*`, \{[^}]*\}/g)];
    assert.ok(said.length >= 1);
    for (const m of said) assert.match(m[0], /keep: true/);
  });
});
