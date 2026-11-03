import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { view, itemView } from '../src/insight.js';
import { appSource } from './appsource.js';

// A bouncing item says why and what it waits on, and reaches Needs you only when a person can help (#564).
const MIN = 60_000, HOUR = 60 * MIN;
function world(file) {
  let t = Date.UTC(2026, 10, 1, 9);
  const hub = new Hub({ ...(file ? { file } : {}), clock: () => t });
  hub.tx(() => hub.project('p', { create: true }));
  const p = () => hub.project('p');
  const add = (title, extra = {}) => hub.humanOp('p', 'create', { title, acceptance: 'x', ...extra }).item;
  const it = (ref) => hub.item(p(), ref);
  // A send-back as a reviewer writes it, with the counter the hub keeps.
  const sendBack = (ref, by, reason) => {
    hub.event(p(), { item: it(ref), actor: by, type: 'sent_back', headline: `${by} sent back ${ref}: ${reason}` });
    hub.q('UPDATE items SET rejections = rejections + 1 WHERE id = ?').run(it(ref).id);
  };
  const lapse = (ref, agent, cause = '') => {
    hub.event(p(), { item: it(ref), actor: 'nuworq', type: 'lease_expired', headline: `${agent} went quiet on ${ref}; it's back in the queue`, data: { agent, stage: 'active', cause } });
    hub.q('UPDATE items SET stalls = stalls + 1 WHERE id = ?').run(it(ref).id);
  };
  const submitted = (ref, by, hash) => hub.event(p(), { item: it(ref), actor: by, type: 'submitted', headline: 'done', data: { git: { commits: [{ hash }] } } });
  const cards = () => view(hub, 'p').attention.filter((a) => a.kind === 'struggling');
  return { hub, p, add, it, sendBack, lapse, submitted, cards, later: (ms) => { t += ms; }, now: () => t };
}

describe('a bouncing item says why, and asks a person only when they can help (#564)', () => {
  test("like #472: handoffs while it waited on a dependency an operator can take, then a send-back with a fix: no Needs you, one line on the item", () => {
    const { hub, add, sendBack, lapse, cards } = world();
    const dep = add('Live sandbox test', { needs: ['operator', 'claude-cli'] }); // #1
    const k = add('Workers sandboxed', { depends_on: [dep] }); // #2
    hub.agentOp('p', 'checkin', 'op', { has: ['operator', 'claude-cli'] });
    lapse(k, 'claude-a');
    sendBack(k, 'claude-r', 'Read and Write bypass the Bash sandbox; add deny rules for ~/.ssh and connect.json');
    assert.deepEqual(cards(), [], 'nothing for a person: the fix is for any worker, the dependency for the operator');
    const line = itemView(hub, 'p', k).bounce;
    assert.match(line, /^Bounced twice: claude-r sent it back: "Read and Write bypass the Bash sandbox; add deny rules for ~\/\.ssh and connect\.json"; agents went quiet on it once\. Now it waits on #1, which needs an operator with claude-cli\.$/);
  });

  test('like #473: rebased after a conflict, its lapses from restarts, an open question to you: Needs you, "answer question N", inline', () => {
    const { hub, add, sendBack, lapse, cards } = world();
    const k = add('Releases need Remy');
    hub.agentOp('p', 'claim', 'claude-w', { item: k });
    const { question } = hub.agentOp('p', 'ask', 'claude-w', { item: k, question: 'Is the second ruleset already there?', assumption: 'it already exists' });
    sendBack(k, 'github', 'it conflicts with main');
    sendBack(k, 'github', 'its checks failed');
    lapse(k, 'claude-x', 'restart');
    lapse(k, 'claude-y', 'restart');
    const [c] = cards();
    assert.ok(c, 'a card');
    assert.equal(c.step, 'answer');
    assert.equal(c.question.id, question);
    assert.equal(c.sub, `Bounced twice · answer question ${question}`);
    assert.match(c.why, /What happened: GitHub sent it back \(twice in all\): "its checks failed"; 2 leases lapsed while the hub restarted, not counted\./);
    assert.match(c.why, new RegExp(`Now it waits on your answer to question ${question}: "Is the second ruleset already there\\?"$`, 'm'));
  });

  test('a blocking question already has its card: that card says why the work bounces, with no second card', () => {
    const { hub, add, sendBack, cards } = world();
    const k = add('Rotate keys');
    sendBack(k, 'claude-r1', 'the old key still works');
    sendBack(k, 'claude-r2', 'no rollback plan');
    hub.agentOp('p', 'claim', 'claude-w', { item: k });
    hub.agentOp('p', 'ask', 'claude-w', { item: k, question: 'Which key store is the source of truth?', blocking: true });
    assert.deepEqual(cards(), []);
    const q = view(hub, 'p').attention.find((a) => a.kind === 'question');
    assert.match(q.why, new RegExp(`^${k} keeps bouncing\\. Bounced twice: claude-r2 sent it back \\(twice in all\\): "no rollback plan"\\.`));
  });

  test('a real bounce: two reviewers send it back for the same reason: Needs you, clarify', () => {
    const { add, sendBack, cards } = world();
    const k = add('Faster export');
    sendBack(k, 'claude-r1', 'The export still times out on 10k rows.');
    sendBack(k, 'claude-r2', 'the export still times out on 10k rows');
    const [c] = cards();
    assert.equal(c?.step, 'clarify');
    assert.match(c.why, /two reviewers sent it back for the same reason/);
  });

  test('three real failures with no new commits between: clarify; a new commit between them: not yet', () => {
    const { add, sendBack, lapse, submitted, cards } = world();
    const k = add('Retry uploads');
    submitted(k, 'claude-a', 'aaa111');
    sendBack(k, 'claude-r1', 'misses the 503 case');
    lapse(k, 'claude-b');
    submitted(k, 'claude-c', 'bbb222');
    sendBack(k, 'claude-r2', 'still misses timeouts');
    assert.deepEqual(cards(), [], 'it moved: a new commit between');
    lapse(k, 'claude-d');
    sendBack(k, 'claude-r3', 'no backoff');
    assert.equal(cards()[0]?.step, 'clarify', 'three failures on bbb222');
  });

  test('work that needs a capability nobody has: start one, with the command; lapses from ended sessions never count', () => {
    const { add, sendBack, lapse, cards } = world();
    const k = add('Verify on the VM', { needs: ['infra'] });
    sendBack(k, 'claude-r', 'not run on the VM');
    lapse(k, 'claude-a');
    lapse(k, 'claude-b', 'session');
    const [c] = cards();
    assert.equal(c?.step, 'capability');
    assert.equal(c.sub, 'Bounced twice · start an operator with infra');
    assert.match(c.how[0].where, /^nuworq operator --project p --has infra$/);
    assert.match(c.why, /one lease lapsed when a worker stopped or its runner restarted, not counted/);
  });

  test('lapses that only restarts or ended sessions caused are no bounce at all', () => {
    const { add, lapse, cards, hub } = world();
    const k = add('Calm work');
    lapse(k, 'a', 'restart'); lapse(k, 'b', 'session'); lapse(k, 'c', 'restart');
    assert.deepEqual(cards(), []);
    assert.equal(itemView(hub, 'p', k).bounce, null);
  });

  test("the sweep records why a lease lapsed: the hub was down, a runner's worker stopped, or the agent went quiet", () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nuworq-bounce-')), 'hub.db');
    const w = world(file);
    const a = w.add('A'), b = w.add('B'), c = w.add('C');
    w.hub.agentOp('p', 'claim', 'quiet', { item: a });
    w.hub.agentOp('p', 'claim', 'worker-1', { item: b });
    w.hub.q(`UPDATE agents SET runner = 'mac' WHERE name = 'worker-1'`).run();
    w.later(30 * MIN);
    w.hub.sweep();
    w.hub.agentOp('p', 'claim', 'before-restart', { item: c });
    w.hub.db.close();
    // The hub is down for an hour; the lease ran out meanwhile.
    const after = new Hub({ file, clock: () => w.now() + HOUR });
    after.sweep();
    const causes = after.q(`SELECT json_extract(data, '$.agent') AS agent, json_extract(data, '$.cause') AS cause FROM events WHERE type = 'lease_expired' ORDER BY id`).all();
    assert.deepEqual(causes.map((r) => [r.agent, r.cause]), [['quiet', ''], ['worker-1', 'session'], ['before-restart', 'restart']]);
    after.db.close();
  });

  test('the card offers only what fits: an answer inline, the steps to start an agent, or clarify, split and drop', () => {
    const app = appSource();
    assert.match(app, /a\.kind === 'struggling' && a\.step === 'answer'/);
    assert.match(app, /a\.kind === 'struggling' && a\.step === 'capability'/);
    assert.match(app, /\$\{it\.bounce \? `<div class="d-sec"><div class="label">Keeps bouncing<\/div>/);
  });
});
