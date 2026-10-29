// The early-access request form: Turnstile's widget (its site key comes from the hub) and one POST.
const $ = (s) => document.querySelector(s);
let token = '';

const { sitekey, open } = await fetch('/api/early-access/config').then((r) => r.json()).catch(() => ({}));
if (!open) {
  $('#ask').innerHTML = '<p class="lead">This hub isn\'t taking requests right now.</p>';
} else if (sitekey) {
  window.onTurnstile = () => window.turnstile.render('#check', { sitekey, callback: (t) => { token = t; } });
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstile';
  s.async = true;
  document.head.append(s);
}

$('#ask')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const said = $('#said');
  said.textContent = 'Sending…';
  const r = await fetch('/api/early-access', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: $('#email').value.trim(), github: $('#github').value.trim(), building: $('#building').value.trim(), turnstile: token }),
  }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : { error: "couldn't reach nuworq" };
  if (r?.ok) {
    $('#ask').innerHTML = `<p class="lead">Thanks: we have your request${j.created ? '' : ' (updated)'}. We'll be in touch at the address you gave.</p>`;
    return;
  }
  said.textContent = `${j.error ?? 'Something went wrong'}${j.hint ? ` — ${j.hint}` : ''}`;
  window.turnstile?.reset();
  token = '';
});
