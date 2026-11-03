

// Per-browser preferences.
export const store = {
  get: (k, d) => { try { return localStorage.getItem('nuworq:' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('nuworq:' + k, v); } catch {} },
};
// Appearance (#485): Match device unless this browser chose Light or Dark. A setting, set once and kept in this
// browser; web/theme.js applies it before the first paint of every page.
export const themeNow = () => { const t = store.get('theme', 'device'); return t === 'light' || t === 'dark' ? t : 'device'; };
export const recent = () => { try { const r = JSON.parse(store.get('recent', '[]')); return Array.isArray(r) ? r : []; } catch { return []; } };
// The items opened lately, newest first, for the launcher with nothing typed.
export function remember(slug, ref) {
  const n = Number(ref.replace('#', ''));
  store.set('recent', JSON.stringify([{ p: slug, n }, ...recent().filter((r) => r.p !== slug || r.n !== n)].slice(0, 8)));
}
