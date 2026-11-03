// nuworq UI. No framework: state → HTML strings → one delegated event handler.
// Zoom levels mirror 0-30-5-30: what isn't relevant at a level simply isn't rendered.
// The app in modules (#602): web/store.js the state, web/data.js the hub's answers, web/views/ the rail, the page
// and the drawer as pure markup, web/ui.js drawing only the regions a change marked, web/actions.js what the
// person does and web/router.js where they are. This file starts it and wires the page's events to them.
import { startTicking } from './ago.js';
import { markNew, markSeen, dismissNew } from './new.js';
import { shortcutFor } from './shortcuts.js';
import { THEMES } from './launcher.js';
import { radioKeys } from './radiogroup.js';
import { bootData } from './boot.js';
import { S, setState, putIn } from './store.js';
import { ACTIONS, KEYS, L, backFromGitHub, closeLauncher, closeRailMenu, drawLauncher, runLauncher, setTheme, workspaceSettings } from './actions.js';
import { store } from './prefs.js';
import { go, openTarget, prefetch, projectTarget, route } from './router.js';
import { $, api, closeModal, data, live, offline, online, prefetchView, render, scheduleRefresh, typing, views } from './ui.js';
import { WIDE } from './views/html.js';

// Crossing the two-column width lays the page out again.
WIDE.addEventListener('change', () => render({ also: ['main'] }));
// The app's state lives in web/store.js (#600); the depth picked last in this browser is where it starts.
setState({ zoom: store.get('zoom', '30s') });
let restTimer;
document.addEventListener('pointerover', (e) => {
  const t = openTarget(e), p = projectTarget(e);
  clearTimeout(restTimer);
  if (e.pointerType !== 'mouse') return;
  if (t) restTimer = setTimeout(() => prefetch(t.slug, t.ref), 60);
  else if (p) restTimer = setTimeout(() => prefetchView(p), 60);
});
document.addEventListener('touchstart', (e) => { const t = openTarget(e); if (t) prefetch(t.slug, t.ref); else prefetchView(projectTarget(e)); }, { passive: true });
document.addEventListener('focusin', (e) => prefetchView(projectTarget(e)));
// The arrow keys move the choice, as in any radio group; Tab reaches the chosen one.
radioKeys(document, '.appearance [role="radio"]', (b, step) => {
  const [k] = THEMES[(THEMES.findIndex(([t]) => t === b.dataset.appearance) + step + THEMES.length) % THEMES.length];
  const group = b.closest('.appearance').querySelector('.seg-label').id; // the workspace menu's, or Menu's on a phone
  setTheme(k);
  $(`#${group} + .seg [data-appearance="${k}"]`)?.focus();
});

$('#launcher').addEventListener('click', (e) => {
  if (e.target.id === 'launcher') return closeLauncher();
  if (e.target.closest('[data-ln-apply]')) return runLauncher(L.confirming);
  if (e.target.closest('[data-ln-back]')) { L.confirming = null; drawLauncher({ keep: true }); return $('#ln-q')?.focus(); }
  const row = e.target.closest('[data-ln]');
  if (row) { L.sel = Number(row.dataset.ln); runLauncher(L.results[L.sel]); }
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT') return;
  const fn = ACTIONS[el.dataset.action];
  if (!fn) return;
  if (el.tagName === 'A' && el.getAttribute('href')) return;
  e.preventDefault();
  e.stopPropagation();
  // On the home, a card's actions belong to its own project.
  setState({ actSlug: el.closest('[data-project]')?.dataset.project ?? null });
  // Picking something from the phone's Menu closes it.
  if (S.railMenu && el.closest('.rail-sheet')) { setState({ railMenu: false }); render({ force: true }); }
  fn(el);
});
document.addEventListener('change', (e) => {
  if (e.target.dataset?.action === 'feed-all') ACTIONS['feed-all']();
  if (e.target.dataset?.draft && e.target.type === 'checkbox') putIn('drafts', e.target.dataset.draft, e.target.checked);
});
document.addEventListener('input', (e) => {
  if (e.target.dataset?.draft) putIn('drafts', e.target.dataset.draft, e.target.type === 'checkbox' ? e.target.checked : e.target.value);
});
document.addEventListener('focusout', () => setTimeout(() => { if (S.pending && !typing()) render(); }, 150));
document.addEventListener('keydown', (e) => {
  const el = document.activeElement;
  const s = shortcutFor(e, {
    inField: /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName) || !!el?.isContentEditable,
    input: el?.tagName === 'INPUT', compose: el?.id === 'compose', modal: !$('#modal').hidden, item: !!S.itemRef, launcher: L.open, menu: !!S.railOpen,
  });
  if (s) KEYS[s.id](e);
});
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
// Using a feature tagged "new" (#130) retires its tag for this viewer, and so does tapping the tag itself (#314).
document.addEventListener('click', (e) => dismissNew(e), true);
for (const type of ['click', 'focusin']) {
  document.addEventListener(type, (e) => {
    const el = e.target.closest?.('.is-new');
    if (el) { markSeen(el.dataset.new); markNew(document); }
  }, true);
}
// The rail's menus (#824) shut on a pick, a click outside or Escape; Appearance keeps its menu open, so the change
// shows. Its own button toggles it (ACTIONS['rail-open']).
document.addEventListener('click', (e) => {
  if (!S.railOpen || e.target.closest?.('[data-action="rail-open"]')) return;
  const inside = e.target.closest?.('.rail-pop .rail-menu-list');
  if (inside && (!e.target.closest('[data-action], a[href]') || e.target.closest('[data-action="theme"]'))) return;
  closeRailMenu();
}, true);
// A row's ⋯ menu (#651) shuts once its action is chosen; the popover shuts itself on a tap elsewhere or Escape.
document.addEventListener('click', (e) => e.target.closest?.('.row-menu:popover-open [data-action]')?.closest('.row-menu').hidePopover());

document.addEventListener('visibilitychange', () => live.shown());
document.addEventListener('pointerdown', () => live.press(), true);
for (const ev of ['pointerup', 'pointercancel']) document.addEventListener(ev, () => live.release(), true);
document.addEventListener('scroll', () => live.scrolled(), { capture: true, passive: true });
let opened = false; // the stream's first open comes right after boot asked for the version (#599)
// A change event's { project, item }; one that can't be read counts as workspace-wide (everything asked again).
const changeOf = (raw) => { try { const e = JSON.parse(raw); return { project: e.project ?? null, item: e.item ?? null }; } catch { return {}; } };
function listen() {
  const es = new EventSource('api/stream');
  // A hub that moved onto a new commit restarts, so the stream reconnects: pick up the version it runs now.
  es.onopen = async () => {
    online();
    if (!opened) return void (opened = true);
    data.clear(); // back after a break: changes may have gone by unheard (#601)
    const info = await api('/api/info').catch(() => null);
    if (info && info.commit !== S.info?.commit) { setState({ info }); scheduleRefresh(); }
  };
  // Each change says which project (and item) it's in (Hub.changed): only what it can affect is asked again (#601).
  es.onmessage = (m) => { data.changed(changeOf(m.data)); setState({ listStale: true }); scheduleRefresh(); };
  es.onerror = () => { es.close(); offline(); setTimeout(listen, 3000); };
}

(async function start() {
  // GitHub returns to the app's setup_url (#/) with ?installation_id=…&setup_action=install, before or in the hash.
  const fromGitHub = /[?&]setup_action=(install|update)\b/.test(location.search + location.hash);
  if (fromGitHub) history.replaceState(null, '', `${location.pathname}#/`);
  // Back from Stripe's billing page (#231) or Checkout (#228), or sent by Free's limit: the workspace's settings,
  // over the home. From Checkout (?checkout=done) they say what happens next.
  const fromStripe = location.hash === '#/settings';
  setState({ checkoutDone: fromStripe && /[?&]checkout=done\b/.test(location.search) });
  if (fromStripe) history.replaceState(null, '', `${location.pathname}#/`);
  // From the push that says their feedback is fixed (#297): what they sent, over the home.
  const fromFixed = location.hash === '#/feedback';
  if (fromFixed) history.replaceState(null, '', `${location.pathname}#/`);
  window.addEventListener('hashchange', route);
  // Everything the first screen needs, at once and each once (#599, web/boot.js); the open project's view starts
  // with it, kept by the view loader for the first refresh.
  const home = !location.hash || location.hash === '#/';
  const slug = location.hash.match(/^#\/p\/([^/]+)/)?.[1];
  const b = await bootData(api, { home, view: slug ? () => views.load(decodeURIComponent(slug)) : home ? () => api('/api/home') : null });
  setState({ me: b.me, person: b.person, info: b.info ?? null });
  // Billing (#231): only a workspace hub that takes payments answers; its owners get Workspace settings.
  if (b.billing !== undefined) setState({ billing: b.billing });
  // Feedback about nuworq (#295): only a hub that takes it shows the entry.
  setState({ feedback: b.feedback });
  if (b.projects) setState({ projects: b.projects, listStale: false });
  setState({ archived: b.archived });
  if (home) setState({ gs: b.gs, gsFresh: true, homeFresh: b.first });
  // Relative times tick here (#530); only a change on the hub refetches, never a timer.
  startTicking();
  if (fromGitHub) return void (route(), listen(), backFromGitHub());
  if (fromStripe) return void (route(), listen(), workspaceSettings());
  if (fromFixed && S.feedback?.on) return void (route(), listen(), ACTIONS.feedback(null, { mine: true }));
  // One project opens it, unless Get started still has steps to show on All projects.
  if (home && S.projects.length === 1 && !S.gs?.show) return void (setState({ homeFresh: null }), go(S.projects[0].slug), listen());
  route();
  listen();
})();
