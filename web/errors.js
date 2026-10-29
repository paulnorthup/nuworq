// An API error as a person reads it (#151): "<error>. <hint>", the hint being what to do about it (every
// error carries one). A hint that names a place in the app ("Open it: /#/p/held") links there. Pure, so the
// page and the tests share it.

// Sentence case, unless it starts with a name that has its own case (github.com/acme/api, a path, a slug-like word).
const sentence = (s) => {
  const t = String(s ?? '').trim();
  return /^[a-z][a-z']*(\s|$|[,:;])/.test(t) ? t[0].toUpperCase() + t.slice(1) : t;
};
const stop = (s) => (/[.!?:]$/.test(s) ? s : `${s}.`);

export function errorText(e) {
  const error = sentence(e?.message || e?.error || 'Something went wrong');
  const hint = sentence(e?.hint);
  return hint ? `${stop(error)} ${hint}` : error;
}

// The same, as HTML: the app's own addresses in the hint become links (relative, so a workspace keeps its prefix).
export function errorHtml(e, esc) {
  return esc(errorText(e)).replace(/\/?(#\/[^\s<]*[^\s<.,;:)])/g, (_, path) => `<a href="${path}">${path}</a>`);
}
