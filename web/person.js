// The person's credential on a hub without logins (#908). localStorage, sent as a header, because both stop at this
// origin: a cookie would also go to anything a worker serves on another loopback port.
import { store } from './prefs.js';

const HEADER = 'x-nuworq-person';
export const personHeaders = () => { const c = store.get('person', ''); return c ? { [HEADER]: c } : {}; };

// The address serve printed lands here with the credential in the fragment. It leaves the address bar first, and is
// kept only if the hub takes it: a link from anywhere else could carry junk, and must not sign this browser out.
export async function signInFromAddress() {
  const sent = location.hash.match(/^#person=([0-9a-f]{64})$/)?.[1];
  if (!sent) return;
  history.replaceState(null, '', `${location.pathname}${location.search}#/`);
  const me = await fetch('api/me', { headers: { [HEADER]: sent } }).then((r) => r.json()).catch(() => null);
  if (me?.role === 'human') store.set('person', sent);
}

// A hub that really stopped no longer takes what this browser holds (#920): the page still reads, so say why nothing
// it does will work, and where to fix that. me: /api/me's answer, null when the hub didn't give one.
export function noteSignIn(me) {
  if (!me) return;
  const lost = me.auth === 'local' && me.role !== 'human' && !!store.get('person', '');
  let bar = document.getElementById('signed-out');
  if (!lost) return void bar?.remove();
  if (bar) return;
  bar = document.createElement('div');
  bar.id = 'signed-out';
  bar.setAttribute('role', 'status');
  bar.textContent = 'This hub restarted, so this browser can only look. To act, open the address nuworq serve printed in its terminal.';
  document.body.prepend(bar);
}
