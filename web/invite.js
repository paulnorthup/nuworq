// The invite link carries its token after "#", so it never reaches server logs or the Referer header.
const token = location.hash.slice(1);
const form = document.getElementById('join');
const lead = document.getElementById('lead');
const handle = document.getElementById('handle');
const error = document.getElementById('error');
const go = document.getElementById('go');

const show = (msg) => { error.textContent = msg; error.hidden = !msg; };
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ ok: r.ok, j: await r.json().catch(() => ({})) }));

post('api/invite/peek', { token }).then(({ ok, j }) => {
  if (!ok) { lead.textContent = [j.error, j.hint].filter(Boolean).join('. '); return; }
  lead.textContent = `You're invited to join as ${j.role}${j.invited_by ? `, by ${j.invited_by}` : ''}. Pick the handle you'll appear as.`;
  handle.hidden = go.hidden = false;
  if (j.email) handle.value = j.email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '');
  handle.focus();
}).catch(() => { lead.textContent = "Can't reach the hub."; });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  show('');
  go.disabled = true;
  try {
    const { ok, j } = await post('api/invite/accept', { token, handle: handle.value.trim().toLowerCase() });
    if (ok) return location.replace('./');
    show([j.error, j.hint].filter(Boolean).join('. '));
  } catch {
    show("Can't reach the hub.");
  } finally {
    go.disabled = false;
  }
});
