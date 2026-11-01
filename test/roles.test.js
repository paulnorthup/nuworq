import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, MIN } from '../src/core.js';
import { view } from '../src/insight.js';
import { tools, guide, skill, shaperSkill, MODE_RULES } from '../src/protocol.js';

// #238: every session has one role, fixed for its life, from how it started; the role decides what it is offered.
function setup() {
  let now = Date.UTC(2026, 9, 31, 9);
  const hub = new Hub({ clock: () => now });
  hub.tx(() => hub.project('r', { create: true }));
  hub.humanOp('r', 'settings', { autonomy: 'full' });
  const human = (op, args) => hub.humanOp('r', op, args);
  human('create', { title: 'Generic work', acceptance: 'x' }); // #1
  human('create', { title: 'Check the live VM', acceptance: 'x', needs: ['operator', 'infra'] }); // #2
  human('create', { title: 'An idea', stage: 'proposed' }); // #3
  const p = hub.project('r');
  return {
    hub, p, human,
    a: (agent, op, args = {}, opts) => hub.agentOp('r', op, agent, args, opts),
    role: (agent) => hub.roleOf(p, agent),
    item: (n) => hub.item(p, `#${n}`),
    tick: (ms) => { now += ms; },
  };
}
// A runner's token, as the server passes it (the hub alone has no token table to point at).
const RUNNER = { token: { name: 'mac-mini-runner', runner: 'mac-mini' } };

describe('a session has one role, from how it started', () => {
  test('a plain checkin is a session; the operator tag an operator; role "shaper" a shaper', () => {
    const { a, role } = setup();
    assert.equal(a('s1', 'checkin', { model: 'm' }).role, 'session');
    a('op', 'checkin', { has: ['operator', 'infra'] });
    a('sh', 'checkin', { role: 'shaper' });
    assert.deepEqual([role('s1'), role('op'), role('sh')], ['session', 'operator', 'shaper']);
  });

  test("a runner's token makes a worker on any call, carrying the runner's name; nuworq run's role says so without one", () => {
    const { hub, p, a, role } = setup();
    a('w1', 'next', { claim: false }, RUNNER);
    assert.equal(role('w1'), 'worker');
    a('w2', 'checkin', { role: 'worker', runner: 'studio', machine: 'studio' });
    assert.equal(role('w2'), 'worker');
    const row = (n) => hub.q('SELECT runner, machine FROM agents WHERE project_id = ? AND name = ?').get(p.id, n);
    assert.deepEqual({ ...row('w1') }, { runner: 'mac-mini', machine: '' });
    assert.deepEqual({ ...row('w2') }, { runner: 'studio', machine: 'studio' });
  });

  test('a worker that declares operator is refused, with a hint, and nothing is stored', () => {
    const { hub, p, a } = setup();
    for (const [name, args, opts] of [['w1', { has: ['operator'] }, RUNNER], ['w2', { role: 'worker', has: ['macos', 'operator'] }], ['w3', { role: 'operator', has: ['operator'] }, RUNNER]]) {
      assert.throws(() => a(name, 'checkin', args, opts), (e) => e.status === 403 && /A worker can't be an operator/.test(e.message) && /nuworq operator/.test(e.hint));
      assert.equal(hub.q('SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND name = ?').get(p.id, name).n, 0);
    }
    // Other operator capabilities on a worker's machine (claude on its PATH) are fine: it still never gets operator-only work.
    assert.equal(a('w4', 'checkin', { has: ['macos', 'claude-cli'] }, RUNNER).role, 'worker');
  });

  test('the role is fixed: a later checkin keeps it, another role is refused, a bad one named', () => {
    const { a, role } = setup();
    a('op', 'checkin', { has: ['operator'] });
    a('op', 'checkin', { has: ['macos'] });
    assert.equal(role('op'), 'operator', 'checking in again without the tag keeps the role');
    assert.throws(() => a('op', 'checkin', { role: 'shaper' }), (e) => e.status === 409 && /fixed for its life/.test(e.message) && /new session/.test(e.hint));
    assert.throws(() => a('op', 'next', {}, RUNNER), (e) => e.status === 409);
    // A plain session may still become one: it had none yet.
    a('s', 'look');
    a('s', 'checkin', { role: 'shaper' });
    assert.equal(role('s'), 'shaper');
    assert.throws(() => a('x', 'checkin', { role: 'boss' }), (e) => /role must be one of operator, shaper, worker, session/.test(e.message));
    assert.throws(() => a('y', 'checkin', { role: 'operator' }), (e) => /declares the operator tag/.test(e.message));
  });

  test('sessions from before roles that declared the operator tag are operators', () => {
    const { hub, p, a, role } = setup();
    a('old', 'checkin', { has: ['operator'] });
    hub.q("UPDATE agents SET role = 'session' WHERE name = 'old'").run();
    hub.q(`UPDATE agents SET role = 'operator' WHERE role = 'session' AND has LIKE '%"operator"%'`).run(); // as openDb does
    assert.equal(role('old'), 'operator');
    assert.equal(hub.isOperator(p, 'old'), true);
  });
});

describe('the role decides what next and claim offer', () => {
  test('an operator gets operator-only work first, and the operator questions before that', () => {
    const { a } = setup();
    a('op', 'checkin', { has: ['operator', 'infra'] });
    assert.equal(a('op', 'next', { claim: false }).item, '#2');
    a('s', 'checkin');
    a('s', 'claim', { item: '#1' });
    a('s', 'ask', { item: '#1', question: 'Can someone run it on prod?', blocking: true, to: 'operator' });
    assert.equal(a('op', 'next', { claim: false }).mode, 'answer');
  });

  // #333: the operator builds only the live step; workers build the rest.
  test('an operator is never offered ordinary work: idle with a hint, though it may still claim it', () => {
    const { a, human, item } = setup();
    human('update', { item: '#2', needs: [] }); // only #1 and #2, both ordinary, are ready
    a('op', 'checkin', { has: ['operator', 'infra'] });
    const idle = a('op', 'next');
    assert.equal(idle.mode, 'idle');
    assert.match(idle.hint, /#1, #2 are ready, but workers build them: an operator takes only the live steps/);
    assert.equal(a('s', 'next', { claim: false }).item, '#1', 'a plain session still gets it');
    a('op', 'claim', { item: '#1' });
    assert.equal(item(1).holder, 'op');
  });

  test('reviews and landing still come before the live step for an operator', () => {
    const { hub, a, item } = setup();
    a('op', 'checkin', { has: ['operator', 'infra'] });
    a('b', 'checkin');
    a('b', 'claim', { item: '#1' });
    a('b', 'submit', { item: '#1', headline: 'Done', evidence: [{ label: 'tests' }] });
    assert.equal(a('op', 'next', { claim: false }).mode, 'review');
    hub.q("UPDATE items SET stage = 'landing', holder = NULL, implementer = 'op' WHERE id = ?").run(item(1).id);
    assert.equal(a('op', 'next', { claim: false }).mode, 'land');
    hub.q("UPDATE items SET stage = 'done' WHERE id = ?").run(item(1).id);
    const live = a('op', 'next', { claim: false });
    assert.deepEqual([live.mode, live.item], ['work', '#2']);
  });

  test('a shaper gets only proposals to shape; a build, review or land claim is refused with a hint', () => {
    const { hub, p, a, human, item } = setup();
    a('sh', 'checkin', { role: 'shaper' });
    const n = a('sh', 'next', { claim: false });
    assert.deepEqual([n.mode, n.item], ['shape', '#3']);
    const refused = (ref, job) => assert.throws(() => a('sh', 'claim', { item: ref }), (e) => e.status === 403 && new RegExp(`A shaper doesn't ${job}`).test(e.message) && /next/.test(e.hint));
    refused('#1', 'build');
    // Work in review and landing is offered to everyone else, never to the shaper.
    a('b', 'checkin');
    a('b', 'claim', { item: '#1' });
    a('b', 'submit', { item: '#1', headline: 'Done', evidence: [{ label: 'tests' }] });
    assert.equal(item(1).stage, 'verifying');
    assert.notEqual(a('sh', 'next', { claim: false }).mode, 'review');
    refused('#1', 'review');
    hub.q("UPDATE items SET stage = 'landing', holder = NULL WHERE id = ?").run(item(1).id); // accepted, with a branch to land
    refused('#1', 'land');
    // Shaping goes as usual, and with nothing left to shape it is idle.
    a('sh', 'claim', { item: '#3' });
    a('sh', 'submit', { item: '#3', headline: 'Shaped', acceptance: 'It works' });
    assert.equal(a('sh', 'next', { claim: false }).mode, 'idle');
    assert.ok(hub.claimable(p, 'sh').every((o) => o.mode === 'shape'));
  });

  test('a worker never gets operator-only work, even with the capability on its machine', () => {
    const { a } = setup();
    a('w', 'checkin', { has: ['macos', 'infra'] }, RUNNER);
    assert.equal(a('w', 'next', { claim: false }, RUNNER).item, '#1');
    assert.throws(() => a('w', 'claim', { item: '#2' }, RUNNER), (e) => e.status === 403 && /operator-only/.test(e.message) && /operator session/.test(e.hint));
  });

  test('once operator-only work is accepted, a worker may land it, so its next never stalls on it', () => {
    const { hub, a, item, tick } = setup();
    a('op', 'checkin', { has: ['operator', 'infra'] });
    a('op', 'claim', { item: '#2' });
    hub.q("UPDATE items SET stage = 'landing', holder = NULL, stage_since = ? WHERE id = ?").run(hub.now(), item(2).id); // accepted, with a branch to land
    tick(10 * MIN); // past the builder's grace
    const n = a('w', 'next', {}, RUNNER);
    assert.deepEqual([n.mode, n.item], ['land', '#2']);
  });

  test('a worker may review operator-only work it may not build, but not work needing a tag it lacks (#271)', () => {
    const { a, human, item } = setup();
    human('create', { title: 'Check the UI', acceptance: 'x', needs: ['browser'] }); // #4
    a('w', 'checkin', { has: ['macos'] }, RUNNER);
    // Before it's submitted: no build offer, and a claim is refused.
    assert.ok(!a('w', 'next', { claim: false }, RUNNER).item.match(/#2|#4/));
    assert.throws(() => a('w', 'claim', { item: '#2' }, RUNNER), (e) => e.status === 403 && /operator-only/.test(e.message));
    a('op', 'checkin', { has: ['operator', 'infra', 'browser'] });
    for (const n of [2, 4]) {
      a('op', 'claim', { item: `#${n}` });
      a('op', 'submit', { item: `#${n}`, headline: 'Done', evidence: [{ label: 'systemctl status nuworq: active (running)' }] });
    }
    assert.equal(item(2).stage, 'verifying');
    // The worker is offered #2's review (not #4's: it has no browser), with a hint on the live part.
    const n = a('w', 'next', {}, RUNNER);
    assert.deepEqual([n.mode, n.item], ['review', '#2']);
    assert.match(n.hint, /operator, infra part was verified live by its builder or an operator/);
    assert.match(n.hint, /ask to: "operator" with the exact command and how to check it, and don't accept until it's answered/);
    assert.equal(item(2).holder, 'w');
    a('w', 'review', { item: '#2', verdict: 'accept', headline: 'Code and live output check out' }, RUNNER);
    assert.notEqual(item(2).stage, 'verifying');
    assert.notEqual(a('w', 'next', { claim: false }, RUNNER).item, '#4');
    // A browser-capable worker gets #4's review; its hint has no operator note.
    a('w2', 'checkin', { has: ['browser'] }, RUNNER);
    const m = a('w2', 'next', {}, RUNNER);
    assert.deepEqual([m.mode, m.item], ['review', '#4']);
    assert.doesNotMatch(m.hint, /verified live/);
  });
});

describe('claims, usage and presence carry the role', () => {
  test('each claim event and usage row records the role it was taken in', () => {
    const { hub, p, a } = setup();
    a('w', 'checkin', {}, RUNNER);
    a('w', 'claim', { item: '#1' }, RUNNER);
    a('w', 'progress', { item: '#1', headline: 'Half way', usage: { input_tokens: 100, output_tokens: 10, cost_usd: 0.01 } }, RUNNER);
    a('sh', 'checkin', { role: 'shaper' });
    a('sh', 'claim', { item: '#3' });
    const claims = hub.q(`SELECT actor, type, json_extract(data, '$.role') AS role FROM events WHERE project_id = ? AND type IN ('claimed', 'shaping') ORDER BY id`).all(p.id);
    assert.deepEqual(claims.map((c) => ({ ...c })), [{ actor: 'w', type: 'claimed', role: 'worker' }, { actor: 'sh', type: 'shaping', role: 'shaper' }]);
    assert.deepEqual({ ...hub.q('SELECT agent, role FROM usage WHERE project_id = ?').get(p.id) }, { agent: 'w', role: 'worker' });
    // What nuworq run posts after a worker exits records its role too.
    a('w', 'usage', { usage: { input_tokens: 5, output_tokens: 5 } }, RUNNER);
    assert.deepEqual(hub.q('SELECT DISTINCT role FROM usage WHERE project_id = ?').all(p.id).map((r) => r.role), ['worker']);
  });

  test('checkin, look and the project view say each agent\'s role, where it runs and its job', () => {
    const { a, hub } = setup();
    a('op', 'checkin', { has: ['operator', 'infra'], machine: "Paul's Mac" });
    a('op', 'claim', { item: '#2' });
    a('w', 'checkin', {}, RUNNER);
    a('w', 'claim', { item: '#1' }, RUNNER);
    a('sh', 'checkin', { role: 'shaper' });
    a('sh', 'claim', { item: '#3' });
    const want = [
      { agent: 'sh', role: 'shaper', where: null, job: 'shaping #3' },
      { agent: 'w', role: 'worker', where: 'mac-mini runner', job: 'building #1' },
      { agent: 'op', role: 'operator', where: "Paul's Mac", job: 'building #2' },
    ];
    const sorted = (list) => [...list].sort((x, y) => x.agent.localeCompare(y.agent));
    const c = a('sh', 'checkin', {});
    assert.equal(c.role, 'shaper');
    assert.deepEqual(sorted(c.agents), sorted(want));
    assert.deepEqual(sorted(a('w', 'look', {}, RUNNER).agents), sorted(want));
    const rows = view(hub, 'r').agents.map(({ name, role, where, job }) => ({ agent: name, role, where, job }));
    assert.deepEqual(sorted(rows), sorted(want));
  });

  test('checkin offers role and machine; the agent list leaves out who left', () => {
    const { a, tick } = setup();
    const params = tools().find((t) => t.name === 'checkin').inputSchema.properties;
    assert.deepEqual(params.role.enum, ['shaper']);
    assert.ok(params.machine);
    a('gone', 'checkin');
    tick(31 * MIN);
    a('here', 'checkin');
    assert.deepEqual(a('here', 'look').agents.map((x) => x.agent), ['here']);
  });
});

// #241, #527: the worker skill and the shaper skill say how each role starts, what it may take and what it never does.
describe('the worker and shaper skills describe the roles; the guide says a role is fixed', () => {
  const texts = { skill: skill(), 'shaper skill': shaperSkill() };
  test('each names Operator, Shaper and Worker and how each starts', () => {
    for (const [name, t] of Object.entries(texts)) {
      for (const want of [/\*\*Operator\b/, /\*\*Shaper\b/, /\*\*Worker\b/, /nuworq operator/, /\/nuworq:operator/, /nuworq run/]) assert.match(t, want, `${name}: ${want}`);
    }
    assert.match(texts.skill, /shaper skill \(`\/nuworq:shaper`/);
    for (const g of [guide(), guide({ via: 'cli' })]) assert.match(g, /Your role \(worker, shaper, operator, session\) is fixed at checkin/);
  });

  test('each says what a shaper and a worker never do', () => {
    for (const [name, t] of Object.entries(texts)) {
      assert.match(t, /never builds?, reviews? or lands?/i, `${name}: the shaper`);
      assert.match(t, /Worker[^\n]*never builds operator-only work/i, `${name}: the worker`);
    }
  });

  // #272: infra work is built by workers; the operator runs only the live step.
  test('the shape hint splits infra work in two parts, and the operator hint builds only the live step', () => {
    assert.match(MODE_RULES.shape, /Infra work[^\n]*carries no operator tag[^\n]*ask to: "operator" with steps[^\n]*small child item/);
    assert.match(MODE_RULES.operator, /Build an item yourself only when it is the step on real infrastructure/);
    assert.match(texts.skill, /\*\*Build only the live step:\*\*/);
  });

  test('the shape hint for operator-only work, and refine adding an operator tag, say to split it; refine still applies it', () => {
    const { a, item } = setup();
    a('sh', 'checkin', { role: 'shaper' });
    const split = /needs infra[^.]*\. If it has code, docs or tests to change, split it: drop the operator tag[^.]*ask to: "operator" with steps/;
    const r = a('sh', 'refine', { item: '#3', needs: ['infra'] });
    assert.match(r.hint, split);
    assert.deepEqual(JSON.parse(item(3).needs), ['infra']);
    assert.doesNotMatch(a('sh', 'refine', { item: '#3', title: 'Renamed' }).hint ?? '', split, 'only when the tag is new');
    assert.doesNotMatch(a('sh', 'refine', { item: '#1', needs: ['docker'] }).hint ?? '', split, 'not for other tags');
    assert.match(a('sh', 'claim', { item: '#3' }).hint, split);
    // A proposal without an operator tag gets the usual hint.
    a('h', 'propose', { title: 'Another idea' });
    assert.doesNotMatch(a('sh', 'claim', { item: '#4' }).hint ?? '', split);
  });

  test('the shaper skill checks in as a shaper', () => {
    assert.match(shaperSkill(), /`checkin` with role "shaper"/);
  });
});
