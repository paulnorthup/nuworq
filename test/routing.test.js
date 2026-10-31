import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { itemView } from '../src/insight.js';
import { candidates, pickModel, MIN_ATTEMPTS, QUALITY } from '../src/models.js';
import { proxyClient, readyFrom, checkLocalModels } from '../src/llmproxy.js';
import { routingResults, workspaceOutcomes } from '../src/outcomes.js';
import { routingSection } from '../web/analytics.js';

// #349: each job runs on the cheapest model whose results are close enough to the best, at the project's bar.
const LIST = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
const [HAIKU, SONNET, OPUS] = LIST;
const cell = (rates, n = 25) => Object.fromEntries(Object.entries(rates).map(([m, r]) => [m, { attempts: n, clean: Math.round(r * n) }]));

describe('picking a model', () => {
  test('at each quality bar, the cheapest model within it of the best', () => {
    const stats = cell({ [HAIKU]: 0.84, [SONNET]: 0.92, [OPUS]: 0.96 });
    const pick = (quality) => LIST[pickModel(LIST, { mode: 'work', stats, quality }).start];
    assert.equal(pick('best'), OPUS);
    assert.equal(pick('balanced'), SONNET, '92% is within 5 points of 96%');
    assert.equal(pick('cheapest'), HAIKU, '84% is within 15 points');
    assert.deepEqual(Object.keys(QUALITY), ['best', 'balanced', 'cheapest']);
    assert.equal(pickModel(LIST, { mode: 'work', stats }).start, 1, 'balanced unless set');
  });

  test('a cheaper model that does as well as the best takes it even at Best quality', () => {
    const stats = cell({ [HAIKU]: 0.96, [OPUS]: 0.96 });
    assert.equal(LIST[pickModel(LIST, { mode: 'work', stats, quality: 'best' }).start], HAIKU);
  });

  test('one line says which model and why', () => {
    const stats = cell({ [SONNET]: 0.92, [OPUS]: 0.96 }, 50);
    assert.equal(pickModel(LIST, { mode: 'work', stats }).why, `${SONNET}: 92% of 50 standard builds landed clean, vs ${OPUS} 96%`);
    assert.equal(pickModel(LIST, { mode: 'work', stats, quality: 'best' }).why, `${OPUS}: 96% of 50 standard builds landed clean, the best measured`);
  });

  test(`fewer than ${MIN_ATTEMPTS} attempts: building stays on the top tier, rote jobs on the cheapest; reviews always top`, () => {
    const thin = { [HAIKU]: { attempts: 40, clean: 40 }, [OPUS]: { attempts: MIN_ATTEMPTS - 1, clean: MIN_ATTEMPTS - 1 } };
    const w = pickModel(LIST, { mode: 'work', stats: thin, difficulty: 'rote' });
    assert.equal(LIST[w.start], OPUS, 'the top tier is not measured yet, so nothing is known to be close to it');
    assert.match(w.why, /the top tier until claude-opus-5-5 has 20 finished rote builds to compare against \(1 to go\)/);
    assert.equal(LIST[pickModel(LIST, { mode: 'land', stats: {} }).start], HAIKU);
    assert.equal(LIST[pickModel(LIST, { mode: 'work', stats: {} }).start], OPUS);
    assert.equal(LIST[pickModel(LIST, { mode: 'review', stats: cell({ [HAIKU]: 1, [OPUS]: 0.5 }) }).start], OPUS);
    // A cheap model with too few attempts is not picked, however good it looks.
    assert.equal(LIST[pickModel(LIST, { mode: 'work', stats: { ...cell({ [OPUS]: 0.9 }), [HAIKU]: { attempts: 5, clean: 5 } } }).start], OPUS);
  });

  test('a local model counts as cheapest, only while ready, and never on hard items', () => {
    const list = [HAIKU, 'qwen3-coder', OPUS];
    const local = (m) => m === 'qwen3-coder';
    assert.deepEqual(candidates(list, { local, ready: () => true }), ['qwen3-coder', HAIKU, OPUS]);
    assert.deepEqual(candidates(list, { local, ready: () => false }), [HAIKU, OPUS]);
    assert.deepEqual(candidates(list, { local, ready: () => true, difficulty: 'hard' }), [HAIKU, OPUS]);
  });
});

describe('llm-proxy readiness', () => {
  test('warm, cold and up are ready; unavailable, unknown and a failing model are not', () => {
    assert.equal(readyFrom({ state: 'warm' }).ready, true);
    assert.equal(readyFrom({ state: 'cold' }).ready, true);
    assert.equal(readyFrom({ state: 'unavailable' }).ready, false);
    assert.equal(readyFrom(undefined).ready, false);
    assert.deepEqual(readyFrom({ state: 'warm', requests15m: 8, failRate15m: 0.75 }), { ready: false, state: 'warm', why: '75% of its last 8 requests failed' });
    assert.equal(readyFrom({ state: 'warm', requests15m: 2, failRate15m: 1 }).ready, true, 'two requests say little');
  });

  test('the client reads GET /_/api/models?model= (aliases or models); the hub keeps each local model\'s answer', async () => {
    const asked = [];
    const fetch = async (url, opts) => {
      asked.push([url, opts.headers.authorization]);
      const model = new URL(url).searchParams.get('model');
      const body = model === 'studio' ? { aliases: [{ name: 'studio', readiness: { state: 'warm' } }], models: [] }
        : { models: [{ model, readiness: { state: 'unavailable' } }] };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const hub = new Hub();
    hub.tx(() => hub.project('p', { create: true }));
    hub.humanOp('p', 'settings', { model_routing: true, model_tiers: { opencode: ['studio', 'qwen3-coder', 'claude-opus-5-5'] } });
    hub.llmProxy = proxyClient({ url: 'http://proxy.test', key: 'sk-read', fetch });
    await checkLocalModels(hub, (m) => !m.startsWith('claude'));
    assert.deepEqual(asked.map(([u]) => u), ['http://proxy.test/_/api/models?model=studio', 'http://proxy.test/_/api/models?model=qwen3-coder']);
    assert.equal(asked[0][1], 'Bearer sk-read');
    assert.equal(hub.localReady.get('studio').ready, true);
    assert.equal(hub.localReady.get('qwen3-coder').ready, false);
    // No llm-proxy: no local model is ready.
    hub.llmProxy = null;
    await checkLocalModels(hub, (m) => !m.startsWith('claude'));
    assert.match(hub.localReady.get('studio').why, /no llm-proxy is set/);
  });
});

// A project that routes, with builds already done on each model: n attempts on model, clean of them landed.
function world() {
  const hub = new Hub({ clock: () => Date.UTC(2026, 9, 31, 9) });
  hub.tx(() => hub.project('p', { create: true }));
  hub.humanOp('p', 'settings', { runner: true, autonomy: 'full', model_routing: true, model_tiers: { claude: LIST }, model_trial: 0 });
  let seq = 0;
  const builds = (model, n, clean) => {
    for (let k = 0; k < n; k++) {
      const agent = `w-${model}-${k}`;
      hub.humanOp('p', 'create', { title: `Build ${++seq}`, acceptance: 'x' });
      hub.agentOp('p', 'checkin', agent, { model });
      hub.agentOp('p', 'claim', agent, { item: `#${seq}` });
      hub.agentOp('p', 'submit', agent, { item: `#${seq}`, headline: 'Done', evidence: [{ label: 'npm test' }] });
      if (k < clean) hub.humanOp('p', 'accept', { item: `#${seq}` });
      else hub.humanOp('p', 'sendback', { item: `#${seq}`, note: 'missing a test' }), hub.humanOp('p', 'update', { item: `#${seq}`, stage: 'dropped' });
    }
  };
  return { hub, builds, route: () => hub.route('', { runner: true, kind: 'claude' })[0] };
}

describe('routing on real results', () => {
  test('the hub counts each model\'s builds per cell and routes the next build to the cheapest close enough', () => {
    const { hub, builds, route } = world();
    builds(OPUS, 20, 19);
    builds(SONNET, 20, 18);
    builds(HAIKU, 20, 17);
    const cells = hub.cellStats(hub.project('p'));
    assert.deepEqual(cells['work standard'][SONNET], { attempts: 20, clean: 18 });
    hub.humanOp('p', 'create', { title: 'Next build', acceptance: 'x' });
    const r = route();
    assert.equal(r.model, SONNET, '90% is within 5 points of 95%');
    assert.equal(r.why, `${SONNET}: 90% of 20 standard builds landed clean, vs ${OPUS} 95%`);
    const it = itemView(hub, 'p', r.item);
    assert.equal(it.model_why, r.why, 'the item says which model and why');
    assert.equal(hub.agentOp('p', 'look', 'x', { item: r.item }).model, r.why);
    hub.humanOp('p', 'settings', { model_quality: 'best' });
    assert.equal(route().model, OPUS);
    hub.humanOp('p', 'settings', { model_quality: 'cheapest' });
    assert.equal(route().model, HAIKU, '85% is within 15 points of 95%');
    assert.throws(() => hub.humanOp('p', 'settings', { model_quality: 'fast' }), /best, balanced, cheapest/);
  });

  test('a failed attempt still steps the next one up a tier from where routing put it', () => {
    const { hub, builds, route } = world();
    builds(OPUS, 20, 19);
    builds(SONNET, 20, 18);
    // Cheapest that passes, so Sonnet stays the plan once its own stalled attempt counts against it (18 of 21).
    hub.humanOp('p', 'settings', { model_quality: 'cheapest' });
    hub.humanOp('p', 'create', { title: 'Next build', acceptance: 'x' });
    const ref = route().item;
    hub.agentOp('p', 'checkin', 'w', { model: SONNET });
    hub.agentOp('p', 'claim', 'w', { item: ref });
    hub.agentOp('p', 'handoff', 'w', { item: ref, headline: 'Stuck' });
    const r = route();
    assert.equal(r.model, OPUS);
    assert.match(r.why, /^claude-opus-5-5, stepped up after 1 failed attempt\. Planned: claude-sonnet-5-5: 86% of 21 standard builds/);
  });

  test('analytics shows each model per cell and what routing saved against the dearest', () => {
    const r = routingResults([
      ...Array.from({ length: 4 }, (_, k) => ({ job: 'work', difficulty: 'standard', model: OPUS, clean: true, cost_usd: 2 })),
      ...Array.from({ length: 4 }, (_, k) => ({ job: 'work', difficulty: 'standard', model: SONNET, clean: k < 3, cost_usd: 0.5 })),
      { job: 'land', difficulty: 'standard', model: 'qwen3-coder', clean: true, cost_usd: null },
    ]);
    const work = r.cells.find((c) => c.job === 'work');
    assert.deepEqual(work.models.map((m) => [m.model, m.rate, m.cost_per_clean]), [[OPUS, 1, 2], [SONNET, 0.75, 0.67]]);
    assert.equal(r.saved_usd, 3.99, 'three clean Sonnet builds at $0.67 each, rework included, vs $2 on Opus');
    const html = routingSection(r, { esc: String });
    assert.match(html, /Routing saved \$3\.99 against running each job on its dearest model/);
    assert.match(html, /Building <span class="s">standard items/);
    assert.match(html, /class="step faint"/, 'under 20 attempts: faint');
    assert.equal(routingSection({ cells: [] }, { esc: String }), '');
  });

  test('workspace outcomes carry the routing results', () => {
    const { hub, builds } = world();
    builds(OPUS, 3, 3);
    const o = workspaceOutcomes(hub, { period: '14d' });
    assert.deepEqual(o.routing.cells[0].models[0], { model: OPUS, attempts: 3, clean: 3, rate: 1, cost_per_clean: null });
  });
});
