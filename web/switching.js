// Moving between projects (#503): a project shows the moment it's picked, from what the app already holds, and the
// hub's answer then fills it in place (morph, #392). Still, never animated: no spinner, no shimmer, no fade.

// How long a view fetched ahead (a pointer resting on a project, a highlighted launcher result) is used as is.
export const VIEW_FOR = 15_000;

// What to draw for a project before its view arrives: the last view seen for it this visit, else its line in the
// project list (name, pulse, needs-you count). Null when the app holds nothing for it.
export function held(slug, { views, projects }) {
  const view = views.get(slug);
  if (view) return { view };
  const line = projects.find((p) => p.slug === slug);
  return line ? { line } : null;
}

// One project's view, fetched once however many ask: a hover, a focus and the click share the request. fresh asks
// the hub again (a live change, the person's own action); forget drops everything fetched ahead.
export function viewLoader(get, { now = Date.now, keep = VIEW_FOR } = {}) {
  const loads = new Map(); // slug → { at, promise }
  return {
    load(slug, { fresh = false } = {}) {
      const had = loads.get(slug);
      if (had && !fresh && now() - had.at < keep) return had.promise;
      const entry = { at: now(), promise: get(slug) };
      loads.set(slug, entry);
      entry.promise.catch(() => { if (loads.get(slug) === entry) loads.delete(slug); });
      return entry.promise;
    },
    forget: () => loads.clear(),
  };
}

// The project list and the view (and the open item), at the same time. The list is asked for only when it may have
// changed (list is null otherwise); a view that fails comes back as its error, for the caller to weigh against the list.
export async function loadProject({ list, view, item }) {
  const settle = (p) => p.then((ok) => ({ ok }), (err) => ({ err }));
  const [l, v, i] = await Promise.all([list ? list() : null, settle(view()), item ? item().catch(() => null) : null]);
  return { projects: l, view: v.ok ?? null, error: v.err ?? null, item: i };
}

// The page before the view arrives, from the project's line: its header, its pulse with the needs-you count, and quiet
// blocks where the rest goes, laid out as the page is (two columns when wide) so nothing jumps when it fills in.
export function shell(line, { esc, stateDot, labels, placeholder, depth, updating, columns }) {
  const needs = line.needs ? ` · <b>${line.needs}</b> ${line.needs === 1 ? 'needs' : 'need'} you` : '';
  const pulse = `<div class="pulse state-${line.pulse.state}">
      <div class="state-chip">${stateDot(line.pulse.state)}${labels[line.pulse.state] ?? ''}${needs}</div>
      <div class="sentence">${esc(line.pulse.sentence ?? '')}</div>
    </div>`;
  const body = placeholder(4, { head: false });
  return `
    <div class="phead">
      <div class="titles"><h1>${esc(line.name)}${updating}</h1>${line.mission ? `<div class="mission">${esc(line.mission)}</div>` : ''}</div>
      <div class="controls"><div class="ctl-row"><span class="seg-label">Depth</span>${depth}</div></div>
    </div>
    ${columns ? columns(body, pulse) : pulse + body}`;
}
