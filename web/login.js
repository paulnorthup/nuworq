const form = document.getElementById('login');
const input = document.getElementById('token');
const error = document.getElementById('error');
const go = document.getElementById('go');

const show = (msg) => { error.textContent = msg; error.hidden = !msg; };

// Sent here to approve a machine (device.html, #153): after signing in, go back there with the same code.
const device = new URLSearchParams(location.search).get('device');
const code = /^[A-Z]{4}-[A-Z]{4}$/i.test(device ?? '') ? device.toUpperCase() : '';
const next = code ? `device.html?code=${code}` : './';

// A sign-in with GitHub or Google that didn't work comes back here as #error=<why>.
const back = new URLSearchParams(location.hash.slice(1)).get('error');
if (back) { show(back.endsWith('.') ? back : `${back}.`); history.replaceState(null, '', location.pathname + location.search); }

// The providers this hub offers, if any, above the token box.
// An organization on a shared hub (#155) names itself and leads with sign-in: its people have no access to the
// hub's host, so the token path is tucked away behind a link, and nothing grabs focus over the sign-in buttons.
fetch('api/oauth').then((r) => r.json()).then(({ providers = [], organization = null }) => {
  if (organization && providers.length) {
    document.getElementById('lead').textContent = `Sign in to ${organization}.`;
    document.querySelector('.hint').hidden = true;
    for (const el of [input, go]) el.hidden = true;
    const reveal = document.createElement('button');
    reveal.type = 'button';
    reveal.className = 'link';
    reveal.textContent = 'Have a token? Paste it';
    reveal.addEventListener('click', () => { for (const el of [input, go]) el.hidden = false; reveal.remove(); input.focus(); });
    go.after(reveal);
  } else input.focus();
  if (!providers.length) return;
  const box = document.getElementById('providers');
  for (const p of providers) {
    const a = document.createElement('a');
    a.className = organization ? 'btn primary' : 'btn';
    a.href = code ? `${p.start}${p.start.includes('?') ? '&' : '?'}device=${code}` : p.start;
    a.textContent = `Sign in with ${p.label}`;
    box.append(a);
  }
  box.hidden = false;
  if (!organization) document.getElementById('lead').textContent = 'This nuworq hub is private. Sign in, or paste your human token.';
}).catch(() => input.focus());

// Already logged in (or the hub needs no login)? Go straight to the app.
// Paths are relative so login also works under a workspace path prefix (/w/<slug>/).
fetch('api/me').then((r) => r.json()).then((me) => {
  if (me.auth === 'local' || me.role === 'human') location.replace(next);
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
    if (r.ok) return location.replace(next);
    if (r.status === 429) show('Too many failed attempts. Wait 10 minutes, then try again.');
    else show([j.error || 'Login failed', j.hint].filter(Boolean).join('. '));
  } catch {
    show("Can't reach the hub.");
  } finally {
    go.disabled = false;
  }
});
