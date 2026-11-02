// Relative times that tick in the page (#530): the hub sends when something happened (ms), the page says how long
// ago, and one local timer keeps every [data-at] current with no fetch. A quiet hub sends nothing, and "3m ago"
// still becomes "4m ago".

// The hub's own format (src/core.js dur), so a time reads the same before and after a tick.
export function dur(ms) {
  ms = Math.max(0, ms);
  const m = 60000, h = 60 * m, d = 24 * h;
  if (ms < m) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < h) return `${Math.round(ms / m)}m`;
  if (ms < d) return `${+(ms / h).toFixed(ms < 10 * h ? 1 : 0)}h`;
  return `${+(ms / d).toFixed(1)}d`;
}

// How long since at, or until it with left (a lease running out), as a span the tick keeps current.
// fallback: the hub's string, for a view from an older hub that sends no time.
export function ago(at, { left = false, fallback = '', now = Date.now() } = {}) {
  if (!at) return fallback;
  return `<span data-at="${Number(at)}"${left ? ' data-left' : ''}>${dur(left ? at - now : now - at)}</span>`;
}

// A hub sentence with times in it (#689: "finished it 3m ago"): each time the hub sent beside it (times: [at, as
// said]) becomes an ago() span, so the tick keeps it current. render turns the rest into markup (esc, named...).
export function timed(text, times, render, now = Date.now()) {
  text = String(text ?? '');
  if (!times?.length) return render(text);
  let end = text.length;
  for (let k = times.length - 1; k >= 0; k--) {
    const said = times[k][1];
    const i = text.lastIndexOf(said, end - said.length);
    if (!said || i < 0) continue;
    text = `${text.slice(0, i)}\u0000${k}\u0000${text.slice(i + said.length)}`;
    end = i;
  }
  return render(text).replace(/\u0000(\d+)\u0000/g, (m, k) => ago(times[k][0], { now }));
}

// Markup with what the tick says left out: two pages that differ only in how long ago things were are alike (#682).
export const untimed = (html) => html.replace(/(<span data-at="\d+"(?: data-left)?>)[^<]*<\/span>/g, '$1</span>');

// Re-says every time under root.
export function tick(root = document, now = Date.now()) {
  for (const el of root.querySelectorAll('[data-at]')) {
    const at = Number(el.dataset.at);
    const text = dur(el.hasAttribute('data-left') ? at - now : now - at);
    if (el.textContent !== text) el.textContent = text;
  }
}

// The one timer: while the tab is visible, often enough that seconds don't lag far behind.
export const TICK_MS = 10_000;
export function startTicking(doc = document) {
  return setInterval(() => { if (!doc.hidden) tick(doc); }, TICK_MS);
}
