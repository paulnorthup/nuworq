// The admin host's dashboard, for the hub's owners: sign in here, then decide early-access requests.
// New requests first; Approve and Decline each ask first; an approval's link (shown once) has a Copy button.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const STATES = [['new', 'New'], ['approved', 'Approved'], ['declined', 'Declined'], ['', 'All']];
let state = 'new';
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
  $('#view').innerHTML = `<h2>Early access</h2>
    <p class="lead">Approve gives you a link to send: it lets them make one workspace, once, within 14 days.</p>
    <div class="seg admin-filter" role="group" aria-label="Show">${STATES.map(([v, label]) => `<button data-state="${v}" aria-pressed="${v === state}" class="${v === state ? 'on' : ''}">${label}</button>`).join('')}</div>
    <div id="list" aria-live="polite"><p class="faint">Loading…</p></div>`;
  load();
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
    list.innerHTML = requests.length ? requests.map(card).join('') : `<p class="faint">${state === 'new' ? 'No new requests.' : 'Nothing here.'}</p>`;
  } catch (e) { list.innerHTML = `<p class="warn">${esc(e.message)}</p>`; }
}

function card(r) {
  const link = links.get(r.id);
  return `<article class="admin-card" data-email="${esc(r.email)}">
    <div class="h">${esc(r.email)}${r.github ? ` · <a href="https://github.com/${esc(r.github)}" target="_blank" rel="noopener">@${esc(r.github)}</a>` : ''}</div>
    <p class="s">${esc(r.building) || '<span class="faint">No note.</span>'}</p>
    <p class="faint">Asked ${esc(ago(r.updated_at))}${r.decided_at ? ` · ${esc(r.state)} by ${esc(r.decided_by)} ${esc(ago(r.decided_at))}` : ''}</p>
    ${link ? `<div class="admin-link"><p class="ok">Approved. Send them this link (it's shown only now):</p><code>${esc(link)}</code>
      <button class="btn primary" data-copy="${esc(link)}">Copy link</button></div>` : ''}
    ${r.state === 'new' ? `<div class="admin-acts"><button class="btn primary" data-id="${r.id}" data-approve="1">Approve</button><button class="btn" data-id="${r.id}">Decline</button></div>` : ''}
  </article>`;
}

document.addEventListener('click', async (e) => {
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
