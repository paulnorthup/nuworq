import { errorText, errorHtml } from './errors.js';
import { markNew, keepNew } from './new.js';
import { isTextBox, saveFocus, restoreFocus } from './focus.js';
import { keepScroll } from './scroll.js';
import { morph } from './morph.js';
import { untimed, tick } from './ago.js';
import { liveGate } from './pace.js';
import { loadProject } from './switching.js';
import { dataCache } from './data.js';
import { S, setState, putIn, markDirty, takeDirty, PAGE } from './store.js';
import { drawerHtml } from './views/drawer.js';
import { esc } from './views/html.js';
import { mainHtml } from './views/main.js';
import { railHtml } from './views/rail.js';

// What the app runs on (#602): the hub's answers (api, data, refresh), drawing the regions (render), dialogs, toasts
// and live updates. web/views/ make the markup; web/actions.js and web/router.js change the state and call render.

// ── utilities ──
export const $ = (sel, el = document) => el.querySelector(sel);
// undo: { action, note } for a button that reverses what just happened; the toast then stays 8s to give time to use it.
export function toast(msg, err = false, undo = null) {
  const t = $('#toast');
  t.textContent = msg;
  if (undo) t.insertAdjacentHTML('beforeend', ` <button class="toast-undo" data-action="${esc(undo.action)}" data-note="${esc(undo.note)}">Undo</button>`);
  t.className = err ? 'err' : '';
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), undo ? 8000 : err ? 5000 : 2200);
}
// A failed request, as a person reads it: the error and what to do about it, with any place it names linked (#151).
export function toastError(e, lead = '') {
  toast(lead + errorText(e), true);
  $('#toast').innerHTML = esc(lead) + errorHtml(e, esc);
  // Following the place it names leaves the dialog the error came from.
  for (const a of $('#toast').querySelectorAll('a')) a.addEventListener('click', () => { closeModal(); $('#toast').hidden = true; });
}

// The hub out of reach (#142): say so in a bar that stays, mark what's on screen as possibly out of date, and
// clear it all by itself once the hub answers again. Shown after a moment, so a hub restarting doesn't flash it.
const OFFLINE = "Couldn't reach the hub; nothing was changed. Try again when it's back.";
export function offline() {
  if (S.offline) return;
  setState({ offline: Date.now() });
  clearTimeout(offline.t);
  offline.t = setTimeout(() => {
    if (!S.offline) return;
    const at = new Date(S.offline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let bar = $('#offline');
    if (!bar) { bar = document.createElement('div'); bar.id = 'offline'; bar.setAttribute('role', 'status'); document.body.prepend(bar); }
    bar.textContent = `Can't reach the hub since ${at}; what you see may be out of date.`;
    document.body.classList.add('offline');
  }, 2000);
}
export function online() {
  if (!S.offline) return;
  data.clear(); // what's kept may have changed while the hub was out of reach (#601)
  setState({ offline: null });
  clearTimeout(offline.t);
  $('#offline')?.remove();
  document.body.classList.remove('offline');
  scheduleRefresh();
}

export async function api(path, opts = {}) {
  // Relative, so the UI also works under a workspace path prefix (/w/<slug>/).
  let r;
  try {
    r = await fetch(path.replace(/^\//, ''), { ...opts, headers: { 'content-type': 'application/json' }, credentials: 'same-origin' });
  } catch {
    offline();
    throw new Error(OFFLINE); // the browser's own words ("Failed to fetch") mean nothing to a person
  }
  online();
  if (r.status === 401) {
    location.href = 'login.html';
    throw new Error('Not signed in');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), j);
  return j;
}
// The project list, home, outcomes, views and open item, each kept per URL until a change event says it may have
// changed (#601, web/data.js): a live update asks only for what the change touched, a person's action reads fresh.
export const data = dataCache((url) => api(url));
// ── data ──
export async function loadProjects() {
  setState({ projects: await data.read('/api/projects', { fresh: true }), listStale: false });
}
// A project's view at the picked depth (#501), with the pages of All work and earlier agents the open project asked for.
const viewUrl = (slug) => {
  const more = slug === S.slug ? ['all', 'agents'].filter((k) => S.pages[k] > PAGE[k]).map((k) => `&${k}=${S.pages[k]}`).join('') : '';
  return `/api/p/${encodeURIComponent(slug)}/view?depth=${encodeURIComponent(S.zoom)}${more}`;
};
// One request however many ask for it, so a hover, a focus and the click share it (#503); kept until a change in that
// project (#601). forget: the views fetched at another depth.
export const views = { load: (slug, { fresh = false } = {}) => data.read(viewUrl(slug), { fresh }), forget: () => data.forget((u) => /\/view\?/.test(u)) };
// Fetched ahead as the pointer rests on a project or the launcher highlights it, and kept as the view to draw at once.
export function prefetchView(slug) {
  if (!slug || slug === S.slug) return;
  views.load(slug).then((v) => putIn('views', slug, v), () => {});
}
// fresh: false lets an open use the view fetched ahead; a live change or the person's own action asks the hub again.
// list: false (moving between pages) skips the project list unless a live change marked it stale.
export async function refresh({ force = false, fresh = true, list = true } = {}) {
  // While an action is on its way, a live update would show the screen from before it: the action's own refresh follows.
  if (S.sending && !force) return;
  try {
    setState({ missing: null });
    if (S.analytics) {
      await loadProjects();
      setState({ outcomes: await data.read(`/api/outcomes?period=${encodeURIComponent(S.period)}`, { fresh }) });
      setState({ view: null });
    } else if (S.slug) {
      // The list and the view at once; the list only when a live change may have changed it.
      const slug = S.slug, ref = S.itemRef;
      const r = await loadProject({
        list: list || S.listStale || !S.projects.length ? () => data.read('/api/projects', { fresh }) : null,
        view: () => views.load(slug, { fresh }),
        item: ref ? () => data.read(`/api/p/${encodeURIComponent(slug)}/items/${encodeURIComponent(ref.replace('#', ''))}`, { fresh }) : null,
      });
      if (r.projects) setState({ projects: r.projects, listStale: false });
      // No view, from a list held a while: the project may have gone since, so the list decides.
      else if (r.error) await loadProjects();
      if (r.view) putIn('views', slug, r.view);
      if (slug !== S.slug) return; // they moved on; this view is kept for when they come back
      setState({ loading: null });
      if (!S.projects.some((p) => p.slug === slug)) {
        // A stale link, or a renamed or archived project: say so, rather than quietly showing the home (#143).
        const archived = await api('/api/projects?archived=1').catch(() => []);
        setState({ view: null, missing: { slug, archived: archived.find((p) => p.slug === slug) ?? null } });
      } else {
        if (r.error) throw r.error;
        setState({ view: r.view });
        if (ref === S.itemRef) setState({ item: r.item });
      }
    } else {
      setState({ view: null });
      // The home: one request, which also brings the project lines the rail shows.
      // Boot just asked (homeFresh, #599): the first refresh uses that answer.
      setState({ home: S.homeFresh ?? await data.read('/api/home', { fresh }) });
      setState({ homeFresh: null, projects: S.home.projects });
      // Get started: asked until it says it's gone (finished or hidden), then never again this visit.
      // Boot just asked (gsFresh, #599): the first refresh uses that answer.
      if (S.gsFresh) setState({ gsFresh: false });
      else if (S.gs?.show !== false) setState({ gs: await api('/api/get-started').catch(() => S.gs) });
    }
  } catch (e) {
    if (!S.projects.length) $('#main').innerHTML = `<div class="loading">Can't reach the nuworq hub. Is <code>nuworq serve</code> running?</div>`;
    return;
  }
  if (S.slug && S.shellOnly === S.slug) return; // the switch's second paint draws it (#637)
  render({ force });
}

// A focused box counts as typing even while empty (#374): live updates wait until focus leaves it.
export const typing = () => isTextBox(document.activeElement);
// A redraw changes only what changed, in place (#392); the "new" tags markNew adds stay for it to look after.
const paint = (el, html, memory = null) => morph(el, html, { ...keepNew, memory, alike: untimed });
// The page's sections as last painted (#682): one the same as before but for its ticking times isn't parsed or
// compared again, and the tick says those times afresh.
const mainSections = new Map();
// The regions (#602): each drawn from its pure view (web/views/), and only when a change marked it (web/store.js).
export const REGIONS = {
  rail: () => {
    const el = $('#rail');
    paint(el, railHtml());
    el.classList.toggle('menu-open', !!S.railMenu); // on a phone the rail's actions sit behind Menu
    return el;
  },
  main: () => { const el = $('#main'); paint(el, mainHtml(), mainSections); tick(el); return el; },
  drawer: () => {
    const el = $('#drawer'), html = drawerHtml(), show = html != null;
    if (el.hidden === show) el.hidden = $('#scrim').hidden = !show; // untouched when it stays as it is (#392)
    if (show) paint(el, html);
    return show ? el : null;
  },
};
// also: regions to draw though no state changed (the window's width, the theme).
export function render({ force = false, also = [] } = {}) {
  markDirty(...also);
  // Nor while they scroll or hold a pointer down (#392): it waits until they let go, the regions still marked.
  if (!force && (typing() || live.busy())) { setState({ pending: true }); return; }
  setState({ pending: false });
  const regions = takeDirty();
  if (!regions.length) return;
  const writing = saveFocus(document); // a forced redraw puts the person back where they were writing
  let drawn = [];
  keepScroll(document, () => { // every scrolled area keeps its place, anchored to the row in view (#376)
    drawn = regions.map((r) => REGIONS[r]()).filter(Boolean);
  });
  for (const el of drawn.flatMap((d) => [...d.querySelectorAll('[data-draft]')])) {
    const v = S.drafts[el.dataset.draft];
    if (v == null) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
  restoreFocus(document, writing);
  for (const el of drawn) markNew(el); // what just shipped (#130), redrawn with its region
}
// ── modals ──
export function modal(html) {
  const m = $('#modal');
  // Redrawn in place (a toggle, a live count), a dialog keeps its place (#376); a different dialog starts at the top.
  const title = html.match(/<h[23][^>]*>([^<]*)/)?.[1] ?? '';
  keepScroll(document, () => { m.innerHTML = `<div class="dialog" data-scroll="dialog:${esc(title)}">${html}</div>`; });
  m.hidden = false;
  markNew(m);
}
export const closeModal = () => { $('#modal').hidden = true; $('#modal').innerHTML = ''; };

// ── live updates ──
// At most one a second, and none while the person scrolls or holds a pointer down: it waits, then applies (#392).
// It reads what a change left kept as it is (#601): the change event already dropped what it touched.
export const live = liveGate({ run: () => refresh({ fresh: false }), hidden: () => document.hidden, idle: () => { if (S.pending && !typing()) render(); } });
export const scheduleRefresh = () => live.poke();
