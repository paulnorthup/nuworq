import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, LEASE_MS } from '../src/core.js';
import { view } from '../src/insight.js';
import { appSource } from './appsource.js';
import { DEFAULT_TIERS, modelFor, newerClaude, parseTiers, tiersOf, QUALITY } from '../src/models.js';

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
  // What the runner hears: a claude runner, optionally with its own --model.
  const route = (model = '') => hub.route('', { runner: true, kind: 'claude', model })[0];
  // Accepted work waiting to land, for anyone (past the builder's grace).
  const landing = (n) => hub.q("UPDATE items SET stage = 'landing', stage_since = 0, holder = NULL WHERE seq = ?").run(n);
  const history = (n) => hub.q("SELECT headline FROM events WHERE item_id = ? AND type = 'stepped_up' ORDER BY id").all(row(n).id).map((e) => e.headline);
  return { hub, clock, set, op, row, route, landing, history };
}

describe('model tiers', () => {
  test('rote jobs start on the lowest tier; building, reviews and shaping on the top one; failures step up', () => {
    assert.equal(modelFor(TIERS, 'claude', 'land'), 'claude-haiku-5-5');
    assert.equal(modelFor(TIERS, 'claude', 'tidy'), 'claude-haiku-5-5');
    assert.equal(modelFor(TIERS, 'claude', 'work'), 'claude-opus-5-5', 'building stays on top until #344 says otherwise');
    assert.equal(modelFor(TIERS, 'claude', 'review'), 'claude-opus-5-5', 'reviews are the quality gate');
    assert.equal(modelFor(TIERS, 'claude', 'shape'), 'claude-opus-5-5', 'shaping needs judgment');
    assert.equal(modelFor(TIERS, 'claude', 'land', 1), 'claude-sonnet-5-5');
    assert.equal(modelFor(TIERS, 'claude', 'land', 5), 'claude-opus-5-5', 'never past the top');
    assert.equal(modelFor({}, 'claude', 'land', 0, 'claude-opus-5-5'), 'claude-opus-5-5', "no tiers: the runner's --model is the one tier");
    assert.equal(modelFor({}, 'claude', 'land'), null, 'nothing to choose from');
    assert.equal(modelFor(TIERS, 'codex', 'land', 0, 'gpt-5'), 'gpt-5', "another agent's tiers don't apply");
  });

  test('tiers are checked as they are set', () => {
    assert.deepEqual(parseTiers({ claude: 'claude-haiku-5-5, claude-opus-5-5', codex: '' }), { claude: ['claude-haiku-5-5', 'claude-opus-5-5'] });
    assert.deepEqual(parseTiers('{"opencode":["ollama/qwen3:8b"]}'), { opencode: ['ollama/qwen3:8b'] });
    assert.throws(() => parseTiers({ gemini: ['x'] }), /no agent "gemini"/);
    assert.throws(() => parseTiers({ claude: ['has space'] }), /model id/);
    assert.throws(() => parseTiers(['claude']), /per agent/);
  });

  test("Claude's tiers default to Haiku, Sonnet and Opus 5.5; the other agents have none (#723)", () => {
    assert.deepEqual(tiersOf('{}'), { claude: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] });
    assert.deepEqual(tiersOf({ claude: ['claude-opus-5-5'], codex: ['gpt-5-mini', 'gpt-5'] }), { claude: ['claude-opus-5-5'], codex: ['gpt-5-mini', 'gpt-5'] }, 'a project\'s own replace them');
    assert.deepEqual(tiersOf({ codex: ['gpt-5'] }).claude, DEFAULT_TIERS.claude, 'per agent');
  });

  test('Staffing says the default tiers are in use, and its trial note counts them (#723)', () => {
    const app = appSource();
    assert.match(app, /trialNote\(\{ on: m\.on, trial: m\.trial \?\? 10, tiers: own, defaults \}\)/);
    assert.match(app,/In use: \$\{esc\(defaults\.claude\.join\(' → '\)\)\}, the default\. Type your own to replace them; clear them to go back\./);
  });

  test('a newer Claude model than a default tier is noticed, per family (#723)', () => {
    assert.deepEqual(newerClaude(['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-5', '']), []);
    assert.deepEqual(newerClaude(['claude-opus-5-6', 'claude-opus-6', 'claude-haiku-5-0', 'claude-sonnet-6-1-20270101', 'claude-fable-9']), [
      { model: 'claude-sonnet-6-1-20270101', replaces: 'claude-sonnet-5-5' },
      { model: 'claude-opus-6', replaces: 'claude-opus-5-5' },
    ]);
  });
});

describe('model routing', () => {
  test('on by default, on the default Claude tiers (#723); off: routes name no model, whatever the tiers', () => {
    const { hub, set, route } = world();
    hub.humanOp('p', 'create', { title: 'Build', acceptance: 'x' });
    assert.deepEqual(view(hub, 'p').project.staffing.models, { on: true, tiers: DEFAULT_TIERS, own: {}, defaults: DEFAULT_TIERS, trial: 10, race: 0, quality: 'balanced', qualities: QUALITY });
    assert.deepEqual(DEFAULT_TIERS, TIERS);
    assert.equal(route('claude-sonnet-5-5').model, 'claude-opus-5-5', 'building starts on the default top, whatever the runner\'s --model');
    set({ model_routing: false, model_tiers: TIERS });
    assert.equal(route('claude-opus-5-5').model, undefined);
    assert.equal(hub.route('', {})[0].model, undefined, 'and an agent asking where work is never hears one');
  });

  test('on: each route names the model its job calls for', () => {
    const { hub, set, op, route, landing } = world();
    set({ model_routing: false });
    set({ model_routing: true, model_tiers: TIERS });
    assert.deepEqual(view(hub, 'p').project.staffing.models, { on: true, tiers: TIERS, own: TIERS, defaults: DEFAULT_TIERS, trial: 10, race: 0, quality: 'balanced', qualities: QUALITY });
    assert.match(hub.q("SELECT headline FROM events WHERE type = 'runner' ORDER BY id DESC").get().headline, /turned on model routing: landing and tidy jobs start on the cheapest tier/);
    hub.humanOp('p', 'create', { title: 'Build', acceptance: 'x' });
    assert.deepEqual([route().mode, route().model], ['work', 'claude-opus-5-5']);
    op('a', 'checkin');
    op('a', 'next');
    op('a', 'submit', { item: '#1', headline: 'Done', evidence: [{ label: 'tests pass' }] });
    assert.deepEqual([route().mode, route().model], ['review', 'claude-opus-5-5']);
    landing(1);
    assert.deepEqual([route().mode, route().model], ['land', 'claude-haiku-5-5']);
    op('a', 'propose', { title: 'An idea' });
    hub.q("UPDATE items SET stage = 'done' WHERE seq = 1").run();
    assert.deepEqual([route().mode, route().model], ['shape', 'claude-opus-5-5']);
    set({ model_tiers: { claude: 'claude-sonnet-5-5' } });
    hub.q("UPDATE items SET stage = 'ready', acceptance = 'x', tidy = '[]' WHERE seq = 2").run();
    assert.deepEqual([route('claude-opus-5-5').mode, route('claude-opus-5-5').model], ['tidy', 'claude-sonnet-5-5'], 'its own one tier');
    set({ model_tiers: { claude: '' } });
    assert.match(hub.q("SELECT headline FROM events WHERE type = 'runner' ORDER BY id DESC").get().headline, /cleared the model tiers: Claude uses the default ones \(claude-haiku-5-5 → claude-sonnet-5-5 → claude-opus-5-5\)/);
    assert.deepEqual([route('claude-sonnet-5-5').mode, route('claude-sonnet-5-5').model], ['tidy', 'claude-haiku-5-5'], 'no tiers of its own: the default ones');
    assert.equal(hub.route('', { runner: true, kind: 'codex' })[0].model, undefined, 'a codex runner with no --model and no tiers: its own model');
  });

  test('a landing that loses its lease, or a build sent back: the next attempt steps up, and the history says so', () => {
    const { hub, clock, set, op, row, route, landing, history } = world();
    set({ model_routing: true, model_tiers: TIERS });
    hub.humanOp('p', 'create', { title: 'Build', acceptance: 'x' });
    landing(1);
    op('l1', 'checkin');
    assert.equal(op('l1', 'next').mode, 'land');
    clock.t += LEASE_MS + 1;
    hub.sweep();
    assert.equal(row(1).tier_up, 1);
    assert.deepEqual([route().mode, route().model], ['land', 'claude-sonnet-5-5']);
    assert.deepEqual(history(1), ['#1 lost its lease, so its next attempt steps up a tier: claude-sonnet-5-5']);
    assert.ok(op('l2', 'next').history.some((h) => h.type === 'stepped_up'), "it's in the history the next lander reads");
    // A land job handed off stays landing and isn't a failed attempt at the work (#729), but the land tier still
    // climbs: it counts the land jobs taken since the item reached landing.
    op('l2', 'handoff', { item: '#1', headline: 'out of time' });
    assert.equal(row(1).stage, 'landing');
    assert.equal(row(1).tier_up, 1);
    assert.equal(route().model, 'claude-opus-5-5');

    // A build sent back: it was on the top tier already, so it steps up without changing models or saying so.
    hub.humanOp('p', 'create', { title: 'Another', acceptance: 'x' });
    hub.q("UPDATE items SET stage = 'done' WHERE seq = 1").run();
    op('b', 'next');
    op('b', 'submit', { item: '#2', headline: 'Done', evidence: [{ label: 'tests pass' }] });
    op('r', 'checkin');
    op('r', 'next');
    op('r', 'review', { item: '#2', verdict: 'reject', headline: 'Missing a test' });
    assert.equal(row(2).tier_up, 1);
    assert.deepEqual(history(2), []);
    landing(2);
    assert.equal(route().model, 'claude-haiku-5-5', "its landing still starts on the cheapest tier: a build's failures aren't a rebase's (#752)");
  });

  test("a land job steps up only for failed land jobs since the item reached landing, not its build's (#752)", () => {
    const { hub, clock, set, op, route, landing } = world();
    set({ model_routing: true, model_tiers: TIERS });
    hub.humanOp('p', 'create', { title: 'Build', acceptance: 'x' });
    hub.q('UPDATE items SET tier_up = 2 WHERE seq = 1').run(); // sent back twice while it was built
    landing(1);
    assert.deepEqual([route().mode, route().model], ['land', 'claude-haiku-5-5']);
    op('l1', 'checkin');
    op('l1', 'next');
    assert.equal(hub.tierUp(hub.item(hub.project('p'), '#1'), 'land'), 0, 'the one held now has not failed');
    clock.t += LEASE_MS + 1;
    hub.sweep();
    assert.equal(route().model, 'claude-sonnet-5-5', 'one failed land job: one tier up');
    // A land job that did its part (rebased for the PR) isn't a failure.
    op('l2', 'checkin');
    op('l2', 'next');
    hub.event(hub.project('p'), { item: hub.item(hub.project('p'), '#1'), actor: 'l2', type: 'rebased', headline: 'rebased' });
    hub.patch(hub.item(hub.project('p'), '#1'), { holder: null, lease_until: null });
    assert.equal(route().model, 'claude-sonnet-5-5');
  });

  test('a stalled attempt steps up even with routing off, so turning it on later starts from what happened', () => {
    const { hub, clock, op, row, set, route } = world();
    hub.humanOp('p', 'create', { title: 'Build', acceptance: 'x' });
    op('a', 'next');
    clock.t += LEASE_MS + 1;
    hub.sweep();
    assert.equal(row(1).tier_up, 1);
    assert.equal(hub.q("SELECT COUNT(*) AS n FROM events WHERE type = 'stepped_up'").get().n, 0, 'off: nothing to say');
    set({ model_routing: true, model_tiers: TIERS });
    hub.q("UPDATE items SET stage = 'landing', stage_since = 0 WHERE seq = 1").run();
    assert.equal(route().model, 'claude-haiku-5-5', "its landing doesn't count the build's stall (#752)");
  });

  test('each claim records the model it runs on and its job', () => {
    const { hub, op, landing } = world();
    hub.humanOp('p', 'create', { title: 'Build', acceptance: 'x' });
    op('a', 'checkin', { model: 'claude-opus-5-5' });
    op('a', 'next');
    op('a', 'submit', { item: '#1', headline: 'Done', evidence: [{ label: 'tests pass' }] });
    op('r', 'checkin', { model: 'claude-opus-5-5' });
    op('r', 'next');
    op('r', 'review', { item: '#1', verdict: 'accept', headline: 'ok' });
    landing(1);
    op('l', 'checkin', { model: 'claude-haiku-5-5' });
    op('l', 'next');
    const claims = hub.q("SELECT actor, data FROM events WHERE type IN ('claimed', 'review_started', 'landing') ORDER BY id").all()
      .map((e) => { const d = JSON.parse(e.data); return [e.actor, d.job, d.model]; });
    assert.deepEqual(claims, [['a', 'work', 'claude-opus-5-5'], ['r', 'review', 'claude-opus-5-5'], ['l', 'land', 'claude-haiku-5-5']]);
  });

  test('bad tiers are refused with a hint', () => {
    const { set } = world();
    assert.throws(() => set({ model_tiers: { gemini: 'x' } }), (e) => /no agent "gemini"/.test(e.message) && /Cheapest first/.test(e.hint));
  });
});
