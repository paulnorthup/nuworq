// nuworq UI. No framework: state → HTML strings → one delegated event handler.
// Zoom levels mirror 0-30-5-30: what isn't relevant at a level simply isn't rendered.
import { connectCommands } from './connect.js';
import { copyBlock, commandBlocks, copyText } from './copy.js';
import { getStartedCard } from './getstarted.js';
import { proposeForm, proposal, sentToast } from './propose.js';
import { homePage, columns, stateDot, STATE_LABELS } from './home.js';
import { credit } from './credit.js';
import { checkChip } from './checks.js';
import { dotClass } from './timeline.js';
import { missingProject } from './missing.js';
import { mapParts } from './groupmap.js';
import { boardWork } from './oldwork.js';
import { milestonesSection, prioritySeg as milestonePriority } from './milestones.js';
import { ackList } from './acks.js';
import { analyticsPage } from './analytics.js';
import { agentLine, roleCounts } from './agentline.js';
import { errorText, errorHtml } from './errors.js';
import { markNew, markSeen, dismissNew, keepNew } from './new.js';
import { preconditionSection, toPrecondition } from './precondition.js';
import { billingSection } from './billing.js';
import { shortcutFor, shortcutsHtml } from './shortcuts.js';
import { rank, resultsHtml, confirmHtml } from './launcher.js';
import { feedbackForm, feedbackThanks, feedbackMine, attached } from './feedback.js';
import { LOGO } from './logo.js';
import { isTextBox, saveFocus, restoreFocus } from './focus.js';
import { keepScroll } from './scroll.js';
import { morph } from './morph.js';
import { liveGate } from './pace.js';
import { predict, placeholder } from './instant.js';

const Z = { '30s': 0, '5m': 1, '30m': 2 };
// Wide enough for two columns (#141); crossing it re-lays the page out (keep in step with style.css).
const WIDE = matchMedia('(min-width: 1024px)');
WIDE.addEventListener('change', () => render());
// A keyboard, a mouse and room: only then does a keyboard hint fit in the copy (cf. .kbd-hint in style.css).
const KEYBOARD = matchMedia('(hover: hover) and (pointer: fine) and (min-width: 421px)');
// Per-browser preferences. Ones saved before the rename (under "trellis:") are still read.
const store = {
  get: (k, d) => { try { return localStorage.getItem('nuworq:' + k) ?? localStorage.getItem('trellis:' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('nuworq:' + k, v); } catch {} },
};
const S = {
  projects: [], slug: null, view: null, info: null,
  analytics: false, period: '14d', outcomes: null, person: null, // the workspace's analytics (#239)
  itemRef: null, item: null, deep: false,
  zoom: store.get('zoom', '30s'),
  open: new Set(), reveal: new Set(), drafts: {},
  composeKind: 'steer', stage: null, addWork: false, editMission: false, editItem: false,
  feedAll: false, pending: false,
  sending: 0, // actions on their way to the hub, already shown (#393)
  prefetched: new Map(), // ref → { at, item } fetched when the pointer rested on it (#393)
};
const z = () => Z[S.zoom];

// ── utilities ──
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const needYou = (n) => `${plural(n, 'thing')} ${n === 1 ? 'needs' : 'need'} you`;
const MAC = /Mac|iP(hone|ad)/.test(navigator.platform);

const inline = (t) => esc(t).replace(/`([^`\n]+)`/g, '<code>$1</code>');

const MD_INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(^|[\s(])(https?:\/\/[^\s<)]+)/gm;
const codeOnly = (t) => t.replace(/`([^`\n]+)`/g, '<code>$1</code>');

function md(text) {
  if (!text) return '';
  const blocks = [];
  let s = String(text).replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => { blocks.push(`<pre>${esc(code.replace(/\n$/, ''))}</pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  // One pass: each piece of text becomes code, bold, a link or an address once, and markup made here is never
  // scanned again (a URL inside a link's address would otherwise close its href early).
  const a = (href, label) => `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
  s = esc(s).replace(MD_INLINE, (m, code, bold, label, href, lead, url) =>
    code != null ? `<code>${code}</code>` : bold != null ? `<strong>${codeOnly(bold)}</strong>` : label != null ? a(href, codeOnly(label)) : `${lead}${a(url, url)}`);
  return s.split(/\n{2,}/).map((par) => {
    const ls = par.split('\n');
    const bullet = /^\s*([-*•]|\d+\.)\s+/;
    if (ls.every((l) => bullet.test(l))) return `<ul>${ls.map((l) => `<li>${l.replace(bullet, '')}</li>`).join('')}</ul>`;
    return `<p>${ls.join('<br>')}</p>`;
  }).join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
}

function providerOf(model = '') {
  const m = (model || '').toLowerCase();
  if (!m) return '';
  if (/claude|anthropic|opus|sonnet|haiku|fable/.test(m)) return 'Anthropic';
  if (/gpt|openai|codex|^o\d/.test(m)) return 'OpenAI';
  if (/gemini/.test(m)) return 'Google';
  return 'Open-weight';
}
const agentNamed = (name) => S.view?.agents.find((a) => a.name === name) ?? null;
// An agent as it reads everywhere (#240, web/agentline.js): role and where it runs, e.g. "Worker · mac-mini runner",
// plus what it is doing (job) where that isn't already the line's subject. Its id shows at 30m and in the tooltip.
// presence: what the hub sent with the entry (Needs you, the home), else the project's agent of that name.
function who(name, model, { job = false, presence } = {}) {
  if (!name) return '';
  if (name === 'you') return '<span class="you-chip">You</span>';
  if (name === 'nuworq' || name === 'trellis') return '<span class="sys-chip">nuworq</span>'; // trellis: events from before the rename
  const known = agentNamed(name);
  presence ??= known;
  model ??= known?.model ?? '';
  const prov = providerOf(model);
  return `<span class="agent prov-${prov.toLowerCase().replace(/[^a-z]/g, '')}" title="${esc([name, model, prov].filter(Boolean).join(' · '))}"><i></i>${esc(agentLine(presence, { name, job, id: z() >= 2 }))}</span>`;
}
// A line the hub wrote that names an agent ("claude-4e0a picked up #4"), with the agent said as who it is. Beside
// the actor (the activity feed, a timeline), a line that opens with its name drops it: "Picked up #4".
const named = (text, name, presence, { beside = false } = {}) => {
  if (!name || ['you', 'nuworq', 'trellis'].includes(name)) return esc(text);
  if (beside && text.startsWith(`${name} `)) { const rest = text.slice(name.length + 1); return esc(rest[0].toUpperCase() + rest.slice(1)); }
  return esc(text).replace(esc(name), who(name, null, { presence }));
};
// The agents here now as counts by role, each opening to its agents (#441, web/agentline.js). scope keeps each page's open counts apart.
const hereNow = (agents, scope) => roleCounts(agents, { scope, isOpen: (k) => S.open.has(k), esc,
  who: (a) => `${who(a.name, a.model, { job: true, presence: a })}${a.project ? ` <span class="age">${esc(a.project.name)}</span>` : ''}` });
// An empty section: one line on why it's empty, and the one thing to do about it.
const zero = (why, action = '') => `<div class="zero"><span class="check">→</span><div>${why}${action ? ` ${action}` : ''}</div></div>`;
const refLink = (ref) => (ref ? `<a class="ref" data-action="open" data-item="${esc(ref)}">${esc(ref)}</a>` : '');
const stagePill = (stage, court) => `<span class="stage-pill ${stage === 'done' ? 'done' : `court-${court ?? ''}`}">${esc(S.view?.stages?.[stage]?.label ?? stage)}</span>`;
const courtOf = (stage) => S.view?.flow.stages.find((s) => s.stage === stage)?.court;

// undo: { action, note } for a button that reverses what just happened; the toast then stays 8s to give time to use it.
function toast(msg, err = false, undo = null) {
  const t = $('#toast');
  t.textContent = msg;
  if (undo) t.insertAdjacentHTML('beforeend', ` <button class="toast-undo" data-action="${esc(undo.action)}" data-note="${esc(undo.note)}">Undo</button>`);
  t.className = err ? 'err' : '';
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), undo ? 8000 : err ? 5000 : 2200);
}
// A failed request, as a person reads it: the error and what to do about it, with any place it names linked (#151).
function toastError(e, lead = '') {
  toast(lead + errorText(e), true);
  $('#toast').innerHTML = esc(lead) + errorHtml(e, esc);
  // Following the place it names leaves the dialog the error came from.
  for (const a of $('#toast').querySelectorAll('a')) a.addEventListener('click', () => { closeModal(); $('#toast').hidden = true; });
}

// The hub out of reach (#142): say so in a bar that stays, mark what's on screen as possibly out of date, and
// clear it all by itself once the hub answers again. Shown after a moment, so a hub restarting doesn't flash it.
const OFFLINE = "Couldn't reach the hub; nothing was changed. Try again when it's back.";
function offline() {
  if (S.offline) return;
  S.offline = Date.now();
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
function online() {
  if (!S.offline) return;
  S.offline = null;
  clearTimeout(offline.t);
  $('#offline')?.remove();
  document.body.classList.remove('offline');
  scheduleRefresh();
}

async function api(path, opts = {}) {
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
// On the open project, or on the home the project of the card clicked (S.actSlug); with neither, the home's own.
// What's predictable shows on the same frame as the tap (#393, web/instant.js). If the hub refuses, the screen
// goes back to what it was, and the toast says so and why.
async function human(action, body = {}, msg) {
  const before = { view: S.view, home: S.home, item: S.item };
  const shown = foresee(action, body);
  S.sending++;
  try {
    const slug = S.slug ?? S.actSlug;
    const r = await api(slug ? `/api/p/${encodeURIComponent(slug)}/human/${action}` : `/api/home/${action}`, { method: 'POST', body: JSON.stringify(body) });
    S.sending--;
    if (msg) toast(msg);
    await refresh();
    return r;
  } catch (e) {
    S.sending--;
    if (shown) { Object.assign(S, before); render({ force: true }); scheduleRefresh(); }
    toastError(e, shown ? 'Not changed, so it is back as it was: ' : '');
  }
}
function foresee(action, body) {
  const next = { view: predict(S.view, action, body), home: predict(S.home, action, body), item: predict(S.item, action, body) };
  if (!next.view && !next.home && !next.item) return false;
  for (const [k, v] of Object.entries(next)) if (v) S[k] = v;
  render({ force: true });
  return true;
}

// Archive or delete the open project, then leave it: it is no longer in the list.
async function removeProject(action, body, msg) {
  try {
    await api(`/api/p/${encodeURIComponent(S.slug)}/human/${action}`, { method: 'POST', body: JSON.stringify(body) });
    closeModal();
    await loadProjects();
    go('');
    toast(msg);
  } catch (e) {
    toastError(e);
  }
}

// ── data ──
async function loadProjects() {
  S.projects = await api('/api/projects');
}
async function refresh({ force = false } = {}) {
  // While an action is on its way, a live update would show the screen from before it: the action's own refresh follows.
  if (S.sending && !force) return;
  try {
    if (S.slug || S.analytics) await loadProjects();
    S.missing = null;
    if (S.analytics) S.outcomes = await api(`/api/outcomes?period=${encodeURIComponent(S.period)}`);
    if (S.slug && !S.projects.some((p) => p.slug === S.slug)) {
      // A stale link, or a renamed or archived project: say so, rather than quietly showing the home (#143).
      const archived = await api('/api/projects?archived=1').catch(() => []);
      S.view = null;
      S.missing = { slug: S.slug, archived: archived.find((p) => p.slug === S.slug) ?? null };
    } else if (S.analytics) {
      S.view = null;
    } else if (S.slug) {
      S.view = await api(`/api/p/${encodeURIComponent(S.slug)}/view`);
      if (S.itemRef) S.item = await api(`/api/p/${encodeURIComponent(S.slug)}/items/${encodeURIComponent(S.itemRef.replace('#', ''))}`).catch(() => null);
    } else {
      S.view = null;
      // The home: one request, which also brings the project lines the rail shows.
      S.home = await api('/api/home');
      S.projects = S.home.projects;
      // Get started: asked until it says it's gone (finished or hidden), then never again this visit.
      if (S.gs?.show !== false) S.gs = await api('/api/get-started').catch(() => S.gs);
    }
  } catch (e) {
    if (!S.projects.length) $('#main').innerHTML = `<div class="loading">Can't reach the nuworq hub. Is <code>nuworq serve</code> running?</div>`;
    return;
  }
  render({ force });
}

// A focused box counts as typing even while empty (#374): live updates wait until focus leaves it.
const typing = () => isTextBox(document.activeElement);
// A redraw changes only what changed, in place (#392); the "new" tags markNew adds stay for it to look after.
const paint = (el, html) => morph(el, html, keepNew);
function render({ force = false } = {}) {
  // Nor while they scroll or hold a pointer down (#392): it waits until they let go.
  if (!force && (typing() || live.busy())) { S.pending = true; return; }
  S.pending = false;
  const writing = saveFocus(document); // a forced redraw puts the person back where they were writing
  keepScroll(document, () => { // every scrolled area keeps its place, anchored to the row in view (#376)
    renderRail();
    paint($('#main'), S.analytics ? analytics() : S.slug && S.view ? project(S.view) : S.missing ? missingProject(S.missing, { esc }) : overview());
    renderDrawer();
  });
  for (const el of document.querySelectorAll('[data-draft]')) {
    const v = S.drafts[el.dataset.draft];
    if (v == null) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
  restoreFocus(document, writing);
  markNew(document); // what just shipped (#130), redrawn with everything else
}

// ── routing ──
function route() {
  if (!$('#modal').hidden) closeModal(); // a dialog belongs to the page it was opened on (#155)
  S.railMenu = false;
  S.analytics = location.hash.startsWith('#/analytics');
  const m = location.hash.match(/^#\/p\/([^/]+)(?:\/(\d+))?/);
  const slug = m ? decodeURIComponent(m[1]) : null;
  const ref = m?.[2] ? `#${m[2]}` : null;
  // Arriving from Get started's "+ repo" opens this project's repository form, focused.
  const linking = !!slug && S.linkRepo === slug;
  if (slug !== S.slug) { S.stage = null; S.addWork = false; S.editMission = false; S.addRemote = linking; }
  S.linkRepo = null;
  S.slug = slug;
  if (ref !== S.itemRef) { S.itemRef = ref; S.item = prefetched(slug, ref); S.deep = z() >= 2; S.editItem = false; S.editPre = false; }
  if (ref) remember(slug, ref);
  // An item opens on this frame: from what was fetched as the pointer rested on it, else as a placeholder.
  if (ref && S.view?.project.slug === slug) render({ force: true });
  refresh({ force: true }).then(() => linking && $('#remote-in')?.focus());
}
// Opening an item (#393): fetched when the pointer rests on its link, or as a finger lands on it, so it opens
// without a wait. Kept a few seconds; the open refreshes it from the hub all the same.
const PREFETCH_FOR = 15_000;
function prefetch(slug, ref) {
  const key = `${slug} ${ref}`;
  const had = S.prefetched.get(key);
  if (!slug || !ref || (had && Date.now() - had.at < PREFETCH_FOR)) return;
  const entry = { at: Date.now(), item: null };
  S.prefetched.set(key, entry);
  api(`/api/p/${encodeURIComponent(slug)}/items/${encodeURIComponent(ref.replace('#', ''))}`)
    .then((it) => { entry.item = it; })
    .catch(() => S.prefetched.delete(key));
}
function prefetched(slug, ref) {
  const had = ref && S.prefetched.get(`${slug} ${ref}`);
  return had?.item && Date.now() - had.at < PREFETCH_FOR ? had.item : null;
}
const openTarget = (e) => {
  const el = e.target.closest?.('[data-action="open"][data-item]');
  return el && { slug: el.closest('[data-project]')?.dataset.project ?? S.slug, ref: el.dataset.item };
};
let restTimer;
document.addEventListener('pointerover', (e) => {
  const t = openTarget(e);
  clearTimeout(restTimer);
  if (t && e.pointerType === 'mouse') restTimer = setTimeout(() => prefetch(t.slug, t.ref), 60);
});
document.addEventListener('touchstart', (e) => { const t = openTarget(e); if (t) prefetch(t.slug, t.ref); }, { passive: true });
const go = (slug, ref) => { location.hash = slug ? `#/p/${encodeURIComponent(slug)}${ref ? '/' + ref.replace('#', '') : ''}` : '#/'; };

// ── rail ──
function renderRail() {
  const projects = S.projects.map((p) => `
    <a class="rail-item ${p.slug === S.slug ? 'on' : ''}" href="#/p/${encodeURIComponent(p.slug)}">
      ${stateDot(p.pulse.state)}<span class="name">${esc(p.name)}</span>
      ${p.needs ? `<span class="badge" title="${needYou(p.needs)}">${p.needs}</span>` : ''}
    </a>`).join('');
  const total = S.projects.reduce((n, p) => n + p.needs, 0);
  paint($('#rail'), `
    <div class="brand">${LOGO}<span>nuworq</span></div>
    ${orgSwitcher()}
    <button class="rail-item rail-search" data-action="launcher" data-new="launcher" title="Quick launcher: go to an item, a project or a setting"><span>Search</span><kbd class="kbd-hint">${MAC ? '⌘K' : 'Ctrl K'}</kbd></button>
    <button class="rail-item rail-menu" data-action="rail-menu" aria-expanded="${!!S.railMenu}"><span data-new="phone-menu">${S.railMenu ? 'Close' : 'Menu'}</span></button><span class="rail-break"></span>
    <a class="rail-label rail-head ${!S.slug && !S.analytics ? 'on' : ''}" href="#/" title="All projects"><span data-new="home">Projects</span>${total ? `<span class="badge" title="${needYou(total)}">${total}</span>` : ''}</a>
    ${projects || '<div class="rail-item rail-empty">No projects yet</div>'}
    <div class="rail-foot">
      <button class="rail-item" data-action="new-project">+ New project</button>
      <button class="rail-item" data-action="archived">Archived projects</button>
      <button class="rail-item" data-action="connect">Connect an agent</button>
      <button class="rail-item" data-action="notify">Notifications</button>
      <a class="rail-item" href="guide"><span data-new="guide">Getting started guide</span></a>
      <button class="rail-item kbd-hint" data-action="shortcuts"><span data-new="shortcuts"><kbd>?</kbd> Shortcuts</span></button>
      ${S.feedback?.on ? '<button class="rail-item" data-action="feedback"><span data-new="feedback">Feedback</span></button>' : ''}
      ${S.billing?.owner ? `<button class="rail-item" data-action="workspace-settings"><span class="name">Workspace settings</span>${S.billing.plans?.length ? '<span class="tag now">Upgrade</span>' : ''}</button>` : ''}
      ${S.me?.auth === 'required' ? `<button class="rail-item" data-action="logout" title="Signed in as ${esc(S.me.name ?? '')}">Sign out</button>` : ''}
      ${versionLine()}
    </div>`);
  // On a phone the rail's actions sit behind Menu, the top bar's only way to them.
  $('#rail').classList.toggle('menu-open', !!S.railMenu);
  markNew($('#rail'));
}

// On a hub with workspaces: which one this is, the others you belong to (one click signs you in there),
// and making a new one.
function orgSwitcher() {
  if (!S.me?.org) return '';
  const orgs = S.me.orgs ?? [];
  const row = (o) => `<span class="org-name">${esc(o.workspace)}</span><span class="org-role">${esc(o.role)}</span>`;
  return `<details class="org-switch" ${S.orgOpen ? 'open' : ''}><summary title="Switch workspace"><span class="org-name">${esc(S.me.org)}</span><span class="org-caret">▾</span></summary>
    <div class="org-menu">${orgs.length > 1 ? orgs.map((o) => o.current ? `<span class="org-item on">${row(o)}</span>` : `<a class="org-item" href="${esc(o.enter)}">${row(o)}</a>`).join('') : ''}
    <a class="org-item" href="${esc(S.me.new_org)}">+ New workspace</a></div></details>`;
}

// What is live, e.g. "v0.2.0 · c3a3008", the commit linked to GitHub when the hub's code came from there.
function versionLine() {
  const { version, commit, commit_url: url } = S.info ?? {};
  if (!version && !commit) return '';
  const sha = commit ? (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(commit)}</a>` : esc(commit)) : '';
  return `<div class="rail-version">${[version && `v${esc(version)}`, sha].filter(Boolean).join(' · ')}</div>`;
}

// ── overview: the 30-second view across every project ──
function zoomControl() {
  return `<div class="seg" title="How much do you want to see? (keys 1, 2, 3)">${Object.keys(Z).map((k) =>
    `<button class="${S.zoom === k ? 'on' : ''}" data-action="zoom" data-zoom="${k}">${k}</button>`).join('')}</div>`;
}

// Analytics (#239, web/analytics.js): the workspace's figures, for its owners, from the home.
const owner = () => S.person?.role === 'owner';
const analytics = () => analyticsPage(S.outcomes, { esc, dur, period: S.period, open: S.open.has('an-agents'), wide: WIDE.matches, columns });

// The home, across every project (web/home.js): the pulse, what needs you, a line per project.
const getStarted = () => getStartedCard(S.gs, { worker: S.info ? connectCommands(S.info, location).worker : '' });
function overview() {
  if (!S.projects.length && S.me?.org) return firstProject();
  if (!S.projects.length || !S.home) {
    // One next step: Get started while it shows, the fallback only once it's finished or hidden (#149).
    const gs = getStarted();
    return `<div class="phead"><div class="titles"><h1>Welcome to nuworq</h1>
      <div class="mission">A hub where you facilitate and AI agents (Claude, OpenAI, open-weight) find, do and verify the work.</div></div></div>
      ${gs || `<div class="zero"><span class="check">→</span><div>No projects yet. Connect an agent and it will create one when it checks in, or <button class="link" data-action="new-project">create one now</button>.
      <button class="btn primary" data-action="connect">Connect an agent</button></div></div>`}`;
  }
  return `<div class="phead"><div class="titles"><h1>Home</h1></div>
      <div class="controls"><div class="ctl-row"><span class="seg-label">Depth</span>${zoomControl()}
      ${owner() ? '<a class="btn an-open" href="#/analytics" data-new="analytics">Analytics</a>' : ''}</div></div></div>
    ${homePage(S.home, { z: z(), pulse, card, esc, plural, who, wide: WIDE.matches, gs: getStarted() })}`;}

// ── project ──
function project(v) {
  const P = v.project;
  const zoomSeg = zoomControl();
  const autoSeg = `<div class="seg" role="group" aria-label="Autonomy" data-new="instant-actions">${Object.entries(P.autonomy_options).map(([k, o]) =>
    `<button class="${P.autonomy === k ? 'on' : ''}" aria-pressed="${P.autonomy === k}" data-action="autonomy" data-level="${k}" title="${esc(o.human)}">${esc(o.label)}</button>`).join('')}</div>`;
  const mission = S.editMission
    ? `<div class="inline-form"><input data-draft="mission" id="mission-in" placeholder="What is this project for? Agents read this first." value="${esc(P.mission)}"><button class="btn primary small" data-action="save-mission">Save</button><button class="btn ghost small" data-action="cancel-mission">Cancel</button></div>`
    : `<div class="mission ${P.mission ? '' : 'empty'}" data-action="edit-mission" title="Click to edit. Every agent reads the mission at checkin.">${esc(P.mission || 'Add a mission: the north star every agent reads at checkin')}</div>`;

  // The repositories this project is: any clone of one, on any machine, finds the project.
  const remotes = `<div class="where">${P.remotes.length ? `Repo ${P.remotes.map((r) => `<code>${esc(r)}</code><button class="link" data-action="remote-remove" data-remote="${esc(r)}" title="Unlink this repository">×</button>`).join(' ')}` : '<span class="faint">No repository linked yet: the first agent that checks in from a clone teaches the hub.</span>'}
    ${S.addRemote
      ? `<div class="inline-form"><input data-draft="remote" id="remote-in" placeholder="github.com/acme/api, or any git remote URL"><button class="btn primary small" data-action="remote-add">Link</button><button class="btn ghost small" data-action="remote-cancel">Cancel</button></div>`
      : `<button class="link" data-action="remote-new" title="Link a git remote: every clone of it, on any machine, reaches this project">+ repo</button>`}</div>`;
  const empty = !v.all.length && !v.agents.length;
  return `
    <div class="phead">
      <div class="titles"><h1>${esc(P.name)}</h1>${mission}${z() >= 1 || S.addRemote ? remotes : ''}</div>
      <div class="controls">
        <div class="ctl-row"><span class="seg-label">Depth</span>${zoomSeg}</div>
        ${z() >= 1 ? `<div class="ctl-row"><span class="seg-label">Autonomy</span>${autoSeg}
        <button class="btn settings-btn" data-action="settings" data-new="project-settings" title="Staffing, freshness, GitHub, park or remove">Settings</button></div>` : ''}
      </div>
    </div>
    ${!P.runner && P.staffing && !P.staffing.asked ? `<div class="staff-ask"><div><b>Let <code>nuworq run</code> staff this project?</b> It starts headless workers whenever work is waiting, and they can cost money. Off until you say.</div>
      <div class="actions"><button class="btn primary" data-action="runner-on">Let run staff it</button><button class="btn ghost" data-action="staff-not-now">Not now</button></div></div>` : ''}
    ${projectBody(v, empty)}`;
}

// The staffing in a few words (#174): paused, budget spent for today, or the limit and budget that apply.
function staffLine(s) {
  if (!s) return '';
  if (s.paused) return 'paused';
  if (s.stopped === 'budget') return `today's $${s.budget.toFixed(2)} spent`;
  return [s.workers ? `up to ${s.workers} at once` : 'runners decide how many', s.budget != null ? `$${s.budget.toFixed(2)}/day` : ''].filter(Boolean).join(' · ');
}
// The same as a sentence, for the Settings dialog (#213): the limit and the budget, both always said.
function staffWords(s) {
  if (!s) return '';
  const said = `${s.workers ? `Up to ${s.workers} at once` : 'As many at once as each runner allows'}, ${s.budget != null ? `$${s.budget.toFixed(2)} a day` : 'no daily budget'}`;
  return s.paused ? `${said}. Paused: no new workers start.` : s.stopped === 'budget' ? `${said}. Today's budget is spent.` : `${said}.`;
}

// The project's sections: one column on a phone; wide (#141), the work in the main column and the pulse,
// flow and agents beside it, the same sections either way. Each starts at its own depth; Flow at every depth (Paul's decision).
function projectBody(v, empty) {
  const more = z() < 2 && !empty ? `<div class="zoom-more">${z() === 0
    ? `That's the 30-second view. <button data-action="zoom" data-zoom="5m">Go to 5m</button> for what's worth knowing, what's next, what finished, and how agents are doing.`
    : `<button data-action="zoom" data-zoom="30m">Go to 30m</button> for the full activity record, every item and agent diagnostics.`}</div>` : '';
  const s = {
    pulse: pulse(v), composer: composer(v), empty: empty ? emptyProject() : '', needs: needsYou(v), groups: groups(v), motion: motion(v),
    worth: z() >= 1 ? worthKnowing(v) : '', flow: flow(v), next: z() >= 1 ? upNext(v) : '', finished: z() >= 1 ? finished(v) : '',
    steering: z() >= 1 ? steering(v) : '', agents: z() >= 1 ? agents(v) : '', runners: z() >= 1 ? runners(v) : '', activity: z() >= 2 ? activity(v) : '', all: z() >= 2 ? allWork(v) : '', more,
  };
  const order = (keys) => keys.map((k) => s[k]).join('');
  if (WIDE.matches && !empty) return columns(order(['composer', 'needs', 'groups', 'motion', 'worth', 'next', 'finished', 'steering', 'activity', 'all', 'more']), order(['pulse', 'flow', 'agents', 'runners']), `p:${S.slug}`);
  return order(['pulse', 'composer', 'empty', 'needs', 'groups', 'motion', 'worth', 'flow', 'next', 'finished', 'steering', 'agents', 'runners', 'activity', 'all', 'more']);
}

function emptyProject() {
  return `<section class="sec"><div class="zero"><span class="check">→</span><div>
    <b>No work yet.</b> Add some above, or connect an agent and let it propose what matters.
    <button class="btn primary small" data-action="connect">Connect an agent</button></div></div></section>`;
}

function pulse(v) {
  const label = STATE_LABELS[v.pulse.state];
  const c = v.since.counts;
  const bits = [
    c.finished && `<b>${c.finished}</b> finished`,
    c.submitted && `<b>${c.submitted}</b> submitted`,
    c.started && `<b>${c.started}</b> started`,
    c.proposed && `<b>${c.proposed}</b> proposed`,
    c.sent_back && `<b>${c.sent_back}</b> sent back`,
  ].filter(Boolean);
  const since = v.since.at
    ? bits.length ? `Since you last looked (${v.since.ago} ago): ${bits.join(' · ')}` : `No agent activity since you last looked (${v.since.ago} ago).`
    : v.home ? 'Everything here is new to you.' : 'Everything in this project is new to you.';
  // On the home, each finished item names its project, and its link opens it there.
  const list = z() >= 1 && v.since.finished.length
    ? `<div class="since-list">${v.since.finished.slice(0, 6).map((f) => `<div${f.project ? ` data-project="${esc(f.project.slug)}"` : ''}>✓ ${refLink(f.item)} ${esc(f.title)} <span class="age">${f.project ? `${esc(f.project.name)} · ` : ''}by ${esc(f.by === 'you' ? 'you' : f.by)}</span></div>`).join('')}</div>` : '';
  // Who is here now, as counts by role (#441): on the home at every depth, on a project at 30s (5m on has its Agents section).
  const here = v.home ? hereNow(v.agents ?? [], 'home') : z() === 0 ? hereNow(v.agents.filter((a) => a.present), S.slug) : '';
  return `<div class="pulse state-${v.pulse.state}">
      <div class="state-chip">${stateDot(v.pulse.state)}${label}</div>
      <div class="sentence">${esc(v.pulse.sentence)}</div>
      ${here}
      ${v.project.parked ? `<div class="actions"><button class="btn primary small" data-action="unpark-project">Unpark</button></div>` : ''}
      <div class="since"><span>${since}</span><span class="spacer"></span>
        ${c.updates || !v.since.at ? `<button class="btn small" data-action="seen" title="Count from now: what changes after this shows as new next time. Nothing that needs you goes away.">Mark all seen</button>` : ''}
        ${list}</div>
    </div>`;
}

function composer(v) {
  const hints = {
    steer: 'Every agent must read and acknowledge it. You\'ll see who did.',
    decision: 'A standing rule. Every agent gets it at every checkin.',
    note: 'For the record. Agents may see it; no acknowledgement needed.',
  };
  const kinds = { steer: 'Steer', decision: 'Decision', note: 'Note' };
  return `<div class="composer">
      <div class="box">
        <textarea id="compose" data-draft="compose" placeholder="Say something to your agents…${KEYBOARD.matches ? ' (⌘↵ to send)' : ''}"></textarea>
        <div class="row">
          <div class="seg">${Object.entries(kinds).map(([k, l]) => `<button class="${S.composeKind === k ? 'on' : ''}" data-action="compose-kind" data-kind="${k}">${l}</button>`).join('')}</div>
          <span class="hint">${hints[S.composeKind]}</span>
          <button class="btn primary small" data-action="compose-send">Send</button>
        </div>
      </div>
      <button class="btn" data-action="toggle-add"data-new="propose-work" aria-expanded="${!!S.addWork}">${S.addWork ? 'Close' : '+ Work'}</button>
    </div>
    ${S.addWork ? proposeForm({ more: S.addMore, priority: S.drafts['nw-priority'] ?? 'soon', autonomy: v?.project.autonomy }) : ''}`;
}

// ── 30s: what needs you ──
function needsYou(v) {
  const act = v.attention.filter((a) => a.level === 'act');
  const body = act.length
    ? `<div class="cards">${act.map(card).join('')}</div>`
    : `<div class="zero"><span class="check good">✓</span><div><b>Nothing needs you.</b> ${v.pulse.active ? 'Agents are working; you\'ll see things here when they need a decision, an answer or a verification.' : 'When agents need a decision, an answer or a verification, it shows up here.'}</div></div>`;
  return `<section class="sec"><header><h2>Needs you</h2>${act.length ? `<span class="count">${act.length}</span>` : ''}
    ${act.length ? '<span class="hint">oldest first; each one moves work to its next stage</span>' : ''}</header>${body}</section>`;
}

// ── 30s: the milestones (web/milestones.js): one line each; a tap opens its map. ──
const groups = (v) => milestonesSection(v, { esc });
const prioritySeg = (item, priority) => milestonePriority(item, priority, { esc });

// A milestone's map in the drawer: the nested tree, each item with its stage, who holds it, what it waits on,
// its pull requests and open questions, and a mark on what needs you. At each level what's left comes first,
// and the done parts fold behind one line until tapped (#215). Dropped parts show only at 30m, behind
// "Show dropped" (#442).
function groupMap(n) {
  const li = (c) => `<li>${mapLine(c)}${kids(c)}</li>`;
  const kids = (x) => {
    const { open, folded, label, dropped } = mapParts(x.children);
    const key = `mapdone:${x.item}`, shown = S.open.has(key);
    const fold = folded.length ? `<li class="m-fold"><button class="link" data-action="toggle" data-key="${esc(key)}" aria-expanded="${shown}">${shown ? `Hide ${label}` : label}</button></li>` : '';
    const dkey = `mapdrop:${x.item}`, dshown = S.open.has(dkey);
    const drops = z() >= 2 && dropped.length ? `<li class="m-fold"><button class="link" data-action="toggle" data-key="${esc(dkey)}" aria-expanded="${dshown}">${dshown ? 'Hide dropped' : `Show dropped (${dropped.length})`}</button></li>${dshown ? dropped.map(li).join('') : ''}` : '';
    if (!open.length && !fold && !drops) return '';
    return `<ul>${open.map(li).join('')}${fold}${shown ? folded.map(li).join('') : ''}${drops}</ul>`;
  };
  return `<div class="map">${kids(n)}</div>`;
}
function mapLine(n) {
  return `<div class="m-line${n.needs_you ? ' you' : ''}">${refLink(n.item)} <span class="m-title">${esc(n.title)}</span> ${stagePill(n.stage, courtOf(n.stage))}${n.holder ? ` ${who(n.holder)}` : ''}${n.needs_you ? ' <span class="tag you">needs you</span>' : ''}
    ${n.depends_on.length ? `<span class="age">waits on ${n.depends_on.map(refLink).join(', ')}</span>` : ''}${n.prs.map((pr) => ` <a href="${esc(pr.url)}" target="_blank" rel="noopener">PR #${pr.number}${pr.ci === 'fail' ? ' ✗' : pr.ci === 'pass' ? ' ✓' : ''}</a>`).join('')}</div>
    ${n.questions.map((q) => `<div class="m-q">${q.to === 'operator' ? 'To the operator' : q.blocking ? 'Asks you' : 'Assumed'}: ${esc(q.question)}</div>`).join('')}`;
}

// What each Needs you card is, in plain words: one per kind the hub puts at level "act" (test/cardlabels.test.js).
const CARD_LABELS = {
  question: 'Question', review: 'Ready to verify', proposal: 'Shaped, needs your approval', struggling: 'Keeps bouncing', direction: 'Direction',
  'no-agents': 'Nobody is working', 'group-stalled': 'A "now" milestone is stalled', 'ci-failing': 'CI is failing', 'pr-review': 'Needs your approval on GitHub',
  'operator-missing': 'No operator connected', 'kept-parked': 'Kept parked', 'app-wiring': 'GitHub App setup', 'payment-failed': 'Payment failed',
  'plan-limit': 'Free plan limit',
};

function card(a) {
  const label = a.kind === 'question' && a.escalation ? 'Escalated by an operator' : CARD_LABELS[a.kind] ?? 'Needs you';
  const key = 'a:' + a.key;
  const open = S.open.has(key) || z() >= 2;
  const hasMore = a.why || a.detail || a.acceptance;
  const more = open && hasMore ? `<div class="more">
      ${a.why ? md(a.why) : ''}
      ${a.acceptance ? `<div class="label">Done means</div>${md(a.acceptance)}` : ''}
      ${a.detail ? `<div class="label">Detail</div>${md(a.detail)}` : ''}
    </div>` : '';
  return `<article class="card kind-${a.kind}">
    <div class="card-top"><span class="kind">${label}</span>${refLink(a.item)}<span class="sub">${named(a.sub, a.agent, a.presence)}</span></div>
    <h3>${esc(a.headline)}</h3>
    ${a.attempts?.length > 1 ? attemptsGrid(a.item, a.attempts) : `${a.evidence?.length ? `<div class="evidence">${a.evidence.map((e) => `<span class="ev">${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.label)}</a>` : esc(e.label)}</span>`).join('')}</div>` : ''}
    ${commits(a.git)}`}
    ${a.warn ? `<div class="warn">⚠ ${esc(a.warn)}</div>` : ''}
    ${a.steps?.length ? stepList(a) : ''}
    ${a.how?.length ? howList(a.how) : ''}
    ${a.kind === 'proposal' && a.acceptance && !open ? `<div class="more"><div class="label" style="margin-top:0">Done means</div>${md(a.acceptance)}</div>` : ''}
    ${more}
    ${cardActions(a, hasMore, open, key)}
  </article>`;
}

// What the hub says to do about something it noticed (#173: why nobody is working), as numbered steps with the
// exact place and how to see it worked. Not a question, so nothing to tick.
function howList(how) {
  return `<div class="steps"><ol>${how.map((s, i) => `<li>
      <div class="step-tick" style="cursor:default"><span class="box" aria-hidden="true">${i + 1}</span><span class="do">${inline(s.do)}</span></div>
      ${s.where || s.check ? `<div class="step-more">${stepWhere(s.where)}${s.check ? `<div class="step-check">${inline(s.check)}</div>` : ''}</div>` : ''}
    </li>`).join('')}</ol></div>`;
}

// A step's place: a URL opens in a new tab; commands each get their own Copy, joined by their words (#379).
const stepWhere = (where) => (!where ? '' : /^https?:\/\/\S+$/i.test(where.trim())
  ? `<a class="step-where" href="${esc(where.trim())}" target="_blank" rel="noopener">${esc(where.trim())}</a>`
  : commandBlocks(where));

// Steps an agent wrote say so above their Copy buttons: their commands are the agent's words, not the hub's.
// A person ('you', '@handle') or the hub itself ('nuworq') wrote the rest.
const stepsBy = (asker) => (!asker || asker === 'you' || asker === 'nuworq' || String(asker).startsWith('@') ? ''
  : `<div class="steps-by">Written by ${esc(asker)}, an agent, not by nuworq. Read each command before you run it.</div>`);

// A question's steps as a checklist the person ticks off (#162), shown at every depth. The row is the tick target;
// a URL opens in a new tab, each command gets a Copy button. Ticks are the viewer's own and survive a reload.
function stepList(a) {
  const done = new Set(a.ticked ?? []);
  const q = a.question.id;
  return `<div class="steps" data-new="step-checklist">
    <div class="steps-head"><span class="label">Steps</span><span class="steps-count">${[...done].filter((n) => n <= a.steps.length).length} of ${a.steps.length} done</span></div>
    ${stepsBy(a.question.asked_by)}
    <ol>${a.steps.map((s, i) => {
      const n = i + 1;
      const on = done.has(n);
      const where = stepWhere(s.where);
      return `<li class="${on ? 'on' : ''}">
        <button class="step-tick" data-action="step" data-q="${q}" data-step="${n}" data-done="${on ? '' : '1'}" aria-pressed="${on}">
          <span class="box" aria-hidden="true">${on ? '✓' : n}</span><span class="do">${inline(s.do)}</span></button>
        ${where || s.check ? `<div class="step-more">${where}${s.check ? `<div class="step-check">${inline(s.check)}</div>` : ''}</div>` : ''}
      </li>`;
    }).join('')}</ol>
  </div>`;
}

// A raced item's submissions side by side, each with its own "Keep this one".
function attemptsGrid(item, attempts, { keep = true } = {}) {
  return `<div class="attempts">${attempts.map((s) => `<div class="attempt ${s.stage}">
      <div class="meta">${who(s.agent, s.model)} <span class="age">${esc(s.model || '')}${s.took ? ` · ${esc(s.took)}` : ''}</span>${s.stage === 'chosen' ? '<span class="tag go">kept</span>' : s.stage === 'not_chosen' ? '<span class="tag">not chosen</span>' : ''}</div>
      <div class="h">${esc(s.headline)}</div>
      ${s.branch ? `<div class="touch"><code>${esc(s.branch)}</code>${s.commits?.length ? ` ${s.commits.map((c) => `<code title="${esc(c.subject ?? '')}">${esc(String(c.hash ?? c).slice(0, 7))}</code>`).join(' ')}` : ''}</div>` : ''}
      ${s.evidence?.length ? `<div class="evidence">${s.evidence.map((e) => `<span class="ev">${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.label)}</a>` : esc(e.label)}</span>`).join('')}</div>` : '<div class="warn">⚠ No evidence attached</div>'}
      ${keep && s.stage === 'submitted' ? `<button class="btn small" data-action="keep" data-item="${esc(item)}" data-attempt="${s.n}">Keep this one</button>` : ''}
    </div>`).join('')}</div>`;
}

// What an item cost, per agent and model. A local model has tokens but no price: its cost is "—".
function usageTable(u) {
  const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  // Measured by llm-proxy: model time, and failed requests and cold loads when there were any.
  const secs = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`);
  const measured = (r) => (r.duration_ms == null ? '' : ` · ${secs(r.duration_ms)} model time${r.failures ? ` · ${r.failures} failed` : ''}${r.cold_loads ? ` · ${r.cold_loads} cold loads` : ''}`);
  const line = (r) => `${tok(r.input_tokens)} in · ${tok(r.output_tokens)} out · ${r.cost_usd == null ? '—' : `$${r.cost_usd.toFixed(2)}`}${measured(r)}`;
  const tag = (r) => (r.source === 'llm-proxy' ? ' · measured' : r.superseded ? ' · reported, superseded' : r.source === 'agent' ? ' · reported' : '');
  return `<div class="d-sec"><div class="label">Usage</div><dl class="kv">
    ${u.rows.map((r) => `<dt>${who(r.agent, r.model)} <span class="age">${esc(r.model || '?')}${tag(r)}</span></dt><dd>${r.superseded ? `<s>${line(r)}</s>` : line(r)}</dd>`).join('')}
    <dt><b>Total</b></dt><dd><b>${line(u.total)}</b></dd></dl></div>`;
}

function cardActions(a, hasMore, open, key) {
  if (a.kind === 'direction') {
    return `<div class="answer">
      <div class="picks">${a.picks.map((p) => `<button class="pick" data-action="pick" data-item="${esc(p.item)}" title="${esc(p.summary || '')}"><span class="ref">${esc(p.item)}</span>${esc(p.title)}</button>`).join('')}</div>
      <div class="actions" style="margin-top:0"><button class="btn ghost small" data-action="park">Park this project instead</button><span style="flex:1"></span>${hasMore ? `<button class="link" data-action="toggle" data-key="${esc(key)}">${open ? 'Less' : 'How this works'}</button>` : ''}</div>
    </div>`;
  }
  if (a.kind === 'no-agents') {
    // The one fix first: let nuworq run staff it when that's all it takes; otherwise start an agent.
    return `<div class="actions">${a.staff
      ? '<button class="btn primary" data-action="runner-on">Let nuworq run staff this project</button><button class="btn" data-action="connect">Start an agent</button>'
      : '<button class="btn primary" data-action="connect">Start an agent</button>'}<button class="btn ghost" data-action="park">Park this project</button></div>`;
  }
  const moreBtn = hasMore ? `<button class="link" data-action="toggle" data-key="${esc(key)}">${open ? 'Less' : 'Why it needs you'}</button>` : '';
  if (a.kind === 'group-stalled') {
    return `<div class="actions"><button class="btn" data-action="open" data-item="${esc(a.item)}">Open ${esc(a.item)}</button><button class="btn ghost" data-action="dismiss" data-key="${esc(a.key)}">Not now</button>${moreBtn}</div>`;
  }
  if (a.kind === 'question') {
    const q = a.question;
    return `<div class="answer">
      ${q.options?.length ? `<div class="opts">${q.options.map((o) => `<button class="opt" data-action="answer" data-q="${q.id}" data-answer="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
      <div class="answer-row"><input data-draft="ans-${q.id}" id="ans-${q.id}" placeholder="${q.options?.length ? 'Or write your own answer…' : 'Your answer…'}"><button class="btn primary" data-action="answer-text" data-q="${q.id}">Answer</button></div>
      <div class="actions" style="margin-top:0"><label class="check-label"><input type="checkbox" data-draft="dec-${q.id}" id="dec-${q.id}"> Make this a standing decision for all agents</label>${a.parked ? `<label class="check-label" title="Record the answer, but don't hand the work back to agents yet"><input type="checkbox" data-draft="keep-${q.id}" id="keep-${q.id}"> Keep it parked</label>` : ''}<span style="flex:1"></span>${moreBtn}</div>
    </div>`;
  }
  if (a.kind === 'operator-missing') {
    return `<div class="actions"><a class="btn primary" href="${esc(a.guide)}" target="_blank" rel="noopener">How to start an operator</a><button class="btn ghost" data-action="dismiss" data-key="${esc(a.key)}">Not now</button>${moreBtn}</div>`;
  }
  if (a.kind === 'payment-failed') {
    return `<div class="actions"><button class="btn primary" data-action="billing-portal">Manage billing</button>${moreBtn}</div>`;
  }
  if (a.kind === 'plan-limit') {
    return `<div class="actions"><button class="btn primary" data-action="workspace-settings">Upgrade</button><button class="btn ghost" data-action="dismiss" data-key="${esc(a.key)}">Not now</button>${moreBtn}</div>`;
  }
  if (a.kind === 'kept-parked') {
    return `<div class="actions"><button class="btn primary" data-action="unpark" data-item="${esc(a.item)}">Unpark</button><button class="btn ghost" data-action="open" data-item="${esc(a.item)}">Open</button>${moreBtn}</div>`;
  }
  if (a.kind === 'review') {
    const r = `sb:${a.item}`;
    const race = a.attempts?.length > 1;
    return `<div class="actions">
      ${race ? '' : `<button class="btn primary" data-action="accept" data-item="${esc(a.item)}">Accept</button>`}
      ${S.reveal.has(r)
        ? `<div class="inline-form grow"><input data-draft="${r}" id="${r}" placeholder="What's missing? The next agent starts from this."><button class="btn primary" data-action="sendback" data-item="${esc(a.item)}">Send ${race ? 'all ' : ''}back</button></div>`
        : `<button class="btn" data-action="reveal" data-key="${r}">Send ${race ? 'all ' : ''}back…</button>`}
      <button class="btn ghost" data-action="open" data-item="${esc(a.item)}">Open</button>${moreBtn}
    </div>`;
  }
  if (a.kind === 'proposal') {
    return `<div class="actions">
      <button class="btn primary" data-action="approve" data-item="${esc(a.item)}">Approve</button>
      <button class="btn" data-action="drop" data-item="${esc(a.item)}">Drop</button>
      <button class="btn ghost" data-action="open" data-item="${esc(a.item)}">Open</button>${moreBtn}
    </div>`;
  }
  if (a.kind === 'pr-review') {
    return `<div class="actions">
      <a class="btn primary" href="${esc(a.pr.url)}" target="_blank" rel="noopener">Approve PR #${a.pr.number} on GitHub</a>
      <button class="btn ghost" data-action="open" data-item="${esc(a.item)}">Open</button>${moreBtn}
    </div>`;
  }
  if (a.kind === 'ci-failing') {
    const r = `sb:${a.item}`;
    return `<div class="evidence">${a.pr.checks.map((c) => checkChip(c, esc)).join('')}</div>
      <div class="actions">
      ${S.reveal.has(r)
        ? `<div class="inline-form grow"><input data-draft="${r}" id="${r}" placeholder="What failed? The next agent starts from this."><button class="btn primary" data-action="sendback" data-item="${esc(a.item)}">Send back</button></div>`
        : `<button class="btn primary" data-action="reveal" data-key="${r}">Send back…</button>`}
      ${a.pr.url ? `<a class="btn" href="${esc(a.pr.url)}" target="_blank" rel="noopener">PR #${a.pr.number}</a>` : ''}
      <button class="btn ghost" data-action="open" data-item="${esc(a.item)}">Open</button>
      <button class="btn ghost" data-action="dismiss" data-key="${esc(a.key)}">Not now</button>${moreBtn}
    </div>`;
  }
  if (a.kind === 'struggling') {
    const r = `cl:${a.item}`;
    return `<div class="actions">
      ${S.reveal.has(r)
        ? `<div class="inline-form grow"><input data-draft="${r}" id="${r}" placeholder="Clarify the intent. Whoever picks it up next must read this."><button class="btn primary" data-action="clarify" data-item="${esc(a.item)}">Steer</button></div>`
        : `<button class="btn primary" data-action="reveal" data-key="${r}">Clarify…</button>`}
      <button class="btn" data-action="open" data-item="${esc(a.item)}">Open</button>
      <button class="btn ghost" data-action="drop" data-item="${esc(a.item)}">Drop</button>
      <button class="btn ghost" data-action="dismiss" data-key="${esc(a.key)}">Not now</button>${moreBtn}
    </div>`;
  }
  return '';
}

// ── 5m: worth knowing ──
function worthKnowing(v) {
  const know = v.attention.filter((a) => a.level === 'know');
  if (!know.length) return '';
  const rows = know.map((a) => {
    let acts = `<button class="btn ghost small" data-action="dismiss" data-key="${esc(a.key)}">Got it</button>`;
    if (a.kind === 'assumption') {
      const r = `ov:${a.question.id}`;
      acts = S.reveal.has(r)
        ? `<div class="inline-form" style="width:320px"><input data-draft="${r}" id="${r}" placeholder="Instead…"><button class="btn primary small" data-action="override" data-q="${a.question.id}">Override</button></div>`
        : `<button class="btn small" data-action="confirm" data-q="${a.question.id}">Confirm</button><button class="btn small" data-action="reveal" data-key="${r}">Override…</button>`;
    }
    if (a.kind === 'proposal') acts = `<button class="btn small" data-action="open" data-item="${esc(a.item)}">Look</button>` + acts;
    if (a.start) acts = `<button class="btn small" data-action="connect">Start an agent</button>` + acts;
    if (a.kind === 'notify-failing') acts = `<button class="btn small" data-action="notify">Check it</button>` + acts;
    if (a.kind === 'outside-overdue') acts = `<button class="btn small" data-action="check-now" data-item="${esc(a.item)}">Check now</button><button class="btn small" data-action="open" data-item="${esc(a.item)}">Edit it</button>` + acts;
    if (a.kind === 'peer-review-stuck') acts =`<button class="btn small" data-action="open" data-item="${esc(a.item)}">Review it</button>` + acts;
    // Stuck on a capability nobody has: the choices are to let any agent take it, or keep waiting for one that has it.
    // Infrastructure work can't go to just any agent: the steps start an operator session instead (#201).
    if (a.kind === 'unfit' && a.operator) acts = `<button class="btn ghost small" data-action="dismiss" data-key="${esc(a.key)}">Keep waiting</button>`;
    else if (a.kind === 'unfit') acts = `<button class="btn small" data-action="needs" data-item="${esc(a.item)}" data-needs="${esc(JSON.stringify(a.keep ?? []))}" title="Drop ${esc((a.missing ?? []).join(', '))} from what it needs">Let any agent take it</button><button class="btn ghost small" data-action="dismiss" data-key="${esc(a.key)}">Keep waiting</button>`;
    // "Got it" is for news; next to a real action, dismissing just hides it.
    else if (/data-action="(open|connect|notify)"/.test(acts)) acts = acts.replace('>Got it</button>', '>Hide</button>');
    return `<div class="row-item"${a.key ? ` data-key="know:${esc(a.key)}"` : ''}><div class="body"><div class="h">${esc(a.headline)}</div><div class="s">${a.item ? refLink(a.item) + ' ' : ''}${esc(a.sub)}</div>
      ${z() >= 2 && a.why ? `<div class="s" style="margin-top:var(--sp-1)">${esc(a.why)}</div>` : ''}${a.how?.length ? howList(a.how) : ''}</div><div class="acts">${acts}</div></div>`;
  }).join('');
  return `<section class="sec"><header><h2>Worth knowing</h2><span class="count">${know.length}</span><span class="hint">agents carried on without you; glance and confirm, or redirect</span></header><div class="rows">${rows}</div></section>`;
}

// ── 30s → 5m: what's in motion ──
function motion(v) {
  if (!v.motion.length) return '';
  const rows = v.motion.map((m) => `
    <div class="row-item clickable" data-action="open" data-item="${esc(m.item)}">
      <div class="body">
        <div class="h">${who(m.agent, m.model)} ${refLink(m.item)} <span>${esc(m.title)}</span>${repoTag(m)}${m.shaping ? '<span class="tag shaping">shaping</span>' : ''}${m.landing ? '<span class="tag shaping">landing</span>' : ''}${m.priority === 'now' ? '<span class="tag now">now</span>' : ''}${m.race ? `<span class="tag soon">race of ${m.race}</span>` : m.attempt > 1 ? `<span class="tag soon">attempt ${m.attempt}</span>` : ''}</div>
        ${z() >= 1 && m.last ? `<div class="last ${m.quiet ? 'quiet' : ''}">${m.last.type === 'claimed' ? 'Just picked it up' : m.last.type === 'shaping' ? 'Started shaping it' : named(m.last.headline, m.agent, undefined, { beside: true })}</div>` : ''}
        ${z() >= 1 && m.touching?.length ? `<div class="touch">${m.touching.map((t) => `<code>${esc(t)}</code>`).join(' ')}</div>` : ''}
        ${z() >= 1 && m.heads_up ? `<div class="headsup">⚠ ${esc(m.heads_up.split('. ')[0])}</div>` : ''}
        ${z() >= 2 && m.last?.summary ? `<div class="s">${md(m.last.summary)}</div>` : ''}
      </div>
      <span class="age" title="Lease: ${esc(m.lease_left)} left">${m.last ? esc(m.last.ago) + ' ago' : ''}${z() >= 1 ? ` · on it ${esc(m.for)}` : ''}</span>
    </div>`).join('');
  return `<section class="sec motion"><header><h2>In motion</h2><span class="count">${v.motion.length}</span></header><div class="rows">${rows}</div></section>`;
}

// ── 5m: flow ──
function flow(v) {
  const f = v.flow;
  // Dropped work isn't on the board (#442): All work's "Show dropped", at 30m, lists it.
  const stages = f.stages.filter((s) => s.stage !== 'dropped');
  const pills = stages.map((s) => `<button class="stage stage-${s.stage} court-${s.court ?? 'none'} ${S.stage === s.stage ? 'on' : ''} ${s.count ? '' : 'zero-count'}" data-action="stage" data-stage="${s.stage}" title="${esc(s.blurb)}"><span class="n">${s.count}</span><span class="l">${esc(s.label)}</span></button>`).join('<span class="arrow">→</span>');
  let detail = '';
  if (S.stage) {
    const st = f.stages.find((s) => s.stage === S.stage);
    const here = boardWork(v.all).rows.filter((i) => i.stage === S.stage);
    // Approved feedback about nuworq (#295) is marked, and can be shown on its own.
    const fb = here.some((i) => i.feedback);
    const items = here.filter((i) => !S.onlyFeedback || !fb || i.feedback).slice(-25).reverse();
    detail = `<div class="stage-detail"><div class="blurb"><b>${esc(st.label)}.</b> ${esc(st.blurb)} ${st.court ? `<i>Whose move: ${st.court === 'you' ? 'yours' : st.court === 'agents' ? "the agents'" : st.court === 'external' ? 'someone outside this hub' : 'nobody yet (waiting for an agent)'}.</i>` : ''} ${st.ms ? `Work spent ${esc(st.time)} here in the last 14 days.` : ''}</div>
      ${fb ? `<button class="chip fb-only ${S.onlyFeedback ? 'on' : ''}" data-action="only-feedback" aria-pressed="${!!S.onlyFeedback}">Feedback only</button>` : ''}
      ${items.length ? items.map((i) => `<div>${refLink(i.item)} ${i.feedback ? '<span class="tag fb-tag">feedback</span> ' : ''}${esc(i.title)} <span class="age">${esc(i.ago)}</span></div>`).join('') : `<div class="age">${STAGE_EMPTY[S.stage] ?? 'Nothing here.'}</div>`}</div>`;
  }
  const c = f.court;
  const hasTime = c.agents + c.queue + c.you + (c.external ?? 0) > 0;
  const max = Math.max(1, ...f.throughput);
  return `<section class="sec"><header><h2>Flow</h2><span class="hint">the lifecycle, and whose move it is (last 14 days)</span></header>
    <div class="flow">
      <div class="stages">${pills}</div>
      ${detail}
      ${hasTime ? `<div class="courtbar">
          ${c.agents ? `<span class="seg-c agents" style="flex:${c.agents}">${c.agents >= 8 ? c.agents + '%' : ''}</span>` : ''}
          ${c.queue ? `<span class="seg-c queue" style="flex:${c.queue}">${c.queue >= 8 ? c.queue + '%' : ''}</span>` : ''}
          ${c.you ? `<span class="seg-c you" style="flex:${c.you}">${c.you >= 8 ? c.you + '%' : ''}</span>` : ''}
          ${c.external ? `<span class="seg-c external" style="flex:${c.external}">${c.external >= 8 ? c.external + '%' : ''}</span>` : ''}
        </div>
        <div class="legend"><span><i class="agents"></i>Agents working ${c.agents}%</span><span><i class="queue"></i>Waiting for an agent ${c.queue}%</span><span><i class="you"></i>Waiting on you ${c.you}%</span>${c.external ? `<span><i class="external"></i>Waiting outside ${c.external}%</span>` : ''}</div>` : ''}
      ${f.takeaway ? `<p class="takeaway">${esc(f.takeaway)}</p>` : ''}
      <div class="throughput">
        <div class="spark" title="Finished per day, last 14 days">${f.throughput.map((n) => `<span class="${n ? '' : 'z'}" style="height:${Math.max(2, Math.round((n / max) * 28))}px" title="${n}"></span>`).join('')}</div>
        <span>${plural(f.finished, 'item')} finished in 14 days${f.median_cycle ? ` · median ${esc(f.median_cycle)} from ready to done` : ''}</span>
      </div>
      ${flowYou(f.you)}
      ${flowHeld(f.verification)}
      ${f.cost ? flowCost(f.cost) : ''}
    </div></section>`;
}

// Whether verification held up (#176): landed work a later item fixes (an escape), per model as builder and as
// peer reviewer, and peer verdicts a person overturned. Silent until there's a peer verdict or an escape.
function flowHeld(v) {
  if (!v || (!v.escaped && !v.peer_accepted)) return '';
  const who = v.by_model.filter((m) => m.built_escaped || m.reviewed_escaped || m.overturned)
    .map((m) => `${esc(m.model ?? 'unknown model')}: ${[m.built_escaped && `built ${m.built_escaped}`, m.reviewed_escaped && `reviewed ${m.reviewed_escaped}`, m.overturned && `${m.overturned} verdict${m.overturned === 1 ? '' : 's'} overturned`].filter(Boolean).join(', ')}`);
  return `<p class="flow-held" title="An escape is landed work that a later item names in fixes">${plural(v.escaped, 'escape')} in ${v.landed} landed${v.peer_accepted ? ` · ${v.overturned} of ${plural(v.peer_accepted, 'peer verdict')} overturned` : ''}${who.length ? ` · ${who.join(' · ')}` : ''}</p>`;
}

// What the work cost you (#175): your actions (answers, verdicts, steers, decisions, comments) per landed item,
// and how long work you had to move waited for you. Nothing to say until you've acted or something landed.
function flowYou(y) {
  if (!y || (!y.actions && !y.landed && !y.waits)) return '';
  const per = y.per_landed != null ? `<b>${y.per_landed}</b> of your actions per landed item` : `${plural(y.actions, 'action')} of yours, nothing landed yet`;
  return `<p class="flow-you" title="Your answers, verdicts, steers, decisions, comments and confirmations over 14 days, against the items that landed">${per}${y.median_wait ? ` · work waited a median <b>${esc(y.median_wait)}</b> for you (${plural(y.waits, 'time')})` : ''}</p>`;
}

// Why a stage is empty, and the one thing to do about it where there is one.
const STAGE_EMPTY = {
  proposed: 'No ideas waiting to be shaped. <button class="link" data-action="toggle-add">+ Work</button>',
  ready: 'Nothing ready: every shaped item is taken or finished. <button class="link" data-action="toggle-add">+ Work</button>',
  outside: 'Nothing is waiting on a check outside this hub.',
  active: 'No agent is working right now. <button class="link" data-action="connect">Start an agent</button>',
  waiting: 'No agent is waiting on an answer from you.',
  verifying: 'Nothing to review: no submissions are waiting.',
  landing: 'Nothing accepted is waiting to land on main.',
  done: 'Nothing finished in the last 3 days. <button class="link" data-action="launcher">Search</button> finds older work.',
};

// The repository an item lands in, when its project has several (the hub sends null otherwise).
const repoTag = (i) => i.repo ? ` <span class="tag" title="Lands in this repository">${esc(i.repo)}</span>` : '';

// What finished work cost per model; a local model shows tokens, having no price.
function flowCost(c) {
  const usd = (n) => `$${n.toFixed(2)}`;
  const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const row = (m) => `<dt>${esc(m.model || 'unknown model')} <span class="age">${plural(m.items, 'item')}</span></dt><dd>${m.median_usd != null
    ? `median ${usd(m.median_usd)} per item · ${usd(m.total_usd)} total`
    : `median ${tok(m.median_tokens)} tokens per item · ${tok(m.total_tokens)} total`}</dd>`;
  return `<div class="cost"><dl class="kv">${c.by_model.map(row).join('')}
    <dt><b>Spent</b></dt><dd><b>${c.spend_usd != null ? usd(c.spend_usd) : '—'}</b> in 14 days</dd></dl></div>`;
}

function itemRow(i, extra = '') {
  const notes = [
    i.blocked_by?.length && `after ${i.blocked_by.join(', ')}`,
    i.handoff?.kind === 'sent_back' && `sent back: "${i.handoff.headline}"`,
    i.handoff?.kind === 'handoff' && `${i.handoff.by} left a note`,
    i.attempts > 1 && `${i.attempts} attempts`,
  ].filter(Boolean).join(' · ');
  return `<div class="row-item clickable" data-action="open" data-item="${esc(i.item)}">
    <span class="tag ${i.priority}">${i.priority}</span>
    <div class="body"><div class="h">${refLink(i.item)} ${esc(i.title)}${repoTag(i)}</div>${notes || extra ? `<div class="s">${esc(notes)}${extra}</div>` : ''}</div>
    <span class="age">${esc(i.ago)}</span></div>`;
}

function upNext(v) {
  if (!v.queue.length) return v.all.length ? `<section class="sec"><header><h2>Up next</h2></header>
    ${zero('<b>Nothing ready for an agent to pick up.</b> Everything here is in progress, waiting, still being shaped or finished.', '<button class="link" data-action="toggle-add">+ Work</button>')}</section>` : '';
  const shown = z() >= 2 ? v.queue : v.queue.slice(0, 5);
  return `<section class="sec"><header><h2>Up next</h2><span class="count">${v.queue.length}</span><span class="hint">ready for any agent, in the order they'll be picked</span></header>
    <div class="rows">${shown.map((i) => itemRow(i)).join('')}</div>
    ${v.queue.length > shown.length ? `<div class="zoom-more">+${v.queue.length - shown.length} more at 30m</div>` : ''}</section>`;
}

function finished(v) {
  if (!v.done.length) return '';
  const shown = z() >= 2 ? v.done : v.done.slice(0, 5);
  return `<section class="sec"><header><h2>Recently finished</h2><span class="count">${v.done.length}</span><span class="hint">last 3 days</span></header>
    <div class="rows">${shown.map((i) => i.parts ? finishedMilestone(i) : `<div class="row-item clickable" data-action="open" data-item="${esc(i.item)}">
      <div class="body"><div class="h">✓ ${refLink(i.item)} ${esc(i.title)}</div>${credit(i, who) ? `<div class="s">${credit(i, who)}</div>` : ''}</div>
      <span class="age">${esc(i.ago)} ago</span></div>`).join('')}</div></section>`;
}
// A finished milestone is one line (#442): its title, how many parts, when it finished. Tapping the parts count
// opens them under it.
function finishedMilestone(i) {
  const key = `fin:${i.item}`, shown = S.open.has(key);
  return `<div class="row-item fin-ms" data-key="${esc(key)}" data-new="finished-milestones"><div class="body">
    <div class="h">✓ ${refLink(i.item)} ${esc(i.title)}</div>
    <button class="link fin-parts" data-action="toggle" data-key="${esc(key)}" aria-expanded="${shown}">${shown ? 'Hide parts' : `${plural(i.parts.length, 'part')}`}</button>
    ${shown ? `<ul class="fin-list">${i.parts.map((c) => `<li>${refLink(c.item)} ${esc(c.title)}${c.stage === 'done' ? '' : ` ${stagePill(c.stage, courtOf(c.stage))}`}</li>`).join('')}</ul>` : ''}</div>
    <span class="age">finished ${esc(i.ago)} ago</span></div>`;
}

function steering(v) {
  if (!v.steers.length && !v.decisions.length && !v.notes.length) return '';
  const steers = v.steers.map((s) => {
    const expected = v.agents.filter((a) => a.present).map((a) => a.name);
    const missing = s.item ? [] : expected.filter((n) => !s.acks.some((x) => x.agent === n));
    return `<div class="row-item steer-item" data-key="note:${s.id}"><div class="body"><div class="h">${s.item ? refLink(s.item) + ' ' : ''}${inline(s.body)}</div>
      <div class="acks">${ackList({ acks: s.acks, missing, key: `acks:${s.id}`, open: S.open.has(`acks:${s.id}`), responses: z() >= 2 }, { esc })}</div></div>
      <div class="acts"><span class="age">${esc(dur(Date.now() - s.at))} ago</span><button class="btn ghost small" data-action="retire" data-note="${s.id}" title="Stop delivering it">Retire</button></div></div>`;
  }).join('');
  const decisions = v.decisions.map((d) => `<div class="row-item" data-key="note:${d.id}"><div class="body"><div class="h">${inline(d.body)}</div></div>
    <div class="acts"><span class="age">${esc(d.ago)} ago</span><button class="btn ghost small" data-action="retire" data-note="${d.id}">Retire</button></div></div>`).join('');
  const shownNotes = z() >= 2 ? v.notes : v.notes.slice(0, 3);
  // Agents get the ten notes that bear on their work (#443); a note marked always-show reaches every one of them.
  const notes = shownNotes.map((n, i) => `<div class="row-item note-item" data-key="note:${n.id}"><div class="body"><div class="h">${inline(n.note ?? n.body)}</div><div class="s">${who(n.by)}${n.item ? ` on ${refLink(n.item)}` : ''}</div></div>
    <div class="acts"><span class="age">${esc(n.ago)} ago</span><button class="btn ghost small${n.always ? ' on' : ''}" data-action="always" data-note="${n.id}" data-on="${n.always ? 0 : 1}" aria-pressed="${!!n.always}" title="${n.always ? 'Every agent gets it, whatever it works on. Tap to stop' : 'Give it to every agent, whatever it works on (at most 3)'}"${i === 0 ? ' data-new="always-show"' : ''}>${n.always ? 'Always shown' : 'Always show'}</button><button class="btn ghost small" data-action="retire" data-note="${n.id}" title="Outdated or wrong">Retire</button></div></div>`).join('');
  const sub = (label, hint) => `<div class="sublabel">${label}<span>${hint}</span></div>`;
  return `<section class="sec"><header><h2>Steering &amp; memory</h2><span class="hint">did your nudges land, and what every agent carries into every session</span></header>
    ${steers ? `${sub('Your steering', 'acknowledged by')}<div class="rows" style="margin-bottom:var(--sp-4)">${steers}</div>` : ''}
    ${decisions ? `${sub('Decisions', 'standing rules, from you')}<div class="rows" style="margin-bottom:var(--sp-4)">${decisions}</div>` : ''}
    ${notes ? `${sub('Field notes', 'what agents learned the hard way, left for the next one')}<div class="rows">${notes}</div>
      ${v.notes.length > shownNotes.length ? `<div class="zoom-more">${v.notes.length} field notes in all; every one at 30m</div>` : ''}` : ''}
  </section>`;
}
function dur(ms) {
  const m = 60000, h = 60 * m, d = 24 * h;
  if (ms < m) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < h) return `${Math.round(ms / m)}m`;
  if (ms < d) return `${+(ms / h).toFixed(ms < 10 * h ? 1 : 0)}h`;
  return `${+(ms / d).toFixed(1)}d`;
}

// What git says the worker committed, read by the hub from the repo at submit time.
function commits(g) {
  if (!g?.commits?.length) return '';
  return `<div class="evidence" title="Read from the repo when the work was submitted"><span class="age">On <code>${esc(g.branch)}</code>:</span>${g.commits.map((c) => `<span class="ev"><code>${esc(c.hash)}</code> ${esc(c.subject)}</span>`).join('')}</div>`;
}

function agents(v) {
  if (!v.agents.length) return v.all.length ? `<section class="sec"><header><h2>Agents</h2></header>
    ${zero('<b>No agent has checked in here yet.</b> The work waits until one does.', '<button class="btn primary small" data-action="connect">Connect an agent</button>')}</section>` : '';
  // Only the agents here now (#441): holding work, or seen in the last hour. The rest wait behind "Show earlier agents" at 30m.
  const live = v.agents.filter((a) => a.present);
  const nobody = `<span class="age">No agent has been here in the last hour, so nothing moves until one comes back. <button class="link" data-action="connect">Start an agent</button></span>`;
  if (z() < 2) {
    return `<section class="sec"><header><h2>Agents</h2><span class="count">${live.length} here</span></header>
      <div class="agent-strip">${live.map((a) => `<span class="a"${a.tokens.length ? ` title="token: ${esc(a.tokens.join(', '))}"` : ''}>${who(a.name, a.model, { job: true })}<span class="st ${a.status.split(' ')[0]}">${esc(a.status)}${a.holding.length && !a.job ? ` ${a.holding.join(', ')}` : ''}${a.tokens.length > 1 ? ` · <span class="warn">${a.tokens.length} tokens</span>` : ''}</span></span>`).join('') || nobody}</div></section>`;
  }
  const gone = v.agents.filter((a) => !a.present);
  const showGone = S.open.has(`earlier:${S.slug}`);
  const earlier = gone.length ? `<button class="link earlier" data-action="toggle" data-key="earlier:${esc(S.slug)}" aria-expanded="${showGone}" data-new="present-agents">${showGone ? 'Hide earlier agents' : `Show earlier agents (${gone.length})`}</button>` : '';
  const shown = showGone ? [...live, ...gone] : live;
  return `<section class="sec"><header><h2>Agents</h2><span class="count">${live.length} here</span><span class="hint">first-class participants, each with a track record</span></header>
    ${shown.length ? '' : `<div class="agent-strip">${nobody}</div>`}
    <div class="agent-grid">${shown.map((a) => `<div class="agent-card">
      <div class="top">${who(a.name, a.model, { job: true })}<span class="status ${a.status.split(' ')[0]}">${esc(a.status)}</span></div>
      <div class="model">${esc([a.model, a.client, a.provider].filter(Boolean).join(' · ') || 'model unknown')}${a.via ? ` · <span title="Who answers for this agent's token">${esc(a.via)}</span>` : ''}</div>
      ${a.tokens.length ? `<div class="model ${a.tokens.length > 1 ? 'warn' : ''}" title="${a.tokens.length > 1 ? 'More than one token has acted under this name' : 'The token this agent connects with'}">token: ${esc(a.tokens.join(', '))}</div>` : ''}
      ${a.has?.length ? `<div class="model" title="What this agent's machine can do (declared at checkin)">has: ${esc(a.has.join(', '))}</div>` : ''}
      <div class="line" title="${esc(a.line)}">${esc(a.line || '—')}</div>
      <div class="stats">
        <div><b>${a.record.landed}</b><span>landed</span></div>
        <div><b>${a.record.sent_back}</b><span>sent back</span></div>
        <div><b>${a.record.stalls}</b><span>stalls</span></div>
        <div><b>${a.record.handoffs}</b><span>handoffs</span></div>
      </div>
      <div class="model" style="margin-top:var(--sp-2)">${a.record.assumptions} assumptions · ${a.record.questions} blocking questions · ${a.record.proposed} proposed · ${a.record.learned} field notes${a.record.reviews ? ` · ${a.record.reviews} reviews` : ''}${a.record.races ? ` · won ${a.record.races_won} of ${a.record.races} races` : ''} · seen ${esc(a.last_seen)} ago</div>
    </div>`).join('')}</div>${earlier}</section>`;
}

// The machines running `nuworq run` for this project (#171), as each last said: up, paused, skipping this
// project, stopped, or down (silent for 3 polls). The state leads each row; one line says why.
function runners(v) {
  if (!v.project.runner) return '';
  const rs = v.runners ?? [];
  // The staffing in words beside the heading (#213), so it shows without opening Settings.
  const staff = `<span class="right">${esc(staffLine(v.project.staffing))} <button class="link" data-action="staffing">Staffing</button></span>`;
  if (!rs.length) return `<section class="sec"><header><h2>Runners</h2>${staff}</header>
    ${zero('<b>No runner has reported here.</b> Nothing starts workers until one does.', 'On a machine with a checkout: <code>nuworq run</code>')}</section>`;
  const why = (r) => r.state === 'down' ? `Silent since ${esc(r.last_seen)} ago${r.machine ? ` on ${esc(r.machine)}` : ''}.`
    : r.state === 'stopped' ? `Stopped ${esc(r.last_seen)} ago: ${esc(r.stopped)}.`
    : r.state === 'paused' ? `Paused for ${esc(r.paused.for)}: ${esc(r.paused.reason)}.`
    : r.state === 'skipping' ? `Leaves this project alone${r.skipping.for ? ` for ${esc(r.skipping.for)}` : ''}: ${esc(r.skipping.reason)}.`
    // --workers auto (#533): it adds workers while the machine has room, and says why when it holds.
    : r.auto ? `${r.running} of up to ${r.workers} running${r.holding ? `. Holding: ${esc(r.holding)}.` : ', as the machine has room.'}`
    : `${r.running} of ${r.workers} worker${r.workers === 1 ? '' : 's'} running.`;
  const up = rs.filter((r) => r.state === 'up').length;
  const st = v.project.staffing;
  const held = st?.stopped === 'paused' ? 'Staffing is paused: no new workers start here; running ones finish.'
    : st?.stopped === 'budget' ? `Today's budget is spent ($${st.spent_today.toFixed(2)} of $${st.budget.toFixed(2)}): new workers start here again tomorrow (UTC).` : '';
  return `<section class="sec"><header><h2>Runners</h2><span class="count">${up} up</span>${up < rs.length ? `<span class="hint">${rs.length - up} not starting work here</span>` : ''}${staff}</header>
    ${held ? `<p class="warn">${held}</p>` : ''}
    <div class="rows">${rs.map((r) => `<div class="row-item runner"><div class="body">
      <div class="h">${esc(r.name)}<span class="status runner-${r.state}">${esc(r.state)}</span></div>
      <div class="s">${why(r)}</div>
      <div class="s faint">${[r.machine && r.machine !== r.name ? `on ${esc(r.machine)}` : '', r.state !== 'down' ? `seen ${esc(r.last_seen)} ago` : '', r.spent ? `$${r.spent.toFixed(2)} spent` : '', r.skipping_others ? `skips ${r.skipping_others} other project${r.skipping_others === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}</div>
    </div></div>`).join('')}</div></section>`;
}

function activity(v) {
  const quiet = new Set(['progress', 'checkin', 'review_started']);
  const events = S.feedAll ? v.activity : v.activity.filter((e) => !quiet.has(e.type));
  return `<section class="sec feed"><header><h2>Everything that happened</h2><span class="count">${events.length}</span>
    <span class="right"><label class="check-label"><input type="checkbox" data-action="feed-all" ${S.feedAll ? 'checked' : ''}> include routine progress</label></span></header>
    ${events.length ? '' : v.activity.length
      ? zero('Only routine progress so far.', '<button class="link" data-action="feed-all">Include routine progress</button>')
      : zero('<b>Nothing has happened here yet.</b> Every claim, question, submission and review will show up here.')}
    <div class="rows">${events.map((e) => {
      const key = 'e:' + e.id;
      const open = S.open.has(key);
      const has = e.summary || e.detail || e.data?.evidence?.length;
      return `<div class="row-item ${has ? 'clickable' : ''}" ${has ? `data-action="toggle" data-key="${key}"` : ''}>
        <span class="type">${esc(e.type.replace('_', ' '))}</span>
        <div class="body"><div class="h">${e.item ? refLink(e.item) + ' ' : ''}${named(e.headline, e.actor, undefined, { beside: true })}</div>
          ${open ? `<div class="expand">${md(e.summary)}${e.data?.evidence?.length ? `<div class="evidence">${e.data.evidence.map((x) => `<span class="ev">${esc(x.label)}</span>`).join('')}</div>` : ''}${e.detail ? `<pre>${esc(e.detail)}</pre>` : ''}</div>` : ''}</div>
        <span class="age">${who(e.actor)} · ${esc(e.ago)}</span></div>`;
    }).join('')}</div></section>`;
}

// Every item on the board (#442): done work older than 3 days and dropped work aren't here; search (⌘K) and
// analytics find the old, and "Show dropped" brings the dropped back.
function allWork(v) {
  if (!v.all.length) return `<section class="sec"><header><h2>All work</h2></header>${zero('<b>No work yet.</b> Every item, in every stage, will be listed here.')}</section>`;
  const { rows, dropped, old } = boardWork(v.all);
  const showDropped = S.open.has('all:dropped');
  const shown = [...rows, ...(showDropped ? dropped : [])].sort((a, b) => b.item.slice(1) - a.item.slice(1));
  const foot = [
    old ? `${plural(old, 'item')} finished more than 3 days ago: <button class="link" data-action="launcher">Search</button> finds them.` : '',
    dropped.length ? `<button class="link" data-action="toggle" data-key="all:dropped" aria-expanded="${showDropped}" data-new="show-dropped">${showDropped ? 'Hide dropped' : `Show dropped (${dropped.length})`}</button>` : '',
  ].filter(Boolean).join(' · ');
  return `<section class="sec"><header><h2>All work</h2><span class="count">${shown.length}</span></header>
    ${shown.length ? `<div class="work-scroll"><table class="work"><thead><tr><th>#</th><th>Title</th><th>Stage</th><th>Priority</th><th>Worked on by</th><th>In stage</th></tr></thead><tbody>
    ${shown.map((i) => `<tr data-action="open" data-item="${esc(i.item)}"><td>${esc(i.item)}</td><td>${esc(i.title)}${repoTag(i)}</td><td>${stagePill(i.stage, courtOf(i.stage))}</td><td>${esc(i.priority)}</td><td>${i.last_worker ? who(i.last_worker) : '<span class="age" title="No agent has worked on it yet">—</span>'}</td><td class="age">${esc(i.ago)}</td></tr>`).join('')}
    </tbody></table></div>` : zero('<b>Nothing open or recently finished.</b>')}
    ${foot ? `<div class="zoom-more">${foot}</div>` : ''}</section>`;
}

// ── item drawer: 30s header, 5m body, 30m deep dive ──
function renderDrawer() {
  const d = $('#drawer');
  const show = !!S.itemRef;
  if (d.hidden === show) d.hidden = $('#scrim').hidden = !show; // untouched when it stays as it is (#392)
  if (!show) return;
  const it = S.item;
  if (!it) { paint(d, placeholder(4)); return; }
  const holderLine = {
    proposed: it.holder
      ? `<b>${who(it.holder)}</b> is shaping it · lease ${esc(it.lease_left)} left`
      : `<b>Proposed</b> by ${who(it.created_by)} ${esc(it.created)} ago. ${it.waits_for_ok && it.acceptance ? 'Shaped and waiting for your approval.' : `Nothing needed from you: ${it.holder ? `${who(it.holder)} is shaping it now` : it.priority === 'now' ? 'the next free agent shapes it first' : 'a free agent shapes it into ready work'}.`}`,
    ready: `<b>Ready</b> for ${it.race > 1 ? `${it.race} agents at once (a race)` : 'any agent'} · waiting ${esc(it.in_stage)}${it.depends_on.some((x) => !['done', 'dropped'].includes(x.stage)) ? ' · blocked by dependencies' : ''}`,
    active: it.race > 1
      ? `<b>Race of ${it.race}</b> · ${esc(it.in_stage)} so far · ${it.racers.map((r) => `${who(r.agent, r.model)} ${r.stage === 'active' ? `on it, lease ${esc(r.lease_left)} left` : esc(r.stage)}`).join(' · ') || 'no one yet'}`
      : `<b>${who(it.holder)}</b> is on it · ${esc(it.in_stage)} so far · lease ${esc(it.lease_left)} left`,
    waiting: `<b>Waiting on you</b> for ${esc(it.in_stage)}: an agent parked it to ask a question.`,
    verifying: `<b>Verifying</b> · ${who(it.implementer)} finished it ${esc(it.in_stage)} ago${it.holder ? ` · ${who(it.holder)} is reviewing` : ''}`,
    landing: `<b>Landing</b> · accepted; ${it.holder ? `${who(it.holder)} is putting it on main` : 'the next free agent puts it on main'}`,
    done: `<b>Done</b> ${esc(it.in_stage)} ago${it.implementer ? ` · ${credit({ implementer: it.implementer }, who)}` : ''}`,
    dropped: `<b>Dropped</b> ${esc(it.in_stage)} ago`,
  }[it.stage];

  const actions = [];
  const raced = it.submissions?.filter((s) => s.stage === 'submitted').length > 1;
  if (it.stage === 'verifying') {
    if (!raced) actions.push(`<button class="btn primary" data-action="accept" data-item="${it.item}">Accept</button>`);
    actions.push(S.reveal.has('dsb') ? `<div class="inline-form grow"><input data-draft="sb:${it.item}" id="sb:${it.item}" placeholder="What's missing?"><button class="btn primary" data-action="sendback" data-item="${it.item}">Send back</button></div>`
      : `<button class="btn" data-action="reveal" data-key="dsb">Send back…</button>`);
  }
  // Only "Check with me" waits on you; otherwise this is an optional shortcut, so it mustn't look like a request.
  // One primary per drawer (#193): when Approve moves it on, "Make it next" steps back.
  const approves = it.waits_for_ok && it.acceptance;
  if (it.stage === 'proposed' && it.priority !== 'now') actions.push(`<button class="btn${approves ? '' : ' primary'}" data-action="pick" data-item="${it.item}" title="Agents shape and build this first">Make it next</button>`);
  if (it.stage === 'proposed') actions.push(approves
    ? `<button class="btn primary" data-action="approve" data-item="${it.item}" title="It becomes ready as written">Approve</button>`
    : `<button class="btn" data-action="approve" data-item="${it.item}" title="Optional: agents shape proposals on their own. This makes it ready as written.">Skip shaping</button>`);
  if (it.stage === 'done') actions.push(`<button class="btn" data-action="reopen" data-item="${it.item}">Reopen</button>`);
  if (!['done', 'dropped'].includes(it.stage)) actions.push(`<button class="btn ghost" data-action="drop" data-item="${it.item}">Drop</button>`);
  if (it.stage === 'dropped') actions.push(`<button class="btn" data-action="reopen" data-item="${it.item}">Restore</button>`);
  actions.push(`<button class="btn ghost" data-action="edit-item">Edit</button>`);
  if (!it.precondition && !S.editPre && ['proposed', 'ready', 'waiting'].includes(it.stage)) actions.push(`<button class="btn ghost" data-action="edit-pre" title="Hold it until a URL answers, or until a person says so">Wait on…</button>`);

  const life = it.lifecycle;
  const totalMs = life.reduce((n, l) => n + (l.court ? l.ms : 0), 0) || 1;
  const lifebar = life.filter((l) => l.court && l.ms > 0).map((l) => {
    const pct = (100 * l.ms) / totalMs;
    return `<span class="${l.court}" style="flex:${Math.max(pct, 1.5)}" title="${esc(l.label)} · ${esc(l.time)}${l.actor ? ` · ${esc(l.actor)}` : ''}">${pct > 14 ? esc(l.label) : ''}</span>`;
  }).join('');

  const handoff = it.handoff && it.stage !== 'done' ? `<div class="d-sec"><div class="label">${it.handoff.kind === 'sent_back' ? 'Sent back' : 'Where the last agent left off'}</div>
    <div class="handoff"><div class="by">${who(it.handoff.by)} · ${esc(dur(Date.now() - it.handoff.at))} ago</div><b>${esc(it.handoff.headline)}</b>${it.handoff.summary ? md(it.handoff.summary) : ''}</div></div>` : '';

  const questions = it.questions.length ? `<div class="d-sec"><div class="label">Questions <span class="count">${it.questions.length}</span></div>
    ${it.questions.map((q) => `<div class="q ${q.status} ${q.blocking ? 'blocking' : ''}">
      <div class="meta">${who(q.asked_by)} · ${q.escalation ? `escalated ${esc(q.escalation.asked_by)}'s question` : q.blocking ? 'blocking' : 'non-blocking'} · ${esc(q.ago)} ago · ${esc(q.status)}</div>
      <div><b>${esc(q.question)}</b></div>${q.escalation ? `<div class="a">${esc(q.escalation.asked_by)} asked an operator: <i>${esc(q.escalation.question)}</i></div>` : ''}${q.context ? md(q.context) : ''}
      ${q.evidence?.length ? `<div class="evidence">${q.evidence.map((e) => `<span class="ev">${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.label)}</a>` : esc(e.label)}</span>`).join('')}</div>` : ''}
      ${q.assumption ? `<div class="a">Assumed: <i>${esc(q.assumption)}</i></div>` : ''}
      ${q.answer ? `<div class="a">Answer: <b>${esc(q.answer)}</b></div>` : q.status === 'confirmed' ? '<div class="a">You confirmed the assumption.</div>'
        : q.status === 'shipped' ? `<div class="a">Shipped with this assumption${q.closed_reason ? ` (${esc(q.closed_reason)})` : ''}. To change it now, steer or propose new work.</div>`
        : q.status === 'withdrawn' ? `<div class="a">Withdrawn${q.closed_reason ? `: ${esc(q.closed_reason)}` : ''}.</div>` : ''}
      ${q.status === 'open' ? `<div class="answer">${q.options.length ? `<div class="opts">${q.options.map((o) => `<button class="opt" data-action="answer" data-q="${q.id}" data-answer="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
        <div class="answer-row"><input data-draft="ans-${q.id}" id="ans-${q.id}" placeholder="${q.blocking ? 'Your answer…' : 'Override with…'}"><button class="btn primary" data-action="${q.blocking ? 'answer-text' : 'override'}" data-q="${q.id}" data-src="ans-${q.id}">${q.blocking ? 'Answer' : 'Override'}</button>
        ${q.blocking ? '' : `<button class="btn" data-action="confirm" data-q="${q.id}">Confirm</button>`}</div></div>` : ''}
    </div>`).join('')}</div>` : '';

  const steers = it.steers.length ? `<div class="d-sec"><div class="label">Your steering</div>${it.steers.map((s) => `<div class="q"><div>${esc(s.body)}</div>
      <div class="meta">${esc(s.ago)} ago</div><div class="acks">${ackList({ acks: s.acks, key: `dacks:${s.id}`, open: S.open.has(`dacks:${s.id}`), responses: true, empty: 'not acknowledged yet' }, { esc })}</div></div>`).join('')}</div>` : '';

  const edit = S.editItem ? `<div class="d-sec"><div class="label">Edit</div><div class="add-work" style="margin:0">
      <input data-draft="ei-title" id="ei-title" value="${esc(it.title)}">
      <textarea data-draft="ei-summary" id="ei-summary" placeholder="Summary">${esc(it.summary)}</textarea>
      <textarea data-draft="ei-acceptance" id="ei-acceptance" placeholder="Done means…">${esc(it.acceptance)}</textarea>
      <label class="field-label">Part of <input data-draft="ei-parent" id="ei-parent" value="${esc(it.parent?.item ?? '')}" placeholder="e.g. #12: the milestone it belongs to; empty for none" inputmode="numeric"></label>
      <label class="field-label">Fixes a landed item <input data-draft="ei-fixes" id="ei-fixes" value="${esc(it.fixes?.item ?? '')}" placeholder="e.g. #12: the landed item this repairs (counts as an escape)" inputmode="numeric"></label>
      <div class="row"><div class="seg">${['now', 'soon', 'later'].map((p) => `<button class="${(S.drafts['ei-priority'] ?? it.priority) === p ? 'on' : ''}" data-action="ei-priority" data-p="${p}">${p}</button>`).join('')}</div>
      ${it.stage !== 'active' ? `<div class="seg" title="Race: how many agents attempt it at once, each on its own; you keep the best">${[1, 2, 3].map((n) => `<button class="${+(S.drafts['ei-race'] ?? it.race) === n ? 'on' : ''}" data-action="ei-race" data-n="${n}">${n === 1 ? '1 agent' : `race ${n}`}</button>`).join('')}</div>` : ''}
      <span style="flex:1"></span><button class="btn ghost" data-action="edit-item">Cancel</button><button class="btn primary" data-action="save-item" data-item="${it.item}">Save</button></div></div></div>` : '';

  const deep = S.deep ? `
    <div class="d-sec"><div class="label">The record</div>
      <dl class="kv">
        <dt>Created</dt><dd>${esc(it.created)} ago by ${who(it.created_by)}</dd>
        <dt>Attempts</dt><dd>${it.attempts}${it.stalls ? ` · ${plural(it.stalls, 'stall')}` : ''}${it.rejections ? ` · sent back ${it.rejections}×` : ''}</dd>
        <dt>Agents involved</dt><dd>${it.agents.map((a) => `${who(a.name, a.model)} <span class="age">${esc(a.model)}</span>`).join(', ') || '—'}</dd>
        ${it.parent ? `<dt>Part of</dt><dd>${refLink(it.parent.item)} ${esc(it.parent.title)}</dd>` : ''}
        ${it.children.length ? `<dt>Broken into</dt><dd>${it.children.map((c) => `${refLink(c.item)} ${esc(c.title)} ${stagePill(c.stage, courtOf(c.stage))}`).join('<br>')}</dd>` : ''}
        ${it.depends_on.length ? `<dt>Depends on</dt><dd>${it.depends_on.map((c) => `${refLink(c.item)} ${esc(c.title)} ${stagePill(c.stage, courtOf(c.stage))}`).join('<br>')}</dd>` : ''}
        ${it.fixes ? `<dt>Repairs</dt><dd>${refLink(it.fixes.item)} ${esc(it.fixes.title)} <span class="age">landed; counted as an escape</span></dd>` : ''}
        ${it.fixed_by?.length ? `<dt>Escaped</dt><dd>fixed later by ${it.fixed_by.map((f) => `${refLink(f.item)} ${esc(f.title)}`).join(', ')}</dd>` : ''}
      </dl></div>
    ${it.detail ? `<div class="d-sec"><div class="label">Detail</div>${md(it.detail)}</div>` : ''}
    ${it.usage ? usageTable(it.usage) : ''}
    <div class="d-sec"><div class="label">Timeline <span class="count">${plural(it.events.length, 'event')}</span></div><div class="timeline">
      ${it.events.map((e) => `<div class="tl t-${e.type} ${dotClass(e.type, courtOf)}">
        <div class="meta">${who(e.actor)}<span>${esc(e.type.replace('_', ' '))}</span><span>${esc(e.ago)} ago</span></div>
        <div class="h">${named(e.headline, e.actor, undefined, { beside: true })}</div>
        ${e.summary ? `<div class="sm">${md(e.summary)}</div>` : ''}
        ${e.data?.evidence?.length ? `<div class="evidence">${e.data.evidence.map((x) => `<span class="ev">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>` : esc(x.label)}</span>`).join('')}</div>` : ''}
        ${e.detail ? `<details><summary>Detail</summary><pre>${esc(e.detail)}</pre></details>` : ''}
      </div>`).join('')}
    </div></div>` : '';

  paint(d, `
    <div class="d-top">${refLink(it.item)} ${stagePill(it.stage, it.court)} <span class="tag ${it.priority}">${it.priority}</span>${it.effective_priority ? ` <span class="tag ${esc(it.effective_priority.split(' ')[0])}" title="Agents take it at this priority: its milestone, or work waiting on it, ranks higher">ranks ${esc(it.effective_priority)}</span>` : ''}${repoTag(it)}${it.size ? ` <span class="tag" title="Large work waits while small models have other work">${esc(it.size)}</span>` : ''}${(it.needs ?? []).map((n) => ` <span class="tag" title="Only agents that have this get it">needs ${esc(n)}</span>`).join('')}
      <button class="btn ghost small x" data-action="close" title="Close (Esc)">✕</button></div>
    <h2 class="title">${esc(it.title)}</h2>
    <div class="d-now">${holderLine}</div>
    ${it.model_why && z() >= 1 ? `<div class="d-model" data-new="model-why">Model: ${esc(it.model_why)}</div>` : ''}
    <div class="actions">${actions.join('')}</div>
    ${it.map ? `<div class="d-sec"><div class="label">Map</div>${prioritySeg(it.item, it.priority)}${groupMap(it.map)}</div>` : ''}
    ${edit}
    ${lifebar ? `<div class="d-sec"><div class="label">Lifecycle <span class="count">agents ${esc(it.court_totals.agents)} · queue ${esc(it.court_totals.queue)} · you ${esc(it.court_totals.you)}${it.court_ms.external ? ` · outside ${esc(it.court_totals.external)}` : ''}</span></div>
      <div class="lifebar">${lifebar}</div>
      <div class="life-steps">${life.map((l) => `<span><b>${esc(l.label)}</b> ${esc(l.time)}${l.court === 'agents' && l.actor ? ` (${esc(l.actor)})` : ''}</span>`).join('<span>→</span>')}</div></div>` : ''}
    ${it.summary ? `<div class="d-sec"><div class="label">Summary</div>${md(it.summary)}</div>` : ''}
    <div class="d-sec"><div class="label">Done means</div>${it.acceptance ? md(it.acceptance) : '<p class="faint">No acceptance criteria yet. Agents are asked to write them before submitting.</p>'}</div>
    ${it.breaking ? `<div class="d-sec"><div class="label"><span data-new="breaking">Breaking: who must act when it ships</span></div><div class="warn">${inline(it.breaking)}</div></div>` : ''}
    ${preconditionSection(it, { editing: S.editPre })}
    ${it.submissions?.length ? `<div class="d-sec"><div class="label">The race <span class="count">${it.submissions.length} submitted</span></div>${attemptsGrid(it.item, it.submissions, { keep: it.stage === 'verifying' })}</div>` : ''}
    ${it.submission && it.stage === 'verifying' && !it.submissions?.length ? `<div class="d-sec"><div class="label">What the agent says</div><p><b>${esc(it.submission.headline)}</b></p>${md(it.submission.summary)}
      ${it.evidence.length ? `<div class="evidence">${it.evidence.map((x) => `<span class="ev">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>` : esc(x.label)}</span>`).join('')}</div>` : '<div class="warn">⚠ No evidence attached</div>'}
      ${commits(it.git)}${it.git_warning ? `<div class="warn">⚠ ${esc(it.git_warning)}</div>` : ''}</div>` : ''}
    ${handoff}
    ${it.prs?.length ? `<div class="d-sec"><div class="label">Pull requests</div>${it.prs.map((pr) => `<p><a href="${esc(pr.url)}" target="_blank" rel="noopener">${esc(pr.repo)}#${pr.number}</a> <b>${esc(pr.state)}</b> · ${esc(pr.title)}
      ${pr.ci ? ` · CI <b class="${pr.ci === 'fail' ? 'bad' : pr.ci === 'pass' ? 'ok' : ''}">${pr.ci === 'pass' ? '✓ passing' : pr.ci === 'fail' ? '✗ failing' : '… running'}</b>` : ''}</p>
      ${pr.checks.length ? `<div class="evidence">${pr.checks.map((c) => checkChip(c, esc)).join('')}</div>` : ''}`).join('')}</div>` : ''}
    ${questions}
    ${steers}
    <div class="d-sec"><div class="label">Say something about this item</div>
      <div class="inline-form"><input data-draft="ic:${it.item}" id="ic:${it.item}" placeholder="Steer whoever works on it next, or leave a note…">
      <button class="btn primary" data-action="item-steer" data-item="${it.item}" title="The agent on it must read and acknowledge">Steer</button>
      <button class="btn" data-action="item-note" data-item="${it.item}">Note</button></div></div>
    <div class="d-sec">${S.deep ? '' : `<button class="btn" data-action="deep">Deep dive (30m): the timeline, every event and its detail</button>`}</div>
    ${deep}`);
}

// ── a new workspace: step 2 (its first project, with its repositories) and step 3 (connect a machine) ──
// Step 1, naming the workspace, is on the hub's own address (web/join.js).
function firstProject() {
  return `<div class="phead"><div class="titles"><h1>${esc(S.me.org)}</h1></div></div>
    <div class="setup">
      <p class="faint">Step 2 of 3 · your first project</p>
      <p class="lead">A project is what agents work on: a mission, and the repositories their work lands in.</p>
      <div class="form"><label>Name<input id="fp-name" data-draft="fp-name" placeholder="e.g. api"></label>
      <label>Mission (optional): the north star every agent reads<textarea id="fp-mission" data-draft="fp-mission" placeholder="What is this for? What matters most?"></textarea></label>
      <label>Repositories (optional): one per line<textarea id="fp-remotes" data-draft="fp-remotes" placeholder="github.com/acme/api&#10;github.com/acme/web"></textarea></label></div>
      <div class="foot"><button class="btn primary" data-action="first-project">Create project</button></div>
    </div>`;
}

function connectStep(r) {
  const c = connectCommands(S.info ?? { url: location.origin }, location, r.slug);
  const refused = r.refused?.length ? `<div class="bad">${r.refused.map((x) => `<p>✗ Not linked: ${esc(x.error)}.${x.hint ? ` ${esc(x.hint)}` : ''}</p>`).join('')}</div>` : '';
  modal(`<p class="faint">Step 3 of 3 · connect a machine</p>
    <h2>${esc(r.name)} is ready</h2>
    ${r.remotes?.length ? `<p class="lead">Linked: ${r.remotes.map((x) => `<code>${esc(x)}</code>`).join(' ')}</p>` : ''}${refused}
    ${c.clone ? `<h4>Get nuworq on the machine (once)</h4>${commandBlocks(c.clone)}` : ''}
    <h4>Set it up for ${esc(S.me.org)}</h4><p class="lead">Paste it in a terminal, in a clone of the repository. It installs nuworq (Node 24 or newer), signs you in through the browser, saves a fresh agent token for this workspace, and registers nuworq with Claude Code and Codex if they're installed. Then it asks to staff ${esc(r.name)} with workers and start an operator.</p>${commandBlocks(c.setup)}
    <h4>Start a worker in a clone of the repository</h4>${commandBlocks(c.worker)}
    <div class="foot"><button class="btn primary" data-action="goto-new" data-slug="${esc(r.slug)}">Open the board</button></div>`);
}

// ── modals ──
function modal(html) {
  const m = $('#modal');
  // Redrawn in place (a toggle, a live count), a dialog keeps its place (#376); a different dialog starts at the top.
  const title = html.match(/<h[23][^>]*>([^<]*)/)?.[1] ?? '';
  keepScroll(document, () => { m.innerHTML = `<div class="dialog" data-scroll="dialog:${esc(title)}">${html}</div>`; });
  m.hidden = false;
  markNew(m);
}
const closeModal = () => { $('#modal').hidden = true; $('#modal').innerHTML = ''; };

// Staffing (#174): what nuworq run does here, set on the hub so it can change from a phone. Runners follow it at
// their next poll. Pause is one tap and says what happens to running workers; the numbers are blank for "no limit".
// Cheaper models (#347): one switch, set about once, and the tiers it picks from, cheapest first. Claude's show;
// the other agents' sit one tap away, since most runners run Claude.
function staffingModal(back) {
  const s = S.view?.project?.staffing ?? {};
  const m = s.models ?? { on: false, tiers: {} };
  const tier = (agent, label) => `<label>${label}<input id="st-tiers-${agent}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="The runner's --model" value="${esc((m.tiers[agent] ?? []).join(', '))}"></label>`;
  modal(`${back ? '<button class="link back" data-action="settings">← Settings</button>' : ''}<h2 data-staffing data-back="${back ? 1 : ''}">Staffing</h2>
    <p class="lead">What <code>nuworq run</code> does here. Runners follow it at their next poll.</p>
    <div class="form"><label>Workers at once<input id="st-workers" type="number" inputmode="numeric" min="1" max="100" placeholder="Each runner's own --workers" value="${s.workers ?? ''}"></label>
    <label>Daily budget, dollars (UTC days)<input id="st-budget" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="No budget" value="${s.budget ?? ''}"></label></div>
    <p class="faint">Spent here today: $${(s.spent_today ?? 0).toFixed(2)}. Once it reaches the budget, no new workers start until tomorrow.</p>
    <div class="setting" data-new="model-routing"><div class="body"><div class="h" id="set-models">Cheaper models where they do as well</div>
      <div class="s">${m.on ? 'On: building starts on the top model below and landing and tidying on the cheapest, until results show a cheaper one meets the quality bar. A failed attempt steps up one. Reviews and shaping always use the top one.' :'Off: every worker runs on its runner\'s own model.'}</div></div>
      <button class="switch" role="switch" aria-checked="${m.on}" aria-labelledby="set-models" data-action="${m.on ? 'models-off' : 'models-on'}"></button></div>
    <div class="form">${tier('claude', 'Claude models, cheapest first')}
    <details><summary>Codex and opencode</summary>${tier('codex', 'Codex models, cheapest first')}${tier('opencode', 'opencode models (provider/model), cheapest first')}</details>
    <label data-new="model-trials">Building jobs that try one model down, percent<input id="st-trial" type="number" inputmode="numeric" min="0" max="100" step="1" value="${m.trial ?? 10}"></label>
    <label>Building jobs raced against the top model, percent<input id="st-race" type="number" inputmode="numeric" min="0" max="100" step="1" value="${m.race ?? 0}"></label></div>
    <p class="faint">Trials teach nuworq what each model can do. Only rote and standard items that aren't "now" or operator-only, while there's budget left today. 0 turns one off.</p>
    <fieldset class="quality" data-new="model-quality"><legend>Quality bar</legend>
      ${Object.entries(m.qualities ?? {}).map(([k, q]) => `<label class="check-label"><input type="radio" name="st-quality" value="${k}" ${(m.quality ?? 'balanced') === k ? 'checked' : ''}> <span><b>${esc(q.label)}</b>: ${esc(q.means)}</span></label>`).join('')}
      <p class="faint">Once a model has 20 finished jobs of a kind (building standard items, say), and so has the top one, each job of that kind runs on the cheapest model that meets the bar. Until then: the top model for building, the cheapest for landing and tidying.</p></fieldset>
    <div class="foot"><button class="btn ghost" data-action="staffing-pause" data-paused="${s.paused ? 1 : 0}">${s.paused ? 'Resume' : 'Pause'}</button><button class="btn primary" data-action="staffing-save">Save</button></div>`);
}
const tiersTyped = () => Object.fromEntries(['claude', 'codex', 'opencode'].map((a) => [a, val(`st-tiers-${a}`)]));
// The switch redraws the dialog in its new state, keeping what was typed and not yet saved.
async function modelRouting(on) {
  const back = !!$('#modal [data-staffing]')?.dataset.back;
  const typed = { workers: val('st-workers'), budget: val('st-budget'), trial: val('st-trial'), race: val('st-race') };
  const r = await human('settings', { model_routing: on, model_tiers: tiersTyped() }, on ? 'Cheaper models are on: runners pick each job\'s model at their next poll' : 'Cheaper models are off');
  if (!r || !$('#modal [data-staffing]')) return;
  staffingModal(back);
  $('#st-workers').value = typed.workers ?? '';
  $('#st-budget').value = typed.budget ?? '';
  $('#st-trial').value = typed.trial ?? '';
  $('#st-race').value = typed.race ?? '';
  $('#modal .switch')?.focus();
}

// A watchable project's public page (#358), beside this app: /live/<slug>, or /w/<workspace>/live/<slug>.
const liveLink = (slug) => `${location.origin}${location.pathname.replace(/[^/]*$/, '')}live/${encodeURIComponent(slug)}`;

// A project's settings (#213), changed about monthly, so one step from the header rather than in it. One row
// each: a fixed name, what it does, one control. A switch shows on or off; a button says what it does.
function settingsModal() {
  const P = S.view?.project;
  if (!P) return;
  const row = (id, name, what, control) => `<div class="setting"><div class="body"><div class="h" id="set-${id}">${name}</div><div class="s">${what}</div></div>${control}</div>`;
  const sw = (id, on, action) => `<button class="switch" role="switch" aria-checked="${on}" aria-labelledby="set-${id}" data-action="${action}"></button>`;
  modal(`<h2 data-settings>Settings</h2>
    <p class="lead">How ${esc(P.name)} is staffed, kept current and linked to GitHub.</p>
    ${row('runner', 'Staff it with nuworq run', `Runners start headless workers here whenever work is waiting. They can cost money.${P.runner
      ? `<span class="staff-words">${esc(staffWords(P.staffing))} <button class="link" data-action="staffing-from-settings">Change</button></span>` : ''}`,
      sw('runner', !!P.runner, P.runner ? 'runner-off' : 'runner-on'))}
    ${row('fresh', 'Keep it fresh weekly', 'Once a week an agent updates dependencies, the runtime and CI actions, and proposes each breaking upgrade.',
      sw('fresh', !!P.fresh, P.fresh ? 'fresh-off' : 'fresh-on'))}
    <div data-new="releases">${row('releases', 'Release per milestone', P.releases === 'milestone'
    ? 'On: when a milestone finishes, the hub drafts "Release vX.Y.Z" with its changelog and upgrade notes, for you to edit and sign.'
    : 'When a milestone finishes, the hub drafts the next release: its version, changelog and upgrade notes.',
    sw('releases', P.releases === 'milestone', P.releases === 'milestone' ? 'releases-off' : 'releases-on'))}
    ${row('release-now', 'Release now', 'A patch for a fix that can\'t wait, or whatever landed since the last release, drafted the same way.',
      '<button class="btn" data-action="release-now">Draft</button>')}</div>
    <div data-new="live-view">${row('live', 'Anyone can watch', P.live
    ? `On: anyone with <a href="${esc(liveLink(P.slug))}" target="_blank" rel="noopener">the link</a> sees item titles, agents, models, Flow and totals. Nothing else.`
    : 'A public, read-only page of what agents are doing here. Off until you turn it on.',
    sw('live', !!P.live, P.live ? 'live-off' : 'live-on'))}</div>
    ${row('github', 'GitHub', P.github ? 'Connected: pull requests and CI results link to items.' : 'Link pull requests and CI results to items.',
      `<button class="btn${P.github ? '' : ' primary'}" data-action="github">${P.github ? 'Manage' : 'Connect GitHub'}</button>`)}
    <h3>This project</h3>
    ${P.parked
      ? row('park', 'Park', 'Parked: no new work starts and nothing here asks for you.', '<button class="btn" data-action="unpark-project">Unpark</button>')
      : row('park', 'Park', 'Pause it: no new work starts and nothing here asks for you until you unpark it.', '<button class="btn" data-action="park">Park</button>')}
    ${row('remove', 'Remove', 'Archive it (history kept), or delete it for good.', '<button class="btn" data-action="remove-project">Remove…</button>')}
    <div class="foot"><button class="btn primary" data-action="close-modal">Done</button></div>`);
}
// A setting changed from the dialog shows its new state there. The redraw replaces the control that changed it,
// so focus goes back to that row's control: otherwise it falls behind the dialog, and the next Tab or a screen
// reader starts over from the page.
const settingsOpen = () => !!$('#modal [data-settings]');
async function setting(body, msg) {
  const row = document.activeElement?.closest?.('#modal .setting')?.querySelector('.h')?.id;
  const redraw = () => {
    if (!settingsOpen()) return;
    settingsModal();
    if (row) $(`#${row}`)?.closest('.setting')?.querySelector(':scope > button')?.focus();
  };
  const sent = human('settings', body, msg);
  redraw(); // the switch shows its new state at once (#393), and goes back if the hub refuses
  const r = await sent;
  redraw();
  return r;
}

// The board's + Work (#389): Propose makes the person's proposal; Add to Ready puts it straight into the queue.
async function addWork(ready) {
  const more = S.addMore, pre = more ? val('nw-pre') : '';
  const body = proposal({ title: val('nw-title'), acceptance: more ? val('nw-acceptance') : '', summary: more ? val('nw-summary') : '',
    priority: S.drafts['nw-priority'], precondition: pre ? toPrecondition(pre) : null, ready });
  if (!body) { $('#nw-title')?.focus(); return toast('Say what should be true when it\'s done', true); }
  await human('create', body, sentToast({ ready, waits: !!pre }));
  clearDraft('nw-title', 'nw-summary', 'nw-acceptance', 'nw-priority', 'nw-pre');
  S.addWork = S.addMore = false;
  render({ force: true });
}

async function connect() {
  S.info ??= await api('/api/info').catch(() => ({ url: location.origin }));
  const slug = S.slug ?? 'my-project';
  const c = connectCommands(S.info, location, slug);
  const url = c.url;
  const gh = await api('/api/github/app').catch(() => null);
  const where = S.view?.project.path;
  modal(`<h2>Connect an agent</h2>
    <p class="lead">Any model can work here, and many agents at once. Set a machine up once: agents find their project from the folder they're in, and anywhere else the hub sends them to the work that matters most.</p>
    <h4>Set up this machine (once)</h4>
    <p class="lead">Paste it in a terminal, in a clone of the project. ${c.install ? 'It installs nuworq from this hub (Node 24 or newer: <code>node --version</code>; older or missing, get it from nodejs.org), and keeps it up to date.' : 'This hub serves no package of nuworq (it doesn\'t run from a git checkout), so install nuworq the way this hub was installed first.'} It signs you in through the browser, then asks, one at a time, to install the Claude Code plugin, staff the project with workers here, and start an operator. <code>nuworq disconnect</code> undoes it all.</p>${commandBlocks(c.setup)}
    <h4>Workers by hand</h4><p class="lead">One per waiting item, on the projects you let it staff, each in its own git worktree and branch. Ctrl-C stops them. Add <code>--browser</code> for workers that check UI work.</p>${commandBlocks(c.run)}
    <p class="lead">One worker on its own, wherever work is waiting:</p>${commandBlocks(c.worker)}
    ${gh ? `<h4>GitHub App (once, for this hub)</h4>${appStatus(gh)}` : ''}
    ${where || S.view?.project.remotes?.length ? '' : `<p class="lead">⚠ The hub doesn't know ${esc(S.view?.project.name ?? 'this project')}'s repository yet. Start the first worker from a clone of it (add --here), or link the repo in the project header, so later workers find it.</p>`}
    ${z() >= 2 ? `<h3>Setting up by hand</h3><p class="lead">What <code>nuworq connect</code> does for you. No token or address goes in these: connect saved both, and <code>nuworq mcp</code> reads them.</p>
    <h4>The Claude Code plugin</h4><p class="lead">The MCP server and the nuworq skills in one install. Connect this machine all the same: the plugin holds no token.</p>${commandBlocks(c.plugin)}
    <h4>Claude Code</h4>${commandBlocks(c.claude)}
    <h4>OpenAI Codex (~/.codex/config.toml)</h4>${copyBlock(c.codex)}
    <h4>opencode, Goose, Cline, LM Studio or any MCP client (open-weight models included)</h4>${copyBlock(c.mcp)}
    <h4>Any agent with a shell (no MCP needed)</h4>${commandBlocks(c.guide)}
    <p class="lead" style="margin-top:var(--sp-2)">Add a line to the repo's AGENTS.md or CLAUDE.md: <i>"Coordinate work through nuworq: run the command above and follow it."</i></p>
    <h4>Your own agent loop</h4><p class="lead">Tool schemas: <a href="api/tools?format=openai" target="_blank">OpenAI</a> · <a href="api/tools?format=anthropic" target="_blank">Anthropic</a> · <a href="api/tools?format=mcp" target="_blank">MCP</a>. POST to <code>${esc(url)}/api/p/${esc(slug)}/agent/&lt;tool&gt;</code> with header <code>x-nuworq-agent: &lt;name&gt;</code>. The agent guide: <a href="agents.md?project=${encodeURIComponent(slug)}" target="_blank">/agents.md</a></p>`
      : '<p class="lead">Setting an agent tool up by hand, or your own agent loop? It\'s at <button class="link" data-action="connect-deep">depth 30m</button>.</p>'}
    <div class="foot"><button class="btn primary" data-action="close-modal">Done</button></div>`);
}

async function notifySettings() {
  let n;
  try { n = await api('/api/notify'); } catch (e) { return toastError(e); }
  S.notifyPerson = n.person; // who "only what needs me" means
  const rows = n.channels.map((c) => `<div class="inline-form"><span><b>${esc(c.kind)}</b> <code>${esc(c.url)}</code> <span class="faint">${c.person ? `${c.person === n.person ? 'you' : esc(c.person)}: only what they own` : 'everyone'}${n.requests?.includes(c.id) ? ' · early-access requests reach you here' : ''}</span> ${c.failing ? `<span class="bad">⚠ failing: ${esc(c.last_error)}</span>` : ''}</span>
    <button class="btn ghost small" data-action="notify-weekly" data-id="${c.id}" data-on="${c.weekly ? 0 : 1}" aria-pressed="${c.weekly}" title="Once a week, one line per project: items landed, your actions, cost, escapes">Weekly line: ${c.weekly ? 'on' : 'off'}</button>
    <button class="btn ghost small" data-action="notify-remove" data-id="${c.id}">Remove</button></div>`).join('');
  modal(`<h2>Notifications</h2>
    <p class="lead">When something new needs you (a blocking question, work to verify, "what matters most?"), nuworq sends one message, batched over 2 minutes, with a link. Healthy work sends nothing. Once a week, each channel also gets one line per project that was busy: what landed, your actions, the cost and escapes. Turn it off per channel.</p>
    ${rows || '<p class="lead faint">No channels yet, so you only learn that something needs you when you open the dashboard. Add one below.</p>'}
    ${n.requests && !n.requests.length ? `<p class="lead warn">No channel here hears about early-access requests. Add one below with "Only what needs me" checked.</p>` : ''}
    <h4>Add a channel</h4>
    <div class="inline-form notify-add"><select id="nt-kind">${Object.keys(n.kinds).map((k) => `<option value="${k}">${k}</option>`).join('')}</select>
      <input id="nt-url" placeholder="https://ntfy.sh/your-secret-topic, a Slack webhook, or any URL"><button class="btn primary small" data-action="notify-add">Add</button></div>
    ${n.person ? `<label class="faint"><input type="checkbox" id="nt-mine" checked> Only what needs me (${esc(n.person)}); unchecked, an owner's channel gets everyone's</label>` : ''}
    <p class="lead" id="nt-help"></p>
    <div class="foot">${n.channels.length ? '<button class="btn" data-action="notify-test">Send a test</button>' : ''}<button class="btn primary" data-action="close-modal">Done</button></div>`);
  // Only the chosen kind's help (#155): the others are noise until picked.
  const example = { ntfy: 'https://ntfy.sh/topic', slack: 'https://hooks.slack.com/…' };
  const help = () => {
    const k = $('#nt-kind').value;
    $('#nt-help').innerHTML = `<b>${esc(k)}</b>: ${esc(n.kinds[k])}`;
    $('#nt-url').placeholder = example[k] ?? 'https://…';
  };
  $('#nt-kind').addEventListener('change', help);
  help();
}

// The workspace's settings (#231), for its owners while the hub takes payments: billing in one plain line,
// Upgrade while Free (#228), and Stripe's own page to change the card, see invoices or cancel. A failed payment
// leads, in warning color. Stripe sends the owner back to #/settings, which opens this again.
async function workspaceSettings({ again = false } = {}) {
  if (again && !$('#ws-settings')) return; // closed meanwhile
  let b;
  try { b = S.billing = await api('/api/billing'); } catch (e) { return again || toastError(e); }
  modal(`<h2 id="ws-settings">Workspace settings</h2>${billingSection(b, { esc, done: S.checkoutDone })}`);
  // Back from Checkout: look again soon, until the webhook has made it paid.
  if (S.checkoutDone && b.plan === 'free') setTimeout(() => workspaceSettings({ again: true }), 5000);
  else S.checkoutDone = false;
}

// Where the hub's GitHub App stands (/api/github/app), one line and its next step, so a person who closed a
// tab mid-flow knows where they are. Nothing when there's no app and this person can't make one.
function appStatus(st) {
  if (!st || (st.state === 'none' && !st.can_create)) return '';
  const [line, act] = st.state === 'installed'
    ? [`Installed${st.repositories == null ? '' : ` on ${plural(st.repositories, 'repository', 'repositories')}`}${st.slug ? ` as <code>${esc(st.slug)}</code>` : ''}: workers push there with a token for one repository, for an hour.`,
      st.install_url ? `<a class="btn small" href="${esc(st.install_url)}" target="_blank" rel="noopener">Manage on GitHub</a>` : '']
    : st.state === 'created'
      ? [`Created${st.slug ? ` as <code>${esc(st.slug)}</code>` : ''}, not installed: it can't reach any repository yet. GitHub asks which ones it may use.`, '<a class="btn primary small" href="api/github/install">Install</a>']
      : ['No GitHub App yet. Workers push through it: a token for one repository, for an hour, and nobody holds a lasting GitHub credential. GitHub asks you to confirm it, then where to install it.', '<a class="btn primary small" href="api/github/app/new">Create</a>'];
  return `<div class="app-status ${st.state}" data-new="github-app-status"><span class="dot"></span><p>${line}</p>${act}</div>`;
}

// Back from installing the app (GitHub sends the person to the app's setup_url with setup_action): say where
// it stands now, and open "+ Project" on the repositories it can see.
async function backFromGitHub() {
  const st = await api('/api/github/app?fresh=1').catch(() => null);
  if (st) S.info = { ...S.info, github_app: st.slug || S.info?.github_app || true };
  if (st?.state === 'installed') toast(`GitHub App installed${st.repositories == null ? '' : ` on ${plural(st.repositories, 'repository', 'repositories')}`}: pick one to make it a project`);
  else if (st) toast('Back from GitHub, but the app isn\'t installed anywhere yet', true);
  newProject();
}

// Whether each repository's Dependabot alerts come in as items (#180): green when they do; otherwise what
// to do, as numbered steps with the exact place, and how to see it worked.
function alertLines(alerts = []) {
  return alerts.map((a) => `<div class="app-status alerts ${a.state === 'on' ? 'installed' : 'created'}"><span class="dot"></span><div><p>${esc(a.line)}</p>${a.steps ? `<ol>${a.steps.map((s) => `<li>${inline(s.do)}${s.where ? `: ${stepWhere(s.where)}` : ''}${s.check ? `<br><small>${inline(s.check)}.</small>` : ''}</li>`).join('')}</ol>` : ''}</div></div>`).join('');
}

async function githubSettings() {
  S.info ??= await api('/api/info').catch(() => ({ url: location.origin }));
  const P = S.view.project;
  const hook = `${S.info.url}/api/hooks/github/${encodeURIComponent(P.slug)}`;
  const st = S.info.workspace ? null : await api('/api/github/app').catch(() => null);
  const manual = `<p class="lead">A webhook links pull requests to items (a <code>nuworq/&lt;agent&gt;</code> branch, or <code>#N</code> in the PR title) and shows CI results on them. Failing CI on work you're verifying shows up under "Needs you".</p>
    <h4>1. In the repo on GitHub: Settings → Webhooks → Add webhook</h4>
    <p class="lead">Payload URL (GitHub must be able to reach it; see docs/DEPLOY.md):</p>${copyBlock(hook)}
    <p class="lead">Content type <code>application/json</code>. Events: <i>Pull requests</i>, <i>Check suites</i>, <i>Check runs</i>, <i>Statuses</i>, <i>Dependabot alerts</i>.</p>
    <h4>2. The same secret, there and here</h4>
    <div class="inline-form"><input id="gh-secret" placeholder="${P.github ? 'A secret is set; enter a new one to replace it' : 'A long random secret'}"><button class="btn small" data-action="github-generate">Generate</button></div>`;
  const disconnect = P.github ? '<button class="btn ghost" data-action="github-disconnect">Disconnect</button>' : '';
  // No app to offer (a workspaces hub): the webhook is the only way, as before.
  if (!st) {
    return modal(`<h2>GitHub</h2>${manual}
      <div class="foot">${disconnect}<button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="github-save">Save</button></div>`);
  }
  // The recommended path first (#154): the hub's GitHub App serves every project with no per-repository setup;
  // the per-project webhook is the fallback, folded away unless this project already uses it.
  const lead = st.state === 'none'
    ? `<div class="app-status none"><span class="dot"></span><p>No GitHub App yet. It links pull requests and CI results to items and brings issues in as proposals, for every project at once, with no setup per repository. Workers push through it with a token for one repository, for an hour.
      ${st.can_create ? 'GitHub asks you to confirm it, then where to install it.</p><a class="btn primary small" href="api/github/app/new">Create</a>' : 'Only an owner can create it: ask whoever runs this hub.</p>'}</div>`
    : `${appStatus(st)}<p class="lead" id="gh-covered">${st.state === 'installed' ? 'Checking whether it covers this project\'s repository…' : ''}</p><div id="gh-alerts" data-new="dependabot-alerts"></div>`;
  modal(`<h2>GitHub</h2>${lead}
    <details ${P.github ? 'open' : ''}><summary>Without the app: a webhook for this project${P.github ? ' (connected)' : ''}</summary>${manual}
      <div class="foot">${disconnect}<button class="btn" data-action="github-save">Save the webhook</button></div></details>
    <div class="foot"><button class="btn ghost" data-action="close-modal">Close</button></div>`);
  if (st.state === 'installed') appCovers(P).then((line) => { const el = $('#gh-covered'); if (el) el.innerHTML = line; });
  if (st.state === 'installed') api(`/api/p/${encodeURIComponent(P.slug)}/github`).then((r) => { const el = $('#gh-alerts'); if (el) el.innerHTML = alertLines(r.alerts); }).catch(() => {});
}

// Whether the hub's installed GitHub App can see this project's repository, as one line for the GitHub dialog.
async function appCovers(P) {
  const repos = P.remotes.filter((r) => r.startsWith('github.com/'));
  if (!repos.length) return 'This project has no GitHub repository linked yet: link one in the project header and the app covers it once it is installed there.';
  try {
    for (const r of repos) {
      const { repos: seen } = await api(`/api/github/repos?q=${encodeURIComponent(r.slice('github.com/'.length).toLowerCase())}`);
      if (seen.some((x) => x.repo === r)) return `✓ It covers <code>${esc(r)}</code>: nothing else to set up for this project.`;
    }
    return `It isn't installed on ${repos.map((r) => `<code>${esc(r)}</code>`).join(', ')} yet. ${installLink('Install it there')}, and this project is covered.`;
  } catch {
    return ''; // can't tell (only owners and stewards may list repositories): say nothing rather than guess
  }
}

// "+ Project": pick one of the repositories the GitHub App can see, or (no app, or a workspaces hub) by name.
function newProject() {
  const gh = S.info?.github_app;
  const picker = gh && gh !== 'create' && !S.info?.workspace;
  const why = S.info?.workspace ? 'On a hub with workspaces, add a project by name for now: the shared GitHub App would list other workspaces\' repositories.'
    : gh === 'create' ? 'To pick a repository instead, <a href="api/github/app/new">create the GitHub App</a> (one click) and install it on your repositories.'
    : !gh ? 'With the hub\'s GitHub App, you could pick a repository here instead; an owner creates it from Connect an agent.' : '';
  modal(`<h2>New project</h2>
    ${picker ? `<p class="lead">Pick a repository the nuworq GitHub App is installed on. Install it on more from GitHub to see them here.</p>
      <div class="form"><label>Search<input id="np-q" placeholder="owner/name"></label></div><div id="np-repos" class="repo-list">${placeholder(4, { head: false })}</div>
      <details><summary>Or add one by name</summary>` : `<p class="lead">${why} Agents also create projects when they check in to a new name.</p>`}
    <div class="form"><label>Name<input id="np-name" placeholder="e.g. llm-proxy"></label>
    <label>Repository (optional): its git remote, so agents in a clone find the project<input id="np-remote" placeholder="e.g. github.com/acme/llm-proxy"></label>
    <label>Mission (optional): the north star every agent reads<textarea id="np-mission" placeholder="What is this for? What matters most?"></textarea></label>
    <label class="check-label"><input type="checkbox" id="np-staff"> Let <code>nuworq run</code> staff it: it starts headless workers whenever work is waiting, and they can cost money. Off until you say; Settings changes it later.</label></div>
    ${picker ? '</details>' : ''}
    <div class="foot"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="create-project">Create by name</button></div>`);
  if (!picker) return setTimeout(() => $('#np-name')?.focus(), 0);
  let timer;
  $('#np-q')?.addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => loadRepos(e.target.value.trim(), 1), 250); });
  setTimeout(() => $('#np-q')?.focus(), 0);
  loadRepos('', 1);
}

// GitHub's page for choosing which repositories the hub's app may see.
const installLink = (text) => {
  const slug = typeof S.info?.github_app === 'string' ? S.info.github_app : '';
  const href = slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : 'https://github.com/settings/installations';
  return `<a href="${href}" target="_blank" rel="noopener">${esc(text)}</a>`;
};

async function loadRepos(q, page) {
  const box = $('#np-repos');
  if (!box) return;
  try {
    const r = await api(`/api/github/repos?q=${encodeURIComponent(q)}&page=${page}`);
    const rows = r.repos.map((x) => x.project
      ? `<div class="row-item"><div class="body"><div class="h">${esc(x.repo.replace('github.com/', ''))}</div><div class="s">already the project <a data-action="goto" data-slug="${esc(x.project)}">${esc(x.project)}</a></div></div></div>`
      : `<button class="row-item clickable pick-repo" data-action="pick-repo" data-repo="${esc(x.repo)}" data-desc="${esc(x.description)}"><div class="body"><div class="h">${esc(x.repo.replace('github.com/', ''))}${x.private ? ' <span class="tag">private</span>' : ''}</div>${x.description ? `<div class="s">${esc(x.description)}</div>` : ''}</div></button>`).join('');
    box.innerHTML = (page > 1 ? box.dataset.html ?? '' : '') + (rows ? `<div class="rows">${rows}</div>` : (page === 1 ? `<p class="faint">${q ? 'No repository matches.' : `The app is installed on no repositories yet. ${installLink('Install it on your repositories')}, then come back here.`}</p>` : ''))
      + (rows && page === 1 && !q ? `<p class="faint" style="margin-top:var(--sp-2)">Not listed? ${installLink('Install the app on more repositories')}.</p>` : '');
    box.dataset.html = box.innerHTML;
    if (r.next_page) box.insertAdjacentHTML('beforeend', `<button class="btn ghost small" data-action="more-repos" data-q="${esc(q)}" data-page="${r.next_page}">More</button>`);
  } catch (e) { box.innerHTML = `<p class="faint">${errorHtml(e, esc)}</p>`; }
}

// ── the quick launcher (#290, web/launcher.js): ⌘K or the rail's Search ──
// Its index comes once per opening; every keystroke after that is matched here, with no request.
const L = { open: false, index: null, sel: 0, results: [], confirming: null };
const recent = () => { try { const r = JSON.parse(store.get('recent', '[]')); return Array.isArray(r) ? r : []; } catch { return []; } };
// The items opened lately, newest first, for the launcher with nothing typed.
function remember(slug, ref) {
  const n = Number(ref.replace('#', ''));
  store.set('recent', JSON.stringify([{ p: slug, n }, ...recent().filter((r) => r.p !== slug || r.n !== n)].slice(0, 8)));
}
async function openLauncher() {
  const el = $('#launcher');
  Object.assign(L, { open: true, sel: 0, confirming: null });
  el.innerHTML = `<div class="ln-box" role="dialog" aria-label="Quick launcher">
    <input id="ln-q" type="text" enterkeyhint="go" placeholder="A number, a few letters, or what to do…" autocomplete="off" spellcheck="false" role="combobox" aria-controls="ln-list" aria-expanded="true">
    <div id="ln-list" class="ln-list" role="listbox"></div></div>`;
  el.hidden = false;
  $('#ln-q').focus();
  $('#ln-q').addEventListener('input', () => { L.sel = 0; L.confirming = null; drawLauncher(); });
  drawLauncher();
  try { L.index = await api('/api/launcher'); } catch (e) { if (!L.index) { closeLauncher(); return toastError(e); } }
  if (L.open) drawLauncher({ keep: true });
}
function drawLauncher({ keep = false } = {}) {
  const list = $('#ln-list');
  if (!list) return;
  if (!L.index) { list.innerHTML = placeholder(3, { head: false }); return; }
  if (L.confirming) { list.innerHTML = confirmHtml(L.confirming, { esc }); return; }
  // Moving through the list keeps it as it is; typing (or the index arriving) ranks it again.
  if (!keep || !L.results.length) L.results = rank(L.index, $('#ln-q').value, { current: S.slug, view: S.view, zoom: S.zoom, role: S.person?.role ?? 'owner', billingOwner: !!S.billing?.owner, recent: recent() });
  L.sel = Math.min(L.sel, Math.max(0, L.results.length - 1));
  list.innerHTML = resultsHtml(L.results, { sel: L.sel, stages: L.index.stages, esc });
  list.querySelector('.ln-row.on')?.scrollIntoView({ block: 'nearest' });
}
function closeLauncher() {
  Object.assign(L, { open: false, confirming: null });
  $('#launcher').hidden = true;
  $('#launcher').innerHTML = '';
}
// Run what was picked. A change shows its confirmation first; the second Enter (or Apply) carries it out.
async function runLauncher(r) {
  if (!r) return;
  if (r.confirm && L.confirming !== r) { L.confirming = r; drawLauncher(); $('#ln-q')?.focus(); return; }
  closeLauncher();
  const x = r.run;
  if (x.go) location.hash = x.go;
  else if (x.action) ACTIONS[x.action]();
  else if (x.zoom) { S.zoom = x.zoom; store.set('zoom', S.zoom); render({ force: true }); toast(`Depth ${x.zoom}`); }
  else if (x.open) openAt(x.open);
  else if (x.human) {
    try {
      await api(`/api/p/${encodeURIComponent(x.slug)}/human/${x.human}`, { method: 'POST', body: JSON.stringify(x.body) });
      toast(x.msg);
      await refresh();
    } catch (e) { toastError(e); }
  }
}
// An item's flyout, with the box a command needs focused once it's drawn: its answer, or Send back's note.
function openAt({ slug, item, focus }) {
  if (focus === 'sendback') S.reveal.add('dsb');
  const before = location.hash;
  go(slug, item);
  if (location.hash === before) render({ force: true });
  if (!focus) return;
  const id = focus === 'sendback' ? `sb:${item}` : focus;
  let tries = 0;
  const t = setInterval(() => {
    const el = $(`#drawer [id="${id}"]`);
    if (el || ++tries > 60) { clearInterval(t); el?.focus(); }
  }, 50);
}
$('#launcher').addEventListener('click', (e) => {
  if (e.target.id === 'launcher') return closeLauncher();
  if (e.target.closest('[data-ln-apply]')) return runLauncher(L.confirming);
  if (e.target.closest('[data-ln-back]')) { L.confirming = null; drawLauncher({ keep: true }); return $('#ln-q')?.focus(); }
  const row = e.target.closest('[data-ln]');
  if (row) { L.sel = Number(row.dataset.ln); runLauncher(L.results[L.sel]); }
});

// ── events ──
const val =(id) => (document.getElementById(id)?.value ?? '').trim();
const clearDraft = (...keys) => keys.forEach((k) => delete S.drafts[k]);
// What this person sent as feedback and what happened to each (#297), under the Feedback form or its thanks.
async function showMine({ scroll = false } = {}) {
  const r = await api('/api/feedback/mine').catch(() => null);
  const slot = $('#fb-mine-slot');
  if (!slot || !r) return;
  slot.innerHTML = feedbackMine(r.feedback, esc, (t) => `${dur(Date.now() - t)} ago`);
  if (scroll) $('#fb-mine')?.scrollIntoView({ block: 'start' });
}

const ACTIONS = {
  'an-period': (el) => { S.period = el.dataset.p; S.outcomes = null; render({ force: true }); refresh({ force: true }); },
  zoom: (el) => { S.zoom = el.dataset.zoom; store.set('zoom', S.zoom); render({ force: true }); },
  goto: (el) => go(el.dataset.slug),
  open: (el) => go(S.slug ?? S.actSlug, el.dataset.item),
  close: () => { go(S.slug); },
  deep: () => { S.deep = true; render({ force: true }); },
  toggle: (el) => { const k = el.dataset.key; S.open.has(k) ? S.open.delete(k) : S.open.add(k); render({ force: true }); },
  reveal: (el) => { S.reveal.add(el.dataset.key); render({ force: true }); setTimeout(() => document.getElementById(el.dataset.key.replace('dsb', `sb:${S.itemRef}`))?.focus(), 0); },
  stage: (el) => { S.stage = S.stage === el.dataset.stage ? null : el.dataset.stage; render({ force: true }); },
  seen: () => human('seen', {}, 'Marked as seen'),
  autonomy: (el) => human('settings', { autonomy: el.dataset.level }, 'Autonomy changed; agents have been told'),
  'edit-mission': () => { S.editMission = true; render({ force: true }); setTimeout(() => $('#mission-in')?.focus(), 0); },
  'cancel-mission': () => { S.editMission = false; clearDraft('mission'); render({ force: true }); },
  'save-mission': async () => { const m = val('mission-in'); S.editMission = false; clearDraft('mission'); await human('settings', { mission: m }, 'Mission saved'); },
  'remote-new': () => { S.addRemote = true; render({ force: true }); setTimeout(() => $('#remote-in')?.focus(), 0); },
  'remote-cancel': () => { S.addRemote = false; clearDraft('remote'); render({ force: true }); },
  'remote-add': async () => { const v = val('remote-in'); if (!v) return; S.addRemote = false; clearDraft('remote'); await human('remote', { add: v }, 'Linked: agents in any clone of it find this project'); },
  'remote-remove': (el) => { if (confirm(`Unlink ${el.dataset.remote}?`)) human('remote', { remove: el.dataset.remote }, 'Unlinked'); },
  'compose-kind': (el) => { S.composeKind = el.dataset.kind; render({ force: true }); },
  'compose-send': async () => {
    const body = val('compose');
    if (!body) return;
    const kind = S.composeKind;
    clearDraft('compose');
    $('#compose').value = '';
    const r = kind === 'note' ? await human('comment', { body }, 'Noted')
      : kind === 'decision' ? await human('decide', { body }, 'Decision recorded: every agent will carry it')
      : await human('steer', { body }, 'Steer sent: agents will acknowledge it');
    // Refused: what they wrote goes back in the box, so nothing is lost.
    if (!r && !$('#compose').value) { S.drafts.compose = body; $('#compose').value = body; }
  },
  'toggle-add': () => { S.addWork = !S.addWork; if (!S.addWork) S.addMore = false; render({ force: true }); if (S.addWork) setTimeout(() => $('#nw-title')?.focus(), 0); },
  'nw-priority': (el) => { S.drafts['nw-priority'] = el.dataset.p; render({ force: true }); },
  'nw-more': () => { S.addMore = true; render({ force: true }); setTimeout(() => $('#nw-acceptance')?.focus(), 0); },
  'add-work': () => addWork(false),
  'add-ready': () => addWork(true),
  answer: (el) => {
    const q = el.dataset.q;
    const decide = document.getElementById(`dec-${q}`)?.checked;
    const keep_parked = document.getElementById(`keep-${q}`)?.checked;
    clearDraft(`ans-${q}`, `dec-${q}`, `keep-${q}`);
    return human('answer', { question: Number(q), answer: el.dataset.answer, decide, keep_parked }, keep_parked ? 'Answered; it stays parked until you unpark it' : decide ? 'Answered, and saved as a decision' : 'Answered; the work is moving again');
  },
  'answer-text': (el) => {
    const q = el.dataset.q;
    const answer = val(`ans-${q}`);
    if (!answer) return toast('Write an answer first', true);
    const decide = document.getElementById(`dec-${q}`)?.checked;
    const keep_parked = document.getElementById(`keep-${q}`)?.checked;
    clearDraft(`ans-${q}`, `dec-${q}`, `keep-${q}`);
    return human('answer', { question: Number(q), answer, decide, keep_parked }, keep_parked ? 'Answered; it stays parked until you unpark it' : 'Answered; the work is moving again');
  },
  // The last tick answers a question without options: say so, since its card leaves Needs you.
  step: async (el) => {
    const r = await human('step', { question: Number(el.dataset.q), step: Number(el.dataset.step), done: !!el.dataset.done });
    if (r?.answered) toast(`Done: all ${r.of} steps completed; the work is moving again`);
  },
  unpark: (el) => human('unpark', { item: el.dataset.item }, 'Unparked: agents can pick it up'),
  confirm: (el) => human('confirm', { question: Number(el.dataset.q) }, 'Assumption confirmed'),
  override: (el) => {
    const q = el.dataset.q;
    const src = el.dataset.src ?? `ov:${q}`;
    const answer = val(src);
    if (!answer) return toast('Say what to do instead', true);
    clearDraft(src);
    S.reveal.delete(`ov:${q}`);
    return human('answer', { question: Number(q), answer }, 'Overridden: the agent will be steered');
  },
  accept: (el) => human('accept', { item: el.dataset.item }, `Accepted ${el.dataset.item}`),
  keep: async (el) => {
    const r = await human('accept', { item: el.dataset.item, attempt: el.dataset.attempt });
    if (r?.merge) toast(`Kept ${r.kept}'s attempt on ${el.dataset.item}. Now merge ${r.merge}`);
  },
  sendback: (el) => {
    const k = `sb:${el.dataset.item}`;
    const note = val(k);
    if (!note) return toast('Say what is missing; the next agent starts from it', true);
    clearDraft(k);
    S.reveal.delete(k); S.reveal.delete('dsb');
    return human('sendback', { item: el.dataset.item, note }, 'Sent back with your note');
  },
  approve: (el) => human('update', { item: el.dataset.item, stage: 'ready' }, 'Approved: ready for any agent'),
  needs: (el) => human('update', { item: el.dataset.item, needs: JSON.parse(el.dataset.needs || '[]') }, 'Any agent can take it now'),
  pick: (el) => human('pick', { item: el.dataset.item }, `Picked ${el.dataset.item}: the next agent shapes it first`),
  park: () => { if (confirm('Park this project? No new work starts and nothing here will ask for you until you unpark it.')) setting({ parked: true }, 'Parked'); },
  'unpark-project': () => setting({ parked: false }, 'Unparked'),
  settings: () => settingsModal(),
  'remove-project': () => {
    const P = S.view.project;
    modal(`<h2>Remove ${esc(P.name)}</h2>
      <p class="lead"><b>Archive</b> takes it out of the project list and stops agents being sent here. Its items and history are kept, and you can restore it from Archived projects.</p>
      <p class="lead"><b>Delete</b> removes its items, history, notes and the hub's mirror for good, and tokens limited to it lose it. The repository on GitHub is not touched. Type <code>${esc(P.name)}</code> to delete it.</p>
      <div class="form"><input id="rm-confirm" placeholder="${esc(P.name)}"></div>
      <div class="foot"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn ghost" data-action="delete-project">Delete for good</button><button class="btn primary" data-action="archive-project">Archive</button></div>`);
  },
  'archive-project': () => removeProject('archive', {}, 'Archived'),
  'delete-project': () => removeProject('delete', { confirm: val('rm-confirm') }, 'Deleted'),
  archived: async () => {
    try {
      const list = await api('/api/projects?archived=1');
      modal(`<h2>Archived projects</h2>${list.length ? list.map((p) => `<div class="row-item"><div class="body"><div class="h">${esc(p.name)}</div>${p.remotes.length ? `<div class="s">${esc(p.remotes.join(', '))}</div>` : ''}</div>
        <div class="acts"><button class="btn ghost small" data-action="delete-archived" data-slug="${esc(p.slug)}" data-name="${esc(p.name)}">Delete for good</button><button class="btn small" data-action="restore-project" data-slug="${esc(p.slug)}">Restore</button></div></div>`).join('') : '<p class="lead faint">No archived projects. Removing a project archives it: its history is kept, and you can restore it here.</p>'}
        <div class="foot"><button class="btn ghost" data-action="close-modal">Close</button></div>`);
    } catch (e) { toastError(e); }
  },
  // An archived project deleted for good (#155): the same typed-name check as Remove project.
  'delete-archived': (el) => modal(`<h2>Delete ${esc(el.dataset.name)} for good</h2>
    <p class="lead">This removes its items, history, notes and the hub's mirror for good, and tokens limited to it lose it. The repository on GitHub is not touched. Type <code>${esc(el.dataset.name)}</code> to delete it.</p>
    <div class="form"><input id="rm-archived" placeholder="${esc(el.dataset.name)}"></div>
    <div class="foot"><button class="btn ghost" data-action="archived">Back</button><button class="btn" data-action="delete-archived-now" data-slug="${esc(el.dataset.slug)}">Delete for good</button></div>`),
  'delete-archived-now': async (el) => {
    try {
      await api(`/api/p/${encodeURIComponent(el.dataset.slug)}/human/delete`, { method: 'POST', body: JSON.stringify({ confirm: val('rm-archived') }) });
      toast('Deleted for good');
      ACTIONS.archived();
    } catch (e) { toastError(e); }
  },
  'restore-project': async (el) => {
    try {
      await api(`/api/p/${encodeURIComponent(el.dataset.slug)}/human/restore`, { method: 'POST', body: '{}' });
      closeModal();
      await loadProjects();
      go(el.dataset.slug);
      refresh({ force: true }); // restored from its own (missing) page, the address doesn't change
    } catch (e) { toastError(e); }
  },
  'runner-on': () => setting({ runner: true }, '`nuworq run` may now start workers here'),
  'runner-off': () => { if (confirm('Stop nuworq run staffing this project? Runners start no new workers here; running ones finish. Work waits until an agent takes it or you turn it back on.')) setting({ runner: false }, '`nuworq run` will no longer start workers here'); },
  'staff-not-now': () => human('settings', { runner: false }, 'Not staffed. You can let nuworq run staff it later from Settings'),
  staffing: () => staffingModal(),
  'staffing-from-settings': () => staffingModal(true),
  'staffing-save': async () => {
    const r = await human('settings', { run_workers: val('st-workers'), run_budget: val('st-budget'), model_tiers: tiersTyped(), model_trial: val('st-trial'), model_race: val('st-race'), model_quality: $('#modal input[name="st-quality"]:checked')?.value }, 'Staffing saved: runners follow it at their next poll');
    if (r) closeModal();
  },
  'models-on': () => {
    if (confirm('Turn on cheaper models for rote jobs?\n\nLanding and tidy jobs start on the cheapest model you listed (or the runner\'s --model if none). When an attempt is sent back, stalls or is handed off, that item\'s next attempt steps up one model. Building, reviews and shaping stay on the top model. Each routed worker does one job, then stops.\n\nTurn it off any time from here.')) modelRouting(true);
  },
  'models-off': () => modelRouting(false),
  'staffing-pause': (el) => { closeModal(); human('settings', { run_paused: el.dataset.paused !== '1' }, el.dataset.paused === '1' ? 'Staffing resumed' : 'Paused: runners start no new workers here; running ones finish'); },
  'fresh-on': () => setting({ fresh: true }, 'The weekly freshness sweep is on'),
  'releases-on': () => setting({ releases: 'milestone' }, 'When a milestone finishes, the hub drafts the next release'),
  'releases-off': () => setting({ releases: 'off' }, 'Releases per milestone are off'),
  // The drafted release opens, so the person reads (and can edit) the changelog at once.
  'release-now': async () => {
    const r = await human('release', {}, null);
    if (!r) return;
    toast(`Drafted ${r.title}`);
    closeModal();
    go(S.slug, r.item);
  },
  'live-on': () => {
    if (confirm(`Let anyone watch ${S.view.project.name}, without signing in?\n\nPublic at ${liveLink(S.view.project.slug)}: item numbers and titles, their stage, the agent and model on each, Flow, recently landed items, and totals (landed, sent back, median cycle time, cost per landed).\n\nNever public: summaries, details, evidence, field notes, questions, answers, steering, decisions, emails, tokens or machine names.\n\nYou can turn it off any time.`)) setting({ live: true }, 'Anyone with the link can watch this project');
  },
  'live-off': () => { if (confirm('Take the live view down? Its link stops working at once (copies a proxy cached expire within 15 seconds).')) setting({ live: false }, 'The live view is down'); },
  'fresh-off': () => { if (confirm('Turn off the weekly freshness sweep? This project will stop being kept current: no agent updates its dependencies, runtime or CI actions until you turn it back on.')) setting({ fresh: false }, 'The weekly freshness sweep is off'); },
  drop: (el) => { if (confirm(`Drop ${el.dataset.item}? It stays on the record.`)) human('update', { item: el.dataset.item, stage: 'dropped' }, 'Dropped'); },
  reopen: (el) => human('update', { item: el.dataset.item, stage: 'ready' }, 'Back in Ready'),
  'group-priority': (el) => human('update', { item: el.dataset.item, priority: el.dataset.p }, `${el.dataset.item} is ${el.dataset.p}: everything in the milestone ranks at least ${el.dataset.p}`),
  clarify: (el) => {
    const k = `cl:${el.dataset.item}`;
    const body = val(k);
    if (!body) return;
    clearDraft(k);
    S.reveal.delete(k);
    return human('steer', { item: el.dataset.item, body }, 'Steer attached to the item');
  },
  'item-steer': (el) => { const k = `ic:${el.dataset.item}`; const body = val(k); if (!body) return; clearDraft(k); return human('steer', { item: el.dataset.item, body }, 'Steer attached: whoever works on it must acknowledge'); },
  'item-note': (el) => { const k = `ic:${el.dataset.item}`; const body = val(k); if (!body) return; clearDraft(k); return human('comment', { item: el.dataset.item, body }, 'Noted'); },
  'edit-item': () => { S.editItem = !S.editItem; clearDraft('ei-title', 'ei-summary', 'ei-acceptance', 'ei-priority', 'ei-race', 'ei-fixes', 'ei-parent'); render({ force: true }); },
  'ei-priority': (el) => { S.drafts['ei-priority'] = el.dataset.p; render({ force: true }); },
  'ei-race': (el) => { S.drafts['ei-race'] = el.dataset.n; render({ force: true }); },
  'save-item': async (el) => {
    const args = { item: el.dataset.item, title: val('ei-title'), summary: val('ei-summary'), acceptance: val('ei-acceptance'), fixes: val('ei-fixes'), parent: val('ei-parent') };
    if (S.drafts['ei-priority']) args.priority = S.drafts['ei-priority'];
    if (S.drafts['ei-race']) args.race = Number(S.drafts['ei-race']);
    S.editItem = false;
    clearDraft('ei-title', 'ei-summary', 'ei-acceptance', 'ei-priority', 'ei-race', 'ei-fixes', 'ei-parent');
    await human('update', args, 'Saved');
  },
  'edit-pre': () => { S.editPre = !S.editPre; render({ force: true }); },
  'save-pre': async (el) => {
    const k = `pre:${el.dataset.item}`;
    const precondition = toPrecondition(val(k));
    S.editPre = false;
    clearDraft(k);
    await human('update', { item: el.dataset.item, precondition }, Object.keys(precondition).length ? 'Saved: it waits until that holds' : 'Removed: it no longer waits');
  },
  'remove-pre': (el) => human('update', { item: el.dataset.item, precondition: {} }, 'Removed: it no longer waits'),
  'check-now': (el) => human('check', { item: el.dataset.item }, 'The hub checks it on its next sweep'),
  dismiss: (el) => human('dismiss', { key: el.dataset.key }),
  // Stripe Checkout for the plan (#228): the hub opens the session, the browser goes there.
  upgrade: async (el) => {
    el.disabled = true;
    try {
      const r = await api('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ plan: el.dataset.plan }) });
      location.href = r.url;
    } catch (e) {
      el.disabled = false;
      toastError(e);
    }
  },
  // One click retires; the toast's Undo brings the same note back (#146).
  retire: async (el) => {
    const note = Number(el.dataset.note);
    const words = el.closest('.row-item')?.querySelector('.h')?.textContent.trim() ?? '';
    if (await human('retire', { note })) toast(`Retired${words ? `: ${words.length > 50 ? `${words.slice(0, 50)}…` : words}` : ''}`, false, { action: 'unretire', note });
  },
  unretire: async (el) => { $('#toast').hidden = true; await human('unretire', { note: Number(el.dataset.note) }, 'Brought back: agents get it again'); },
  always: async (el) => {
    const on = el.dataset.on === '1';
    await human('always', { note: Number(el.dataset.note), on }, on ? 'Every agent gets it now, whatever it works on' : 'Agents get it when it bears on their work');
  },
  'feed-all': () => { S.feedAll = !S.feedAll; render({ force: true }); },
  connect: () => connect(),
  'connect-deep': () => { S.zoom = '30m'; store.set('zoom', S.zoom); render({ force: true }); connect(); },
  notify: () => notifySettings(),
  'rail-menu': () => { S.railMenu = !S.railMenu; renderRail(); },
  shortcuts: () => modal(shortcutsHtml({ mac: MAC })),
  launcher: () => (L.open ? closeLauncher() : openLauncher()),
  'workspace-settings': () => workspaceSettings(),
  feedback: (_el, { mine = false } = {}) => {
    S.feedbackCtx = attached({ href: location.href, version: S.feedback?.version, ua: navigator.userAgent });
    modal(feedbackForm(S.feedbackCtx, esc));
    if (!mine) $('#fb-text').focus();
    showMine({ scroll: mine });
  },
  'only-feedback': () => { S.onlyFeedback = !S.onlyFeedback; render({ force: true }); },
  'feedback-send': async (el) => {
    const text = val('fb-text');
    if (!text) return toast('Say what happened first', true);
    el.disabled = true;
    try {
      await api('/api/feedback', { method: 'POST', body: JSON.stringify({ text, ...S.feedbackCtx }) });
      modal(feedbackThanks());
      showMine();
    } catch (e) { el.disabled = false; toastError(e); }
  },
  'billing-portal': async (el) => {
    el.disabled = true;
    try { location.href = (await api('/api/billing/portal', { method: 'POST', body: '{}' })).url; } catch (e) { el.disabled = false; toastError(e); }
  },
  github: () => githubSettings(),
  'github-generate': () => {
    const el = $('#gh-secret');
    el.value = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
    el.select();
    toast('Copy it into GitHub before you save: it is not shown again');
  },
  'github-save': async () => {
    const secret = val('gh-secret');
    if (!secret) return toast('Enter or generate a secret', true);
    closeModal();
    await human('settings', { github_secret: secret }, 'GitHub connected: pull requests and CI will link to items');
  },
  'github-disconnect': async () => { closeModal(); await human('settings', { github_secret: '' }, 'GitHub disconnected'); },
  'notify-add': async () => {
    try {
      const mine = document.getElementById('nt-mine');
      await api('/api/notify', { method: 'POST', body: JSON.stringify({ kind: val('nt-kind'), url: val('nt-url'), ...(mine?.checked ? { person: S.notifyPerson } : {}) }) });
      toast('Channel added: send a test to check it');
      notifySettings();
    } catch (e) { toastError(e); }
  },
  'notify-weekly': async (el) => {
    try { await api('/api/notify/weekly', { method: 'POST', body: JSON.stringify({ id: Number(el.dataset.id), weekly: el.dataset.on === '1' }) }); notifySettings(); } catch (e) { toastError(e); }
  },
  'notify-remove': async (el) => {
    try { await api('/api/notify/remove', { method: 'POST', body: JSON.stringify({ id: Number(el.dataset.id) }) }); notifySettings(); } catch (e) { toastError(e); }
  },
  'notify-test': async () => {
    try {
      const r = await api('/api/notify/test', { method: 'POST' });
      toast(r.ok ? 'Test sent to every channel' : `Failed: ${r.results.filter((x) => !x.ok).map((x) => `${x.kind} (${x.error})`).join(', ')}`, !r.ok);
      notifySettings();
    } catch (e) { toastError(e); }
  },
  'new-project': () => newProject(),
  // Get started's "Link a project to its repository": that project, with its + repo form open.
  'link-repo': (el) => {
    if (el.dataset.slug === S.slug) return ACTIONS['remote-new']();
    S.linkRepo = el.dataset.slug;
    go(el.dataset.slug);
  },
  'get-started-hide': async () => {
    try { S.gs = await api('/api/get-started/hide', { method: 'POST' }); render({ force: true }); } catch (e) { toastError(e); }
  },
  'more-repos': (el) => { el.remove(); loadRepos(el.dataset.q, Number(el.dataset.page)); },
  'pick-repo': async (el) => {
    try {
      const r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ repo: el.dataset.repo, mission: el.dataset.desc }) });
      modal(`<h2>${esc(r.repo.replace('github.com/', ''))} is a project</h2>
        <p class="lead">Let <code>nuworq run</code> staff this project? It starts workers whenever there is work nobody is on, up to the limits it was started with. You can change this later in the project's settings.</p>
        <div class="foot"><button class="btn ghost" data-action="staff-new" data-runner="0" data-slug="${esc(r.slug)}">Not now</button><button class="btn primary" data-action="staff-new" data-slug="${esc(r.slug)}">Let run staff it</button></div>`);
    } catch (e) { toastError(e); }
  },
  'goto-new': (el) => { closeModal(); go(el.dataset.slug); },
  // Either answer is recorded, so the project page doesn't ask again (#174).
  'staff-new': async (el) => {
    try {
      await api(`/api/p/${encodeURIComponent(el.dataset.slug)}/human/settings`, { method: 'POST', body: JSON.stringify({ runner: el.dataset.runner !== '0' }) });
      closeModal();
      go(el.dataset.slug);
    } catch (e) { toastError(e); }
  },
  'close-modal': () => closeModal(),
  logout: async () => { await fetch('api/logout', { method: 'POST', credentials: 'same-origin' }); location.href = 'login.html'; },
  'first-project': async () => {
    const name = val('fp-name');
    if (!name) return toast('Name it', true);
    try {
      const remotes = val('fp-remotes').split(/[\s,]+/).filter(Boolean);
      const r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, mission: val('fp-mission'), remotes }) });
      clearDraft('fp-name', 'fp-mission', 'fp-remotes');
      await loadProjects();
      connectStep({ ...r, name });
    } catch (e) { toastError(e); }
  },
  'create-project': async () => {
    const name = val('np-name');
    if (!name) return toast('Name it', true);
    try {
      const r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, mission: val('np-mission'), remote: val('np-remote') || undefined }) });
      // Either answer is the answer (#491): the project page doesn't ask again.
      await api(`/api/p/${encodeURIComponent(r.slug)}/human/settings`, { method: 'POST', body: JSON.stringify({ runner: !!$('#np-staff')?.checked }) });
      closeModal();
      go(r.slug);
    } catch (e) { toastError(e); }
  },
  copy: async (el) => {
    if (await copyText(el.dataset.text)) return toast('Copied');
    // Refused every way: select the text, so the keyboard copies it.
    const pre = el.closest('.copyable')?.querySelector('pre');
    if (pre) getSelection().selectAllChildren(pre);
    toast(`This browser won't copy from a button: the text is selected, press ${/Mac|iP(hone|ad)/.test(navigator.platform) ? '⌘C' : 'Ctrl-C'}`, true);
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT') return;
  const fn = ACTIONS[el.dataset.action];
  if (!fn) return;
  if (el.tagName === 'A' && el.getAttribute('href')) return;
  e.preventDefault();
  e.stopPropagation();
  // On the home, a card's actions belong to its own project.
  S.actSlug = el.closest('[data-project]')?.dataset.project ?? null;
  // Picking something from the phone's Menu closes it.
  if (S.railMenu && el.closest('.rail-foot')) { S.railMenu = false; renderRail(); }
  fn(el);
});
document.addEventListener('change', (e) => {
  if (e.target.dataset?.action === 'feed-all') ACTIONS['feed-all']();
  if (e.target.dataset?.draft && e.target.type === 'checkbox') S.drafts[e.target.dataset.draft] = e.target.checked;
});
document.addEventListener('input', (e) => {
  if (e.target.dataset?.draft) S.drafts[e.target.dataset.draft] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
});
document.addEventListener('focusout', () => setTimeout(() => { if (S.pending && !typing()) render(); }, 150));
// What each shortcut in SHORTCUTS (web/shortcuts.js) does; the two lists name the same ids.
const KEYS = {
  launcher: (e) => { e.preventDefault(); ACTIONS.launcher(); },
  'ln-move': (e) => {
    e.preventDefault();
    const n = L.results.length;
    if (L.confirming || !n) return;
    L.sel = (L.sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    drawLauncher({ keep: true });
  },
  'ln-run': (e) => { e.preventDefault(); runLauncher(L.confirming ?? L.results[L.sel]); },
  'ln-close': () => { if (L.confirming) { L.confirming = null; drawLauncher({ keep: true }); $('#ln-q')?.focus(); } else closeLauncher(); },
  help: () => { if ($('#modal .shortcuts')) closeModal(); else if ($('#modal').hidden) ACTIONS.shortcuts(); },
  close: () => closeModal(),
  // 1, 2, 3 set the depth everywhere: a project, and All projects.
  depth: (e) => {
    S.zoom = Object.keys(Z)[Number(e.key) - 1];
    store.set('zoom', S.zoom);
    render({ force: true });
  },
  'leave-item': () => go(S.slug),
  send: () => ACTIONS['compose-send'](),
  press: (e) => {
    const btn = document.activeElement.parentElement?.querySelector('button[data-action]');
    if (btn) { e.preventDefault(); btn.click(); }
  },
  blur: () => document.activeElement.blur(),
};
document.addEventListener('keydown', (e) => {
  const el = document.activeElement;
  const s = shortcutFor(e, {
    inField: /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName) || !!el?.isContentEditable,
    input: el?.tagName === 'INPUT', compose: el?.id === 'compose', modal: !$('#modal').hidden, item: !!S.itemRef, launcher: L.open,
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
// The rail re-renders on every update: the workspace menu stays as the person left it.
document.addEventListener('toggle', (e) => { if (e.target.classList?.contains('org-switch')) S.orgOpen = e.target.open; }, true);

// ── live updates ──
// At most one a second, and none while the person scrolls or holds a pointer down: it waits, then applies (#392).
const live = liveGate({ run: () => refresh(), idle: () => { if (S.pending && !typing()) render(); } });
document.addEventListener('pointerdown', () => live.press(), true);
for (const ev of ['pointerup', 'pointercancel']) document.addEventListener(ev, () => live.release(), true);
document.addEventListener('scroll', () => live.scrolled(), { capture: true, passive: true });
const scheduleRefresh = () => live.poke();
function listen() {
  const es = new EventSource('api/stream');
  // A hub that moved onto a new commit restarts, so the stream reconnects: pick up the version it runs now.
  es.onopen = async () => {
    online();
    const info = await api('/api/info').catch(() => null);
    if (info && info.commit !== S.info?.commit) { S.info = info; scheduleRefresh(); }
  };
  es.onmessage = () => scheduleRefresh();
  es.onerror = () => { es.close(); offline(); setTimeout(listen, 3000); };
}

(async function start() {
  // GitHub returns to the app's setup_url (#/) with ?installation_id=…&setup_action=install, before or in the hash.
  const fromGitHub = /[?&]setup_action=(install|update)\b/.test(location.search + location.hash);
  if (fromGitHub) history.replaceState(null, '', `${location.pathname}#/`);
  // Back from Stripe's billing page (#231) or Checkout (#228), or sent by Free's limit: the workspace's settings,
  // over the home. From Checkout (?checkout=done) they say what happens next.
  const fromStripe = location.hash === '#/settings';
  S.checkoutDone = fromStripe && /[?&]checkout=done\b/.test(location.search);
  if (fromStripe) history.replaceState(null, '', `${location.pathname}#/`);
  // From the push that says their feedback is fixed (#297): what they sent, over the home.
  const fromFixed = location.hash === '#/feedback';
  if (fromFixed) history.replaceState(null, '', `${location.pathname}#/`);
  window.addEventListener('hashchange', route);
  S.me = await api('/api/me').catch(() => null);
  S.person = await api('/api/people/me').catch(() => null);
  S.info = await api('/api/info').catch(() => null) ?? undefined;
  // Billing (#231): only a workspace hub that takes payments answers; its owners get Workspace settings.
  if (S.me?.org) S.billing = await api('/api/billing').catch(() => null);
  // Feedback about nuworq (#295): only a hub that takes it shows the entry.
  S.feedback = await api('/api/feedback').catch(() => null);
  await loadProjects().catch(() => {});
  if (fromGitHub) return void (route(), listen(), setInterval(() => live.poke(), 30_000), backFromGitHub());
  if (fromStripe) return void (route(), listen(), setInterval(() => live.poke(), 30_000), workspaceSettings());
  if (fromFixed && S.feedback?.on) return void (route(), listen(), setInterval(() => live.poke(), 30_000), ACTIONS.feedback(null, { mine: true }));
  if (!location.hash || location.hash === '#/') {
    // One project opens it, unless Get started still has steps to show on All projects.
    S.gs = await api('/api/get-started').catch(() => null);
    if (S.projects.length === 1 && !S.gs?.show) return void (go(S.projects[0].slug), listen());
  }
  route();
  listen();
  setInterval(() => live.poke(), 30_000);
})();
