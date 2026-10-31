// A workspace's analytics (#239), for its owner, on the figures GET /api/outcomes serves (#237). Read every week or
// two, deliberately, to decide where agents and money go: so the one decision the figures suggest comes first,
// then a period switch, then one line per project, then models and agents compared on cost per landed item,
// cycle time and escapes. Figures carry no state color (web/style.css's map); a change says itself with a sign
// or a word ("+4", "−20m", "same"). Pure: the page hands in esc, dur and its two-column layout.
export const PERIODS = ['14d', '90d', 'all'];
const AGENTS_SHOWN = 5;

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
  if (!o) return `${head}<div class="loading">Loading the figures…</div>`;

  const take = `<section class="sec an-take"><p class="takeaway">${o.takeaway ? esc(o.takeaway)
    : 'Too little has landed in this period to suggest a change: the figures speak once 3 or more items land.'}</p></section>`;
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

  const top = `${head}${take}<div class="an-switch">${seg}</div>`;
  return wide ? `${top}${columns(projects, `${modelSec}${agentSec}`)}` : `${top}${projects}${modelSec}${agentSec}`;
}
