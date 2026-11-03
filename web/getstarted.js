// The Get started card at the top of All projects (#117), from GET /api/get-started. Pure, so the UI and
// the tests share it. Nothing to show (finished or hidden): no card at all.
import { commandBlocks } from './copy.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// gs: the response. commands: what to type for a step's action.command (the setup that works, #489: a SETUP
// session's how), shown under that step while it's the next one.
export function getStartedCard(gs, { commands = {} } = {}) {
  if (!gs?.show || !gs.steps?.length) return '';
  const done = gs.steps.filter((s) => s.done).length;
  // The first undone step is the one to do now: its action is a button, the rest are links.
  const next = gs.steps.find((s) => !s.done)?.key;
  const action = (s) => {
    const a = s.action;
    if (!a) return '';
    if (a.note) return `<span class="faint">${esc(a.label)}</span>`; // someone else's to do: nothing to click
    const cls = s.key === next ? 'btn primary small' : 'link';
    if (a.href) return `<a class="${cls}" href="${esc(a.href)}"${/^https?:/.test(a.href) ? ' target="_blank" rel="noopener"' : ''}>${esc(a.label)}</a>`;
    return `<button class="${cls}" data-action="${esc(a.ui)}"${a.slug ? ` data-slug="${esc(a.slug)}"` : ''}>${esc(a.label)}</button>`;
  };
  const rows = gs.steps.map((s) => `<li class="${s.done ? 'done' : s.key === next ? 'next' : ''}" data-step="${esc(s.key)}">
      <span class="tick">${s.done ? '✓' : ''}</span><span class="label"${s.key === 'worker-commands' ? ' data-new="tests-step"' : ''}>${esc(s.label)}</span>${s.done ? '' : `${action(s)}<a class="link how" href="guide#${esc(s.key)}">How?</a>`}
      ${!s.done && s.key === next && commands[s.action?.command] ? commandBlocks(commands[s.action.command]) : ''}</li>`).join('');
  return `<section class="get-started"><div class="gs-head"><h3>Get started</h3><span class="faint">${done} of ${gs.steps.length} done</span>
      <a class="link gs-guide" href="guide"><span data-new="guide-gs">Guide</span></a><button class="link" data-action="get-started-hide" title="Hide this for good">Hide</button></div>
    <ol>${rows}</ol></section>`;
}
