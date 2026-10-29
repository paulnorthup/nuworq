// nuworq UI. No framework: state → HTML strings → one delegated event handler.
// Zoom levels mirror 0-30-5-30: what isn't relevant at a level simply isn't rendered.
import { connectCommands } from './connect.js';
import { copyBlock, copyText } from './copy.js';

const Z = { '30s': 0, '5m': 1, '30m': 2 };
// Per-browser preferences. Ones saved before the rename (under "trellis:") are still read.
const store = {
  get: (k, d) => { try { return localStorage.getItem('nuworq:' + k) ?? localStorage.getItem('trellis:' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('nuworq:' + k, v); } catch {} },
};
const S = {
  projects: [], slug: null, view: null, info: null,
  itemRef: null, item: null, deep: false,
  zoom: store.get('zoom', '30s'),
  open: new Set(), reveal: new Set(), drafts: {},
  composeKind: 'steer', stage: null, addWork: false, editMission: false, editItem: false,
  feedAll: false, pending: false,
};
const z = () => Z[S.zoom];

// ── utilities ──
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

const inline = (t) => esc(t).replace(/`([^`\n]+)`/g, '<code>$1</code>');

function md(text) {
  if (!text) return '';
  const blocks = [];
  let s = String(text).replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => { blocks.push(`<pre>${esc(code.replace(/\n$/, ''))}</pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  s = esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
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
const modelOf = (name) => S.view?.agents.find((a) => a.name === name)?.model ?? '';
function who(name, model) {
  if (!name) return '';
  if (name === 'you') return '<span class="you-chip">You</span>';
  if (name === 'nuworq' || name === 'trellis') return '<span class="sys-chip">nuworq</span>'; // trellis: events from before the rename
  model ??= modelOf(name);
  const prov = providerOf(model);
  return `<span class="agent prov-${prov.toLowerCase().replace(/[^a-z]/g, '')}" title="${esc([model, prov].filter(Boolean).join(' · '))}"><i></i>${esc(name)}</span>`;
}
const refLink = (ref) => (ref ? `<a class="ref" data-action="open" data-item="${esc(ref)}">${esc(ref)}</a>` : '');
const stagePill = (stage, court) => `<span class="stage-pill ${stage === 'done' ? 'done' : `court-${court ?? ''}`}">${esc(S.view?.stages?.[stage]?.label ?? stage)}</span>`;
const courtOf = (stage) => S.view?.flow.stages.find((s) => s.stage === stage)?.court;
const LOGO = `<svg viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="var(--agents)"/><path d="M8 24L24 8M8 16l8-8M16 24l8-8M8 8l16 16M8 16l8 8M16 8l8 8" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>`;

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = err ? 'err' : '';
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), err ? 5000 : 2200);
}

async function api(path, opts = {}) {
  // Relative, so the UI also works under a workspace path prefix (/w/<slug>/).
  const r = await fetch(path.replace(/^\//, ''), { ...opts, headers: { 'content-type': 'application/json' }, credentials: 'same-origin' });
  if (r.status === 401) {
    location.href = 'login.html';
    throw new Error('Not signed in');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), j);
  return j;
}
async function human(action, body = {}, msg) {
  try {
    const r = await api(`/api/p/${encodeURIComponent(S.slug)}/human/${action}`, { method: 'POST', body: JSON.stringify(body) });
    if (msg) toast(msg);
    await refresh();
    return r;
  } catch (e) {
    toast(e.message + (e.hint ? ` — ${e.hint}` : ''), true);
  }
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
    toast(e.message + (e.hint ? ` — ${e.hint}` : ''), true);
  }
}

// ── data ──
async function loadProjects() {
  S.projects = await api('/api/projects');
}
async function refresh({ force = false } = {}) {
  try {
    await loadProjects();
    if (S.slug && S.projects.some((p) => p.slug === S.slug)) {
      S.view = await api(`/api/p/${encodeURIComponent(S.slug)}/view`);
      if (S.itemRef) S.item = await api(`/api/p/${encodeURIComponent(S.slug)}/items/${encodeURIComponent(S.itemRef.replace('#', ''))}`).catch(() => null);
    } else {
      S.view = null;
    }
  } catch (e) {
    if (!S.projects.length) $('#main').innerHTML = `<div class="loading">Can't reach the nuworq hub. Is <code>nuworq serve</code> running?</div>`;
    return;
  }
  render({ force });
}

let typing = () => {
  const a = document.activeElement;
  return a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'checkbox')) && a.value;
};
function render({ force = false } = {}) {
  if (!force && typing()) { S.pending = true; return; }
  S.pending = false;
  const drawerScroll = $('#drawer').scrollTop;
  renderRail();
  $('#main').innerHTML = S.slug && S.view ? project(S.view) : overview();
  renderDrawer();
  $('#drawer').scrollTop = drawerScroll;
  for (const el of document.querySelectorAll('[data-draft]')) {
    const v = S.drafts[el.dataset.draft];
    if (v == null) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
}

// ── routing ──
function route() {
  const m = location.hash.match(/^#\/p\/([^/]+)(?:\/(\d+))?/);
  const slug = m ? decodeURIComponent(m[1]) : null;
  const ref = m?.[2] ? `#${m[2]}` : null;
  if (slug !== S.slug) { S.stage = null; S.addWork = false; S.editMission = false; S.addRemote = false; }
  S.slug = slug;
  if (ref !== S.itemRef) { S.itemRef = ref; S.item = null; S.deep = z() >= 2; S.editItem = false; }
  refresh({ force: true });
}
const go = (slug, ref) => { location.hash = slug ? `#/p/${encodeURIComponent(slug)}${ref ? '/' + ref.replace('#', '') : ''}` : '#/'; };

// ── rail ──
function renderRail() {
  const projects = S.projects.map((p) => `
    <a class="rail-item ${p.slug === S.slug ? 'on' : ''}" href="#/p/${encodeURIComponent(p.slug)}">
      <span class="dot ${p.pulse.state}"></span><span class="name">${esc(p.name)}</span>
      ${p.needs ? `<span class="badge" title="${plural(p.needs, 'thing')} need you">${p.needs}</span>` : ''}
    </a>`).join('');
  const total = S.projects.reduce((n, p) => n + p.needs, 0);
  $('#rail').innerHTML = `
    <div class="brand">${LOGO}<span>nuworq</span></div>
    <a class="rail-label rail-head ${!S.slug ? 'on' : ''}" href="#/" title="All projects">Projects${total ? `<span class="badge" title="${plural(total, 'thing')} need you">${total}</span>` : ''}</a>
    ${projects || '<div class="rail-item" style="color:var(--faint)">None yet</div>'}
    <div class="rail-foot">
      <button class="rail-item" data-action="new-project">+ New project</button>
      <button class="rail-item" data-action="archived">Archived projects</button>
      <button class="rail-item" data-action="connect">⌁ Connect an agent</button>
      <button class="rail-item" data-action="notify">◔ Notifications</button>
      ${S.me?.auth === 'required' ? `<button class="rail-item" data-action="logout" title="Signed in as ${esc(S.me.name ?? '')}">Sign out</button>` : ''}
      ${versionLine()}
    </div>`;
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

// All projects at 30s: what needs you and whether each is moving. 5m adds the mission (two lines);
// 30m the whole mission, its repos and whether nuworq run staffs it. Parked projects wait until 5m.
function overview() {
  if (!S.projects.length) {
    return `<div class="phead"><div class="titles"><h1>Welcome to nuworq</h1>
      <div class="mission">A hub where you facilitate and AI agents (Claude, OpenAI, open-weight) find, do and verify the work.</div></div></div>
      <div class="zero"><span class="check">→</span><div>No projects yet. Connect an agent and it will create one when it checks in, or <button class="link" data-action="new-project">create one now</button>.
      <div style="margin-top:8px"><button class="btn primary" data-action="connect">Connect an agent</button></div></div></div>`;
  }
  const sorted = [...S.projects].sort((a, b) => a.parked - b.parked || b.needs - a.needs || a.name.localeCompare(b.name));
  const total = sorted.reduce((n, p) => n + p.needs, 0);
  const shown = z() >= 1 ? sorted : sorted.filter((p) => !p.parked);
  const parked = sorted.length - shown.length;
  const details = (p) => z() < 2 ? '' : `<div class="s">${[
    p.remotes?.length ? esc(p.remotes.join(', ')) : 'No repo linked',
    p.runner ? 'nuworq run staffs it' : 'nuworq run leaves it alone',
    p.parked ? 'parked' : '',
  ].filter(Boolean).join(' · ')}</div>`;
  return `<div class="phead"><div class="titles"><h1>All projects</h1>
      <div class="mission">${total ? `${plural(total, 'thing')} across ${plural(sorted.filter((p) => p.needs).length, 'project')} ${total === 1 ? 'needs' : 'need'} you.` : 'Nothing needs you anywhere. Work is flowing.'}</div></div>
      <div class="controls"><div class="ctl-row"><span class="seg-label">Depth</span>${zoomControl()}</div></div></div>
    <div class="overview">${shown.map((p) => `
      <div class="ov-card state-${p.pulse.state} ${p.parked ? 'parked' : ''}" data-action="goto" data-slug="${esc(p.slug)}">
        <span class="dot ${p.pulse.state}" style="margin-top:7px"></span>
        <div class="body"><h3>${esc(p.name)}</h3>
          ${z() >= 1 && p.mission ? `<div class="m ${z() < 2 ? 'clamp' : ''}">${esc(p.mission)}</div>` : ''}
          <div class="sentence">${esc(p.pulse.sentence)}</div>${details(p)}</div>
        ${p.needs ? `<span class="badge">${p.needs}</span>` : ''}
      </div>`).join('')}</div>
    ${parked ? `<div class="zoom-more">${plural(parked, 'parked project')} not shown. <button data-action="zoom" data-zoom="5m">Go to 5m</button> to see ${parked === 1 ? 'it' : 'them'}.</div>` : ''}`;
}

// ── project ──
function project(v) {
  const P = v.project;
  const zoomSeg = zoomControl();
  const autoSeg = `<div class="seg">${Object.entries(P.autonomy_options).map(([k, o]) =>
    `<button class="${P.autonomy === k ? 'on' : ''}" data-action="autonomy" data-level="${k}" title="${esc(o.human)}">${esc(o.label)}</button>`).join('')}</div>`;
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
      <div class="titles"><h1>${esc(P.name)}</h1>${mission}${z() >= 1 ? remotes : ''}</div>
      <div class="controls">
        <div class="ctl-row"><span class="seg-label">Depth</span>${zoomSeg}</div>
        ${z() >= 1 ? `<div class="ctl-row"><span class="seg-label">Autonomy</span>${autoSeg}</div>` : ''}
        ${z() >= 1 ? `<button class="link" data-action="github" title="Link pull requests and CI results to items with a GitHub webhook">${P.github ? 'GitHub: connected' : 'Connect GitHub'}</button>` : ''}
        ${z() >= 1 && !P.parked ? `<button class="link" data-action="park" title="Pause the project: no new work starts and nothing asks for you here">Park this project</button>` : ''}
        ${z() >= 2 ? `<button class="link" data-action="remove-project" title="Archive it (history kept) or delete it for good">Remove project</button>` : ''}
        ${z() >= 1 ? (P.runner
          ? `<button class="link" data-action="runner-off" title="nuworq run keeps headless workers on waiting work here. Click to stop it starting new ones.">Auto-staffed by nuworq run · stop</button>`
          : `<button class="link" data-action="runner-on" title="Let nuworq run start headless workers here whenever work is waiting">Let nuworq run staff this project</button>`) : ''}
      </div>
    </div>
    ${pulse(v)}
    ${composer(v)}
    ${empty ? emptyProject() : ''}
    ${needsYou(v)}
    ${motion(v)}
    ${z() >= 1 ? worthKnowing(v) : ''}
    ${z() >= 1 ? flow(v) : ''}
    ${z() >= 1 ? upNext(v) : ''}
    ${z() >= 1 ? finished(v) : ''}
    ${z() >= 1 ? steering(v) : ''}
    ${z() >= 1 ? agents(v) : ''}
    ${z() >= 2 ? activity(v) : ''}
    ${z() >= 2 ? allWork(v) : ''}
    ${z() < 2 && !empty ? `<div class="zoom-more">${z() === 0
      ? `That's the 30-second view. <button data-action="zoom" data-zoom="5m">Go to 5m</button> for flow, what's next, and how agents are doing.`
      : `<button data-action="zoom" data-zoom="30m">Go to 30m</button> for the full activity record, every item and agent diagnostics.`}</div>` : ''}`;
}

function emptyProject() {
  return `<section class="sec"><div class="zero"><span class="check">→</span><div>
    <b>No work yet.</b> Add some above, or connect an agent and let it propose what matters.
    <div style="margin-top:8px"><button class="btn primary small" data-action="connect">Connect an agent</button></div></div></div></section>`;
}

function pulse(v) {
  const label = { 'needs-you': 'Needs you', flowing: 'Flowing', stalled: 'Stalled', idle: 'Idle', parked: 'Parked' }[v.pulse.state];
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
    : 'First look at this project.';
  const list = z() >= 1 && v.since.finished.length
    ? `<div class="since-list">${v.since.finished.slice(0, 6).map((f) => `<div>✓ ${refLink(f.item)} ${esc(f.title)} <span class="age">by ${esc(f.by === 'you' ? 'you' : f.by)}</span></div>`).join('')}</div>` : '';
  return `<div class="pulse state-${v.pulse.state}">
      <div class="state-chip"><span class="dot ${v.pulse.state}"></span>${label}</div>
      <div class="sentence">${esc(v.pulse.sentence)}</div>
      ${v.project.parked ? `<div class="actions"><button class="btn primary small" data-action="unpark">Unpark</button></div>` : ''}
      <div class="since"><span>${since}</span><span class="spacer"></span>
        ${c.updates || !v.since.at ? `<button class="btn small" data-action="seen" title="Reset 'since you last looked' to now">Mark all seen</button>` : ''}
        ${list}</div>
    </div>`;
}

function composer() {
  const hints = {
    steer: 'Every agent must read and acknowledge it. You\'ll see who did.',
    decision: 'A standing rule. Every agent gets it at every checkin.',
    note: 'For the record. Agents may see it; no acknowledgement needed.',
  };
  const kinds = { steer: 'Steer', decision: 'Decision', note: 'Note' };
  return `<div class="composer">
      <div class="box">
        <textarea id="compose" data-draft="compose" placeholder="Say something to your agents… (⌘↵ to send)"></textarea>
        <div class="row">
          <div class="seg">${Object.entries(kinds).map(([k, l]) => `<button class="${S.composeKind === k ? 'on' : ''}" data-action="compose-kind" data-kind="${k}">${l}</button>`).join('')}</div>
          <span class="hint">${hints[S.composeKind]}</span>
          <button class="btn primary small" data-action="compose-send">Send</button>
        </div>
      </div>
      <button class="btn" data-action="toggle-add" style="height:40px">+ Work</button>
    </div>
    ${S.addWork ? `<div class="add-work">
      <input data-draft="nw-title" id="nw-title" placeholder="Outcome, in one line (e.g. 'Users can reset their password')">
      <textarea data-draft="nw-summary" id="nw-summary" placeholder="Why it matters, context, constraints (optional)"></textarea>
      <textarea data-draft="nw-acceptance" id="nw-acceptance" placeholder="Done means… (checkable criteria; agents verify against this)"></textarea>
      <div class="row"><div class="seg">${['now', 'soon', 'later'].map((p) => `<button class="${(S.drafts['nw-priority'] ?? 'soon') === p ? 'on' : ''}" data-action="nw-priority" data-p="${p}">${p}</button>`).join('')}</div>
        <span style="flex:1"></span><button class="btn ghost" data-action="toggle-add">Cancel</button><button class="btn primary" data-action="add-work">Add to Ready</button></div>
    </div>` : ''}`;
}

// ── 30s: what needs you ──
function needsYou(v) {
  const act = v.attention.filter((a) => a.level === 'act');
  const body = act.length
    ? `<div class="cards">${act.map(card).join('')}</div>`
    : `<div class="zero"><span class="check">✓</span><div><b>Nothing needs you.</b> ${v.pulse.active ? 'Agents are working; you\'ll see things here when they need a decision, an answer or a verification.' : 'When agents need a decision, an answer or a verification, it shows up here.'}</div></div>`;
  return `<section class="sec"><header><h2>Needs you</h2>${act.length ? `<span class="count">${act.length}</span>` : ''}
    ${act.length ? '<span class="hint">oldest first; each one moves work to its next stage</span>' : ''}</header>${body}</section>`;
}

function card(a) {
  const label = { question: 'Question', review: 'Ready to verify', proposal: 'Shaped, needs your approval', struggling: 'Keeps bouncing', direction: 'Direction', 'no-agents': 'Nobody is working', 'ci-failing': 'CI is failing', 'pr-review': 'Needs your approval on GitHub' }[a.kind] ?? a.kind;
  const key = 'a:' + a.key;
  const open = S.open.has(key) || z() >= 2;
  const hasMore = a.why || a.detail || a.acceptance;
  const more = open && hasMore ? `<div class="more">
      ${a.why ? md(a.why) : ''}
      ${a.acceptance ? `<div class="label">Done means</div>${md(a.acceptance)}` : ''}
      ${a.detail ? `<div class="label">Detail</div>${md(a.detail)}` : ''}
    </div>` : '';
  return `<article class="card kind-${a.kind}">
    <div class="card-top"><span class="kind">${label}</span>${refLink(a.item)}<span class="sub">${esc(a.sub)}</span></div>
    <h3>${esc(a.headline)}</h3>
    ${a.attempts?.length > 1 ? attemptsGrid(a.item, a.attempts) : `${a.evidence?.length ? `<div class="evidence">${a.evidence.map((e) => `<span class="ev">${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.label)}</a>` : esc(e.label)}</span>`).join('')}</div>` : ''}
    ${commits(a.git)}`}
    ${a.warn ? `<div class="warn">⚠ ${esc(a.warn)}</div>` : ''}
    ${a.kind === 'proposal' && a.acceptance && !open ? `<div class="more"><div class="label" style="margin-top:0">Done means</div>${md(a.acceptance)}</div>` : ''}
    ${more}
    ${cardActions(a, hasMore, open, key)}
  </article>`;
}

// A raced item's submissions side by side, each with its own "Keep this one".
function attemptsGrid(item, attempts, { keep = true } = {}) {
  return `<div class="attempts">${attempts.map((s) => `<div class="attempt ${s.stage}">
      <div class="meta">${who(s.agent, s.model)} <span class="age">${esc(s.model || '')}${s.took ? ` · ${esc(s.took)}` : ''}</span>${s.stage === 'chosen' ? '<span class="tag go">kept</span>' : s.stage === 'not_chosen' ? '<span class="tag">not chosen</span>' : ''}</div>
      <div class="h">${esc(s.headline)}</div>
      ${s.branch ? `<div class="touch"><code>${esc(s.branch)}</code>${s.commits?.length ? ` ${s.commits.map((c) => `<code title="${esc(c.subject ?? '')}">${esc(String(c.hash ?? c).slice(0, 7))}</code>`).join(' ')}` : ''}</div>` : ''}
      ${s.evidence?.length ? `<div class="evidence">${s.evidence.map((e) => `<span class="ev">${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.label)}</a>` : esc(e.label)}</span>`).join('')}</div>` : '<div class="warn">⚠ No evidence attached</div>'}
      ${keep && s.stage === 'submitted' ? `<button class="btn go small" data-action="keep" data-item="${esc(item)}" data-attempt="${s.n}">Keep this one</button>` : ''}
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
    return `<div class="actions"><button class="btn primary" data-action="connect">Start an agent</button><button class="btn ghost" data-action="park">Park this project</button></div>`;
  }
  const moreBtn = hasMore ? `<button class="link" data-action="toggle" data-key="${esc(key)}">${open ? 'Less' : 'Why? (5m)'}</button>` : '';
  if (a.kind === 'question') {
    const q = a.question;
    return `<div class="answer">
      ${q.options?.length ? `<div class="opts">${q.options.map((o) => `<button class="opt" data-action="answer" data-q="${q.id}" data-answer="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
      <div class="answer-row"><input data-draft="ans-${q.id}" id="ans-${q.id}" placeholder="${q.options?.length ? 'Or write your own answer…' : 'Your answer…'}"><button class="btn primary" data-action="answer-text" data-q="${q.id}">Answer</button></div>
      <div class="actions" style="margin-top:0"><label class="check-label"><input type="checkbox" data-draft="dec-${q.id}" id="dec-${q.id}"> Make this a standing decision for all agents</label><span style="flex:1"></span>${moreBtn}</div>
    </div>`;
  }
  if (a.kind === 'review') {
    const r = `sb:${a.item}`;
    const race = a.attempts?.length > 1;
    return `<div class="actions">
      ${race ? '' : `<button class="btn go" data-action="accept" data-item="${esc(a.item)}">Accept</button>`}
      ${S.reveal.has(r)
        ? `<div class="inline-form grow"><input data-draft="${r}" id="${r}" placeholder="What's missing? The next agent starts from this."><button class="btn you" data-action="sendback" data-item="${esc(a.item)}">Send ${race ? 'all ' : ''}back</button></div>`
        : `<button class="btn" data-action="reveal" data-key="${r}">Send ${race ? 'all ' : ''}back…</button>`}
      <button class="btn ghost" data-action="open" data-item="${esc(a.item)}">Open</button>${moreBtn}
    </div>`;
  }
  if (a.kind === 'proposal') {
    return `<div class="actions">
      <button class="btn go" data-action="approve" data-item="${esc(a.item)}">Approve</button>
      <button class="btn" data-action="drop" data-item="${esc(a.item)}">Drop</button>
      <button class="btn ghost" data-action="open" data-item="${esc(a.item)}">Open</button>${moreBtn}
    </div>`;
  }
  if (a.kind === 'pr-review') {
    return `<div class="actions">
      <a class="btn you" href="${esc(a.pr.url)}" target="_blank" rel="noopener">Approve PR #${a.pr.number} on GitHub</a>
      <button class="btn ghost" data-action="open" data-item="${esc(a.item)}">Open</button>${moreBtn}
    </div>`;
  }
  if (a.kind === 'ci-failing') {
    const r = `sb:${a.item}`;
    return `<div class="evidence">${a.pr.checks.map((c) => `<span class="ev">${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">✗ ${esc(c.name)}</a>` : `✗ ${esc(c.name)}`}</span>`).join('')}</div>
      <div class="actions">
      ${S.reveal.has(r)
        ? `<div class="inline-form grow"><input data-draft="${r}" id="${r}" placeholder="What failed? The next agent starts from this."><button class="btn you" data-action="sendback" data-item="${esc(a.item)}">Send back</button></div>`
        : `<button class="btn you" data-action="reveal" data-key="${r}">Send back…</button>`}
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
        ? `<div class="inline-form" style="width:320px"><input data-draft="${r}" id="${r}" placeholder="Instead…"><button class="btn you small" data-action="override" data-q="${a.question.id}">Override</button></div>`
        : `<button class="btn small" data-action="confirm" data-q="${a.question.id}">Fine</button><button class="btn small" data-action="reveal" data-key="${r}">Override…</button>`;
    }
    if (a.kind === 'proposal') acts = `<button class="btn small" data-action="open" data-item="${esc(a.item)}">Look</button>` + acts;
    if (a.start) acts = `<button class="btn small" data-action="connect">Start an agent</button>` + acts;
    if (a.kind === 'notify-failing') acts = `<button class="btn small" data-action="notify">Check it</button>` + acts;
    if (a.kind === 'peer-review-stuck') acts =`<button class="btn small" data-action="open" data-item="${esc(a.item)}">Review it</button>` + acts;
    // Stuck on a capability nobody has: the choices are to let any agent take it, or keep waiting for one that has it.
    if (a.kind === 'unfit') acts = `<button class="btn small" data-action="needs" data-item="${esc(a.item)}" data-needs="${esc(JSON.stringify(a.keep ?? []))}" title="Drop ${esc((a.missing ?? []).join(', '))} from what it needs">Let any agent take it</button><button class="btn ghost small" data-action="dismiss" data-key="${esc(a.key)}">Keep waiting</button>`;
    // "Got it" is for news; next to a real action, dismissing just hides it.
    else if (/data-action="(open|connect|notify)"/.test(acts)) acts = acts.replace('>Got it</button>', '>Hide</button>');
    return `<div class="row-item"><div class="body"><div class="h">${esc(a.headline)}</div><div class="s">${a.item ? refLink(a.item) + ' ' : ''}${esc(a.sub)}</div>
      ${z() >= 2 && a.why ? `<div class="s" style="margin-top:4px">${esc(a.why)}</div>` : ''}</div><div class="acts">${acts}</div></div>`;
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
        ${z() >= 1 && m.last ? `<div class="last ${m.quiet ? 'quiet' : ''}">${m.last.type === 'claimed' ? 'Just picked it up' : esc(m.last.headline)}</div>` : ''}
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
  const stages = f.stages.filter((s) => s.stage !== 'dropped' || s.count);
  const pills = stages.map((s) => `<button class="stage court-${s.court ?? 'none'} ${S.stage === s.stage ? 'on' : ''} ${s.count ? '' : 'zero-count'}" data-action="stage" data-stage="${s.stage}" title="${esc(s.blurb)}"><span class="n">${s.count}</span><span class="l">${esc(s.label)}</span></button>`).join('<span class="arrow">→</span>');
  let detail = '';
  if (S.stage) {
    const st = f.stages.find((s) => s.stage === S.stage);
    const items = v.all.filter((i) => i.stage === S.stage).slice(-25).reverse();
    detail = `<div class="stage-detail"><div class="blurb"><b>${esc(st.label)}.</b> ${esc(st.blurb)} ${st.court ? `<i>Whose move: ${st.court === 'you' ? 'yours' : st.court === 'agents' ? "the agents'" : st.court === 'external' ? 'someone outside this hub' : 'nobody yet (waiting for an agent)'}.</i>` : ''} ${st.ms ? `Work spent ${esc(st.time)} here in the last 14 days.` : ''}</div>
      ${items.length ? items.map((i) => `<div>${refLink(i.item)} ${esc(i.title)} <span class="age">${esc(i.ago)}</span></div>`).join('') : '<div class="age">Nothing here.</div>'}</div>`;
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
      ${f.cost ? flowCost(f.cost) : ''}
    </div></section>`;
}

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
  if (!v.queue.length) return '';
  const shown = z() >= 2 ? v.queue : v.queue.slice(0, 5);
  return `<section class="sec"><header><h2>Up next</h2><span class="count">${v.queue.length}</span><span class="hint">ready for any agent, in the order they'll be picked</span></header>
    <div class="rows">${shown.map((i) => itemRow(i)).join('')}</div>
    ${v.queue.length > shown.length ? `<div class="zoom-more">+${v.queue.length - shown.length} more at 30m</div>` : ''}</section>`;
}

function finished(v) {
  if (!v.done.length) return '';
  const shown = z() >= 2 ? v.done : v.done.slice(0, 5);
  return `<section class="sec"><header><h2>Recently finished</h2><span class="count">${v.done.length}</span><span class="hint">last 3 days</span></header>
    <div class="rows">${shown.map((i) => `<div class="row-item clickable" data-action="open" data-item="${esc(i.item)}">
      <div class="body"><div class="h">✓ ${refLink(i.item)} ${esc(i.title)}</div><div class="s">built by ${who(i.implementer)}${i.accepted ? ` · verified by ${who(i.accepted)}` : ''}</div></div>
      <span class="age">${esc(i.ago)} ago</span></div>`).join('')}</div></section>`;
}

function steering(v) {
  if (!v.steers.length && !v.decisions.length && !v.notes.length) return '';
  const steers = v.steers.map((s) => {
    const expected = v.agents.filter((a) => a.status !== 'away' && a.status !== 'signed off').map((a) => a.name);
    const missing = s.item ? [] : expected.filter((n) => !s.acks.some((x) => x.agent === n));
    return `<div class="row-item steer-item"><div class="body"><div class="h">${s.item ? refLink(s.item) + ' ' : ''}${inline(s.body)}</div>
      <div class="acks">${s.acks.map((a) => `<span class="ack" title="${esc(a.response)}">${esc(a.agent)}${z() >= 2 && a.response ? `: ${esc(a.response)}` : ''}</span>`).join('')}
      ${missing.map((n) => `<span class="unacked">${esc(n)} hasn't acknowledged</span>`).join('')}
      ${!s.acks.length && !missing.length ? '<span class="unacked">not seen yet</span>' : ''}</div></div>
      <div class="acts"><span class="age">${esc(dur(Date.now() - s.at))} ago</span><button class="btn ghost small" data-action="retire" data-note="${s.id}" title="Stop delivering it">Retire</button></div></div>`;
  }).join('');
  const decisions = v.decisions.map((d) => `<div class="row-item"><div class="body"><div class="h">${inline(d.body)}</div></div>
    <div class="acts"><span class="age">${esc(d.ago)} ago</span><button class="btn ghost small" data-action="retire" data-note="${d.id}">Retire</button></div></div>`).join('');
  const shownNotes = z() >= 2 ? v.notes : v.notes.slice(0, 3);
  const notes = shownNotes.map((n) => `<div class="row-item"><div class="body"><div class="h">${inline(n.note ?? n.body)}</div><div class="s">${who(n.by)}${n.item ? ` on ${refLink(n.item)}` : ''}</div></div>
    <div class="acts"><span class="age">${esc(n.ago)} ago</span><button class="btn ghost small" data-action="retire" data-note="${n.id}" title="Outdated or wrong">Retire</button></div></div>`).join('');
  const sub = (label, hint) => `<div class="sublabel">${label}<span>${hint}</span></div>`;
  return `<section class="sec"><header><h2>Steering &amp; memory</h2><span class="hint">did your nudges land, and what every agent carries into every session</span></header>
    ${steers ? `${sub('Your steering', 'acknowledged by')}<div class="rows" style="margin-bottom:14px">${steers}</div>` : ''}
    ${decisions ? `${sub('Decisions', 'standing rules, from you')}<div class="rows" style="margin-bottom:14px">${decisions}</div>` : ''}
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
  if (!v.agents.length) return '';
  if (z() < 2) {
    const live = v.agents.filter((a) => a.status !== 'away' && a.status !== 'signed off');
    const away = v.agents.length - live.length;
    return `<section class="sec"><header><h2>Agents</h2><span class="count">${live.length} active</span>${away ? `<span class="hint">${away} away</span>` : ''}</header>
      <div class="agent-strip">${live.map((a) => `<span class="a"${a.tokens.length ? ` title="token: ${esc(a.tokens.join(', '))}"` : ''}>${who(a.name, a.model)}<span class="st">${esc(a.status)}${a.holding.length ? ` ${a.holding.join(', ')}` : ''}${a.tokens.length > 1 ? ` · <span class="warn">${a.tokens.length} tokens</span>` : ''}</span></span>`).join('') || '<span class="age">No agent is active right now.</span>'}</div></section>`;
  }
  return `<section class="sec"><header><h2>Agents</h2><span class="count">${v.agents.length}</span><span class="hint">first-class participants, each with a track record</span></header>
    <div class="agent-grid">${v.agents.map((a) => `<div class="agent-card">
      <div class="top">${who(a.name, a.model)}<span class="status ${a.status.split(' ')[0]}">${esc(a.status)}</span></div>
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
      <div class="model" style="margin-top:6px">${a.record.assumptions} assumptions · ${a.record.questions} blocking questions · ${a.record.proposed} proposed · ${a.record.learned} field notes${a.record.reviews ? ` · ${a.record.reviews} reviews` : ''}${a.record.races ? ` · won ${a.record.races_won} of ${a.record.races} races` : ''} · seen ${esc(a.last_seen)} ago</div>
    </div>`).join('')}</div></section>`;
}

function activity(v) {
  const quiet = new Set(['progress', 'checkin', 'review_started']);
  const events = S.feedAll ? v.activity : v.activity.filter((e) => !quiet.has(e.type));
  return `<section class="sec feed"><header><h2>Everything that happened</h2><span class="count">${events.length}</span>
    <span class="right"><label class="check-label"><input type="checkbox" data-action="feed-all" ${S.feedAll ? 'checked' : ''}> include routine progress</label></span></header>
    <div class="rows">${events.map((e) => {
      const key = 'e:' + e.id;
      const open = S.open.has(key);
      const has = e.summary || e.detail || e.data?.evidence?.length;
      return `<div class="row-item ${has ? 'clickable' : ''}" ${has ? `data-action="toggle" data-key="${key}"` : ''}>
        <span class="type">${esc(e.type.replace('_', ' '))}</span>
        <div class="body"><div class="h">${e.item ? refLink(e.item) + ' ' : ''}${esc(e.headline)}</div>
          ${open ? `<div class="expand">${md(e.summary)}${e.data?.evidence?.length ? `<div class="evidence">${e.data.evidence.map((x) => `<span class="ev">${esc(x.label)}</span>`).join('')}</div>` : ''}${e.detail ? `<pre>${esc(e.detail)}</pre>` : ''}</div>` : ''}</div>
        <span class="age">${who(e.actor)} · ${esc(e.ago)}</span></div>`;
    }).join('')}</div></section>`;
}

function allWork(v) {
  const rows = [...v.all].reverse();
  return `<section class="sec"><header><h2>All work</h2><span class="count">${rows.length}</span></header>
    <table class="work"><thead><tr><th>#</th><th>Title</th><th>Stage</th><th>Priority</th><th>Who</th><th>In stage</th></tr></thead><tbody>
    ${rows.map((i) => `<tr data-action="open" data-item="${esc(i.item)}"><td>${esc(i.item)}</td><td>${esc(i.title)}${repoTag(i)}</td><td>${stagePill(i.stage, courtOf(i.stage))}</td><td>${esc(i.priority)}</td><td>${i.last_worker ? who(i.last_worker) : `<span class="age">${esc(i.by)}</span>`}</td><td class="age">${esc(i.ago)}</td></tr>`).join('')}
    </tbody></table></section>`;
}

// ── item drawer: 30s header, 5m body, 30m deep dive ──
function renderDrawer() {
  const d = $('#drawer');
  const show = !!S.itemRef;
  d.hidden = !show;
  $('#scrim').hidden = !show;
  if (!show) return;
  const it = S.item;
  if (!it) { d.innerHTML = '<div class="loading">Loading…</div>'; return; }
  const holderLine = {
    proposed: it.holder
      ? `<b>${who(it.holder)}</b> is shaping it · lease ${esc(it.lease_left)} left`
      : `<b>Proposed</b> by ${who(it.created_by)} ${esc(it.created)} ago. ${S.view?.project.autonomy === 'ask' && it.acceptance ? 'Shaped and waiting for your approval.' : `Nothing needed from you: ${it.holder ? `${esc(it.holder)} is shaping it now` : it.priority === 'now' ? 'the next free agent shapes it first' : 'a free agent shapes it into ready work'}.`}`,
    ready: `<b>Ready</b> for ${it.race > 1 ? `${it.race} agents at once (a race)` : 'any agent'} · waiting ${esc(it.in_stage)}${it.depends_on.some((x) => !['done', 'dropped'].includes(x.stage)) ? ' · blocked by dependencies' : ''}`,
    active: it.race > 1
      ? `<b>Race of ${it.race}</b> · ${esc(it.in_stage)} so far · ${it.racers.map((r) => `${who(r.agent, r.model)} ${r.stage === 'active' ? `on it, lease ${esc(r.lease_left)} left` : esc(r.stage)}`).join(' · ') || 'no one yet'}`
      : `<b>${who(it.holder)}</b> is on it · ${esc(it.in_stage)} so far · lease ${esc(it.lease_left)} left`,
    waiting: `<b>Waiting on you</b> for ${esc(it.in_stage)}: an agent parked it to ask a question.`,
    verifying: `<b>Verifying</b> · ${who(it.implementer)} finished it ${esc(it.in_stage)} ago${it.holder ? ` · ${who(it.holder)} is reviewing` : ''}`,
    done: `<b>Done</b> ${esc(it.in_stage)} ago · built by ${who(it.implementer)}`,
    dropped: `<b>Dropped</b> ${esc(it.in_stage)} ago`,
  }[it.stage];

  const actions = [];
  const raced = it.submissions?.filter((s) => s.stage === 'submitted').length > 1;
  if (it.stage === 'verifying') {
    if (!raced) actions.push(`<button class="btn go" data-action="accept" data-item="${it.item}">Accept</button>`);
    actions.push(S.reveal.has('dsb') ? `<div class="inline-form grow"><input data-draft="sb:${it.item}" id="sb:${it.item}" placeholder="What's missing?"><button class="btn you" data-action="sendback" data-item="${it.item}">Send back</button></div>`
      : `<button class="btn" data-action="reveal" data-key="dsb">Send back…</button>`);
  }
  if (it.stage === 'proposed' && it.priority !== 'now') actions.push(`<button class="btn primary" data-action="pick" data-item="${it.item}" title="Agents shape and build this first">Make it next</button>`);
  // Only "Check with me" waits on you; otherwise this is an optional shortcut, so it mustn't look like a request.
  if (it.stage === 'proposed') actions.push(S.view?.project.autonomy === 'ask' && it.acceptance
    ? `<button class="btn go" data-action="approve" data-item="${it.item}" title="It becomes ready as written">Approve</button>`
    : `<button class="btn" data-action="approve" data-item="${it.item}" title="Optional: agents shape proposals on their own. This makes it ready as written.">Skip shaping</button>`);
  if (it.stage === 'done') actions.push(`<button class="btn" data-action="reopen" data-item="${it.item}">Reopen</button>`);
  if (!['done', 'dropped'].includes(it.stage)) actions.push(`<button class="btn ghost" data-action="drop" data-item="${it.item}">Drop</button>`);
  if (it.stage === 'dropped') actions.push(`<button class="btn" data-action="reopen" data-item="${it.item}">Restore</button>`);
  actions.push(`<button class="btn ghost" data-action="edit-item">Edit</button>`);

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
      <div class="meta">${who(q.asked_by)} · ${q.blocking ? 'blocking' : 'non-blocking'} · ${esc(q.ago)} ago · ${esc(q.status)}</div>
      <div><b>${esc(q.question)}</b></div>${q.context ? md(q.context) : ''}
      ${q.assumption ? `<div class="a">Assumed: <i>${esc(q.assumption)}</i></div>` : ''}
      ${q.answer ? `<div class="a">Answer: <b>${esc(q.answer)}</b></div>` : q.status === 'confirmed' ? '<div class="a">You confirmed the assumption.</div>' : ''}
      ${q.status === 'open' ? `<div class="answer">${q.options.length ? `<div class="opts">${q.options.map((o) => `<button class="opt" data-action="answer" data-q="${q.id}" data-answer="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
        <div class="answer-row"><input data-draft="ans-${q.id}" id="ans-${q.id}" placeholder="${q.blocking ? 'Your answer…' : 'Override with…'}"><button class="btn primary" data-action="${q.blocking ? 'answer-text' : 'override'}" data-q="${q.id}" data-src="ans-${q.id}">${q.blocking ? 'Answer' : 'Override'}</button>
        ${q.blocking ? '' : `<button class="btn" data-action="confirm" data-q="${q.id}">Fine</button>`}</div></div>` : ''}
    </div>`).join('')}</div>` : '';

  const steers = it.steers.length ? `<div class="d-sec"><div class="label">Your steering</div>${it.steers.map((s) => `<div class="q"><div>${esc(s.body)}</div>
      <div class="meta">${esc(s.ago)} ago · ${s.acks.length ? s.acks.map((a) => `<span class="ack">${esc(a.agent)}${a.response ? `: ${esc(a.response)}` : ''}</span>`).join(' ') : '<span class="unacked">not acknowledged yet</span>'}</div></div>`).join('')}</div>` : '';

  const edit = S.editItem ? `<div class="d-sec"><div class="label">Edit</div><div class="add-work" style="margin:0">
      <input data-draft="ei-title" id="ei-title" value="${esc(it.title)}">
      <textarea data-draft="ei-summary" id="ei-summary" placeholder="Summary">${esc(it.summary)}</textarea>
      <textarea data-draft="ei-acceptance" id="ei-acceptance" placeholder="Done means…">${esc(it.acceptance)}</textarea>
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
        ${it.precondition ? `<dt>Waits on</dt><dd>${esc(it.precondition.waits_for)} <span class="age">${it.precondition.met ? 'passed' : it.precondition.last_check ? `last check: ${esc(it.precondition.last_check.detail)}` : 'not checked yet'}</span></dd>` : ''}
        ${it.depends_on.length ? `<dt>Depends on</dt><dd>${it.depends_on.map((c) => `${refLink(c.item)} ${esc(c.title)} ${stagePill(c.stage, courtOf(c.stage))}`).join('<br>')}</dd>` : ''}
      </dl></div>
    ${it.detail ? `<div class="d-sec"><div class="label">Detail</div>${md(it.detail)}</div>` : ''}
    ${it.usage ? usageTable(it.usage) : ''}
    <div class="d-sec"><div class="label">Timeline <span class="count">${it.events.length} events</span></div><div class="timeline">
      ${it.events.map((e) => `<div class="tl t-${e.type}">
        <div class="meta">${who(e.actor)}<span>${esc(e.type.replace('_', ' '))}</span><span>${esc(e.ago)} ago</span></div>
        <div class="h">${esc(e.headline)}</div>
        ${e.summary ? `<div class="sm">${md(e.summary)}</div>` : ''}
        ${e.data?.evidence?.length ? `<div class="evidence">${e.data.evidence.map((x) => `<span class="ev">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>` : esc(x.label)}</span>`).join('')}</div>` : ''}
        ${e.detail ? `<details><summary>Detail</summary><pre>${esc(e.detail)}</pre></details>` : ''}
      </div>`).join('')}
    </div></div>` : '';

  d.innerHTML = `
    <div class="d-top">${refLink(it.item)} ${stagePill(it.stage, it.court)} <span class="tag ${it.priority}">${it.priority}</span>${repoTag(it)}${it.size ? ` <span class="tag" title="Large work waits while small models have other work">${esc(it.size)}</span>` : ''}${(it.needs ?? []).map((n) => ` <span class="tag" title="Only agents that have this get it">needs ${esc(n)}</span>`).join('')}
      <button class="btn ghost small x" data-action="close" title="Close (Esc)">✕</button></div>
    <h2 class="title">${esc(it.title)}</h2>
    <div class="d-now">${holderLine}</div>
    <div class="actions">${actions.join('')}</div>
    ${edit}
    ${lifebar ? `<div class="d-sec"><div class="label">Lifecycle <span class="count">agents ${esc(it.court_totals.agents)} · queue ${esc(it.court_totals.queue)} · you ${esc(it.court_totals.you)}${it.court_ms.external ? ` · outside ${esc(it.court_totals.external)}` : ''}</span></div>
      <div class="lifebar">${lifebar}</div>
      <div class="life-steps">${life.map((l) => `<span><b>${esc(l.label)}</b> ${esc(l.time)}${l.court === 'agents' && l.actor ? ` (${esc(l.actor)})` : ''}</span>`).join('<span>→</span>')}</div></div>` : ''}
    ${it.summary ? `<div class="d-sec"><div class="label">Summary</div>${md(it.summary)}</div>` : ''}
    <div class="d-sec"><div class="label">Done means</div>${it.acceptance ? md(it.acceptance) : '<p class="age">No acceptance criteria yet. Agents are asked to write them before submitting.</p>'}</div>
    ${it.submissions?.length ? `<div class="d-sec"><div class="label">The race <span class="count">${it.submissions.length} submitted</span></div>${attemptsGrid(it.item, it.submissions, { keep: it.stage === 'verifying' })}</div>` : ''}
    ${it.submission && it.stage === 'verifying' && !it.submissions?.length ? `<div class="d-sec"><div class="label">What the agent says</div><p><b>${esc(it.submission.headline)}</b></p>${md(it.submission.summary)}
      ${it.evidence.length ? `<div class="evidence">${it.evidence.map((x) => `<span class="ev">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>` : esc(x.label)}</span>`).join('')}</div>` : '<div class="warn">⚠ No evidence attached</div>'}
      ${commits(it.git)}${it.git_warning ? `<div class="warn">⚠ ${esc(it.git_warning)}</div>` : ''}</div>` : ''}
    ${handoff}
    ${it.prs?.length ? `<div class="d-sec"><div class="label">Pull requests</div>${it.prs.map((pr) => `<p><a href="${esc(pr.url)}" target="_blank" rel="noopener">${esc(pr.repo)}#${pr.number}</a> <b>${esc(pr.state)}</b> · ${esc(pr.title)}
      ${pr.ci ? ` · CI <b class="${pr.ci === 'fail' ? 'warn' : ''}">${pr.ci === 'pass' ? '✓ passing' : pr.ci === 'fail' ? '✗ failing' : '… running'}</b>` : ''}</p>
      ${pr.checks.length ? `<div class="evidence">${pr.checks.map((c) => `<span class="ev">${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)}: ${esc(c.conclusion)}</a>` : `${esc(c.name)}: ${esc(c.conclusion)}`}</span>`).join('')}</div>` : ''}`).join('')}</div>` : ''}
    ${questions}
    ${steers}
    <div class="d-sec"><div class="label">Say something about this item</div>
      <div class="inline-form"><input data-draft="ic:${it.item}" id="ic:${it.item}" placeholder="Steer whoever works on it next, or leave a note…">
      <button class="btn primary" data-action="item-steer" data-item="${it.item}" title="The agent on it must read and acknowledge">Steer</button>
      <button class="btn" data-action="item-note" data-item="${it.item}">Note</button></div></div>
    <div class="d-sec">${S.deep ? '' : `<button class="btn" data-action="deep">Deep dive (30m): the timeline, every event and its detail</button>`}</div>
    ${deep}`;
}

// ── modals ──
function modal(html) {
  const m = $('#modal');
  m.innerHTML = `<div class="dialog">${html}</div>`;
  m.hidden = false;
}
const closeModal = () => { $('#modal').hidden = true; $('#modal').innerHTML = ''; };

async function connect() {
  S.info ??= await api('/api/info').catch(() => ({ bin: '/path/to/nuworq/bin/nuworq.js', url: location.origin }));
  const slug = S.slug ?? 'my-project';
  const c = connectCommands(S.info, location, slug);
  const url = c.url;
  const where = S.view?.project.path;
  modal(`<h2>Connect an agent</h2>
    <p class="lead">Any model can work here, and many agents at once. Set an agent tool up once: it needs no project. An agent working in a folder the hub knows finds its project; anywhere else, the hub routes it to the work that matters most.</p>
    ${c.local ? '' : `<h4>Get nuworq on your machine (once)</h4><p class="lead">It has no dependencies beyond Node 22.13+${c.clone ? ', so a clone is the install' : ': clone its repository into ~/nuworq'}.</p>${c.clone ? copyBlock(c.clone) : ''}`}
    ${c.connect ? `<h4>Connect this machine (once)</h4><p class="lead">It checks the hub answers, logs you in through the browser for this machine's token, and registers nuworq with Claude Code and Codex if they're installed. Undo it all with <code>disconnect</code>.</p>${copyBlock(c.connect)}` : ''}
    <h4>Start a worker (it goes wherever work is waiting)</h4><p class="lead">Each worker gets its own git worktree and branch, so many can run at once. Run it again for more workers.</p>${copyBlock(c.worker)}
    ${S.info.github_app === 'create' ? `<h4>GitHub App (once, for this hub)</h4><p class="lead">Workers push through a GitHub App: a token for one repository, for an hour, and nobody holds a lasting GitHub credential.</p><p><a class="btn primary small" href="${esc(url)}/api/github/app/new">Create GitHub App</a></p>`
      : S.info.github_app ? `<p class="lead">Workers push through the GitHub App${typeof S.info.github_app === 'string' ? ` <code>${esc(S.info.github_app)}</code>` : ''}: install it on each project's repository.</p>` : ''}
    ${where || S.view?.project.remotes?.length ? '' : `<p class="lead">⚠ The hub doesn't know ${esc(S.view?.project.name ?? 'this project')}'s repository yet. Start the first worker from a clone of it (add --here), or link the repo in the project header, so later workers find it.</p>`}
    ${c.claude ? `<h4>Claude Code (once, for every project)</h4>${copyBlock(c.claude)}` : ''}
    <h4>OpenAI Codex (~/.codex/config.toml)${c.connect ? ', if you set it up by hand' : ''}</h4>${copyBlock(c.codex)}
    <h4>opencode, Goose, Cline, LM Studio or any MCP client (open-weight models included)</h4>${copyBlock(c.mcp)}
    ${c.token ? `<p class="lead">By hand, each agent needs its own token, so you can revoke one without the others. Make one on the hub's host, and put it where the config says <code>paste-an-agent-token-here</code>:</p>${copyBlock(c.token)}` : ''}
    <h4>Any agent with a shell (no MCP needed)</h4>${copyBlock(c.guide)}
    <p class="lead" style="margin-top:6px">Add a line to the repo's AGENTS.md or CLAUDE.md: <i>"Coordinate work through nuworq: run the command above and follow it."</i></p>

    <h4>Your own agent loop</h4><p class="lead">Tool schemas: <a href="api/tools?format=openai" target="_blank">OpenAI</a> · <a href="api/tools?format=anthropic" target="_blank">Anthropic</a> · <a href="api/tools?format=mcp" target="_blank">MCP</a>. POST to <code>${esc(url)}/api/p/${esc(slug)}/agent/&lt;tool&gt;</code> with header <code>x-nuworq-agent: &lt;name&gt;</code>. The agent guide: <a href="agents.md?project=${encodeURIComponent(slug)}" target="_blank">/agents.md</a></p>
    <div class="foot"><button class="btn primary" data-action="close-modal">Done</button></div>`);
}

async function notifySettings() {
  let n;
  try { n = await api('/api/notify'); } catch (e) { return toast(e.message, true); }
  S.notifyPerson = n.person; // who "only what needs me" means
  const rows = n.channels.map((c) => `<div class="inline-form"><span><b>${esc(c.kind)}</b> <code>${esc(c.url)}</code> <span class="faint">${c.person ? `${c.person === n.person ? 'you' : esc(c.person)}: only what they own` : 'everyone'}</span> ${c.failing ? `<span class="warn">⚠ failing: ${esc(c.last_error)}</span>` : ''}</span>
    <button class="btn ghost small" data-action="notify-remove" data-id="${c.id}">Remove</button></div>`).join('');
  modal(`<h2>Notifications</h2>
    <p class="lead">When something new needs you (a blocking question, work to verify, "what matters most?"), nuworq sends one message, batched over 2 minutes, with a link. Healthy work sends nothing.</p>
    ${rows || '<p class="lead faint">No channels yet.</p>'}
    <h4>Add a channel</h4>
    <div class="inline-form"><select id="nt-kind">${Object.keys(n.kinds).map((k) => `<option value="${k}">${k}</option>`).join('')}</select>
      <input id="nt-url" placeholder="https://ntfy.sh/your-secret-topic, a Slack webhook, or any URL"><button class="btn primary small" data-action="notify-add">Add</button></div>
    ${n.person ? `<label class="faint"><input type="checkbox" id="nt-mine" checked> Only what needs me (${esc(n.person)}); unchecked, an owner's channel gets everyone's</label>` : ''}
    <p class="lead">${Object.entries(n.kinds).map(([k, v]) => `<b>${esc(k)}</b>: ${esc(v)}`).join('<br>')}</p>
    <div class="foot">${n.channels.length ? '<button class="btn" data-action="notify-test">Send a test</button>' : ''}<button class="btn primary" data-action="close-modal">Done</button></div>`);
}

async function githubSettings() {
  S.info ??= await api('/api/info').catch(() => ({ url: location.origin }));
  const P = S.view.project;
  const hook = `${S.info.url}/api/hooks/github/${encodeURIComponent(P.slug)}`;
  modal(`<h2>GitHub</h2>
    <p class="lead">A webhook links pull requests to items (a <code>nuworq/&lt;agent&gt;</code> branch, or <code>#N</code> in the PR title) and shows CI results on them. Failing CI on work you're verifying shows up under "Needs you".</p>
    <h4>1. In the repo on GitHub: Settings → Webhooks → Add webhook</h4>
    <p class="lead">Payload URL (GitHub must be able to reach it; see docs/DEPLOY.md):</p>${copyBlock(hook)}
    <p class="lead">Content type <code>application/json</code>. Events: <i>Pull requests</i>, <i>Check suites</i>, <i>Check runs</i>, <i>Statuses</i>.</p>
    <h4>2. The same secret, there and here</h4>
    <div class="inline-form"><input id="gh-secret" placeholder="${P.github ? 'A secret is set; enter a new one to replace it' : 'A long random secret'}"><button class="btn small" data-action="github-generate">Generate</button></div>
    <div class="foot">${P.github ? '<button class="btn ghost" data-action="github-disconnect">Disconnect</button>' : ''}<button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="github-save">Save</button></div>`);
}

// "+ Project": pick one of the repositories the GitHub App can see, or (no app, or a workspaces hub) by name.
function newProject() {
  const gh = S.info?.github_app;
  const picker = gh && gh !== 'create' && !S.info?.workspace;
  const why = S.info?.workspace ? 'On a hub with workspaces, add a project by name for now: the shared GitHub App would list other organizations\' repositories.'
    : gh === 'create' ? 'To pick a repository instead, <a href="api/github/app/new">create the GitHub App</a> (one click) and install it on your repositories.'
    : !gh ? 'With the hub\'s GitHub App, you could pick a repository here instead; an owner creates it from Connect an agent.' : '';
  modal(`<h2>New project</h2>
    ${picker ? `<p class="lead">Pick a repository the nuworq GitHub App is installed on. Install it on more from GitHub to see them here.</p>
      <div class="form"><label>Search<input id="np-q" placeholder="owner/name"></label></div><div id="np-repos" class="repo-list"><p class="faint">Loading…</p></div>
      <details><summary>Or add one by name</summary>` : `<p class="lead">${why} Agents also create projects when they check in to a new name.</p>`}
    <div class="form"><label>Name<input id="np-name" placeholder="e.g. llm-proxy"></label>
    <label>Repository (optional): its git remote, so agents in a clone find the project<input id="np-remote" placeholder="e.g. github.com/acme/llm-proxy"></label>
    <label>Mission (optional): the north star every agent reads<textarea id="np-mission" placeholder="What is this for? What matters most?"></textarea></label></div>
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
      + (rows && page === 1 && !q ? `<p class="faint" style="margin-top:8px">Not listed? ${installLink('Install the app on more repositories')}.</p>` : '');
    box.dataset.html = box.innerHTML;
    if (r.next_page) box.insertAdjacentHTML('beforeend', `<button class="btn ghost small" data-action="more-repos" data-q="${esc(q)}" data-page="${r.next_page}">More</button>`);
  } catch (e) { box.innerHTML = `<p class="faint">${esc(e.message)}</p>`; }
}

// ── events ──
const val = (id) => (document.getElementById(id)?.value ?? '').trim();
const clearDraft = (...keys) => keys.forEach((k) => delete S.drafts[k]);

const ACTIONS = {
  zoom: (el) => { S.zoom = el.dataset.zoom; store.set('zoom', S.zoom); render({ force: true }); },
  goto: (el) => go(el.dataset.slug),
  open: (el) => go(S.slug, el.dataset.item),
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
    if (kind === 'note') await human('comment', { body }, 'Noted');
    else if (kind === 'decision') await human('decide', { body }, 'Decision recorded: every agent will carry it');
    else await human('steer', { body }, 'Steer sent: agents will acknowledge it');
  },
  'toggle-add': () => { S.addWork = !S.addWork; render({ force: true }); if (S.addWork) setTimeout(() => $('#nw-title')?.focus(), 0); },
  'nw-priority': (el) => { S.drafts['nw-priority'] = el.dataset.p; render({ force: true }); },
  'add-work': async () => {
    const title = val('nw-title');
    if (!title) return toast('Give it a title', true);
    await human('create', { title, summary: val('nw-summary'), acceptance: val('nw-acceptance'), priority: S.drafts['nw-priority'] ?? 'soon' }, 'Added to Ready');
    clearDraft('nw-title', 'nw-summary', 'nw-acceptance', 'nw-priority');
    S.addWork = false;
    render({ force: true });
  },
  answer: (el) => {
    const q = el.dataset.q;
    const decide = document.getElementById(`dec-${q}`)?.checked;
    clearDraft(`ans-${q}`, `dec-${q}`);
    return human('answer', { question: Number(q), answer: el.dataset.answer, decide }, decide ? 'Answered, and saved as a decision' : 'Answered; the work is moving again');
  },
  'answer-text': (el) => {
    const q = el.dataset.q;
    const answer = val(`ans-${q}`);
    if (!answer) return toast('Write an answer first', true);
    const decide = document.getElementById(`dec-${q}`)?.checked;
    clearDraft(`ans-${q}`, `dec-${q}`);
    return human('answer', { question: Number(q), answer, decide }, 'Answered; the work is moving again');
  },
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
  park: () => { if (confirm('Park this project? No new work starts and nothing here will ask for you until you unpark it.')) human('settings', { parked: true }, 'Parked'); },
  unpark: () => human('settings', { parked: false }, 'Unparked'),
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
      modal(`<h2>Archived projects</h2>${list.length ? list.map((p) => `<div class="row-item"><div class="body"><div class="h">${esc(p.name)}</div>${p.remotes.length ? `<div class="s">${esc(p.remotes.join(', '))}</div>` : ''}</div><button class="btn small" data-action="restore-project" data-slug="${esc(p.slug)}">Restore</button></div>`).join('') : '<p class="lead">None.</p>'}
        <div class="foot"><button class="btn ghost" data-action="close-modal">Close</button></div>`);
    } catch (e) { toast(e.message, true); }
  },
  'restore-project': async (el) => {
    try {
      await api(`/api/p/${encodeURIComponent(el.dataset.slug)}/human/restore`, { method: 'POST', body: '{}' });
      closeModal();
      await loadProjects();
      go(el.dataset.slug);
    } catch (e) { toast(e.message, true); }
  },
  'runner-on': () => human('settings', { runner: true }, '`nuworq run` may now start workers here'),
  'runner-off': () => human('settings', { runner: false }, '`nuworq run` will no longer start workers here'),
  drop: (el) => { if (confirm(`Drop ${el.dataset.item}? It stays on the record.`)) human('update', { item: el.dataset.item, stage: 'dropped' }, 'Dropped'); },
  reopen: (el) => human('update', { item: el.dataset.item, stage: 'ready' }, 'Back in Ready'),
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
  'edit-item': () => { S.editItem = !S.editItem; clearDraft('ei-title', 'ei-summary', 'ei-acceptance', 'ei-priority', 'ei-race'); render({ force: true }); },
  'ei-priority': (el) => { S.drafts['ei-priority'] = el.dataset.p; render({ force: true }); },
  'ei-race': (el) => { S.drafts['ei-race'] = el.dataset.n; render({ force: true }); },
  'save-item': async (el) => {
    const args = { item: el.dataset.item, title: val('ei-title'), summary: val('ei-summary'), acceptance: val('ei-acceptance') };
    if (S.drafts['ei-priority']) args.priority = S.drafts['ei-priority'];
    if (S.drafts['ei-race']) args.race = Number(S.drafts['ei-race']);
    S.editItem = false;
    clearDraft('ei-title', 'ei-summary', 'ei-acceptance', 'ei-priority', 'ei-race');
    await human('update', args, 'Saved');
  },
  dismiss: (el) => human('dismiss', { key: el.dataset.key }),
  retire: (el) => human('retire', { note: Number(el.dataset.note) }, 'Retired'),
  'feed-all': () => { S.feedAll = !S.feedAll; render({ force: true }); },
  connect: () => connect(),
  notify: () => notifySettings(),
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
    } catch (e) { toast(e.message + (e.hint ? ` — ${e.hint}` : ''), true); }
  },
  'notify-remove': async (el) => {
    try { await api('/api/notify/remove', { method: 'POST', body: JSON.stringify({ id: Number(el.dataset.id) }) }); notifySettings(); } catch (e) { toast(e.message, true); }
  },
  'notify-test': async () => {
    try {
      const r = await api('/api/notify/test', { method: 'POST' });
      toast(r.ok ? 'Test sent to every channel' : `Failed: ${r.results.filter((x) => !x.ok).map((x) => `${x.kind} (${x.error})`).join(', ')}`, !r.ok);
      notifySettings();
    } catch (e) { toast(e.message, true); }
  },
  'new-project': () => newProject(),
  'more-repos': (el) => { el.remove(); loadRepos(el.dataset.q, Number(el.dataset.page)); },
  'pick-repo': async (el) => {
    try {
      const r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ repo: el.dataset.repo, mission: el.dataset.desc }) });
      modal(`<h2>${esc(r.repo.replace('github.com/', ''))} is a project</h2>
        <p class="lead">Let <code>nuworq run</code> staff this project? It starts workers whenever there is work nobody is on, up to the limits it was started with. You can change this later in the project's settings.</p>
        <div class="foot"><button class="btn ghost" data-action="goto-new" data-slug="${esc(r.slug)}">Not now</button><button class="btn primary" data-action="staff-new" data-slug="${esc(r.slug)}">Let run staff it</button></div>`);
    } catch (e) { toast(e.message, true); }
  },
  'goto-new': (el) => { closeModal(); go(el.dataset.slug); },
  'staff-new': async (el) => {
    try {
      await api(`/api/p/${encodeURIComponent(el.dataset.slug)}/human/settings`, { method: 'POST', body: JSON.stringify({ runner: true }) });
      closeModal();
      go(el.dataset.slug);
    } catch (e) { toast(e.message, true); }
  },
  'close-modal': () => closeModal(),
  logout: async () => { await fetch('api/logout', { method: 'POST', credentials: 'same-origin' }); location.href = 'login.html'; },
  'create-project': async () => {
    const name = val('np-name');
    if (!name) return toast('Name it', true);
    try {
      const r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, mission: val('np-mission'), remote: val('np-remote') || undefined }) });
      closeModal();
      go(r.slug);
    } catch (e) { toast(e.message, true); }
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
document.addEventListener('keydown', (e) => {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === 'Escape') {
    if (!$('#modal').hidden) return closeModal();
    if (S.itemRef) return go(S.slug);
    if (inField) document.activeElement.blur();
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && document.activeElement?.id === 'compose') return ACTIONS['compose-send']();
  if (e.key === 'Enter' && inField && document.activeElement.tagName === 'INPUT') {
    const btn = document.activeElement.parentElement?.querySelector('button[data-action]');
    if (btn) { e.preventDefault(); btn.click(); }
  }
  // 1, 2, 3 set the depth everywhere: a project, and All projects.
  if (!inField && !e.metaKey && !e.ctrlKey && !e.altKey && ['1', '2', '3'].includes(e.key)) {
    S.zoom = Object.keys(Z)[Number(e.key) - 1];
    store.set('zoom', S.zoom);
    render({ force: true });
  }
});
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

// ── live updates ──
let refreshTimer;
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh(), 250); }
function listen() {
  const es = new EventSource('api/stream');
  // A hub that moved onto a new commit restarts, so the stream reconnects: pick up the version it runs now.
  es.onopen = async () => {
    const info = await api('/api/info').catch(() => null);
    if (info && info.commit !== S.info?.commit) { S.info = info; scheduleRefresh(); }
  };
  es.onmessage = () => scheduleRefresh();
  es.onerror = () => { es.close(); setTimeout(listen, 3000); };
}

(async function start() {
  window.addEventListener('hashchange', route);
  S.me = await api('/api/me').catch(() => null);
  S.info = await api('/api/info').catch(() => null) ?? undefined;
  await loadProjects().catch(() => {});
  if (!location.hash || location.hash === '#/') {
    if (S.projects.length === 1) return void (go(S.projects[0].slug), listen());
  }
  route();
  listen();
  setInterval(() => refresh(), 30_000);
})();
