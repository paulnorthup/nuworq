const form = document.getElementById('login');
const input = document.getElementById('token');
const error = document.getElementById('error');
const go = document.getElementById('go');

const show = (msg) => { error.textContent = msg; error.hidden = !msg; };

// Already logged in (or the hub needs no login)? Go straight to the app.
// Paths are relative so login also works under a workspace path prefix (/w/<slug>/).
fetch('api/me').then((r) => r.json()).then((me) => {
  if (me.auth === 'local' || me.role === 'human') location.replace('./');
}).catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  show('');
  go.disabled = true;
  try {
    const r = await fetch('api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: input.value.trim() }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return location.replace('./');
    if (r.status === 429) show('Too many failed attempts. Wait 10 minutes, then try again.');
    else show([j.error || 'Login failed', j.hint].filter(Boolean).join('. '));
  } catch {
    show("Can't reach the hub.");
  } finally {
    go.disabled = false;
  }
});
input.focus();
