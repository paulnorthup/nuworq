import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyticsPage, change } from '../web/analytics.js';
import { appSource } from './appsource.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dur = (ms) => `${Math.round(ms / 60000)}m`;
const HOUR = 3600_000;
const tally = (t) => ({ landed: 0, cost_per_landed: null, median_cycle_ms: null, escape_rate: null, ...t });
// A GET /api/outcomes answer: two projects, three models, seven agents.
const outcomes = (over = {}) => ({
  period: '14d', takeaway: 'claude-opus-5-5 lands for $1.10 an item vs $2.88 for gpt-5-codex, with as few escapes: prefer it.',
  projects: [
    { project: 'nuworq', name: 'nuworq', landed: 11, median_cycle_ms: 2 * HOUR, cost_usd: 20, human_actions: 11, median_wait_ms: HOUR / 2, escapes: 1,
      previous: { landed: 8, median_cycle_ms: 2.5 * HOUR, cost_usd: 11.2, human_actions: 8, median_wait_ms: HOUR / 2, escapes: 1 } },
    { project: 'llm-proxy', name: 'llm<proxy>', landed: 4, median_cycle_ms: 5 * HOUR, cost_usd: null, human_actions: 1, median_wait_ms: null, escapes: 0, previous: null },
  ],
  by_model: [tally({ model: 'gpt-5-codex', landed: 5, cost_per_landed: 2.88 }), tally({ model: 'claude-opus-5-5', landed: 6, cost_per_landed: 1.1, escape_rate: 0.17 }),
    tally({ model: 'qwen3-coder', landed: 4 }), tally({ model: 'idle-model', landed: 0 })],
  by_agent: Array.from({ length: 7 }, (_, i) => tally({ agent: `claude-${i}`, model: 'claude-opus-5-5', landed: 1 + i, cost_per_landed: 1 + i / 10 })),
  ...over,
});
const page = (o = outcomes(), opts = {}) => analyticsPage(o, { esc, dur, ...opts });

// #239: a workspace's analytics, for its owner, phone first.
describe('analytics', () => {
  test('the takeaway first, then the period switch, then a line per project, then models, then agents', () => {
    const html = page();
    const at = (s) => { const i = html.indexOf(s); assert.ok(i >= 0, s); return i; };
    assert.ok(at('class="takeaway"') < at('data-action="an-period"'));
    assert.ok(at('data-action="an-period"') < at('<h2>Projects</h2>'));
    assert.ok(at('<h2>Projects</h2>') < at('<h2>Models</h2>'));
    assert.ok(at('<h2>Models</h2>') < at('<h2>Agents</h2>'));
    assert.match(html, /prefer it\.<\/p>/);
    for (const [p, label] of [['14d', 'Last 14 days'], ['90d', 'Last 90 days'], ['all', 'All time']]) {
      assert.match(html, new RegExp(`aria-pressed="${p === '14d'}" data-action="an-period" data-p="${p}">${label}<`));
    }
  });

  test('each project: landed, cycle time, cost, the owner\'s actions and wait, escapes, each with its change in words', () => {
    const html = page();
    const line = html.slice(html.indexOf('href="#/p/nuworq"'), html.indexOf('href="#/p/llm-proxy"'));
    for (const want of ['<b>11</b> landed <span class="chg">+3</span>', '<b>120m</b> median cycle <span class="chg">−30m</span>',
      '<b>$20.00</b> cost <span class="chg">+$8.80</span>', '<b>11</b> actions of yours <span class="chg">+3</span>',
      '<b>30m</b> median wait on you <span class="chg">same</span>', '<b>1</b> escape <span class="chg">same</span>']) assert.ok(line.includes(want), want);
    const fresh = html.slice(html.indexOf('href="#/p/llm-proxy"'));
    assert.match(fresh, /llm&lt;proxy&gt;/, 'names are escaped');
    assert.match(fresh, /<b>—<\/b> cost<\/span>/, 'an unpriced cost is unknown, not $0');
    assert.ok(!fresh.slice(0, fresh.indexOf('</div></div>')).includes('class="chg"'), 'no period before: nothing to compare');
  });

  test('change says itself with a sign or a word', () => {
    assert.equal(change(11, 8), '+3');
    assert.equal(change(2, 3), '−1');
    assert.equal(change(5, 5), 'same');
    assert.equal(change(5, null), '');
    assert.equal(change(null, 5), '');
    assert.equal(change(7200000, 9000000, dur), '−30m');
  });

  test('models and agents compared cheapest per landed item first; idle ones left out; agents past five fold', () => {
    const html = page();
    const models = html.slice(html.indexOf('<h2>Models</h2>'), html.indexOf('<h2>Agents</h2>'));
    assert.ok(models.indexOf('claude-opus-5-5') < models.indexOf('gpt-5-codex') && models.indexOf('gpt-5-codex') < models.indexOf('qwen3-coder'), 'unpriced last');
    assert.ok(!models.includes('idle-model'));
    assert.match(models, /<b>17%<\/b> escaped/);
    const agents = html.slice(html.indexOf('<h2>Agents</h2>'));
    assert.equal(agents.match(/class="an-line"/g).length, 5);
    assert.match(agents, /data-action="toggle" data-key="an-agents" aria-expanded="false">\+2 more</);
    assert.equal(page(outcomes(), { open: true }).slice(page(outcomes(), { open: true }).indexOf('<h2>Agents</h2>')).match(/class="an-line"/g).length, 7);
  });

  test('too little to go on says so; all time has nothing to compare against', () => {
    const html = page(outcomes({ takeaway: null, period: 'all', summary: { landed: 2 } }), { period: 'all' });
    assert.match(html, /Too little has landed in this period to suggest a change/);
    assert.ok(!html.includes('changes against'));
  });

  test('enough landed but nothing calls for a change says that, not "too little"', () => {
    const html = page(outcomes({ takeaway: null, summary: { landed: 8 } }));
    assert.match(html, /Nothing in these figures calls for a change this period\./);
    assert.ok(!html.includes('Too little'));
  });

  test('the period switch stays while the figures load', () => {
    const html = page(null, { period: '90d' });
    assert.match(html, /class="ph-block" aria-busy="true"/, 'a quiet placeholder where the figures go (#393)');
    assert.doesNotMatch(html.replace(/aria-label="Loading"/g, ''), /Loading/);
    assert.match(html, /data-action="an-period" data-p="90d"/);
    assert.match(html, /class="on" aria-pressed="true" data-action="an-period" data-p="90d"/);
  });

  test('desktop: projects beside models and agents, nothing added', () => {
    const cols = (a, b) => `<cols>${a}|${b}</cols>`;
    const wide = page(outcomes(), { wide: true, columns: cols });
    assert.match(wide, /<cols><section class="sec"><header><h2>Projects<\/h2>[\s\S]*\|<section class="sec"><header><h2>Models<\/h2>[\s\S]*<h2>Agents<\/h2>[\s\S]*<\/cols>$/);
    assert.equal(wide.replace(/<\/?cols>|\|/g, '').length, page().length, 'the same content, side by side');
  });

  test('figures carry no state color, and every target is thumb-sized', () => {
    const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
    const rules = [...css.matchAll(/(^|\n)([^{}\n]*\.an-[^{}\n]*)\{([^}]*)\}/g)];
    assert.ok(rules.length >= 8);
    for (const r of rules) assert.doesNotMatch(r[3], /var\(--(you|agents|queue|ok|warn|bad)(-tint|-line)?\)/, r[2]);
    for (const sel of ['a.an-name', '.an-more']) assert.match(css, new RegExp(`${sel.replace('.', '\\.')} \\{[^}]*min-height: 44px;`), sel);
    // The home's Analytics ends the Depth row (#394): the control's height with a mouse, thumb-sized on a phone.
    assert.match(css, /@media \(max-width: 860px\) \{[^@]*\.ctl-row > \.btn \{[^}]*min-height: 44px;/);
  });

  test('owners open it from the home; #/analytics is its address', () => {
    const app = appSource();
    assert.match(app, /\$\{owner\(\) \? '<a class="btn an-open" href="#\/analytics" data-new="analytics">Analytics<\/a>' : ''\}/);
    assert.match(app, /const owner = \(\) => S\.person\?\.role === 'owner';/);
    assert.match(app, /analytics: location\.hash\.startsWith\('#\/analytics'\)/);
    assert.match(app, /if \(S\.analytics\) \{\n\s*await loadProjects\(\);\n\s*setState\(\{ outcomes: await data\.read\(`\/api\/outcomes\?period=\$\{encodeURIComponent\(S\.period\)\}`, \{ fresh \}\) \}\);/);
  });
});
