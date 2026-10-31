// Copy buttons. Pure enough to test: the document and the clipboard are passed in.
// The synchronous copy goes first, while the click certainly still counts as a user gesture (Safari ends
// it at the first await), and it works where the async clipboard API is refused: a Permissions-Policy
// from a proxy, an unfocused document, an origin the browser doesn't call secure. Then the async API.
// If both refuse, the caller selects the text so Cmd/Ctrl-C works.

import { commandParts } from './commands.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// A block of text with a Copy button that copies exactly that text. Nothing to copy: no block at all.
export const copyBlock = (text) => (String(text ?? '').trim() ?`<div class="copyable"><pre>${esc(text)}</pre><button data-action="copy" data-text="${esc(text)}">Copy</button></div>` : '');

// Commands to run (#379): each its own block and Copy, in order, with the joining words ("then") as plain text
// between them. Backticks, fences and prompts never reach the clipboard. For text that isn't commands (a config
// file), use copyBlock: it copies verbatim.
export function commandBlocks(where) {
  const parts = commandParts(where);
  const html = parts.map((x) => (x.cmd ? copyBlock(x.cmd) : `<p class="cmd-join">${esc(x.text)}</p>`)).join('');
  return parts.filter((x) => x.cmd).length > 1 ? `<div class="cmds" data-new="copy-each-command">${html}</div>` : html;
}

function syncCopy(text, doc) {
  if (typeof doc?.execCommand !== 'function') return false;
  const back = doc.activeElement;
  const ta = doc.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', ''); // no keyboard popping up on phones
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
  doc.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = doc.execCommand('copy'); } catch { /* refused */ }
  ta.remove();
  back?.focus?.({ preventScroll: true });
  return !!ok;
}

// true once the text is on the clipboard, false if the browser refused every way.
export async function copyText(text, { doc = globalThis.document, clipboard = globalThis.navigator?.clipboard } = {}) {
  if (!text) return false;
  if (syncCopy(text, doc)) return true;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
