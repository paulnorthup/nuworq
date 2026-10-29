import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError, HUMAN_OP_NAMES, HUMAN, PERSON_CAN, normRemote, slugify } from './core.js';
import { view, itemView, projectList } from './insight.js';
import { tools, guide } from './protocol.js';
import { Auth, SESSION_MS } from './auth.js';
import { Devices } from './device.js';
import { Workspaces } from './workspaces.js';
import { KINDS, addChannel, listChannels, removeChannel, testChannels } from './notify.js';
import { receive } from './github.js';
import { OAuth, FLOW_COOKIE } from './oauth.js';
import { ORG_CAP } from './directory.js';
import { GitHubApp } from './ghapp.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8' };
const MAX_BODY = 1024 * 1024;

// What is running: package.json's version and the commit of this code's own folder (under --follow, the
// hub-src worktree; the hub restarts on every move, so reading it once per process stays true).
const ROOT = join(WEB, '..');
let build = null;
export function buildInfo() {
  if (build) return build;
  const git = (...args) => {
    try { return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
  };
  let version = null;
  try { version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? null; } catch {}
  const sha = git('rev-parse', 'HEAD');
  const remote = normRemote(git('remote', 'get-url', 'origin') ?? '');
  return (build = {
    version,
    commit: sha?.slice(0, 7) ?? null,
    commit_url: sha && remote.startsWith('github.com/') ? `https://${remote}/commit/${sha}` : null,
  });
}
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const COOKIE = 'nuworq_session';
const OLD_COOKIE = 'trellis_session'; // still read, so logins from before the rename stay signed in
const HUB_COOKIE = 'nuworq_id'; // signed in to the hub itself (workspaces mode): who you are, not any one workspace
const LOGIN_WINDOW = 10 * 60_000, LOGIN_MAX_FAILS = 10;
const DEVICE_MAX_STARTS = 10; // device logins started per IP per LOGIN_WINDOW
// What an agent-role token may reach in required mode.
const AGENT_ROUTES = [/^POST \/api\/p\/[^/]+\/agent\/[a-z]+$/, /^POST \/api\/agent\/[a-z]+$/, /^GET \/api\/(tools|guide|info|me|route|where|projects)$/, /^GET \/agents\.md$/];
const LOOPBACK = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

// auth: 'local' (no login; loopback only) or 'required' (tokens + sessions).
// target: one Hub (today's single hub), or a Workspaces registry: then each request is resolved to a
// workspace by subdomain of baseDomain or a /w/<slug>/ path prefix, and login is always required.
// oauth: providers people may sign in with ({ github: { id, secret }, google: … }; see src/oauth.js).
// orgCap: how many organizations one signed-in person may create (workspaces mode).
// githubApp: the GitHub App that mints one-repo, one-hour tokens for workers ({ id, key, slug } or a GitHubApp; see src/ghapp.js).
export function createServer(target, { auth = 'local', trustProxy = false, baseDomain = '', sweepMs = 15_000, publicUrl = '', oauth = {}, orgCap = ORG_CAP, githubApp = null } = {}) {
  const spaces = target instanceof Workspaces ? target : null;
  const app = githubApp && !(githubApp instanceof GitHubApp) ? new GitHubApp(githubApp) : githubApp;
  // The hub's own address names no workspace: the base domain, or the public URL's host (e.g. auth.<base-domain>).
  const rootHost = publicUrl ? hostname(new URL(publicUrl).host) : '';
  const required = spaces ? true : auth === 'required';
  const sso = oauth instanceof OAuth ? oauth : new OAuth(oauth);
  const failures = new Map(); // ip → [timestamps of failed logins]
  const starts = new Map(); // ip → [timestamps of device logins started]
  // Per hub: its tokens and sessions, and the browsers streaming its changes. Nothing is shared across hubs.
  const scopes = new Map();
  const scopeOf = (hub) => {
    let s = scopes.get(hub);
    if (!s) {
      const authz = new Auth(hub.db);
      s = { authz, devices: new Devices(authz), clients: new Set() };
      hub.on('change', (e) => {
        const msg = `data: ${JSON.stringify(e)}\n\n`;
        for (const res of s.clients) res.write(msg);
      });
      hub.once('closed', () => { for (const res of s.clients) res.end(); scopes.delete(hub); });
      scopes.set(hub, s);
    }
    return s;
  };
  const hubs = () => (spaces ? spaces.hubs() : [target]);
  const sweeper = setInterval(() => {
    for (const hub of hubs()) { try { hub.sweep(); } catch (e) { console.error('sweep failed', e); } }
  }, sweepMs);
  const keepalive = setInterval(() => { for (const s of scopes.values()) for (const res of s.clients) res.write(': ping\n\n'); }, 25_000);

  const first = (v) => String(v ?? '').split(',')[0].trim();
  const clientIp = (req) => (trustProxy && first(req.headers['x-forwarded-for'])) || req.socket.remoteAddress || '?';
  const hostOf = (req) => (trustProxy && first(req.headers['x-forwarded-host'])) || req.headers.host || '';
  const https = (req) => req.socket.encrypted || (trustProxy && first(req.headers['x-forwarded-proto']) === 'https');
  const origin = (req) => `${https(req) ? 'https' : 'http'}://${hostOf(req)}`;
  const jarOf = (req) => {
    const jar = new Map();
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (!jar.has(k)) jar.set(k, v.join('='));
    }
    return jar;
  };
  const cookieOf = (req) => { const jar = jarOf(req); return jar.get(COOKIE) ?? jar.get(OLD_COOKIE) ?? null; };
  const sessionCookie = (req, sid, path) => `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=${SESSION_MS / 1000}${https(req) ? '; Secure' : ''}`;
  // Where sign-in with GitHub or Google starts and returns: the hub's public address, the same for every workspace.
  const authOrigin = (req) => publicUrl || origin(req);
  // Where a workspace lives, as the browser should reach it after signing in.
  const homeOf = (req, ws) => {
    if (!spaces) return authOrigin(req);
    if (baseDomain) return `${new URL(authOrigin(req)).protocol}//${ws}.${baseDomain}`;
    return `${authOrigin(req)}/w/${encodeURIComponent(ws)}`;
  };
  const joined = (hub, person, role, invitedBy) => {
    const who = `@${person.handle}`;
    for (const p of hub.projects()) {
      hub.event(p, { actor: who, type: 'joined', headline: `${who} joined as ${role}${invitedBy ? `, invited by ${invitedBy}` : ''}` });
      hub.changed(p);
    }
  };
  const redirect = (res, location) => { res.writeHead(302, { location, 'cache-control': 'no-store' }); res.end(); };

  // GET /auth/<provider>/start?ws=<workspace> and /auth/<provider>/callback: hub-wide, whatever the host.
  async function signIn(req, res, url, provider, step, { send, deny }) {
    if (!required) return deny(400, 'this hub has no logins', 'Sign-in is for hubs that require login (--auth or --workspaces).');
    if (!sso.providers[provider]) return deny(404, `sign-in with ${provider} isn't set up on this hub`, `The hub host sets NUWORQ_${provider.toUpperCase()}_CLIENT_ID and _SECRET (see DEPLOY.md).`);
    const callback = `${authOrigin(req)}/auth/${provider}/callback`;
    if (step === 'start') {
      // No workspace: sign in to the hub itself, to see and create organizations.
      const ws = spaces ? String(url.searchParams.get('ws') ?? '').toLowerCase() : '';
      if (spaces && ws && !spaces.get(ws)) return deny(404, `no workspace "${ws}"`, 'Start from your workspace\'s login page.');
      const go = sso.start(provider, { ws, back: spaces && !ws ? authOrigin(req) : homeOf(req, ws), callback });
      res.setHeader('set-cookie', `${FLOW_COOKIE}=${go.nonce}; HttpOnly; SameSite=Lax; Path=/auth/; Max-Age=600${https(req) ? '; Secure' : ''}`);
      return redirect(res, go.url);
    }
    res.setHeader('set-cookie', `${FLOW_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth/; Max-Age=0`);
    let flow;
    try {
      flow = sso.claim(provider, url.searchParams.get('state'), jarOf(req).get(FLOW_COOKIE));
    } catch (e) {
      return send(400, `<!doctype html><meta charset="utf-8"><title>nuworq</title><p>Sign-in failed: ${e.message.replace(/[<>&"]/g, '')}. Go back to your workspace's login page and start again.`, 'text/html; charset=utf-8');
    }
    const fail = (msg) => redirect(res, `${flow.back}/login.html#error=${encodeURIComponent(msg)}`);
    if (url.searchParams.get('error')) return fail(`${sso.providers[provider].label} sign-in was cancelled`);
    let email;
    try { email = await sso.email(provider, url.searchParams.get('code'), flow); } catch (e) { return fail(e.message); }
    if (!email) return fail(`${sso.providers[provider].label} has no verified email for you. Verify one there, then try again`);
    // Every verified sign-in teaches the directory who this is, so their organizations follow them.
    const id = spaces?.directory.identify(email, provider);
    if (spaces && !flow.ws) return redirect(res, `${flow.back}/api/oauth/finish?ticket=${sso.ticket('', spaces.directory.createSession(id.id))}`);
    const hub = spaces ? spaces.get(flow.ws) : target;
    if (!hub) return fail('that workspace is gone');
    const r = scopeOf(hub).authz.signInByEmail(email, provider);
    if (!r) return fail(`${email} isn't a member here. Ask an owner for an invite (to this email)`);
    spaces?.directory.join(email, flow.ws);
    if (r.joined) joined(hub, r.person, r.person.role, r.invitedBy);
    return redirect(res, `${flow.back}/api/oauth/finish?ticket=${sso.ticket(flow.ws, r.sid)}`);
  }
  const sameOrigin = (req) => {
    try { return new URL(req.headers.origin).host === hostOf(req); } catch { return false; }
  };
  const recent = (map, ip) => {
    const now = Date.now();
    const list = (map.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW);
    map.set(ip, list);
    if (map.size > 10_000) map.clear();
    return list;
  };
  const recentFailures = (ip) => recent(failures, ip);

  // The hub's own address (workspaces mode): who you are, your organizations, and making a new one.
  // Only GitHub/Google sign-in reaches it; tokens belong to one workspace.
  async function hubRoot(req, res, url, path, { send, deny }) {
    if (path === '/api/health') return send(200, { ok: true, name: 'nuworq', workspaces: true });
    const dir = spaces.directory;
    if (req.method === 'GET' && path === '/api/oauth') {
      return send(200, { providers: sso.list().map((p) => ({ ...p, start: `${authOrigin(req)}/auth/${p.name}/start` })) });
    }
    if (req.method === 'GET' && path === '/api/oauth/finish') {
      const sid = sso.redeem(url.searchParams.get('ticket'), '');
      if (!sid) return deny(400, 'that sign-in link was already used or expired', 'Sign in again.');
      res.setHeader('set-cookie', `${HUB_COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${https(req) ? '; Secure' : ''}`);
      return redirect(res, '/');
    }
    const sid = jarOf(req).get(HUB_COOKIE);
    const me = dir.verifySession(sid);
    const signIn = sso.enabled ? 'Sign in with GitHub or Google: see GET /api/oauth for where to start.' : 'This hub has no GitHub or Google sign-in set up (see DEPLOY.md).';
    const known = ['/api/me', '/api/orgs', '/api/logout'].includes(path) || /^\/api\/orgs\/[^/]+\/enter$/.test(path);
    if (!known) return deny(404, 'this address names no workspace', `Use <workspace>.${baseDomain || '<base-domain>'} or /w/<workspace>/.`);
    if (!me) return deny(401, 'sign in required', signIn);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req)) return deny(403, 'missing or mismatched Origin header');

    // An organization as the browser reaches it: its address, and a link that signs you in there.
    const org = (m) => ({ ...m, address: homeOf(req, m.workspace), enter: `/api/orgs/${m.workspace}/enter` });
    if (req.method === 'GET' && path === '/api/me') return send(200, { auth: 'required', email: me.email, orgs: dir.orgsOf(me, spaces).map(org) });
    if (req.method === 'POST' && path === '/api/logout') {
      dir.deleteSession(sid);
      res.setHeader('set-cookie', `${HUB_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
      return send(200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/orgs') {
      const b = await body(req);
      const slug = Workspaces.check(b.slug || slugify(b.name ?? ''));
      if (spaces.has(slug)) throw new UserError(`"${slug}" is taken`, { status: 409, hint: 'Pick another name for the address.' });
      if (dir.createdBy(me, spaces) >= orgCap) return deny(429, `you have created ${orgCap} organizations, the most this hub allows`, 'Ask the hub host to raise --org-cap, or use one you have.');
      spaces.create(slug);
      const hub = spaces.get(slug);
      const authz = scopeOf(hub).authz;
      const person = authz.addPerson(Auth.handleOf(me.email.split('@')[0]), 'owner', { email: me.email });
      dir.join(me.email, slug, { created: true });
      return send(200, { ok: true, ...org({ workspace: slug, handle: person.handle, role: 'owner', created: true }) });
    }
    const enter = path.match(/^\/api\/orgs\/([^/]+)\/enter$/);
    if (req.method === 'GET' && enter) {
      const ws = decodeURIComponent(enter[1]).toLowerCase();
      const hub = spaces.get(ws);
      // The person with this email there, or an open invite to it: the same rule as signing in there.
      const r = hub && scopeOf(hub).authz.signInByEmail(me.email, me.provider);
      if (!r) return deny(404, `${me.email} isn't a member of "${ws}"`, 'Ask an owner there for an invite (to this email).');
      dir.join(me.email, ws);
      if (r.joined) joined(hub, r.person, r.person.role, r.invitedBy);
      return redirect(res, `${homeOf(req, ws)}/api/oauth/finish?ticket=${sso.ticket(ws, r.sid)}`);
    }
    return deny(405, `use ${path === '/api/orgs' ? 'POST' : 'GET'}`);
  }

  const server = http.createServer(async (req, res) => {
    // A client that hangs up mid-request (e.g. after an oversized body is refused) must never crash the hub.
    req.on('error', () => {});
    res.on('error', () => {});
    const url = new URL(req.url, 'http://local');
    let path = url.pathname;
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(type.startsWith('application/json') ? JSON.stringify(body, null, 2) : body);
    };
    const deny = (status, error, hint) => send(status, { ok: false, error, ...(hint ? { hint } : {}) });
    try {
      let am;
      if (req.method === 'GET' && (am = path.match(/^\/auth\/([a-z]+)\/(start|callback)$/))) return await signIn(req, res, url, am[1], am[2], { send, deny });
      // Which hub: the only one, or the workspace this address names.
      let hub = target, base = '', ws = '';
      if (spaces) {
        const host = hostname(hostOf(req));
        const sub = baseDomain && host !== rootHost && host.endsWith(`.${baseDomain}`) ? host.slice(0, -baseDomain.length - 1) : null;
        const pre = sub == null ? path.match(/^\/w\/([^/]+)(\/.*)?$/) : null;
        const slug = sub ?? (pre ? decodeURIComponent(pre[1]) : null);
        if (slug == null) return await hubRoot(req, res, url, path, { send, deny });
        hub = spaces.get(slug);
        if (!hub) return deny(404, `no workspace "${slug}"`, 'Workspaces are created on the hub host: nuworq workspace create <name>.');
        ws = slug.toLowerCase();
        if (pre) {
          base = `/w/${pre[1]}`;
          path = pre[2] ?? '';
          if (!path) { res.writeHead(308, { location: `${base}/` }); return res.end(); }
        }
      }
      const { authz, devices, clients } = scopeOf(hub);
      const cookiePath = `${base}/`;
      const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);

      // GitHub can't log in: the delivery's signature is its credential, so this answers under any host name
      // (e.g. through a tunnel to a loopback hub). Browsers never send these, and nothing changes without a valid signature.
      let hook;
      if (req.method === 'POST' && (hook = path.match(/^\/api\/hooks\/github\/([^/]+)$/))) {
        return send(200, receive(hub, decodeURIComponent(hook[1]), { event: req.headers['x-github-event'], signature: req.headers['x-hub-signature-256'], raw: await rawBody(req) }));
      }

      // Without login, only answer to loopback names: blocks DNS-rebinding from web pages you visit.
      if (!required && !LOOPBACK.test(hostname(req.headers.host))) {
        return deny(403, 'this hub only answers on localhost', 'To serve it under another name, start it with --auth (tokens required).');
      }
      // A browser request from another site never gets to change anything.
      if (unsafe && req.headers.origin && !sameOrigin(req)) return deny(403, 'cross-origin request refused');

      // ── public ──
      if (req.method === 'GET' && path === '/api/health') return send(200, { ok: true, name: 'nuworq' });
      // The guide is how any agent learns nuworq, before it has a token: no project data, no secrets.
      if (req.method === 'GET' && (path === '/agents.md' || path === '/api/guide')) {
        return send(200, guide({ project: url.searchParams.get('project') ?? '<project>', url: origin(req) + base, via: url.searchParams.get('via') ?? 'tools' }), TYPES['.md']);
      }
      if (req.method === 'POST' && path === '/api/login') {
        if (!required) return send(200, { ok: true, auth: 'local' });
        const ip = clientIp(req);
        if (recentFailures(ip).length >= LOGIN_MAX_FAILS) return deny(429, 'too many failed attempts', 'Wait 10 minutes, then try again.');
        const b = await body(req);
        const t = authz.verifyToken(b.token);
        if (!t || t.role !== 'human') {
          recentFailures(ip).push(Date.now());
          return t ? deny(403, 'agent tokens cannot log in to the UI', 'Use a token created with --role human.') : deny(401, 'invalid token');
        }
        failures.delete(ip);
        const sid = authz.createSession(t.id);
        res.setHeader('set-cookie', sessionCookie(req, sid, cookiePath));
        return send(200, { ok: true, name: t.name });
      }
      // Sign in with GitHub or Google: which providers the login page offers, and the last step of the flow.
      if (req.method === 'GET' && path === '/api/oauth') {
        return send(200, { providers: required ? sso.list().map((p) => ({ ...p, start: `${authOrigin(req)}/auth/${p.name}/start${spaces ? `?ws=${encodeURIComponent(ws)}` : ''}` })) : [] });
      }
      if (req.method === 'GET' && path === '/api/oauth/finish') {
        const sid = required ? sso.redeem(url.searchParams.get('ticket'), ws) : null;
        if (!sid) return redirect(res, `${base}/login.html#error=${encodeURIComponent('That sign-in link was already used, expired, or belongs to another workspace. Sign in again')}`);
        res.setHeader('set-cookie', sessionCookie(req, sid, cookiePath));
        return redirect(res, `${base}/`);
      }
      // An invite link: peek at what it offers, or accept it with a handle (creates the person, signs them in).
      if (req.method === 'POST' && (path === '/api/invite/peek' || path === '/api/invite/accept')) {
        if (!required) return deny(400, 'this hub has no logins', 'Invites are for hubs that require login (--auth or --workspaces).');
        const ip = clientIp(req);
        if (recentFailures(ip).length >= LOGIN_MAX_FAILS) return deny(429, 'too many failed attempts', 'Wait 10 minutes, then try again.');
        const b = await body(req);
        const peek = authz.peekInvite(b.token);
        if (!peek.ok) { recentFailures(ip).push(Date.now()); return deny(410, peek.error, 'Ask an owner of this workspace for a new invite.'); }
        if (path === '/api/invite/peek') return send(200, { ok: true, role: peek.invite.role, email: peek.invite.email || undefined, invited_by: peek.invite.created_by || undefined });
        let r;
        try { r = authz.acceptInvite(b.token, b.handle); } catch (e) { return deny(400, e.message, 'Pick another handle: lowercase letters, digits, ., _ or -.'); }
        res.setHeader('set-cookie', sessionCookie(req, r.sid, cookiePath));
        if (r.person.email) spaces?.directory.join(r.person.email, ws);
        joined(hub, r.person, r.person.role, r.invitedBy);
        return send(200, { ok: true, person: `@${r.person.handle}`, role: r.person.role });
      }
      // Device login, the CLI's side: start a request, then poll until a person approves it in the browser.
      if (req.method === 'POST' && (path === '/api/device/start' || path === '/api/device/poll')) {
        if (!required) return deny(400, 'this hub has no logins', 'A hub without --auth needs no token: connect to it directly.');
        const ip = clientIp(req);
        const b = await body(req);
        if (path === '/api/device/start') {
          if (recent(starts, ip).length >= DEVICE_MAX_STARTS) return deny(429, 'too many device logins started', 'Wait 10 minutes, then try again.');
          recent(starts, ip).push(Date.now());
          const d = devices.start(b.machine);
          const verify = `${origin(req)}${base}/device.html`;
          return send(200, { ok: true, ...d, verify_url: verify, verify_url_complete: `${verify}?code=${d.user_code}` });
        }
        if (recentFailures(ip).length >= LOGIN_MAX_FAILS) return deny(429, 'too many failed attempts', 'Wait 10 minutes, then try again.');
        try {
          const r = devices.poll(b.device_code);
          return send(200, { ok: true, ...r, ...(r.status === 'approved' ? {} : { hint: r.status === 'slow_down' ? `Poll every ${r.interval} seconds.` : 'Waiting for a person to approve the code in the browser.' }) });
        } catch (e) {
          if (e.code === 'invalid') recentFailures(ip).push(Date.now());
          if (!e.code) throw e;
          return deny(e.code === 'invalid' ? 404 : 410, e.message, e.code === 'used' ? 'The token was handed out once; start a new device login for another.' : 'Start a new device login.');
        }
      }
      if (req.method === 'GET' && !path.startsWith('/api/') && path !== '/agents.md') {
        const file = path === '/' || !extname(path) ? 'index.html' : path.slice(1);
        if (file.includes('..')) return send(404, 'not found', 'text/plain');
        try {
          return send(200, await readFile(join(WEB, file)), TYPES[extname(file)] ?? 'application/octet-stream');
        } catch {
          return send(404, 'not found', 'text/plain');
        }
      }

      // ── who is this? ──
      let who = { role: 'human', name: 'you', via: 'local' };
      if (required) {
        const bearer = String(req.headers.authorization ?? '').match(/^Bearer\s+(\S+)/i)?.[1];
        const sid = cookieOf(req);
        who = bearer ? authz.verifyToken(bearer) : sid ? authz.verifySession(sid) : null;
        if (who) who.via = bearer ? 'bearer' : 'cookie';
        if (req.method === 'GET' && path === '/api/me') {
          return send(200, { auth: 'required', role: who?.role ?? null, name: who?.name ?? null });
        }
        if (!who) {
          return deny(401, bearer ? 'invalid or revoked token' : 'login required',
            bearer ? 'Check NUWORQ_TOKEN; tokens are managed with `nuworq token` on the hub host.' : 'Log in at /login.html, or send Authorization: Bearer <token>.');
        }
        // Cookies ride along automatically, so they must prove the request came from this site.
        if (who.via === 'cookie' && unsafe && !sameOrigin(req)) return deny(403, 'missing or mismatched Origin header');
        if (who.role === 'agent' && !AGENT_ROUTES.some((r) => r.test(`${req.method} ${path}`))) {
          return deny(403, 'agent tokens can only use agent operations', 'Use a human token for the UI and human actions.');
        }
      }

      // What a token-bearing agent may reach, and its token (name for the record; powers, provenance).
      const caller = { scope: who.projects ?? null, token: who.via === 'bearer' ? who : null };
      // A person acts as "@handle" with their role; without accounts the one human is "you", an owner.
      const by = who.person ? `@${who.person.handle}` : HUMAN;
      const personRole = who.person?.role ?? 'owner';
      if (req.method === 'GET' && path === '/api/me') return send(200, { auth: required ? 'required' : 'local', role: who.role, name: who.name, ...(caller.scope ? { projects: caller.scope } : {}) });
      if (req.method === 'GET' && path === '/api/people/me') return send(200, { person: by, role: personRole });
      if (path === '/api/invites' || path === '/api/invites/revoke') {
        if (personRole !== 'owner') return deny(403, 'only an owner invites people', 'Ask an owner of this workspace.');
        if (req.method === 'GET' && path === '/api/invites') return send(200, authz.listInvites());
        if (req.method !== 'POST') return deny(405, 'use GET or POST');
        const b = await body(req);
        try {
          if (path === '/api/invites/revoke') { authz.revokeInvite(b.id); return send(200, { ok: true }); }
          const inv = authz.createInvite(b.role, { email: b.email, by: by === HUMAN ? '' : by });
          // The link is shown this once; only its hash is kept.
          return send(200, { ok: true, id: inv.id, role: inv.role, link: `${origin(req)}${base}/invite.html#${inv.token}`, expires_in: '7 days' });
        } catch (e) {
          throw new UserError(e.message);
        }
      }
      if (path === '/api/people' || path === '/api/people/role') {
        if (req.method === 'GET' && path === '/api/people') return send(200, authz.listPeople());
        if (req.method !== 'POST') return deny(405, 'use GET or POST');
        if (personRole !== 'owner') return deny(403, 'only an owner manages people', 'Ask an owner of this workspace.');
        const b = await body(req);
        try {
          const person = path === '/api/people' ? authz.addPerson(b.handle, b.role, { name: b.name, email: b.email }) : authz.setRole(b.handle, b.role);
          if (person.email) spaces?.directory.join(person.email, ws);
          return send(200, { ok: true, person });
        } catch (e) {
          throw new UserError(e.message);
        }
      }
      // Device login, the person's side: see which machine asks, then approve or deny it.
      if (req.method === 'POST' && (path === '/api/device/peek' || path === '/api/device/approve')) {
        if (!who.person) return deny(400, 'this hub has no logins', 'Device login is for hubs that require login (--auth or --workspaces).');
        const b = await body(req);
        const peek = devices.peek(b.user_code);
        if (!peek.ok) return deny(410, peek.error, 'Check the code the CLI shows, or start the device login again.');
        if (path === '/api/device/peek') return send(200, { ok: true, machine: peek.request.machine, expires_in: Math.max(0, Math.round((peek.request.expires_at - authz.now()) / 1000)) });
        const approve = b.approve !== false;
        if (approve && personRole === 'viewer') return deny(403, "a viewer can't connect machines", 'Ask an owner for a member role.');
        let d;
        try { d = devices.decide(b.user_code, who.person.handle, approve); } catch (e) { throw new UserError(e.message); }
        if (d.name) {
          for (const p of hub.projects()) {
            hub.event(p, { actor: by, type: 'connected', headline: `${by} connected ${d.machine} (agent token ${d.name})` });
            hub.changed(p);
          }
        }
        return send(200, { ok: true, machine: d.machine, approved: !!d.name, token_name: d.name ?? undefined });
      }
      if (req.method === 'POST' && path === '/api/logout') {
        authz.deleteSession(cookieOf(req));
        res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=0`);
        return send(200, { ok: true });
      }
      if (req.method === 'GET' && path === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': hello\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && path === '/api/info') {
        return send(200, { bin: join(WEB, '..', 'bin', 'nuworq.js'), url: origin(req) + base, auth: required ? 'required' : 'local', workspace: hub.workspace, ...buildInfo() });
      }
      // "Needs you" is the viewer's own: a person sees what is theirs as act, the rest as worth knowing.
      const viewer = who.person ? by : undefined;
      // Agents get only what a worker needs to find its checkout, for the projects their token may reach.
      if (req.method === 'GET' && path === '/api/projects' && who.role === 'agent') {
        return send(200, hub.projects().filter((p) => !caller.scope || caller.scope.includes(p.slug))
          .map((p) => ({ slug: p.slug, name: p.name, path: p.path, remotes: hub.remotesOf(p), parked: !!p.parked, runner: !!p.runner })));
      }
      if (req.method === 'GET' && path === '/api/projects') return send(200, projectList(hub, { viewer }));
      if (req.method === 'POST' && path === '/api/projects') {
        if (!['owner', 'steward'].includes(personRole)) return deny(403, `a ${personRole} can't create projects`, 'Ask an owner or steward.');
        const b = await body(req);
        const p = hub.tx(() => hub.project(b.slug || b.name, { create: true, name: b.name }));
        if (b.mission) hub.humanOp(p.slug, 'settings', { mission: b.mission });
        hub.changed(p);
        return send(200, { ok: true, slug: p.slug });
      }
      if (req.method === 'GET' && path === '/api/tools') {
        return send(200, tools(url.searchParams.get('format') ?? 'mcp', url.searchParams.get('prefix') ?? ''));
      }

      let m;
      if ((m = path.match(/^\/api\/p\/([^/]+)\/view$/)) && req.method === 'GET') {
        hub.sweep();
        return send(200, view(hub, decodeURIComponent(m[1]), { viewer }));
      }
      if ((m = path.match(/^\/api\/p\/([^/]+)\/items\/([^/]+)$/)) && req.method === 'GET') {
        return send(200, itemView(hub, decodeURIComponent(m[1]), decodeURIComponent(m[2])));
      }
      if ((m = path.match(/^\/api\/p\/([^/]+)\/human\/([a-z]+)$/)) && req.method === 'POST') {
        if (!HUMAN_OP_NAMES.includes(m[2])) throw new UserError(`Unknown action "${m[2]}"`, { status: 404 });
        if (!PERSON_CAN[personRole]?.includes(m[2])) return deny(403, `a ${personRole} can't ${m[2]} here`, 'Ask an owner of this workspace for a different role.');
        const args = await body(req);
        if (personRole === 'member' && m[2] === 'create') args.stage = 'proposed'; // members propose; stewards decide
        return send(200, hub.humanOp(decodeURIComponent(m[1]), m[2], args, by));
      }
      if ((m = path.match(/^\/api\/p\/([^/]+)\/agent\/([a-z]+)$/)) && req.method === 'POST') {
        const b = await body(req);
        const agent = header(req, 'agent') || b.agent;
        delete b.agent;
        return send(200, hub.agentOp(decodeURIComponent(m[1]), m[2], agent, b, { root: rootOf(req), remote: remoteOf(req), ...caller }));
      }
      // git asks for a credential (nuworq git-credential): a token for the repository of the item this
      // agent holds, minted by the GitHub App for that one repository and an hour. On the record, never shown.
      if (path === '/api/agent/credential' && req.method === 'POST') {
        const b = await body(req);
        const agent = header(req, 'agent') || b.agent;
        if (!app) return deny(404, "this hub has no GitHub App, so it hands out no GitHub tokens", 'The hub host sets NUWORQ_GITHUB_APP_ID and NUWORQ_GITHUB_APP_KEY_FILE (see docs/GITHUB.md). Until then, push with your own credentials.');
        const held = hub.q(`SELECT i.* FROM items i WHERE i.holder = ? AND i.stage IN ('active', 'landing') ORDER BY i.updated_at DESC`).all(String(agent ?? ''))
          .map((it) => ({ it, p: hub.q('SELECT * FROM projects WHERE id = ?').get(it.project_id) }))
          .find(({ p }) => !caller.scope || caller.scope.includes(p.slug));
        if (!held) return deny(409, `${agent || 'this agent'} holds no item to push for`, 'Tokens are for the item you hold: claim one (next), then push.');
        const { it, p } = held;
        const repo = it.repo || hub.remotesOf(p)[0] || '';
        let t;
        try {
          t = await app.mint(repo);
        } catch (e) {
          if (e instanceof UserError) {
            hub.event(p, { item: it, actor: agent, type: 'credential_refused', headline: `No GitHub token for ${agent} on #${it.seq}: ${e.message}`, summary: e.hint ?? '', data: { agent, repo } });
            hub.changed(p);
          }
          throw e;
        }
        hub.event(p, {
          item: it, actor: agent, type: 'credential',
          headline: `${agent} got a GitHub token for ${t.repo} on #${it.seq}, until ${new Date(t.expires_at).toISOString().slice(11, 16)} UTC`,
          data: { agent, item: it.seq, repo: t.repo, expires_at: t.expires_at, token: caller.token?.name ?? null }, // the agent token that asked
        });
        hub.changed(p);
        return send(200, { ok: true, username: 'x-access-token', password: t.token, repo: t.repo, expires_at: t.expires_at });
      }
      // No project named: the agent's folder picks it, or the hub routes the agent to the most valuable work.
      if ((m = path.match(/^\/api\/agent\/([a-z]+)$/)) && req.method === 'POST') {
        const b = await body(req);
        const agent = header(req, 'agent') || b.agent;
        delete b.agent;
        return send(200, hub.agentOp('', m[1], agent, b, { root: rootOf(req), remote: remoteOf(req), ...caller }));
      }
      // Push channels (hub-wide, or workspace-wide). Agent tokens never reach these; only an owner changes them.
      if (req.method === 'GET' && path === '/api/notify') return send(200, { channels: listChannels(hub.db), kinds: KINDS });
      if (req.method === 'POST' && path.startsWith('/api/notify') && personRole !== 'owner') return deny(403, 'only an owner manages push channels', 'Ask an owner of this workspace.');
      if (req.method === 'POST' && path === '/api/notify') {
        const b = await body(req);
        const c = addChannel(hub.db, b.kind, b.url, hub.now());
        hub.emit('change', { project: null, at: hub.now() });
        return send(200, { ok: true, ...c });
      }
      if (req.method === 'POST' && path === '/api/notify/remove') {
        removeChannel(hub.db, (await body(req)).id);
        hub.emit('change', { project: null, at: hub.now() });
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/notify/test') {
        const results = await testChannels(hub.db, { baseUrl: (!spaces && publicUrl) || origin(req) + base, now: () => hub.now() });
        hub.emit('change', { project: null, at: hub.now() });
        return send(200, { ok: results.every((r) => r.ok), results });
      }
      if (req.method === 'GET' && path === '/api/route') return send(200, hub.route('', {
        runner: !!url.searchParams.get('runner'), scope: caller.scope, powers: who.role === 'agent' ? who.powers : null,
        has: url.searchParams.has('has') ? url.searchParams.get('has').split(',').filter(Boolean) : undefined,
      }));
      if (req.method === 'GET' && path === '/api/where') {
        const p = hub.projectByRemote(url.searchParams.get('remote') ?? '', caller.scope) ?? hub.projectByPath(url.searchParams.get('root') ?? '', caller.scope);
        return send(200, { project: p?.slug ?? null, path: p?.path ?? null });
      }
      send(404, { ok: false, error: `No route ${req.method} ${path}` });
    } catch (e) {
      if (e instanceof UserError) return send(e.status, { ok: false, error: e.message, ...(e.hint ? { hint: e.hint } : {}) });
      console.error(e);
      send(500, { ok: false, error: String(e?.message ?? e) });
    }
  });
  if (!spaces) server.auth = scopeOf(target).authz;
  server.on('close', () => { clearInterval(sweeper); clearInterval(keepalive); });
  return server;
}

function hostname(host) {
  try { return new URL(`http://${host}`).hostname; } catch { return ''; }
}

// x-nuworq-<name>, else the old x-trellis-<name> that clients from before the rename send.
const header = (req, name) => req.headers[`x-nuworq-${name}`] ?? req.headers[`x-trellis-${name}`];
const rootOf = (req) => { try { return decodeURIComponent(header(req, 'root') ?? ''); } catch { return ''; } };
const remoteOf = (req) => { try { return decodeURIComponent(header(req, 'remote') ?? ''); } catch { return ''; } };

const TOO_BIG = () => new UserError('Request body too large (limit 1MB)', { status: 413, hint: 'Keep detail to what a person would read; put long logs in the repo and reference them.' });

async function rawBody(req) {
  // Read and discard a moderately oversized body so the client gets a clean 413 instead of a broken pipe;
  // only refuse outright, unread, when it's absurdly large.
  if (Number(req.headers['content-length']) > 16 * MAX_BODY) { req.destroy(); throw TOO_BIG(); }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 16 * MAX_BODY) { req.destroy(); break; }
    if (size <= MAX_BODY) chunks.push(c);
  }
  if (size > MAX_BODY) throw TOO_BIG();
  return Buffer.concat(chunks);
}

async function body(req) {
  const raw = (await rawBody(req)).toString('utf8').trim();
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new UserError('Request body must be JSON');
  }
}
