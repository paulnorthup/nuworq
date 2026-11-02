// The app's data (#601): each GET answer kept per URL until a change event says it may have changed, so a live update
// asks the hub only for what the change touched, and a second read of an unchanged page asks nothing. A person's own
// action reads fresh. One request however many ask at once; a request that fails isn't kept.

// What a change can affect, by URL (api paths as the app asks them, query included):
//   /api/p/<slug>/items/<n>  that project's item n: a change naming that item, or naming none in the project;
//   /api/p/<slug>/…          anything else of that project (its view, its outcomes);
//   /api/projects, /api/home, /api/outcomes, /api/get-started: what every project's change shows up in.
// A change that names no project (workspace-wide) affects all of them. Anything else (settings, people, the hub's
// info) isn't kept here.
const SHARED = /^\/?api\/(projects|home|outcomes|get-started)(\?|$)/;
const PROJECT = /^\/?api\/p\/([^/?]+)(\/items\/(\d+))?/;

// Whether the change event e ({ project: slug | null, item: "#12" | null }) may have changed what url answered.
export function affects(url, e = {}) {
  if (SHARED.test(url)) return true;
  const m = url.match(PROJECT);
  if (!m) return false;
  if (e.project == null) return true;
  if (decodeURIComponent(m[1]) !== e.project) return false;
  return !m[3] || !e.item || e.item === `#${m[3]}`;
}

// Whether the app keeps url's answer here.
export const kept = (url) => SHARED.test(url) || PROJECT.test(url);

// get(url): the request (the app's api()). read(url, { fresh }) answers from what's kept, else asks; fresh asks the
// hub again. changed(e) drops what e affects. forget(test) drops the URLs test(url) says; clear() drops everything,
// for when change events may have been missed (the stream reconnected, the hub was out of reach).
export function dataCache(get) {
  const kept_ = new Map(); // url → promise of its answer
  return {
    read(url, { fresh = false } = {}) {
      if (!kept(url)) return get(url);
      const had = kept_.get(url);
      if (had && !fresh) return had;
      const p = get(url);
      kept_.set(url, p);
      p.catch(() => { if (kept_.get(url) === p) kept_.delete(url); });
      return p;
    },
    changed(e) { for (const url of [...kept_.keys()]) if (affects(url, e)) kept_.delete(url); },
    forget(test) { for (const url of [...kept_.keys()]) if (test(url)) kept_.delete(url); },
    clear() { kept_.clear(); },
    has: (url) => kept_.has(url),
  };
}
