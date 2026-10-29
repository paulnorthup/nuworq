// The early-access request form: Turnstile's widget (its site key comes from the hub) and one POST.
const $ = (s) => document.querySelector(s);
let token = '';

// Replace the form with a message, keeping the card's brand.
const say = (title, line) => { $('#ask').innerHTML = `${$('#ask .brand').outerHTML}<h1>${title}</h1><p class="lead thanks">${line}</p>`; };

const { sitekey, open } = await fetch('/api/early-access/config').then((r) => r.json()).catch(() => ({}));
if (!open) {
  say('Request early access', 'This hub isn\'t taking requests right now.');
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
  said.className = 'hint';
  said.textContent = 'Sending…';
  const r = await fetch('/api/early-access', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: $('#email').value.trim(), github: $('#github').value.trim(), building: $('#building').value.trim(), turnstile: token }),
  }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : { error: "couldn't reach nuworq" };
  if (r?.ok) {
    say('Thanks, we\'ll be in touch', `We have your request${j.created ? '' : ' (updated)'}, and we'll write to the address you gave.`);
    return;
  }
  said.className = 'login-error';
  const error = j.error ?? 'something went wrong';
  said.textContent = `${error[0].toUpperCase()}${error.slice(1)}.${j.hint ? ` ${j.hint}` : ''}`;
  window.turnstile?.reset();
  token = '';
});
