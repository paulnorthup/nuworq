// A CLI asked to connect this machine: check the code, show which machine it is, and let the person approve it.
const form = document.getElementById('device');
const lead = document.getElementById('lead');
const code = document.getElementById('code');
const error = document.getElementById('error');
const go = document.getElementById('go');
const deny = document.getElementById('deny');
let checked = null; // the code whose machine is on screen, waiting for confirmation

const show = (msg) => { error.textContent = msg; error.hidden = !msg; };
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) }));
const done = (msg) => { lead.textContent = msg; code.hidden = go.hidden = deny.hidden = true; };

async function check() {
  show('');
  const { ok, status, j } = await post('api/device/peek', { user_code: code.value });
  if (status === 401) {
    // Signing in brings you back here with the same code (#153); until then there's nothing to continue.
    const back = /^[A-Z]{4}-[A-Z]{4}$/i.test(code.value.trim()) ? `?device=${encodeURIComponent(code.value.trim().toUpperCase())}` : '';
    lead.innerHTML = `To approve this machine, sign in first. You'll come back here with the code. <a href="login.html${back}">Sign in</a>`;
    go.hidden = true;
    return;
  }
  if (!ok) return show([j.error, j.hint].filter(Boolean).join('. '));
  checked = code.value;
  code.readOnly = true;
  lead.textContent = `"${j.machine}" asks for an agent token in your name. Its agents will work here, and you answer for them. Only approve it if you just started this on that machine.`;
  go.textContent = `Approve ${j.machine}`;
  deny.hidden = false;
}

async function decide(approve) {
  go.disabled = deny.disabled = true;
  try {
    const { ok, j } = await post('api/device/approve', { user_code: checked, approve });
    if (!ok) return show([j.error, j.hint].filter(Boolean).join('. '));
    done(approve ? `Approved. ${j.machine} is connected as ${j.token_name}; you can close this page.` : `Denied. ${j.machine} gets no token.`);
  } catch {
    show("Can't reach the hub.");
  } finally {
    go.disabled = deny.disabled = false;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  (checked ? decide(true) : check()).catch(() => show("Can't reach the hub."));
});
deny.addEventListener('click', () => decide(false));

code.value = new URLSearchParams(location.search).get('code') ?? '';
if (code.value) check().catch(() => show("Can't reach the hub.")); else code.focus();
