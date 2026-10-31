// Propose work from a project's board (#389), for a person who isn't in a terminal. Phone-first: one field and
// one button; what done means, context and priority open on demand. It always becomes a proposal: an agent shapes
// it, and under "ask" it waits for an OK like any other. Pure, so the UI and the tests share it.

// more: the optional fields are open. priority: the one picked so far. autonomy: the project's.
export function proposeForm({ more = false, priority = 'soon', autonomy = '' } = {}) {
  return `<div class="add-work propose">
      <div class="propose-row">
        <input data-draft="nw-title" id="nw-title" aria-label="What should be true when it's done" placeholder="What should be true when done?" enterkeyhint="send">
        <button class="btn primary" data-action="add-work">Propose</button>
      </div>
      ${more ? `<textarea data-draft="nw-acceptance" id="nw-acceptance" placeholder="Done means… (checkable; agents verify against this)"></textarea>
      <textarea data-draft="nw-summary" id="nw-summary" placeholder="Why it matters, context, constraints"></textarea>
      <div class="row"><span class="faint">Priority</span><div class="seg">${['now', 'soon', 'later'].map((p) => `<button class="${priority === p ? 'on' : ''}" data-action="nw-priority" data-p="${p}">${p}</button>`).join('')}</div></div>`
    : '<button class="link propose-more" data-action="nw-more">+ What done means, context, priority</button>'}
      <p class="faint">${autonomy === 'ask' ? 'An agent shapes it into work if it needs it; it waits for your OK, then gets built.' : 'An agent shapes it into work, then it gets built.'}</p>
    </div>`;
}

// What the board sends to the human create op: always a proposal. No title: nothing to send.
export function proposal({ title, acceptance, summary, priority } = {}) {
  const t = String(title ?? '').trim();
  if (!t) return null;
  return { title: t, acceptance: String(acceptance ?? '').trim(), summary: String(summary ?? '').trim(), priority: priority || 'soon', stage: 'proposed' };
}
