// The milestones (#200, #269), the 30-second view's answer to "is what I care about moving, and is anything
// stuck?": one line each, a tap opens its map. Finishing a milestone releases something, so people read
// "milestone"; the code and the API still say group (v.groups, v.ungrouped). Pure, so the page and the tests share it.
import { groupLine } from './groupline.js';

// v: the project view ({ groups, ungrouped }). Each line is web/groupline.js's: state · bar · count, title, reason.
export function milestonesSection(v, { esc }) {
  if (!v.groups?.length) return '';
  return `<section class="sec"><header><h2 data-new="milestones">Milestones</h2><span class="count">${v.groups.length}</span><span class="hint">tap one for its map</span></header>
    <div class="groups">${v.groups.map((g, i) => groupLine(g, { esc, priority: prioritySeg(g.item, g.priority, { esc }), isNew: i === 0 })).join('')}
    ${v.ungrouped ? `<div class="group-none">Not in a milestone (${v.ungrouped})</div>` : ''}</div></section>`;
}

// A milestone's own priority, set in one tap (#198 carries it to everything in it). Reversible, so no dialog.
export const prioritySeg = (item, priority, { esc }) => `<div class="seg g-prio" role="group" aria-label="Priority of ${esc(item)}">${['now', 'soon', 'later'].map((p) =>
  `<button class="${priority === p ? 'on' : ''}" aria-pressed="${priority === p}" data-action="group-priority" data-item="${esc(item)}" data-p="${p}">${p}</button>`).join('')}</div>`;
