// What the page and the drawer both draw (#602): the depth, agents, stages, a race's attempts. These read the
// store, so a region that uses them redraws with the fields they read (test/regions.test.js).
import { agentLine } from '../agentline.js';
import { S } from '../store.js';
import { Z, esc, providerOf } from './html.js';

// The depth shown: the one picked, or the one the project's view was fetched at while a deeper one is on its way (#501).
export const z = () => Math.min(Z[S.zoom], S.view?.depth ? Z[S.view.depth] : 2);
const agentNamed = (name) => S.view?.agents.find((a) => a.name === name) ?? null;
// An agent as it reads everywhere (#240, web/agentline.js): role and where it runs, e.g. "Worker · mac-mini runner",
// plus what it is doing (job) where that isn't already the line's subject. Its id shows at 30m and in the tooltip.
// presence: what the hub sent with the entry (Needs you, the home), else the project's agent of that name.
export function who(name, model, { job = false, presence } = {}) {
  if (!name) return '';
  if (name === 'you') return '<span class="you-chip">You</span>';
  if (name === 'nuworq' || name === 'trellis') return '<span class="sys-chip">nuworq</span>'; // trellis: events from before the rename
  const known = agentNamed(name);
  presence ??= known;
  model ??= known?.model ?? '';
  const prov = providerOf(model);
  return `<span class="agent prov-${prov.toLowerCase().replace(/[^a-z]/g, '')}" title="${esc([name, model, prov].filter(Boolean).join(' · '))}"><i></i>${esc(agentLine(presence, { name, job, id: z() >= 2 }))}</span>`;
}
// A line the hub wrote that names an agent ("claude-4e0a picked up #4"), with the agent said as who it is. Beside
// the actor (the activity feed, a timeline), a line that opens with its name drops it: "Picked up #4".
export const named = (text, name, presence, { beside = false } = {}) => {
  if (!name || ['you', 'nuworq', 'trellis'].includes(name)) return esc(text);
  if (beside && text.startsWith(`${name} `)) { const rest = text.slice(name.length + 1); return esc(rest[0].toUpperCase() + rest.slice(1)); }
  return esc(text).replace(esc(name), who(name, null, { presence }));
};
export const stagePill = (stage, court) => `<span class="stage-pill ${stage === 'done' ? 'done' : `court-${court ?? ''}`}">${esc(S.view?.stages?.[stage]?.label ?? stage)}</span>`;
export const courtOf = (stage) => S.view?.flow.stages.find((s) => s.stage === stage)?.court;

// A raced item's submissions side by side, each with its own "Keep this one".
export function attemptsGrid(item, attempts, { keep = true } = {}) {
  return `<div class="attempts">${attempts.map((s) => `<div class="attempt ${s.stage}">
      <div class="meta">${who(s.agent, s.model)} <span class="age">${esc(s.model || '')}${s.took ? ` · ${esc(s.took)}` : ''}</span>${s.stage === 'chosen' ? '<span class="tag go">kept</span>' : s.stage === 'not_chosen' ? '<span class="tag">not chosen</span>' : ''}</div>
      <div class="h">${esc(s.headline)}</div>
      ${s.branch ? `<div class="touch"><code>${esc(s.branch)}</code>${s.commits?.length ? ` ${s.commits.map((c) => `<code title="${esc(c.subject ?? '')}">${esc(String(c.hash ?? c).slice(0, 7))}</code>`).join(' ')}` : ''}</div>` : ''}
      ${s.evidence?.length ? `<div class="evidence">${s.evidence.map((e) => `<span class="ev">${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.label)}</a>` : esc(e.label)}</span>`).join('')}</div>` : '<div class="warn">⚠ No evidence attached</div>'}
      ${keep && s.stage === 'submitted' ? `<button class="btn small" data-action="keep" data-item="${esc(item)}" data-attempt="${s.n}">Keep this one</button>` : ''}
    </div>`).join('')}</div>`;
}
