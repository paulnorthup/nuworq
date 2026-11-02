// A CLI asked to connect this machine: check the code, show which machine it is, and let the person approve it.
const form = document.getElementById('device');
const lead = document.getElementById('lead');
const code = document.getElementById('code');
const error = document.getElementById('error');
const go = document.getElementById('go');
const deny = document.getElementById('deny');
let checked = null; // the code whose machine is on screen, waiting for confirmation
let staff = null; // what a staffing request asks for, when it is one

const show = (msg) => { error.textContent = msg; error.hidden = !msg; };
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) }));
// What a machine approved by this role can do: never more than the person may themselves (#629).
const canDo = (role) => (role === 'member'
  ? 'As a member, its agents can check in, look, propose work and comment, but not claim, build, review or push: a steward or owner connects machines that do.'
  : role === 'viewer' ? 'A viewer can\'t connect machines.'
  : 'Its agents will work here: claim, build, review and push.');
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
  staff = j.staff ?? null;
  // A staffing request (#490): the machine is connected already, and asks to start workers on one project.
  lead.textContent = staff
    ? `"${j.machine}" asks to staff ${staff.name ?? staff.project} with its workers, spending up to $${staff.budget} a day. Approving turns on staffing for ${staff.name ?? staff.project} with that daily budget. Only approve it if you just asked for this on that machine.`
    : `"${j.machine}" asks for an agent token in your name. ${canDo(j.role)} You answer for them. Only approve it if you just started this on that machine.`;
  go.textContent = staff ? `Staff ${staff.name ?? staff.project}` : `Approve ${j.machine}`;
  deny.hidden = false;
}

async function decide(approve) {
  go.disabled = deny.disabled = true;
  try {
    const { ok, j } = await post('api/device/approve', { user_code: checked, approve });
    if (!ok) return show([j.error, j.hint].filter(Boolean).join('. '));
    if (staff) done(approve ? `Approved. ${staff.name ?? staff.project} is staffed, up to $${staff.budget} a day; ${j.machine} installs its runner now. You can close this page.` : `Denied. ${staff.name ?? staff.project} isn't staffed.`);
    else done(approve ? `Approved. ${j.machine} is connected as ${j.token_name}; you can close this page.` : `Denied. ${j.machine} gets no token.`);
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
