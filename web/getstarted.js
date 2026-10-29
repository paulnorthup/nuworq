// The Get started card at the top of All projects (#117), from GET /api/get-started. Pure, so the UI and
// the tests share it. Nothing to show (finished or hidden): no card at all.
import { copyBlock } from './copy.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// gs: the response. worker: the command that starts an agent, shown under that step while it's undone.
export function getStartedCard(gs, { worker = '' } = {}) {
  if (!gs?.show || !gs.steps?.length) return '';
  const done = gs.steps.filter((s) => s.done).length;
  // The first undone step is the one to do now: its action is a button, the rest are links.
  const next = gs.steps.find((s) => !s.done)?.key;
  const action = (s) => {
    const a = s.action;
    if (!a) return '';
    const cls = s.key === next ? 'btn primary small' : 'link';
    if (a.href) return `<a class="${cls}" href="${esc(a.href)}"${/^https?:/.test(a.href) ? ' target="_blank" rel="noopener"' : ''}>${esc(a.label)}</a>`;
    return `<button class="${cls}" data-action="${esc(a.ui)}">${esc(a.label)}</button>`;
  };
  const rows = gs.steps.map((s) => `<li class="${s.done ? 'done' : s.key === next ? 'next' : ''}" data-step="${esc(s.key)}">
      <span class="tick">${s.done ? '✓' : ''}</span><span class="label">${esc(s.label)}</span>${s.done ? '' : action(s)}
      ${!s.done && s.key === next && s.action?.command === 'worker' && worker ? copyBlock(worker) : ''}</li>`).join('');
  return `<section class="get-started"><div class="gs-head"><h3>Get started</h3><span class="faint">${done} of ${gs.steps.length} done</span>
      <button class="link" data-action="get-started-hide" title="Hide this for good">Hide</button></div>
    <ol>${rows}</ol></section>`;
}
