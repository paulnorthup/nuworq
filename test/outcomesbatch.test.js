import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, HUMAN, HOUR, isHuman, isSystem } from '../src/core.js';
import { seed } from '../src/seed.js';
import { outcomes, jobsTaken, heldUp, humanActionsOn } from '../src/outcomes.js';

// The per-item reads outcomes made before #537, kept here as the reference the batched ones must equal.
const old = {
  heldUp(hub, it) {
    const fixed_by = hub.q('SELECT seq FROM items WHERE fixes = ? ORDER BY seq').all(it.id).map((r) => `#${r.seq}`);
    const accepts = hub.q(`SELECT actor, at FROM events WHERE item_id = ? AND type = 'accepted' ORDER BY at, id`).all(it.id);
    const peer = (a) => !isHuman(a) && !isSystem(a);
    const last = accepts.at(-1) ?? null;
    const firstPeer = accepts.find((a) => peer(a.actor));
    const sentBack = !!firstPeer && !!hub.q(`SELECT 1 FROM events WHERE item_id = ? AND type = 'sent_back' AND at >= ? AND (actor = ? OR actor LIKE '@%')`).get(it.id, firstPeer.at, HUMAN);
    const peerReviewed = !!last && peer(last.actor);
    return { escaped: fixed_by.length > 0, fixed_by, reviewer: last?.actor ?? null, peer_review: peerReviewed, overturned: sentBack || (peerReviewed && fixed_by.length > 0), peer_accepted: !!firstPeer };
  },
  // What each job's result was, from each take's own later events.
  results(hub, p, from) {
    const FINISHED = { work: ['submitted'], review: ['accepted', 'sent_back'], shape: ['shaped'], land: ['landed', 'pushed', 'rebased', 'submitted'], tidy: ['tidied'] };
    const takes = hub.q(`SELECT e.*, i.stage AS item_stage FROM events e JOIN items i ON i.id = e.item_id
      WHERE e.project_id = ? AND e.type IN ('claimed', 'shaping', 'review_started', 'landing') AND e.at >= ? ORDER BY e.at, e.id`).all(p.id, from);
    return takes.map((e) => {
      const d = JSON.parse(e.data || '{}');
      const job = d.job ?? { shaping: 'shape', review_started: 'review', landing: 'land' }[e.type] ?? 'work';
      const after = hub.q('SELECT type, actor, data FROM events WHERE item_id = ? AND id > ? ORDER BY id').all(e.item_id, e.id);
      const lapsed = (x) => x.type === 'lease_expired' && (JSON.parse(x.data || '{}').agent ?? (job === 'review' ? e.actor : null)) === e.actor;
      const end = after.findIndex((x) => (x.actor === e.actor && (FINISHED[job].includes(x.type) || x.type === 'handoff')) || lapsed(x));
      if (end < 0) return 'open';
      const x = after[end];
      if (x.type === 'handoff' || x.type === 'lease_expired') return 'stalled';
      if (job !== 'work') return 'done';
      const verdict = after.slice(end + 1).find((v) => v.type === 'accepted' || v.type === 'sent_back');
      const kept = verdict && JSON.parse(verdict.data || '{}').kept;
      if (verdict?.type === 'sent_back') return 'sent_back';
      if (verdict && kept && kept !== e.actor) return 'not_chosen';
      if (verdict && e.item_stage === 'done') return hub.q('SELECT 1 FROM items WHERE fixes = ?').get(e.item_id) ? 'escaped' : 'landed';
      return 'open';
    });
  },
};

// A seeded hub, plus a project with escapes, an overturned peer accept, a send-back and a dropped item.
async function hubWithHistory() {
  let t = Date.UTC(2026, 9, 30, 9);
  const hub = new Hub({ clock: () => t });
  await seed(hub);
  hub.tx(() => hub.project('p', { create: true }));
  hub.humanOp('p', 'settings', { autonomy: 'full' });
  hub.agentOp('p', 'checkin', 'b1', { model: 'opus' });
  hub.agentOp('p', 'checkin', 'r1', { model: 'qwen' });
  const build = (title, verdict = 'accept') => {
    const { item } = hub.agentOp('p', 'propose', 'b1', { title, acceptance: 'works' });
    hub.agentOp('p', 'claim', 'b1', { item });
    t += 60_000;
    hub.agentOp('p', 'submit', 'b1', { item, headline: 'Built' });
    hub.agentOp('p', 'review', 'r1', { item, verdict, headline: 'Checked' });
    return item;
  };
  build('One'); build('Two');
  const back = build('Three', 'reject');
  hub.agentOp('p', 'claim', 'b1', { item: back });
  hub.agentOp('p', 'submit', 'b1', { item: back, headline: 'Again' });
  hub.agentOp('p', 'review', 'r1', { item: back, verdict: 'accept', headline: 'Now' });
  const four = build('Four');
  hub.humanOp('p', 'update', { item: four, stage: 'ready' });
  hub.agentOp('p', 'claim', 'b1', { item: four });
  hub.agentOp('p', 'submit', 'b1', { item: four, headline: 'Built' });
  hub.humanOp('p', 'settings', { autonomy: 'balanced' });
  hub.humanOp('p', 'sendback', { item: four, note: 'Not what I meant' });
  hub.agentOp('p', 'claim', 'b1', { item: four });
  hub.agentOp('p', 'submit', 'b1', { item: four, headline: 'Built right' });
  hub.humanOp('p', 'accept', { item: four });
  hub.agentOp('p', 'propose', 'r1', { title: 'One crashes', acceptance: 'no crash', fixes: '#1' });
  const { item: gone } = hub.agentOp('p', 'propose', 'b1', { title: 'Dropped', acceptance: 'x' });
  hub.humanOp('p', 'update', { item: gone, stage: 'dropped' });
  t += HOUR;
  return { hub, at: (ms) => { t = ms; }, now: () => t };
}

describe('outcomes read finished items in a few queries, with the same results (#537)', () => {
  test('every item, job and tally is what the per-item reads gave', async () => {
    const { hub } = await hubWithHistory();
    for (const p of hub.projects()) {
      const o = outcomes(hub, p.slug);
      assert.ok(o.items.length, `${p.slug} has finished items`);
      for (const it of o.items) {
        const row = hub.item(p, it.item);
        const claimed = hub.q(`SELECT MIN(at) AS at FROM events WHERE item_id = ? AND type = 'claimed'`).get(row.id).at;
        assert.equal(it.cycle_ms, claimed != null ? row.stage_since - claimed : null, it.item);
        assert.equal(it.human_actions, humanActionsOn(hub, row), it.item);
        if (row.stage === 'done') {
          const h = old.heldUp(hub, row);
          assert.deepEqual([it.escaped, it.fixed_by, it.reviewer, it.overturned], [h.escaped, h.fixed_by, h.reviewer, h.overturned], it.item);
          assert.deepEqual(heldUp(hub, row), h, 'heldUp itself is unchanged');
        }
      }
      assert.deepEqual(o.jobs.map((j) => j.result), old.results(hub, p, o.since), p.slug);
    }
    const o = outcomes(hub, 'p');
    assert.deepEqual(o.items.map((i) => [i.item, i.outcome, i.escaped, i.overturned]),
      [['#1', 'landed', true, true], ['#2', 'landed', false, false], ['#3', 'landed', false, false], ['#4', 'landed', false, true], ['#6', 'dropped', false, false]]);
    assert.ok(o.jobs.some((j) => j.result === 'escaped') && o.jobs.some((j) => j.result === 'sent_back'));
    assert.deepEqual(o.by_reviewer, [{ model: 'qwen', reviewed: 3, escapes: 1, overturned: 2 }]);
  });

  test('cellStats is recounted when a job could have changed, not after every event', async () => {
    const { hub } = await hubWithHistory();
    const p = hub.project('p');
    const first = hub.cellStats(p);
    const { item } = hub.agentOp('p', 'propose', 'b1', { title: 'More', acceptance: 'x' });
    hub.agentOp('p', 'comment', 'b1', { headline: 'A note' });
    hub.agentOp('p', 'checkin', 'r1', {});
    assert.equal(hub.cellStats(p), first, 'a proposal, a comment and a checkin change no job: the same count');
    hub.agentOp('p', 'claim', 'b1', { item });
    hub.agentOp('p', 'progress', 'b1', { item });
    const taken = hub.cellStats(p);
    assert.notEqual(taken, first, 'a claim is a take: recounted');
    assert.equal(hub.cellStats(p), taken, 'and kept until the next one');
    hub.agentOp('p', 'submit', 'b1', { item, headline: 'Built' });
    assert.notEqual(hub.cellStats(p), taken, "a job's end: recounted");
    assert.ok(jobsTaken(hub, p, 0).length > 0);
  });
});
