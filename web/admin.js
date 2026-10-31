// The admin host's dashboard, for the hub's owners: sign in here, then decide early-access requests.
// New requests first; Approve and Decline each ask first; an approval's link (shown once) has a Copy button.
// Then the workspaces (#169): one row each, most recently active first; tap a row for who and what is in it,
// and to switch its plan between Free and Unlimited (that asks first too, saying what changes).
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
    <div id="list" aria-live="polite"><p class="faint">Loading…</p></div>
    <h2 class="admin-h2">Workspaces</h2>
    <div id="spaces" aria-live="polite"><p class="faint">Loading…</p></div>`;
  load();
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
    <div class="h">${esc(r.email)}${r.github ? ` · <a href="https://github.com/${esc(r.github)}" target="_blank" rel="noopener">@${esc(r.github)}</a>` : ''}</div>
    <p class="s">${esc(r.building) || '<span class="faint">No note.</span>'}</p>
    <p class="faint">Asked ${esc(ago(r.updated_at))}${r.decided_at ? ` · ${esc(r.state)} by ${esc(r.decided_by)} ${esc(ago(r.decided_at))}` : ''}</p>
    ${link ? `<div class="admin-link"><p class="ok">Approved. Send them this link (it's shown only now):</p><code>${esc(link)}</code>
      <button class="btn primary" data-copy="${esc(link)}">Copy link</button></div>` : ''}
    ${r.state === 'new' ? `<div class="admin-acts"><button class="btn primary" data-id="${r.id}" data-approve="1">Approve</button><button class="btn" data-id="${r.id}">Decline</button></div>` : ''}
  </article>`;
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
