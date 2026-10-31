// The milestones (#200, #269), the 30-second view's answer to "is what I care about moving, and is anything
// stuck?": one line each, a tap opens its map. Finishing a milestone releases something, so people read
// "milestone"; the code and the API still say group (v.groups, v.ungrouped). Pure, so the page and the tests share it.
const STATE = { you: 'Waits on you', stuck: 'Stuck', moving: 'Moving', queued: 'Queued' };

// v: the project view ({ groups, ungrouped }).
export function milestonesSection(v, { esc }) {
  if (!v.groups?.length) return '';
  return `<section class="sec"><header><h2 data-new="milestones">Milestones</h2><span class="count">${v.groups.length}</span><span class="hint">tap one for its map</span></header>
    <div class="groups">${v.groups.map((g) => `<div class="group g-${g.state}">
      <button class="g-main" data-action="open" data-item="${esc(g.item)}">
        <span class="g-head"><span class="g-state">${STATE[g.state]}</span><span class="g-title">${esc(g.title)}</span></span>
        <span class="g-meta">${g.done} of ${g.total} done · ${esc(g.reason)}${g.from ? ` · ranks ${esc(g.effective)} (from ${esc(g.from)})` : ''}</span>
      </button>
      ${prioritySeg(g.item, g.priority, { esc })}</div>`).join('')}
    ${v.ungrouped ? `<div class="group-none">Not in a milestone (${v.ungrouped})</div>` : ''}</div></section>`;
}

// A milestone's own priority, set in one tap (#198 carries it to everything in it). Reversible, so no dialog.
export const prioritySeg = (item, priority, { esc }) => `<div class="seg g-prio" role="group" aria-label="Priority of ${esc(item)}">${['now', 'soon', 'later'].map((p) =>
  `<button class="${priority === p ? 'on' : ''}" aria-pressed="${priority === p}" data-action="group-priority" data-item="${esc(item)}" data-p="${p}">${p}</button>`).join('')}</div>`;
