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
  if (!ok) {
    // A used or expired link (#155): say so in a sentence, and offer the way on.
    const why = [j.error || "This invite link can't be used", j.hint].filter(Boolean).join('. ');
    lead.textContent = `${why[0].toUpperCase()}${why.slice(1)}${/[.!?]$/.test(why) ? '' : '.'} Already have an account? Sign in.`;
    const signIn = document.createElement('a');
    signIn.className = 'btn primary';
    signIn.href = 'login.html';
    signIn.textContent = 'Sign in';
    lead.after(signIn);
    return;
  }
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
