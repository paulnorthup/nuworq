import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, LEASE_MS } from '../src/core.js';
import { view } from '../src/insight.js';
import { nextTrial, trialEligible, parseShare, QUALITY } from '../src/models.js';
import { outcomes, calibration, workspaceOutcomes } from '../src/outcomes.js';
import { plan } from '../src/runner.js';
import { calibrationSection } from '../web/analytics.js';

const TIERS = { claude: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] };

// One project nuworq run staffs, in full autonomy so agents review each other.
function world() {
  const clock = { t: Date.UTC(2026, 9, 31, 9) };
  const hub = new Hub({ clock: () => clock.t });
  hub.tx(() => hub.project('p', { create: true }));
  const set = (s) => hub.humanOp('p', 'settings', s);
  set({ runner: true, autonomy: 'full' });
  const op = (agent, o, args = {}) => hub.agentOp('p', o, agent, args);
  const row = (n) => hub.q('SELECT * FROM items WHERE seq = ?').get(n);
  const route = () => hub.route('', { runner: true, kind: 'claude' })[0];
  const create = (title, extra = {}) => hub.humanOp('p', 'create', { title, acceptance: 'x', ...extra });
  return { hub, clock, set, op, row, route, create };
}

describe('difficulty', () => {
  test('refine rates it with a one-line reason; next and look show it; unrated counts as standard', () => {
    const { op, create } = world();
    create('Rename a setting');
    assert.equal(op('a', 'look', { item: '#1' }).difficulty, 'standard (not rated yet)');
    assert.throws(() => op('a', 'refine', { item: '#1', difficulty: 'rote' }), (e) => /one-line reason/.test(e.message) && /difficulty_why/.test(e.hint));
    assert.throws(() => op('a', 'refine', { item: '#1', difficulty: 'easy', difficulty_why: 'x' }), /rote, standard, hard/);
    op('a', 'refine', { item: '#1', difficulty: 'rote', difficulty_why: 'renames one setting and its tests' });
    assert.equal(op('a', 'look', { item: '#1' }).difficulty, 'rote: renames one setting and its tests');
    assert.deepEqual(op('a', 'look').board.ready, ['#1 [soon, rote] Rename a setting']);
    op('a', 'refine', { item: '#1', difficulty_why: 'one setting, its tests and the docs' });
    assert.equal(op('b', 'next').difficulty, 'rote: one setting, its tests and the docs', 'the reason alone can be sharpened');
    op('b', 'refine', { item: '#1', difficulty: '' });
    assert.equal(op('b', 'look', { item: '#1' }).difficulty, 'standard (not rated yet)', '"" clears it');
  });

  test('shaping rates it on submit, and a shaper who leaves it out hears it counts as standard', () => {
    const { hub, op, row } = world();
    op('a', 'propose', { title: 'One idea' });
    op('a', 'propose', { title: 'Another idea' });
    op('s', 'checkin', { role: 'shaper' });
    assert.equal(op('s', 'next').mode, 'shape');
    const r = op('s', 'submit', { item: '#1', headline: 'Shaped', acceptance: 'x', difficulty: 'hard', difficulty_why: 'touches the lease sweep' });
    assert.doesNotMatch(r.hint, /no difficulty/);
    assert.deepEqual([row(1).difficulty, row(1).difficulty_why], ['hard', 'touches the lease sweep']);
    assert.equal(JSON.parse(hub.q("SELECT data FROM events WHERE type = 'shaped'").get().data).difficulty, 'hard');
    op('s', 'next');
    assert.match(op('s', 'submit', { item: '#2', headline: 'Shaped', acceptance: 'x' }).hint, /no difficulty yet, so it counts as standard: refine #2 with difficulty/);
  });
});

describe('trials', () => {
  test('the shares hold exactly, however few items there are; 0 turns one off', () => {
    const decide = (shares, n) => {
      const c = { down: 0, race: 0, none: 0 };
      for (let i = 0; i < n; i++) c[nextTrial(c, shares)]++;
      return c;
    };
    assert.deepEqual(decide({ down: 10, race: 0 }, 9), { down: 0, race: 0, none: 9 }, 'not before the tenth');
    assert.deepEqual(decide({ down: 10, race: 0 }, 100), { down: 10, race: 0, none: 90 });
    // Both fall due on the 100th: the race takes it, and one tier down catches up on the next.
    assert.deepEqual(decide({ down: 10, race: 5 }, 100), { down: 9, race: 5, none: 86 });
    assert.deepEqual(decide({ down: 10, race: 5 }, 101), { down: 10, race: 5, none: 86 });
    assert.deepEqual(decide({ down: 0, race: 0 }, 50), { down: 0, race: 0, none: 50 });
    assert.deepEqual(decide({ down: 100, race: 0 }, 3), { down: 3, race: 0, none: 0 });
    assert.equal(parseShare('25', 'model_trial'), 25);
    assert.throws(() => parseShare(101, 'model_trial'), /whole percent/);
  });

  test('eligible: rote or standard, not "now", not operator-only, within the budget', () => {
    assert.ok(trialEligible({}, { priority: 'soon' }), 'unrated counts as standard');
    assert.ok(trialEligible({ difficulty: 'rote' }, { priority: 'later' }));
    assert.ok(!trialEligible({ difficulty: 'hard' }, { priority: 'soon' }));
    assert.ok(!trialEligible({}, { priority: 'now' }));
    assert.ok(!trialEligible({}, { priority: 'soon', operatorOnly: true }));
    assert.ok(!trialEligible({}, { priority: 'soon', overBudget: true }));
  });

  test('a trial builds a tier down, the claim records it, and a failed one steps back up to the top', () => {
    const { hub, set, op, row, route, create } = world();
    set({ model_routing: true, model_tiers: TIERS, model_trial: 100 });
    assert.deepEqual(view(hub, 'p').project.staffing.models, { on: true, tiers: TIERS, trial: 100, race: 0, quality: 'balanced', qualities: QUALITY });
    create('Build', { priority: 'now' });
    assert.equal(route().model, 'claude-opus-5-5', '"now" work never tries a cheaper model');
    assert.equal(row(1).trial, '', 'and nothing is decided for it');
    hub.q("UPDATE items SET stage = 'done' WHERE seq = 1").run();
    create('Hard one');
    op('x', 'refine', { item: '#2', difficulty: 'hard', difficulty_why: 'subtle' });
    assert.equal(route().model, 'claude-opus-5-5', 'nor hard work');
    hub.q("UPDATE items SET stage = 'done' WHERE seq = 2").run();
    create('Ordinary');
    assert.equal(route().model, 'claude-sonnet-5-5');
    assert.equal(row(3).trial, 'down');
    assert.equal(route().model, 'claude-sonnet-5-5', 'decided once: every poll says the same');
    op('a', 'checkin', { model: 'claude-sonnet-5-5' });
    assert.match(op('a', 'next').trial, /a tier down/);
    const claim = JSON.parse(hub.q("SELECT data FROM events WHERE type = 'claimed' AND actor = 'a'").get().data);
    assert.deepEqual([claim.job, claim.model, claim.difficulty, claim.trial], ['work', 'claude-sonnet-5-5', 'standard', 'down']);
    op('a', 'submit', { item: '#3', headline: 'Done', evidence: [{ label: 'tests pass' }] });
    op('r', 'next');
    op('r', 'review', { item: '#3', verdict: 'reject', headline: 'Missing a test' });
    assert.equal(route().model, 'claude-opus-5-5', 'its next attempt is back on top');
    assert.match(hub.q("SELECT headline FROM events WHERE type = 'stepped_up'").get().headline, /#3 was sent back, so its next attempt steps up a tier: claude-opus-5-5/);
  });

  test('without routing, or with one tier, nothing is tried and nothing decided', () => {
    const { set, row, route, create } = world();
    set({ model_trial: 100, model_tiers: TIERS });
    create('Build');
    assert.equal(route().model, undefined);
    set({ model_routing: true, model_tiers: { claude: 'claude-opus-5-5' } });
    assert.equal(route().model, 'claude-opus-5-5');
    assert.equal(row(1).trial, '');
  });

  test('a raced trial: two slots, the top tier and one down, a model for each worker the runner starts', () => {
    const { hub, set, op, row, route, create } = world();
    set({ model_routing: true, model_tiers: TIERS, model_trial: 0, model_race: 100 });
    create('Build');
    const r = route();
    assert.deepEqual([row(1).trial, row(1).race, r.claimable, r.models], ['race', 2, 2, ['claude-opus-5-5', 'claude-sonnet-5-5']]);
    assert.deepEqual(plan([r], [], { workers: 3 }).map((w) => w.model), ['claude-opus-5-5', 'claude-sonnet-5-5']);
    op('a', 'checkin', { model: 'claude-sonnet-5-5' });
    op('a', 'next');
    assert.deepEqual([route().model, route().models], ['claude-opus-5-5', undefined], 'the cheaper slot is taken: the top one is left');
    assert.match(hub.q("SELECT headline FROM events WHERE type = 'trial'").get().headline, /raced to learn what a cheaper model can do/);
  });

  test('trials stop at the daily budget: a project that spent it routes nothing and decides nothing', () => {
    const { hub, set, op, row, route, create } = world();
    set({ model_routing: true, model_tiers: TIERS, model_trial: 100, run_budget: 1 });
    create('Spent on');
    op('a', 'next');
    op('a', 'progress', { item: '#1', headline: 'Working', usage: { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 1, cost_usd: 1.5 } });
    create('Build');
    assert.equal(route(), undefined);
    assert.equal(row(2).trial, '');
    set({ run_budget: 5 });
    assert.equal(route().model, 'claude-sonnet-5-5');
  });

  test('shares are set in Staffing and refused outside 0-100', () => {
    const { hub, set } = world();
    set({ model_trial: 25, model_race: 5 });
    assert.deepEqual([hub.project('p').model_trial, hub.project('p').model_race], [25, 5]);
    assert.throws(() => set({ model_trial: 150 }), (e) => /whole percent/.test(e.message) && /0 turns it off/.test(e.hint));
    set({ model_trial: '' });
    assert.equal(hub.project('p').model_trial, 25, 'blank leaves it as it was');
  });
});

describe('what each job came to', () => {
  test('each attempt records its difficulty, model, job and result', () => {
    const { hub, clock, op, create } = world();
    create('Lands');
    create('Stalls');
    op('x', 'refine', { item: '#1', difficulty: 'rote', difficulty_why: 'one line' });
    op('a', 'checkin', { model: 'claude-sonnet-5-5' });
    op('a', 'claim', { item: '#1' });
    op('a', 'submit', { item: '#1', headline: 'Done', evidence: [{ label: 'ok' }] });
    op('r', 'checkin', { model: 'claude-opus-5-5' });
    op('r', 'next');
    op('r', 'review', { item: '#1', verdict: 'reject', headline: 'no test' });
    op('b', 'claim', { item: '#1' });
    op('b', 'submit', { item: '#1', headline: 'Done', evidence: [{ label: 'ok' }] });
    op('r', 'next');
    op('r', 'review', { item: '#1', verdict: 'accept', headline: 'ok' });
    hub.q("UPDATE items SET stage = 'done', stage_since = ? WHERE seq = 1").run(clock.t);
    op('c', 'claim', { item: '#2' });
    clock.t += LEASE_MS + 1;
    hub.sweep();
    const jobs = outcomes(hub, 'p').jobs.map((j) => [j.item, j.job, j.agent, j.model, j.difficulty, j.result]);
    assert.deepEqual(jobs, [
      ['#1', 'work', 'a', 'claude-sonnet-5-5', 'rote', 'sent_back'],
      ['#1', 'review', 'r', 'claude-opus-5-5', 'rote', 'done'],
      ['#1', 'work', 'b', null, 'rote', 'landed'],
      ['#1', 'review', 'r', 'claude-opus-5-5', 'rote', 'done'],
      ['#2', 'work', 'c', null, 'standard', 'stalled'],
    ]);
    op('x', 'propose', { title: 'Fix it', fixes: '#1' });
    assert.equal(outcomes(hub, 'p').jobs[2].result, 'escaped', 'landed work a later item repairs escaped');
  });
});

describe('calibration', () => {
  const item = (difficulty, size, cost, attempts = 1) => ({
    outcome: 'landed', difficulty, rated: true, size, attempts, usage: [{ cost_usd: cost }],
  });

  test('difficulty that spreads cost more than size predicts it better', () => {
    const items = [
      ...[0.4, 0.5, 0.6].map((c) => item('rote', null, c)),
      ...[1.4, 1.5, 1.6].map((c) => item('standard', 'large', c)),
      ...[3, 4, 5].map((c) => item('hard', null, c, 2)),
      ...[1.3, 1.5, 1.4].map((c) => item('standard', null, c)),
    ];
    const c = calibration(items);
    assert.equal(c.predicts, 'difficulty');
    assert.deepEqual(c.by_difficulty.map((g) => [g.key, g.landed, g.median_cost, g.mean_attempts]), [['rote', 3, 0.5, 1], ['standard', 6, 1.5, 1], ['hard', 3, 4, 2]]);
    assert.equal(c.spread.difficulty.cost, 8);
    assert.equal(c.spread.size.cost, 1.07);
    const html = calibrationSection(c, { esc: String });
    assert.match(html, /Difficulty foretells cost better than size: its ratings differ 8\.0× in median cost, size 1\.1×/);
    assert.match(html, /width:100%/);
    assert.match(html, /data-new="calibration"/);
  });

  test('unrated work, or too little of it, says so', () => {
    const unrated = [1, 2, 3].map((c) => ({ ...item('standard', null, c), rated: false }));
    assert.equal(calibration(unrated).predicts, null);
    assert.match(calibrationSection(calibration(unrated), { esc: String }), /Not enough rated work yet to tell: 0 of 3 landed items were rated/);
    assert.match(calibrationSection(calibration([]), { esc: String }), /Too little has landed/);
  });

  test('the workspace outcomes carry it', () => {
    const { hub } = world();
    assert.deepEqual(workspaceOutcomes(hub).calibration.by_size.map((g) => g.key), ['small', 'large']);
  });
});
