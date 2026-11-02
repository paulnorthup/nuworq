// A workspace's analytics (#239), for its owner, on the figures GET /api/outcomes serves (#237). Read every week or
// two, deliberately, to decide where agents and money go: so the one decision the figures suggest comes first,
// then a period switch, then one line per project, then models and agents compared on cost per landed item,
// cycle time and escapes. Figures carry no state color (web/style.css's map); a change says itself with a sign
// or a word ("+4", "−20m", "same"). Pure: the page hands in esc, dur and its two-column layout.
import { placeholder } from './instant.js';

export const PERIODS =['14d', '90d', 'all'];
const AGENTS_SHOWN = 5;
const MIN_LANDED = 3; // src/outcomes.js suggests nothing below this many landed

const money = (n) => `$${n.toFixed(2)}`;
const pct = (r) => `${Math.round(r * 100)}%`;

// The change from the previous period, in words: "+4", "−20m", "+$8.00", "same", or nothing to compare.
export function change(now, before, fmt = String) {
  if (now == null || before == null) return '';
  if (now === before) return 'same';
  return `${now > before ? '+' : '−'}${fmt(Math.abs(now - before))}`;
}

// The page. o: the /api/outcomes answer. open: whether the full agent list shows. wide: two columns.
export function analyticsPage(o, { esc, dur, period = o?.period ?? '14d', open = false, wide = false, columns = (a, b) => a + b }) {
  const time = (ms) => (ms == null ? '—' : dur(ms));
  const usd = (n) => (n == null ? '—' : money(n));
  const fig = (value, label, chg = '') => `<span class="fig"><b>${value}</b> ${label}${chg ? ` <span class="chg">${chg}</span>` : ''}</span>`;
  const head = `<div class="phead"><div class="titles"><h1>Analytics</h1>
    <div class="mission">What your agents landed, how long it took, what it cost and how much of your time it took, across every project.</div></div></div>`;
  const seg = `<div class="seg an-period" role="group" aria-label="Period">${PERIODS.map((p) =>
    `<button class="${p === period ? 'on' : ''}" aria-pressed="${p === period}" data-action="an-period" data-p="${p}">${p === 'all' ? 'All time' : `Last ${p.replace('d', ' days')}`}</button>`).join('')}</div>`;
  // The switch stays while the figures load, so it doesn't vanish for a moment on every switch.
  if (!o) return `${head}<div class="an-switch">${seg}</div>${placeholder(4)}`;

  // No takeaway means too little landed, or enough landed and nothing calls for a change: say which.
  const quiet = (o.summary?.landed ?? 0) < MIN_LANDED
    ? `Too little has landed in this period to suggest a change: the figures speak once ${MIN_LANDED} or more items land.`
    : 'Nothing in these figures calls for a change this period.';
  const take = `<section class="sec an-take"><p class="takeaway">${o.takeaway ? esc(o.takeaway) : quiet}</p></section>`;
  const versus = period === 'all' ? '' : `<span class="hint">changes against the ${period} before</span>`;

  const project = (p) => {
    const b = p.previous ?? {};
    return `<div class="an-line"><a class="an-name" href="#/p/${encodeURIComponent(p.project)}">${esc(p.name)}</a><div class="an-figs">
      ${fig(p.landed, 'landed', change(p.landed, b.landed))}
      ${fig(time(p.median_cycle_ms), 'median cycle', change(p.median_cycle_ms, b.median_cycle_ms, dur))}
      ${fig(usd(p.cost_usd), 'cost', change(p.cost_usd, b.cost_usd, money))}
      ${fig(p.human_actions, p.human_actions === 1 ? 'action of yours' : 'actions of yours', change(p.human_actions, b.human_actions))}
      ${fig(time(p.median_wait_ms), 'median wait on you', change(p.median_wait_ms, b.median_wait_ms, dur))}
      ${fig(p.escapes, p.escapes === 1 ? 'escape' : 'escapes', change(p.escapes, b.escapes))}</div></div>`;
  };
  const projects = `<section class="sec"><header><h2>Projects</h2><span class="count">${o.projects.length}</span>${versus}</header>
    <div class="an-lines">${o.projects.map(project).join('') || '<div class="zero">No projects yet.</div>'}</div></section>`;

  // Compared on what an owner decides with: cost per landed item first (cheapest first, unpriced last).
  const byCost = (a, b) => (a.cost_per_landed ?? Infinity) - (b.cost_per_landed ?? Infinity) || b.landed - a.landed;
  const compared = (r, name, sub = '') => `<div class="an-line"><span class="an-name">${name}${sub ? ` <span class="s">${sub}</span>` : ''}</span><div class="an-figs">
      ${fig(usd(r.cost_per_landed), 'per landed item')}${fig(time(r.median_cycle_ms), 'median cycle')}
      ${fig(r.escape_rate == null ? '—' : pct(r.escape_rate), 'escaped')}${fig(r.landed, 'landed')}</div></div>`;
  const models = o.by_model.filter((m) => m.landed).sort(byCost);
  const modelSec = `<section class="sec"><header><h2>Models</h2><span class="count">${models.length}</span><span class="hint">cheapest per landed item first</span></header>
    <div class="an-lines">${models.map((m) => compared(m, esc(m.model ?? 'Model not reported'))).join('') || '<div class="zero">Nothing landed in this period.</div>'}</div></section>`;
  const agents = o.by_agent.filter((a) => a.landed).sort(byCost);
  const shown = open ? agents : agents.slice(0, AGENTS_SHOWN);
  const more = agents.length > AGENTS_SHOWN
    ? `<button class="link an-more" data-action="toggle" data-key="an-agents" aria-expanded="${open}">${open ? 'Show fewer' : `+${agents.length - AGENTS_SHOWN} more`}</button>` : '';
  const agentSec = `<section class="sec"><header><h2>Agents</h2><span class="count">${agents.length}</span></header>
    <div class="an-lines">${shown.map((a) => compared(a, esc(a.agent ?? 'unknown'), a.model ? esc(a.model) : '')).join('') || '<div class="zero">Nothing landed in this period.</div>'}</div>${more}</section>`;

  const calSec = calibrationSection(o.calibration, { esc });
  const routeSec = routingSection(o.routing, { esc });
  const top = `${head}${take}<div class="an-switch">${seg}</div>`;
  return wide ? `${top}${columns(`${projects}${calSec}`, `${modelSec}${agentSec}${routeSec}`)}` : `${top}${projects}${modelSec}${agentSec}${routeSec}${calSec}`;
}

const JOBS = { work: 'Building', land: 'Landing', tidy: 'Tidying', review: 'Reviewing', shape: 'Shaping' };

// Model routing (#349): each model's results per kind of job, the figures routing picks from. What it saved comes
// first, in words; then per kind of job, each model's clean rate as a bar (an amount: no state color), its attempts
// and its full cost per clean job beside it. Routing counts a model in a kind from 20 attempts: fewer are faint.
export function routingSection(r, { esc }) {
  if (!r?.cells?.length) return '';
  const saved = r.saved_usd == null ? 'Nothing priced to compare yet: savings show once jobs on different models report their cost.'
    : r.saved_usd >= 0 ? `Routing saved ${money(r.saved_usd)} against running each job on its dearest model.`
      : `Routing cost ${money(-r.saved_usd)} more than running each job on its dearest model: the cheaper models needed rework.`;
  const cell = (c) => `<div class="an-line"><span class="an-name">${esc(JOBS[c.job] ?? c.job)} <span class="s">${esc(c.difficulty)} items</span></span>
    <dl class="funnel an-cal">${c.models.map((m) => `<div class="step${m.attempts < 20 ? ' faint' : ''}"><dt>${esc(m.model)} <span class="s">${m.attempts}${m.cost_per_clean == null ? '' : ` · ${money(m.cost_per_clean)}`}</span></dt>
      <dd><span class="bar" style="width:${Math.max(m.rate ? 2 : 0, Math.round(m.rate * 100))}%"></span></dd>
      <dd class="n">${pct(m.rate)}</dd></div>`).join('')}</dl></div>`;
  return `<section class="sec" data-new="model-routing-results"><header><h2>Model routing</h2><span class="hint">clean rate per model, by kind of job</span></header>
    <p class="an-verdict">${esc(saved)}</p>
    <div class="an-lines">${r.cells.map(cell).join('')}</div></section>`;
}

const LABELS = { rote: 'Rote', standard: 'Standard', hard: 'Hard', small: 'Small', large: 'Large' };

// Calibration (#348): whether an item's difficulty foretells what it costs better than its size does. Read when
// deciding whether to trust difficulty to pick models, so the answer comes first, in words; then each rating's
// median cost as a bar on one scale shared by both, its count and attempts beside it. Bars are amounts: no state color.
export function calibrationSection(c, { esc }) {
  if (!c) return '';
  const groups = [...c.by_difficulty, ...c.by_size];
  const max = Math.max(...groups.map((g) => g.median_cost ?? 0), 0);
  const x = (n) => `${n.toFixed(1)}×`;
  const { difficulty: d, size: s } = c.spread;
  const verdict = c.landed < MIN_LANDED ? `Too little has landed in this period to tell: the comparison speaks once ${MIN_LANDED} or more items land.`
    : c.predicts === 'difficulty' ? `Difficulty foretells cost better than size: its ratings differ ${x(d.cost)} in median cost${s.cost ? `, size ${x(s.cost)}` : ''}.`
      : c.predicts === 'size' ? `Size foretells cost better than difficulty: ${x(s.cost)} between sizes${d.cost ? ` against ${x(d.cost)}` : ''}.`
        : c.predicts === 'neither' ? `Difficulty and size foretell cost about as well: ${x(d.cost)} and ${x(s.cost)} between their groups.`
          : `Not enough rated work yet to tell: ${c.rated} of ${c.landed} landed ${c.landed === 1 ? 'item was' : 'items were'} rated. Shaping rates each item from now on.`;
  const rows = (list) => list.map((g) => `<div class="step"><dt>${LABELS[g.key]} <span class="s">${g.landed}</span></dt>
      <dd><span class="bar" style="width:${max && g.median_cost ? Math.max(2, Math.round((100 * g.median_cost) / max)) : 0}%"></span></dd>
      <dd class="n">${g.median_cost == null ? '—' : money(g.median_cost)}</dd></div>`).join('');
  // Unrated items (#720) count under no rating: a line of their own, no bar, as they say nothing about cost.
  const unrated = (n) => (n > 0 ? `<div class="step unrated"><dt>Not rated <span class="s">${n}</span></dt></div>` : '');
  const tries = (list) => list.filter((g) => g.landed).map((g) => `${LABELS[g.key].toLowerCase()} ${g.mean_attempts}`).join(', ');
  const block = (name, list, rated) => `<div class="an-line"><span class="an-name">${name}</span><dl class="funnel an-cal">${rows(list)}${unrated(c.landed - rated)}</dl>
      ${tries(list) ? `<div class="an-figs"><span class="fig">Attempts per item: ${esc(tries(list))}</span></div>` : ''}</div>`;
  return `<section class="sec" data-new="calibration"><header><h2>Difficulty or size</h2><span class="hint">median cost per landed item, by rating</span></header>
    <p class="an-verdict">${esc(verdict)}</p>
    <div class="an-lines">${block('By difficulty', c.by_difficulty, c.rated)}${block('By size', c.by_size, c.sized ?? c.landed)}</div></section>`;
}
