// The early-access link: sign in with GitHub or Google, then name your organization. The grant in the
// link is kept in this browser across the sign-in round trip, and used once, when the organization is made.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const KEY = 'nuworq-grant';
const fromLink = new URLSearchParams(location.search).get('grant');
if (fromLink) { localStorage.setItem(KEY, fromLink); history.replaceState(null, '', '/'); }
const grant = localStorage.getItem(KEY);
const step = $('#step');

async function main() {
  const me = await fetch('/api/me').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!me) {
    const { providers = [] } = await fetch('/api/oauth').then((r) => r.json()).catch(() => ({}));
    step.innerHTML = `<p class="lead">${grant ? "You're in. Sign in, then name your organization." : 'Sign in to see your organizations.'}</p>
      ${providers.map((p) => `<a class="btn primary" href="${esc(p.start)}">Sign in with ${esc(p.label ?? p.name)}</a>`).join(' ') || '<p class="faint">This hub has no sign-in set up.</p>'}`;
    return;
  }
  if (me.orgs?.length && !grant) {
    step.innerHTML = `<p class="lead">Your organizations:</p>${me.orgs.map((o) => `<p><a href="${esc(o.enter)}">${esc(o.workspace)}</a> <span class="faint">${esc(o.role)}</span></p>`).join('')}`;
    return;
  }
  step.innerHTML = `<p class="lead">Signed in as ${esc(me.email)}. Name your organization: it becomes its address.</p>
    <div class="inline-form"><input id="name" placeholder="e.g. acme"><button class="btn primary" id="make">Create</button></div><p id="err" class="faint"></p>`;
  $('#make').addEventListener('click', async () => {
    const r = await fetch('/api/orgs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: $('#name').value.trim(), grant }) });
    const j = await r.json();
    if (!r.ok) { $('#err').textContent = j.error + (j.hint ? ` — ${j.hint}` : ''); return; }
    localStorage.removeItem(KEY);
    location.href = j.enter;
  });
}
main();
