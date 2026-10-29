const form = document.getElementById('login');
const input = document.getElementById('token');
const error = document.getElementById('error');
const go = document.getElementById('go');

const show = (msg) => { error.textContent = msg; error.hidden = !msg; };

// A sign-in with GitHub or Google that didn't work comes back here as #error=<why>.
const back = new URLSearchParams(location.hash.slice(1)).get('error');
if (back) { show(back.endsWith('.') ? back : `${back}.`); history.replaceState(null, '', location.pathname); }

// The providers this hub offers, if any, above the token box.
fetch('api/oauth').then((r) => r.json()).then(({ providers = [] }) => {
  if (!providers.length) return;
  const box = document.getElementById('providers');
  for (const p of providers) {
    const a = document.createElement('a');
    a.className = 'btn';
    a.href = p.start;
    a.textContent = `Sign in with ${p.label}`;
    box.append(a);
  }
  box.hidden = false;
  document.getElementById('lead').textContent = 'This nuworq hub is private. Sign in, or paste your human token.';
}).catch(() => {});

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
