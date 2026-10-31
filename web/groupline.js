// A group's line at the 30-second view (#200, #270): Paul scans the list to see which are close, which are stuck
// and which barely started. So every card reads the same way whatever its title's length: a first row of the
// state word, a bar and the count, then the title on its own line, then the reason. The state word has a fixed
// width and the bar a fixed one, so the bars start at the same x down the list and compare by length. Color
// stays on the state word and the left border (#187); the bar is an amount, so it's neutral. Pure, so the page
// and the tests share it.
export const GROUP_STATE = { you: 'Waits on you', stuck: 'Stuck', moving: 'Moving', queued: 'Queued' };

// g: a line of view().groups; done and total count the group itself as its last step. priority: its control's
// HTML. isNew: whether this line carries the "new" tag.
export function groupLine(g, { esc, priority = '', isNew = false }) {
  const pct = g.total ? Math.round((g.done / g.total) * 100) : 0;
  const bar = `<span class="g-bar" role="progressbar" aria-valuemin="0" aria-valuenow="${g.done}" aria-valuemax="${g.total}" aria-label="${g.done} of ${g.total} parts done"><i style="width:${pct}%"></i></span>`;
  return `<div class="group g-${g.state}">
      <button class="g-main" data-action="open" data-item="${esc(g.item)}">
        <span class="g-top"><span class="g-state">${GROUP_STATE[g.state]}</span>${bar}<span class="g-count"${isNew ? ' data-new="group-progress"' : ''}>${g.done}/${g.total}</span></span>
        <span class="g-title">${esc(g.title)}</span>
        <span class="g-meta">${esc(g.reason)}${g.from ? ` · ranks ${esc(g.effective)} (from ${esc(g.from)})` : ''}</span>
      </button>
      ${priority}</div>`;
}
