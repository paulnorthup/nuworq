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
