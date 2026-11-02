// The early-access link: sign in with GitHub or Google, then name your workspace. The grant in the
// link is kept in this browser across the sign-in round trip, and used once, when the workspace is made.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const KEY = 'nuworq-grant';
const fromLink = new URLSearchParams(location.search).get('grant');
if (fromLink) { localStorage.setItem(KEY, fromLink); history.replaceState(null, '', '/'); }
const grant = localStorage.getItem(KEY);
const step = $('#step');
// Into a workspace (#630): ?enter=<workspace>, from the switcher or a sign-in that needs your yes. Kept across
// signing in to the hub, so the page comes back to it.
const ENTER = 'nuworq-enter';
const asked = new URLSearchParams(location.search).get('enter');
if (asked) sessionStorage.setItem(ENTER, asked);

// A link from before this hub had workspaces (#/p/<slug>/<n>): its project lives in the root workspace now (#204).
if (location.hash.startsWith('#/p/')) {
  const { address } = await fetch('/api/root').then((r) => r.json()).catch(() => ({}));
  if (address) location.replace(`${address}/${location.hash}`);
}

async function main() {
  const me = await fetch('/api/me').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!me) {
    const { providers = [] } = await fetch('/api/oauth').then((r) => r.json()).catch(() => ({}));
    step.innerHTML = `<p class="lead">${grant ? "You're in. Sign in, then name your workspace." : 'Sign in to see your workspaces.'}</p>
      ${providers.map((p) => `<a class="btn primary" href="${esc(p.start)}">Sign in with ${esc(p.label ?? p.name)}</a>`).join(' ') || '<p class="faint">This hub has no sign-in set up.</p>'}`;
    return;
  }
  const into = sessionStorage.getItem(ENTER);
  if (into) {
    sessionStorage.removeItem(ENTER);
    return enter(into);
  }
  const fresh = new URLSearchParams(location.search).has('new');
  if (me.orgs?.length && !grant && !fresh) {
    step.innerHTML = `<p class="lead">Your workspaces:</p>${me.orgs.map((o) => `<p><a href="${esc(o.enter)}">${esc(o.workspace)}</a> <span class="faint">${esc(o.role)}</span></p>`).join('')}
      <p><a class="btn" href="/?new">New workspace</a></p>`;
    return;
  }
  createOrg(me);
}

// A member goes straight in. Someone invited (or added by an owner) sees the offer, and joins only on their yes.
async function enter(ws, confirm = false) {
  const r = await fetch(`/api/orgs/${encodeURIComponent(ws)}/enter`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm }) }).catch(() => null);
  const j = await r?.json().catch(() => null);
  if (j?.go) { location.href = j.go; return; }
  history.replaceState(null, '', '/');
  if (!j?.pending) {
    step.innerHTML = `<p class="lead">${esc(j?.error ?? 'The hub did not answer')}.</p>${j?.hint ? `<p class="faint">${esc(j.hint)}</p>` : ''}<p><a class="btn" href="/">Your workspaces</a></p>`;
    return;
  }
  const p = j.pending;
  step.innerHTML = `<p class="lead">Join <b>${esc(p.workspace)}</b> as ${esc(p.role)}${p.invited_by ? `, invited by ${esc(p.invited_by)}` : ''}?</p>
    <p class="faint">You were invited with this email. You're added only if you join.</p>
    <p><button class="btn primary" id="join">Join ${esc(p.workspace)}</button> <a class="btn" href="/">Not now</a></p>`;
  $('#join').addEventListener('click', () => { $('#join').disabled = true; enter(ws, true); });
}

// Step 1 of 3: a name, and the address it becomes (suggested from the name, editable), checked as you type.
// Step 2 (the first project) and step 3 (connect a machine) happen inside the new workspace (web/app.js).
function createOrg(me) {
  step.innerHTML = `<p class="faint">Step 1 of 3 · then your first project, then connect a machine</p>
    <p class="lead">Signed in as ${esc(me.email)}. Name your workspace.</p>
    <div class="form"><label>Name<input id="name" placeholder="e.g. Acme" autocomplete="off"></label>
    <label>Address<input id="slug" placeholder="acme" autocapitalize="off" spellcheck="false"></label></div>
    <p id="check" class="faint" aria-live="polite">The address is suggested from the name.</p>
    <p><button class="btn primary" id="make" disabled>Create workspace</button></p>`;
  let edited = false, timer, asked = 0, ok = false;
  const check = async () => {
    const name = $('#name').value.trim(), slug = $('#slug').value.trim();
    const n = ++asked;
    if (!name && !slug) { ok = false; $('#make').disabled = true; $('#check').className = 'faint'; $('#check').textContent = 'The address is suggested from the name.'; return; }
    const q = edited ? `slug=${encodeURIComponent(slug)}` : `name=${encodeURIComponent(name)}`;
    const r = await fetch(`/api/orgs/check?${q}`).catch(() => null);
    const j = await r?.json().catch(() => null);
    if (n !== asked) return; // a newer keystroke has its own answer coming
    ok = !!r?.ok;
    // The address the name suggests: the hub's when it answered with one, else the same rule here (src/core.js slugify).
    if (!edited) $('#slug').value = j?.slug ?? name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    $('#check').className = ok ? 'ok' : 'bad';
    $('#check').textContent = ok ? `✓ ${j.address.replace(/^https?:\/\//, '')} is free` : `${j?.error ?? 'The hub did not answer'}${j?.hint ? `. ${j.hint}` : ''}`;
    $('#make').disabled = !ok || !name;
  };
  const soon = () => { clearTimeout(timer); $('#make').disabled = true; timer = setTimeout(check, 200); };
  $('#name').addEventListener('input', () => { if (!edited) $('#slug').value = ''; soon(); });
  $('#slug').addEventListener('input', () => { edited = $('#slug').value.trim() !== ''; soon(); });
  $('#make').addEventListener('click', async () => {
    if (!ok) return;
    $('#make').disabled = true;
    const r = await fetch('/api/orgs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: $('#name').value.trim(), slug: $('#slug').value.trim(), grant }) });
    const j = await r.json();
    if (!r.ok) { $('#check').className = 'bad'; $('#check').textContent = j.error + (j.hint ? `. ${j.hint}` : ''); $('#make').disabled = false; return; }
    localStorage.removeItem(KEY);
    location.href = j.enter;
  });
  setTimeout(() => $('#name').focus(), 0);
}
main();
