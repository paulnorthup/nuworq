// The app's first requests (#599): all at once, each once. Who you are, where you are, the hub's version, whether
// it takes feedback, the project list, and what the first screen shows (Get started on the home, a project's view)
// don't wait on one another; billing waits only on who you are (a workspace hub's). Pure, so the page and the tests
// share it.

// api(url) → a promise. home: the first screen is the home, so Get started is asked for. view: starts the open
// project's view (the app's view loader, which keeps it for the first refresh) or the home, or null.
export async function bootData(api, { home = false, view = null } = {}) {
  const quiet = (p) => p.catch(() => null);
  const me = quiet(api('/api/me'));
  const billing = me.then((m) => (m?.org ? quiet(api('/api/billing')) : undefined));
  const [m, person, info, feedback, projects, archived, gs, b, first] = await Promise.all([
    me, quiet(api('/api/people/me')), quiet(api('/api/info')), quiet(api('/api/feedback')), quiet(api('/api/projects')), quiet(api('/api/projects?archived=1')),
    home ? quiet(api('/api/get-started')) : undefined,
    billing,
    view ? quiet(view()) : null,
  ]);
  return { me: m, person, info, feedback, projects, archived: archived?.length ?? 0, gs, billing: b, first };
}
