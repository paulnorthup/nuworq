// What an item waits on outside the hub (#100), in the item detail: the condition, its last check, and the
// human's edit, remove and "check now". Pure, so the UI and the tests share it.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ago = (ms) => { const m = Math.round(ms / 60_000); return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

// One box for both kinds: a URL (or the JSON form) is checked by the hub; anything else is a question for
// a person. Empty clears it.
export function toPrecondition(text) {
  const s = String(text ?? '').trim();
  if (!s) return {};
  return /^(https?:\/\/|\{)/i.test(s) ? s : { kind: 'ask', question: s };
}

// The text that edits it back: the URL alone when that's all it is, else the JSON, or the question.
export function preconditionText(pre) {
  if (!pre) return '';
  if (pre.kind === 'ask') return pre.question;
  const { kind, waits_for, met, last_check, ...rest } = pre;
  return Object.keys(rest).length === 2 && rest.status === 200 ? rest.url : JSON.stringify(rest);
}

// it: the item view (it.item, it.stage, it.precondition). editing: the edit box is open. now: the clock.
export function preconditionSection(it, { editing = false, now = Date.now() } = {}) {
  const pre = it.precondition;
  const open = !['active', 'verifying', 'landing', 'done', 'dropped'].includes(it.stage);
  if (!pre && !editing) return '';
  const last = pre?.last_check;
  const status = !pre ? '' : pre.met ? `passed${last ? ` ${ago(now - last.at)} ago` : ''}`
    : pre.kind === 'ask' ? 'waiting for your answer, under Questions'
    : pre.kind === 'date' ? 'ready by itself then'
    : last ? `last check ${ago(now - last.at)} ago: ${last.detail}` : 'not checked yet';
  // A date needs no "check now": the hub knows the day.
  const acts = !open ? '' : editing ? ''
    : `<div class="answer-row">${it.stage === 'outside' && !['ask', 'date'].includes(pre.kind) ? `<button class="btn small" data-action="check-now" data-item="${esc(it.item)}">Check now</button>` : ''}
      <button class="btn ghost small" data-action="edit-pre">Edit</button>
      <button class="btn ghost small" data-action="remove-pre" data-item="${esc(it.item)}">Remove</button></div>`;
  const form = editing ? `<div class="inline-form"><input data-draft="pre:${esc(it.item)}" id="pre:${esc(it.item)}" value="${esc(preconditionText(pre))}" placeholder="A URL that must answer 200, or a question for a person">
      <button class="btn ghost" data-action="edit-pre">Cancel</button><button class="btn primary" data-action="save-pre" data-item="${esc(it.item)}">Save</button></div>` : '';
  return `<div class="d-sec"><div class="label">Waits on</div>
    ${pre ? `<p><b>${esc(pre.waits_for)}</b> <span class="age">${esc(status)}</span></p>` : ''}${acts}${form}</div>`;
}
