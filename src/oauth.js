// Sign in with GitHub or Google, with fetch and node:crypto only. Authorization-code flow with a signed,
// short-lived state and PKCE; then the provider's own API, called with the access token, says who it is
// (GitHub: /user/emails, primary and verified; Google: /userinfo, email_verified), so no JWT is checked here.
//
// The flow is hub-wide, so one provider app serves every workspace: /auth/<provider>/start?ws=<slug> and
// /auth/<provider>/callback, with the workspace riding in the state. The callback can't set a cookie on a
// workspace's own address (acme.example.com), so it hands over a one-time ticket that the workspace's
// /api/oauth/finish trades for its session cookie. A ticket is bound to its workspace.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { envVar } from './names.js';

export const PROVIDERS = {
  github: {
    label: 'GitHub',
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    api: 'https://api.github.com',
    scope: 'read:user user:email',
  },
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    api: 'https://openidconnect.googleapis.com',
    scope: 'openid email',
  },
};
const FLOW_MS = 10 * 60_000;
const TICKET_MS = 2 * 60_000;
export const FLOW_COOKIE = 'nuworq_oauth';

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Which providers this hub offers: NUWORQ_GITHUB_CLIENT_ID/_SECRET, NUWORQ_GOOGLE_CLIENT_ID/_SECRET
// (or TRELLIS_…). Endpoints can be overridden (tests point them at a local stub).
export function oauthFromEnv(env = process.env) {
  const out = {};
  for (const name of Object.keys(PROVIDERS)) {
    const id = envVar(`${name.toUpperCase()}_CLIENT_ID`, env), secret = envVar(`${name.toUpperCase()}_CLIENT_SECRET`, env);
    if (id && secret) out[name] = { id, secret };
  }
  return out;
}

export class OAuth {
  // config: { github: { id, secret, authorize?, token?, api? }, google: {…} }. now: for tests.
  constructor(config = {}, { now = () => Date.now(), secret = randomBytes(32) } = {}) {
    this.providers = {};
    for (const [name, c] of Object.entries(config ?? {})) {
      if (PROVIDERS[name] && c?.id && c?.secret) this.providers[name] = { ...PROVIDERS[name], ...c };
    }
    this.now = now;
    this.key = secret;
    this.flows = new Map(); // nonce → { provider, ws, verifier, back, exp }
    this.tickets = new Map(); // ticket → { ws, sid, exp }
  }

  get enabled() { return Object.keys(this.providers).length > 0; }
  list() { return Object.entries(this.providers).map(([name, p]) => ({ name, label: p.label })); }

  sign(s) { return b64(createHmac('sha256', this.key).update(s).digest()); }
  sweep() {
    const t = this.now();
    for (const m of [this.flows, this.tickets]) for (const [k, v] of m) if (v.exp < t) m.delete(k);
  }

  // Begin: remember the PKCE verifier server-side, and send the browser to the provider.
  // ws: the workspace slug ('' for a single hub). back: where the workspace lives (origin + base path).
  // device: a device-login code to come back to after signing in (#153), already checked by the caller.
  start(provider, { ws = '', back, callback, device = '' }) {
    const p = this.providers[provider];
    if (!p) return null;
    this.sweep();
    const nonce = b64(randomBytes(24));
    const verifier = b64(randomBytes(32));
    const exp = this.now() + FLOW_MS;
    this.flows.set(nonce, { provider, ws, verifier, back, callback, exp, device });
    const body = `${nonce}.${exp}.${ws}`;
    const state = `${body}.${this.sign(body)}`;
    const u = new URL(p.authorize);
    u.search = new URLSearchParams({
      client_id: p.id, redirect_uri: callback, response_type: 'code', scope: p.scope, state,
      code_challenge: b64(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
      ...(provider === 'google' ? { prompt: 'select_account' } : { allow_signup: 'false' }),
    }).toString();
    return { url: u.toString(), nonce };
  }

  // The state must be ours (signature), fresh, unused, and come back to the browser that started it (cookie).
  // Returns the flow, used up, or throws with what went wrong.
  claim(provider, state, cookieNonce) {
    const parts = String(state ?? '').split('.');
    if (parts.length < 4) throw new Error('the sign-in state is missing');
    const [nonce, exp] = parts, sig = parts.at(-1), ws = parts.slice(2, -1).join('.'); // a slug may hold dots
    if (!same(sig, this.sign(`${nonce}.${exp}.${ws}`))) throw new Error("the sign-in state doesn't match");
    if (Number(exp) < this.now()) throw new Error('the sign-in took too long');
    const flow = this.flows.get(nonce);
    this.flows.delete(nonce);
    if (!flow || flow.provider !== provider || flow.ws !== ws) throw new Error('the sign-in was already used or never started here');
    if (!cookieNonce || !same(cookieNonce, nonce)) throw new Error('the sign-in was started in another browser');
    return flow;
  }

  // Trade the code for an access token (with the PKCE verifier), then ask the provider for a verified email.
  async email(provider, code, flow) {
    const p = this.providers[provider];
    const r = await fetch(p.token, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: p.id, client_secret: p.secret, code: String(code ?? ''), redirect_uri: flow.callback, grant_type: 'authorization_code', code_verifier: flow.verifier }),
      signal: AbortSignal.timeout(10_000),
    });
    const tok = await r.json().catch(() => ({}));
    if (!r.ok || !tok.access_token) throw new Error(`${p.label} refused the sign-in${tok.error ? ` (${tok.error})` : ''}`);
    const get = async (path) => {
      const res = await fetch(`${p.api}${path}`, { headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/json', 'user-agent': 'nuworq' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`${p.label} didn't say who you are (${res.status})`);
      return res.json();
    };
    if (provider === 'github') {
      const emails = await get('/user/emails');
      const e = Array.isArray(emails) ? emails.find((x) => x.primary && x.verified) : null;
      return e?.email ? String(e.email).toLowerCase() : null;
    }
    const me = await get('/v1/userinfo');
    return me.email && (me.email_verified === true || me.email_verified === 'true') ? String(me.email).toLowerCase() : null;
  }

  ticket(ws, sid) {
    const t = b64(randomBytes(24));
    this.tickets.set(t, { ws, sid, exp: this.now() + TICKET_MS });
    return t;
  }

  // A ticket works once, only in the workspace it was made for.
  redeem(ticket, ws) {
    const t = this.tickets.get(String(ticket ?? ''));
    this.tickets.delete(String(ticket ?? ''));
    return t && t.ws === ws && t.exp >= this.now() ? t.sid : null;
  }
}
