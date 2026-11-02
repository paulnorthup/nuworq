// The admin host's dashboard, for the hub's owners: sign in here, then decide early-access requests.
// New requests first; Approve and Decline each ask first; an approval's link (shown once) has a Copy button.
// Then the workspaces (#169): one row each, most recently active first; tap a row for who and what is in it,
// and to switch its plan between Free and Unlimited (that asks first too, saying what changes).
import { markNew, dismissNew } from './new.js';
import { placeholder } from './instant.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const STATES = [['new', 'New'], ['approved', 'Approved'], ['declined', 'Declined'], ['', 'All']];
let state = 'new';
const focus = Number(new URLSearchParams(location.search).get('request')) || 0; // the request a push linked to (#167)
const links = new Map(); // request id → the link its approval gave, shown until the page is left

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error + (j.hint ? `. ${j.hint}` : '')), { status: r.status });
  return j;
}

function showError(msg) {
  $('#error').hidden = !msg;
  $('#error').textContent = msg ?? '';
}

async function main() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('error');
  if (fromHash) { showError(fromHash); history.replaceState(null, '', '/'); }
  const me = await api('/api/me').catch(() => null);
  if (!me) return signIn();
  $('#who').innerHTML = `<span class="faint">${esc(me.email)}</span> <button class="btn ghost" id="out">Sign out</button>`;
  $('#out').addEventListener('click', async () => { await api('/api/logout', {}).catch(() => {}); location.reload(); });
  if (!me.owner) {
    $('#view').innerHTML = `<p class="lead">${esc(me.email)} isn't one of this hub's owners, so there is nothing here for it.</p>
      <p class="faint">Sign out, then sign in with an owner's account. The hub host lists the owners in NUWORQ_HUB_OWNERS.</p>`;
    return;
  }
  $('#view').innerHTML = `<div id="wiring"></div>
    <h2>Early access</h2>
    <p class="lead">Approve gives you a link to send: it lets them make one workspace, once, within 14 days.</p>
    <div class="seg admin-filter" role="group" aria-label="Show">${STATES.map(([v, label]) => `<button data-state="${v}" aria-pressed="${v === state}" class="${v === state ? 'on' : ''}">${label}</button>`).join('')}</div>
    <div id="list" aria-live="polite">${placeholder(3, { head: false })}</div>
    <h2 class="admin-h2" data-new="ea-sources">Where they came from</h2>
    <p class="lead">How far the people from each source got. A source is the ?ref= tag on nuworq.com's link, or the site they came from.</p>
    <div class="seg admin-filter src-filter" role="group" aria-label="Count">${SPANS.map(([v, label]) => `<button data-span="${v}" aria-pressed="${v === span}" class="${v === span ? 'on' : ''}">${label}</button>`).join('')}</div>
    <div id="sources" aria-live="polite">${placeholder(3, { head: false })}</div>
    <h2 class="admin-h2" id="feedback"><span data-new="feedback-groups">Feedback</span></h2>
    <p class="lead" id="fb-lead">What got in people's and agents' way. Approve makes it a proposal agents shape; Decline closes it, with a note to the sender if you like.</p>
    <div id="fb-level"></div>
    <div class="seg admin-filter fb-filter" role="group" aria-label="Show feedback">${FB_STATES.map(([v, label]) => `<button data-fb-state="${v}" aria-pressed="${v === fbState}" class="${v === fbState ? 'on' : ''}">${label}</button>`).join('')}</div>
    <div id="fb-list" aria-live="polite">${placeholder(3, { head: false })}</div>
    <h2 class="admin-h2">Workspaces</h2>
    <div id="spaces" aria-live="polite">${placeholder(3, { head: false })}</div>`;
  load();
  loadSources();
  loadFeedback();
  loadSpaces();
  loadWiring();
}

// What the hub's GitHub App is missing (#220), first on the page, with the steps; nothing when it has it all.
async function loadWiring() {
  const { missing } = await api('/api/github/app/wiring').catch(() => ({}));
  if (!missing) return;
  $('#wiring').innerHTML = `<article class="admin-card focus">
    <div class="h">${esc(missing.headline)}</div>
    <p class="faint">${esc(missing.sub)}</p>
    <ol>${missing.how.map((s) => `<li>${esc(s.do)}${s.where ? `<br><a href="${esc(s.where)}" target="_blank" rel="noopener">${esc(s.where)}</a>` : ''}${s.check ? `<br><small class="faint">${esc(s.check)}.</small>` : ''}</li>`).join('')}</ol>
  </article>`;
}

async function signIn() {
  const { providers = [] } = await api('/api/oauth').catch(() => ({}));
  $('#view').innerHTML = `<p class="lead">Only this hub's owners can open the admin dashboard. Sign in to continue.</p>
    <div class="admin-signin">${providers.map((p) => `<a class="btn primary" href="${esc(p.start)}">Sign in with ${esc(p.label ?? p.name)}</a>`).join('') || '<p class="faint">This hub has no GitHub or Google sign-in set up (see DEPLOY.md).</p>'}</div>`;
}

async function load() {
  const list = $('#list');
  try {
    const { requests } = await api(`/api/early-access?state=${encodeURIComponent(state)}`);
    // The linked request was decided already: show everything, so it is still there to see.
    if (focus && state && !requests.some((r) => r.id === focus) && !load.widened) {
      load.widened = true;
      return document.querySelector('.admin-filter button[data-state=""]').click();
    }
    list.innerHTML = requests.length ? requests.map(card).join('') : `<p class="faint">${state === 'new' ? 'No new requests.' : 'Nothing here.'}</p>`;
    document.getElementById(`request-${focus}`)?.scrollIntoView({ block: 'center' });
  } catch (e) { list.innerHTML = `<p class="bad">${esc(e.message)}</p>`; }
}

function card(r) {
  const link = links.get(r.id);
  return `<article class="admin-card${r.id === focus ? ' focus' : ''}" id="request-${r.id}" data-email="${esc(r.email)}">
    <div class="h">${esc(r.email)}${r.github ? ` · <a href="https://github.com/${esc(r.github)}" target="_blank" rel="noopener">@${esc(r.github)}</a>` : ''}${r.source ? ` <span class="src-tag">via ${esc(r.source)}</span>` : ''}</div>
    <p class="s">${esc(r.building) || '<span class="faint">No note.</span>'}</p>
    <p class="faint">Asked ${esc(ago(r.updated_at))}${r.decided_at ? ` · ${esc(r.state)} by ${esc(r.decided_by)} ${esc(ago(r.decided_at))}` : ''}</p>
    ${link ? `<div class="admin-link"><p class="ok">Approved. Send them this link (it's shown only now):</p><code>${esc(link)}</code>
      <button class="btn primary" data-copy="${esc(link)}">Copy link</button></div>` : ''}
    ${r.state === 'new' ? `<div class="admin-acts"><button class="btn primary" data-id="${r.id}" data-approve="1">Approve</button><button class="btn" data-id="${r.id}">Decline</button></div>` : ''}
  </article>`;
}

// ── where they came from (#356): per source, a funnel of bars from requests to a first item landed ──
// Read at a glance, on a phone, before deciding where to spend: the same scale across sources, so a long first bar
// that drops to nothing stands out next to a short one that holds.
const SPANS = [['recent', 'Last 14 days'], ['all', 'All time']];
const STEPS = [['requests', 'Asked'], ['let_in', 'Let in'], ['connected', 'Agent connected'], ['landed', 'Item landed']];
let span = 'recent', sourcesData = null;

async function loadSources() {
  const el = $('#sources');
  try {
    sourcesData ??= await api('/api/early-access/sources');
    const rows = sourcesData.sources.filter((s) => s[span].requests);
    const max = Math.max(1, ...rows.map((s) => s[span].requests));
    el.innerHTML = rows.length ? rows.map((s) => sourceCard(s, s[span], max)).join('')
      : `<p class="faint">${span === 'recent' ? `No requests in the last ${sourcesData.days} days.` : 'No requests yet.'}</p>`;
    markNew(document);
  } catch (e) { el.innerHTML = `<p class="bad">${esc(e.message)}</p>`; }
}

function sourceCard(s, c, max) {
  return `<article class="admin-card src" data-source="${esc(s.source)}">
    <div class="h">${s.source ? esc(s.source) : '<span class="faint">No source</span>'}</div>
    <dl class="funnel">${STEPS.map(([k, label]) => `<div class="step"><dt>${label}</dt>
      <dd><span class="bar" style="width:${(c[k] / max) * 100}%"></span></dd><dd class="n">${c[k]}</dd></div>`).join('')}</dl>
  </article>`;
}

// ── feedback (#295), in groups (#688): pieces that report the same thing are one card, newest first. Each says
// who sent it, what already covers it, and the call it suggests; one tap decides it, and Undo takes it back. ──
const FB_STATES = [['new', 'New'], ['decided', 'Decided'], ['', 'All']];
let fbState = 'new';
const fbFocus = Number(new URLSearchParams(location.search).get('feedback')) || 0; // the piece a push linked to
const picked = new Set(); // groups ticked for one decision together
let fbMax = 1; // the most senders any group in view has: the bars' shared scale

async function loadFeedback() {
  const el = $('#fb-list');
  try {
    const { on, project, autonomy, groups: all } = await api('/api/feedback/groups');
    $('#fb-lead').textContent = on
      ? `What got in people's and agents' way, for ${project}. The same report from many senders is one group: decide it once.`
      : 'Feedback is off on this hub: the host turns it on with --feedback-project <workspace>/<project> (NUWORQ_FEEDBACK_PROJECT).';
    $('#fb-level').innerHTML = on ? fbLevel(autonomy) : '';
    markNew($('#fb-level'));
    const groups = all.filter((g) => !fbState || (fbState === 'new' ? g.state === 'new' : g.state !== 'new'));
    if (fbFocus && fbState && !groups.some((g) => g.pieces.some((p) => p.id === fbFocus)) && !loadFeedback.widened) {
      loadFeedback.widened = true;
      return document.querySelector('.fb-filter button[data-fb-state=""]').click();
    }
    for (const id of picked) if (!groups.some((g) => g.id === id && g.state === 'new')) picked.delete(id);
    fbMax = Math.max(1, ...groups.map((g) => g.senders.length));
    el.innerHTML = `<div id="fb-bulk"></div>${groups.length ? groups.map(fbGroup).join('') : `<p class="faint">${fbState === 'new' ? 'No new feedback.' : 'Nothing here.'}</p>`}`;
    fbBulk();
    markNew(document);
    document.querySelector(`[data-pieces~="${fbFocus}"]`)?.scrollIntoView({ block: 'center' });
  } catch (e) { el.innerHTML = `<p class="bad">${esc(e.message)}</p>`; }
}

const ACT = { link: (s) => `Link to ${s.ref}`, approve: () => 'New work', decline: () => 'Decline' };
const DONE = { linked: 'Linked to', approved: 'New work:', declined: 'Declined' };

function sentWith(f) {
  const c = f.context ?? {};
  return (f.kind === 'agent'
    ? [c.client, c.model, c.version && `nuworq ${c.version}`, f.item && `about ${f.item}`]
    : [c.page, c.version && `nuworq ${c.version}`, c.browser]).filter(Boolean);
}

function fbGroup(g) {
  const lead = g.pieces[0];
  const spaces = [...new Set(g.senders.map((s) => s.workspace))];
  const who = `${g.senders[0].kind === 'agent' ? 'Agent ' : ''}${esc(g.senders[0].sender)}${g.senders.length > 1 ? ` and ${g.senders.length - 1} more` : ''}`;
  const email = g.senders.length === 1 && lead.email ? ` <span class="faint">${esc(lead.email)}</span>` : '';
  const focus = g.pieces.some((p) => p.id === fbFocus);
  const s = g.state === 'new' ? g.suggest : null;
  // The suggested call first and filled; the others beside it. Link only when something covers it.
  const acts = s ? [s.action, ...['link', 'approve', 'decline'].filter((a) => a !== s.action && (a !== 'link' || g.known))] : [];
  const d = g.decision;
  const decided = d ? `${d.auto ? `Proposed at once (${LEVELS[d.auto]?.label ?? esc(d.auto)})` : `${DONE[d.state] ?? esc(d.state)}`}${d.ref ? ` <b>${esc(d.ref)}</b>${d.title ? ` <span class="faint">${esc(d.title)}</span>` : ''}` : d.state !== 'declined' && d.proposal ? ` ${esc(d.proposal)}` : ''}${d.note ? `: “${esc(d.note)}”` : ''}
    <span class="faint">· ${d.by ? `${esc(d.by)} ` : ''}${esc(ago(d.at))}</span>` : '';
  return `<article class="admin-card fb-group${focus ? ' focus' : ''}" id="fbg-${g.id}" data-group="${g.id}" data-pieces="${g.pieces.map((p) => p.id).join(' ')}">
    <div class="fb-g-head">
      ${g.state === 'new' ? `<input type="checkbox" class="fb-pick" data-pick="${g.id}" aria-label="Pick this group"${picked.has(g.id) ? ' checked' : ''}>` : ''}
      <div class="h">${who}${email} · ${spaces.map(esc).join(', ')}</div>
    </div>
    ${g.count > 1 ? `<div class="fb-g-count" title="${g.senders.length} sent it"><span class="fb-g-bar"><span style="width:${(g.senders.length / fbMax) * 100}%"></span></span><b>${g.senders.length}</b></div>` : ''}
    <p class="s fb-text">${esc(lead.text)}</p>
    <p class="faint">${g.count > 1 ? `First ${esc(ago(g.first_at))}, latest ${esc(ago(g.last_at))}` : `Sent ${esc(ago(g.first_at))}`}${g.count === 1 && sentWith(lead).length ? ` · ${sentWith(lead).map(esc).join(' · ')}` : ''}</p>
    ${g.count > 1 ? `<details class="fb-g-all"><summary>All ${g.count}</summary><ul>${g.pieces.map((p) => `<li><b>${esc(p.sender)}</b> <span class="faint">${esc(ago(p.created_at))}</span><span class="fb-words">${esc(p.text)}</span></li>`).join('')}</ul></details>` : ''}
    ${g.known && g.state === 'new' ? `<p class="fb-known"><b>${esc(g.known.line)}</b> <span class="faint">${esc(g.known.title)}</span></p>` : ''}
    ${s ? `<p class="fb-suggest"><span class="label">Suggested</span> ${esc(ACT[s.action](s))}${g.known && s.action === 'link' ? '' : `: ${esc(s.why)}`}</p>
      ${s.action === 'decline' ? note(g.id, s.note) : `<details class="fb-note-more"><summary>A note, if you decline</summary>${note(g.id, '')}</details>`}
      <div class="admin-acts">${acts.map((a, i) => `<button class="btn${i ? '' : ' primary'}" data-g="${g.id}" data-g-act="${a}"${a === 'link' ? ` data-ref="${esc(s.ref ?? g.known?.ref)}"` : ''}>${esc(ACT[a](a === 'link' ? { ref: s.ref ?? g.known?.ref } : s))}</button>`).join('')}</div>` : ''}
    ${decided ? `<div class="fb-decided"><p>${decided}</p><button class="btn ghost" data-g-undo="${g.id}">Undo</button></div>` : ''}
  </article>`;
}

// What Decline sends the senders: in the open when declining is the suggestion, else folded away.
const note = (id, value) => `<input class="fb-note" data-note="${id}" aria-label="A note to the senders, if you decline" placeholder="A note to them, if you decline" value="${esc(value ?? '')}">`;

// Groups ticked together: one tap takes each one's suggestion, or declines them all.
function fbBulk() {
  const el = $('#fb-bulk');
  if (!el) return;
  el.innerHTML = picked.size ? `<div class="fb-bulk" role="group" aria-label="Decide the picked groups"><span>${picked.size} picked</span>
    <button class="btn primary" data-bulk="suggested">Take the suggestions</button><button class="btn" data-bulk="decline">Decline</button></div>` : '';
}

async function decideGroups(ids, body, from) {
  if (from) from.disabled = true;
  try {
    const r = await api(body.undo ? '/api/feedback/groups/undo' : '/api/feedback/groups/decide', { groups: ids, ...body });
    showError('');
    for (const g of r.groups) {
      picked.delete(g.id);
      const card = document.getElementById(`fbg-${g.id}`);
      if (card) card.outerHTML = fbGroup(g);
    }
    fbBulk();
  } catch (err) { showError(err.message); if (from) from.disabled = false; }
}

// How far feedback goes on its own (#296): the project autonomy levels, each with the one line on what it does.
const LEVELS = {
  ask: { label: 'Check with me', does: 'Each report waits here for you to decide it: link it, make it new work, or decline it.' },
  balanced: { label: 'Keep moving', does: 'Each piece becomes a proposal at once and agents shape it; you approve each shaped item before it\'s built.' },
  full: { label: 'Run with it', does: 'Agents shape, build and land it under the project\'s own autonomy; you see it in the project and here.' },
};

function fbLevel(level) {
  return `<div class="admin-card fb-level" data-level="${esc(level)}">
    <p class="h" data-new="feedback-autonomy">How far it goes on its own</p>
    <div class="seg" role="group" aria-label="How far feedback goes on its own">${Object.entries(LEVELS).map(([v, l]) => `<button data-fb-level="${v}" aria-pressed="${v === level}" class="${v === level ? 'on' : ''}">${l.label}</button>`).join('')}</div>
    <p class="s">${esc(LEVELS[level]?.does)}</p>
    <p class="faint">At every level, asking for a new feature, a pricing or policy change, or removing something comes to you as a question.</p>
  </div>`;
}

const PLAN = { free: 'Free', unlimited: 'Unlimited' };
const CHANGE = {
  free: 'Free: one agent works at a time; a second claim is refused with an upgrade hint.',
  unlimited: 'Unlimited: any number of agents work side by side.',
};
const expanded = new Set(); // workspaces whose detail is showing, kept across reloads

async function loadSpaces() {
  const el = $('#spaces');
  try {
    const { enforced, workspaces } = await api('/api/workspaces');
    el.innerHTML = `${enforced ? '' : '<p class="faint">Plans aren\'t enforced on this hub (start it with --plans): changes are stored and apply once they are.</p>'}
      ${workspaces.length ? workspaces.map(space).join('') : '<p class="faint">No workspaces yet.</p>'}`;
  } catch (e) { el.innerHTML = `<p class="bad">${esc(e.message)}</p>`; }
}

function space(w) {
  const other = w.plan === 'free' ? 'unlimited' : 'free';
  const why = w.source === 'owners' ? 'Always Unlimited: a hub owner is in it.'
    : w.source === 'set' ? `Set by ${esc(w.set_by || 'the host')} ${esc(ago(w.set_at))}.`
    : w.source === 'billing' ? 'Paid through Stripe.'
    : w.source === 'early_access' ? 'Let in through early access: Unlimited, never charged.'
    : `The default: ${w.plan === 'free' ? 'someone signed up for it' : 'the host made it'}.`;
  // What Stripe last said (#227), e.g. "paid until 2026-12-01", "cancels 2026-12-01", "payment failed".
  const billing = w.billing?.line ? `<span class="${w.billing.line === 'payment failed' ? 'bad' : 'faint'}">${esc(w.billing.line)}</span>` : '';
  return `<details class="admin-card admin-space" data-name="${esc(w.name)}"${expanded.has(w.name) ? ' open' : ''}>
    <summary><span class="h">${esc(w.name)}</span><span class="plan plan-${esc(w.plan)}">${PLAN[w.plan]}</span>${billing}
      <span class="faint">${w.working.length ? `<b class="working">${w.working.length} working</b>` : 'idle'} · ${w.last_active ? esc(ago(w.last_active)) : 'never active'}</span></summary>
    <p>Made by ${w.creator ? `${esc(w.creator.email)}${w.creator.github ? ` · <a href="https://github.com/${esc(w.creator.github)}" target="_blank" rel="noopener">@${esc(w.creator.github)}</a>` : ''}` : 'the host'}</p>
    <p class="s">${w.people} ${w.people === 1 ? 'person' : 'people'} · ${w.projects} ${w.projects === 1 ? 'project' : 'projects'}${w.working.length ? ` · working: ${w.working.map(esc).join(', ')}` : ''}</p>
    <p class="faint">${why}</p>
    ${w.source === 'owners' ? '' : `<div class="admin-acts"><button class="btn" data-plan="${other}">Switch to ${PLAN[other]}</button></div>`}
  </details>`;
}

document.addEventListener('click', (e) => dismissNew(e), true);

document.addEventListener('change', (e) => {
  const pk = e.target.closest?.('input[data-pick]');
  if (!pk) return;
  pk.checked ? picked.add(Number(pk.dataset.pick)) : picked.delete(Number(pk.dataset.pick));
  fbBulk();
});

document.addEventListener('toggle', (e) => {
  const d = e.target.closest?.('.admin-space');
  if (d) d.open ? expanded.add(d.dataset.name) : expanded.delete(d.dataset.name);
}, true);

document.addEventListener('click', async (e) => {
  const pl = e.target.closest('button[data-plan]');
  if (pl) {
    const name = pl.closest('.admin-space').dataset.name, plan = pl.dataset.plan;
    if (!confirm(`Switch ${name} to ${PLAN[plan]}?\n\n${CHANGE[plan]}\n\nYou can switch it back here.`)) return;
    pl.disabled = true;
    try {
      const r = await api('/api/workspaces/plan', { workspace: name, plan });
      showError('');
      pl.closest('.admin-space').outerHTML = space(r.workspace);
    } catch (err) { showError(err.message); pl.disabled = false; }
    return;
  }
  const lv = e.target.closest('button[data-fb-level]');
  if (lv) {
    const level = lv.dataset.fbLevel;
    if (lv.closest('.fb-level').dataset.level === level) return;
    if (!confirm(`Switch feedback to ${LEVELS[level].label}?\n\n${LEVELS[level].does}\n\nOnly feedback that comes in from now on. You can switch it back here.`)) return;
    lv.disabled = true;
    try { await api('/api/feedback/autonomy', { level }); showError(''); } catch (err) { showError(err.message); }
    return loadFeedback();
  }
  const sp = e.target.closest('button[data-span]');
  if (sp) { span = sp.dataset.span; for (const b of document.querySelectorAll('.src-filter button')) { b.classList.toggle('on', b === sp); b.setAttribute('aria-pressed', String(b === sp)); } return loadSources(); }
  const fs = e.target.closest('button[data-fb-state]');
  if (fs) { fbState = fs.dataset.fbState; for (const b of document.querySelectorAll('.fb-filter button')) { b.classList.toggle('on', b === fs); b.setAttribute('aria-pressed', String(b === fs)); } return loadFeedback(); }
  // A group's call, in one tap: no dialog, since Undo takes it back. Decline sends the note in its card.
  const ga = e.target.closest('button[data-g-act]');
  if (ga) {
    const id = Number(ga.dataset.g), action = ga.dataset.gAct;
    return decideGroups([id], { action, ...(action === 'link' ? { ref: ga.dataset.ref } : {}), ...(action === 'decline' ? { note: document.querySelector(`[data-note="${id}"]`)?.value ?? '' } : {}) }, ga);
  }
  const gu = e.target.closest('button[data-g-undo]');
  if (gu) return decideGroups([Number(gu.dataset.gUndo)], { undo: true }, gu);
  const bk = e.target.closest('button[data-bulk]');
  if (bk) return decideGroups([...picked], { action: bk.dataset.bulk }, bk);
  const f = e.target.closest('button[data-state]');
  if (f) { state = f.dataset.state; for (const b of document.querySelectorAll('.admin-filter button')) { b.classList.toggle('on', b === f); b.setAttribute('aria-pressed', String(b === f)); } return load(); }
  const c = e.target.closest('button[data-copy]');
  if (c) {
    try { await navigator.clipboard.writeText(c.dataset.copy); c.textContent = 'Copied ✓'; } catch { c.textContent = 'Select and copy it above'; }
    return;
  }
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  const email = b.closest('.admin-card')?.dataset.email;
  const approve = !!b.dataset.approve;
  if (!confirm(approve ? `Approve ${email}? You get a link to send them; it makes one workspace.` : `Decline ${email}? This can't be undone here.`)) return;
  b.disabled = true;
  try {
    const r = await api('/api/early-access/decide', { id: Number(b.dataset.id), approve });
    showError('');
    if (r.link) {
      links.set(Number(b.dataset.id), r.link);
      // Keep the approved card in view, link and all, whatever the filter shows.
      b.closest('.admin-card').outerHTML = card({ ...(await api('/api/early-access?state=approved')).requests.find((x) => x.id === Number(b.dataset.id)) });
      return;
    }
    load();
  } catch (err) { showError(err.message); b.disabled = false; }
});
main();
