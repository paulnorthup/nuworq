import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError, HUMAN_OP_NAMES, HUMAN, PERSON_CAN, normRemote, slugify } from './core.js';
import { view, itemView, projectList, homeView } from './insight.js';
import { tools, guide } from './protocol.js';
import { Auth, SESSION_MS } from './auth.js';
import { Devices } from './device.js';
import { Workspaces } from './workspaces.js';
import { KINDS, addChannel, listChannels, removeChannel, testChannels, channelOwner } from './notify.js';
import { receive } from './github.js';
import { runChecks } from './precondition.js';
import { syncIssues, commentIssues, closeLanded, closeStale } from './issues.js';
import { OAuth, FLOW_COOKIE } from './oauth.js';
import { ORG_CAP } from './directory.js';
import { getStarted, facts, finished, finish } from './getstarted.js';
import { GitHubApp, manifest, convert, prClient, CLONE_PERMISSIONS, installState, readInstallState } from './ghapp.js';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { outcomes } from './outcomes.js';
import { tmpdir } from 'node:os';
import { buildPackage, signatureOf } from './package.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8' };
const MAX_BODY = 1024 * 1024;
// The ops that decide on git state (landing, the submit check): their mirror is fetched first (hub.prefetch).
const DECIDES = { human: ['accept'], agent: ['submit', 'review'] };

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
    source: remote.startsWith('github.com/') ? remote : null, // where to clone nuworq from, for another machine
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
const ASK_MAX = 5, ASK_WINDOW = 60 * 60_000; // early-access requests per IP per hour
// What an agent-role token may reach in required mode.
const AGENT_ROUTES = [/^POST \/api\/p\/[^/]+\/agent\/[a-z]+$/, /^POST \/api\/agent\/[a-z]+$/, /^GET \/api\/(tools|guide|info|me|route|where|projects|claims)$/, /^GET \/agents\.md$/, /^GET \/api\/p\/[^/]+\/outcomes$/];
const LOOPBACK = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i;
const REPO_PAGE = 30; // repositories per page in "+ Project"

// auth: 'local' (no login; loopback only) or 'required' (tokens + sessions).
// target: one Hub (today's single hub), or a Workspaces registry: then each request is resolved to a
// workspace by subdomain of baseDomain or a /w/<slug>/ path prefix, and login is always required.
// oauth: providers people may sign in with ({ github: { id, secret }, google: … }; see src/oauth.js).
// orgCap: how many organizations one signed-in person may create (workspaces mode).
// githubApp: the GitHub App that mints one-repo, one-hour tokens for workers ({ id, key, slug } or a GitHubApp; see src/ghapp.js).
// appFile: where an app the hub creates for itself (one click, single hub only) is saved, 0600.
// github: GitHub's addresses ({ web, api }; tests point them at a stub).
// packageDir: where the package of the running commit is built and kept (/nuworq.tgz; see src/package.js).
// source: the checkout it is built from (tests point it at a clone).
// earlyAccess (workspaces mode): { owners: [emails], verify: async (token, ip) => bool, gate: bool }. owners
// decide requests; verify checks the form's Turnstile token (src/directory.js turnstile); gate: making an
// organization takes an approved request's grant. null: no early access.
export function createServer(target, { auth = 'local', trustProxy = false, baseDomain = '', sweepMs = 15_000, publicUrl = '', oauth = {}, orgCap = ORG_CAP, githubApp = null, appFile = '', github = {}, packageDir = join(tmpdir(), 'nuworq-package'), source = ROOT, earlyAccess = null } = {}) {
  const spaces = target instanceof Workspaces ? target : null;
  // Built once, at start, off the request path; null when this hub doesn't run from a git checkout.
  let built = null;
  const pkg = buildPackage(source, packageDir).then((b) => (built = b));
  const gh = { web: 'https://github.com', api: 'https://api.github.com', ...github };
  let app = githubApp && !(githubApp instanceof GitHubApp) ? new GitHubApp({ api: gh.api, web: gh.web, ...githubApp }) : githubApp;
  // The app as a hub may use it: on a shared hub, only the installations bound to that organization
  // (installed from inside it; see /api/github/installed), so one organization can't read another's repositories.
  const appOf = (hub) => (!app ? null : spaces ? app.scoped((id) => spaces.directory.installation(id) === hub.workspace) : app);
  const appStates = new Map(); // one-click app creation: state → expiry (single use, an hour)
  // Follow a renamed app: refresh its slug now and then (never blocking a request), and save it.
  let slugAt = 0;
  const freshSlug = () => {
    if (!app?.refreshSlug || Date.now() - slugAt < 10 * 60_000) return;
    slugAt = Date.now();
    app.refreshSlug().then((changed) => {
      if (!changed || !appFile) return;
      try { writeFileSync(appFile, JSON.stringify({ ...JSON.parse(readFileSync(appFile, 'utf8')), slug: app.slug }, null, 2), { mode: 0o600 }); } catch {}
    }).catch(() => {});
  };
  freshSlug();
  // Whether the app reaches anything (Get started): installed anywhere on a single hub; on a workspaces hub,
  // on one of the workspace's own repositories, through an installation bound to it. Asked of GitHub at most
  // once a minute per hub.
  const installs = new WeakMap(); // hub → { app, at, state }
  const appState = async (hub) => {
    if (!app) return 'none';
    const have = installs.get(hub);
    if (have?.app === app && Date.now() - have.at < 60_000) return have.state;
    let ok = false;
    try {
      if (!spaces) ok = await app.installed();
      else for (const r of hub.projects().flatMap((p) => hub.remotesOf(p)).filter((r) => r.startsWith('github.com/')).slice(0, 10)) if ((ok = await appOf(hub).installed(r))) break;
    } catch { /* GitHub unreachable: not installed, as far as we can tell */ }
    const state = ok ? 'installed' : 'uninstalled';
    installs.set(hub, { app, at: Date.now(), state });
    return state;
  };
  // Workers' tokens, reused until 5 minutes before they expire: memory only, never the database.
  const minted = new Map(); // `${agent}|${item id}|${repo}` → { token, expires_at, repo }
  // The hub's own address names no workspace: the base domain, or the public URL's host (e.g. auth.<base-domain>).
  const rootHost = publicUrl ? hostname(new URL(publicUrl).host) : '';
  const required = spaces ? true : auth === 'required';
  const sso = oauth instanceof OAuth ? oauth : new OAuth(oauth);
  const failures = new Map(); // ip → [timestamps of failed logins]
  const asks = new Map(); // ip → [timestamps of early-access requests]
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
    for (const hub of hubs()) {
      try { hub.sweep(); hub.refreshMirrorTokens(); } catch (e) { console.error('sweep failed', e); }
      // Preconditions, in the background. A shared host lends tenants neither its credentials nor its network.
      // Release preconditions read GitHub through the app where it's installed.
      runChecks(hub, { shared: !!spaces, github: { api: gh.api, app } }).catch((e) => console.error('checking preconditions failed', e));
      // Landing work's pull requests, as GitHub has them (no webhook may reach the hub): ready ones merge,
      // merged ones land, closed or conflicting ones become land jobs. At most once a minute.
      if (hub.github) hub.mergeReady().catch((e) => console.error('checking pull requests failed', e));
      // Issues whose work has landed close on GitHub (a hub that has served a request knows its public address).
      if (app && hub._app === app) for (const p of hub.projects()) closeLanded(hub, p, hub.github.app).catch((e) => console.error('closing issues failed', e));
    }
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
  const recent = (map, ip, window = LOGIN_WINDOW) => {
    const now = Date.now();
    const list = (map.get(ip) ?? []).filter((t) => now - t < window);
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
    // GitHub's setup page after the app was installed from inside an organization (/api/github/install):
    // the signed state says which one, and the installation is bound to it once GitHub confirms, through the
    // installer's OAuth code, that they can see it (the redirect's installation_id can be forged). The first binding stands.
    if (req.method === 'GET' && path === '/api/github/installed') {
      if (!app) return deny(404, 'this hub has no GitHub App');
      const ws = readInstallState(app, url.searchParams.get('state'));
      const id = Number(url.searchParams.get('installation_id'));
      if (!ws || !spaces.has(ws) || !id) return deny(400, "this install didn't start from an organization on this hub, or its link expired", 'Open your organization, then Connect → Install the GitHub App, and finish the install within the hour.');
      if (!(await app.installedBy(url.searchParams.get('code'), id))) {
        return deny(403, `GitHub says you can't see installation ${id}, so it isn't bound to ${ws}`, 'Install the app from your organization on an account or repositories you manage, and let GitHub send you back here.');
      }
      if (!dir.bindInstallation(id, ws)) return deny(409, 'that installation belongs to another organization on this hub', 'Install the app for this organization on its own account or repositories.');
      return redirect(res, `/w/${encodeURIComponent(ws)}/#github-installed`);
    }
    // Early access: anyone may ask to come in (a Turnstile token and a per-address limit keep bots out).
    if (req.method === 'POST' && path === '/api/early-access') {
      if (!earlyAccess?.verify) return deny(503, 'this hub takes no early-access requests', 'It has no Turnstile secret set (NUWORQ_TURNSTILE_SECRET).');
      const ip = clientIp(req);
      // Every attempt counts, passing or not, so the limit also caps calls to Turnstile.
      if (recent(asks, ip, ASK_WINDOW).length >= ASK_MAX) return deny(429, 'too many requests from this address', 'Try again in an hour.');
      recent(asks, ip, ASK_WINDOW).push(Date.now());
      const b = await body(req);
      if (!(await earlyAccess.verify(b.turnstile, ip))) return deny(400, "the form's check didn't pass", 'Reload the page and try again.');
      let r;
      try { r = dir.request({ email: b.email, github: b.github, building: b.building, ip }); } catch (e) { return deny(400, e.message, 'e.g. you@example.com'); }
      return send(200, { ok: true, state: r.state, created: r.created_at === r.updated_at });
    }
    // The pages the hub's own address shows: joining (the early-access link) and the owners' request list.
    const page = path === '/' ? '/join.html' : path;
    if (['/join.html', '/join.js', '/requests.html', '/requests.js', '/style.css'].includes(page) && req.method === 'GET') {
      return send(200, readFileSync(join(WEB, page.slice(1)), 'utf8'), TYPES[extname(page)]);
    }
    const sid = jarOf(req).get(HUB_COOKIE);
    const me = dir.verifySession(sid);
    const signIn = sso.enabled ? 'Sign in with GitHub or Google: see GET /api/oauth for where to start.' : 'This hub has no GitHub or Google sign-in set up (see DEPLOY.md).';
    const known = ['/api/me', '/api/orgs', '/api/logout', '/api/early-access', '/api/early-access/decide'].includes(path) || /^\/api\/orgs\/[^/]+\/enter$/.test(path);
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
    // The hub's owners (by verified email) read and decide early-access requests.
    const owner = !!earlyAccess?.owners?.includes(me.email);
    if (path === '/api/early-access' || path === '/api/early-access/decide') {
      if (!owner) return deny(403, 'only the hub\'s owners see early-access requests', 'The hub host lists them in NUWORQ_HUB_OWNERS.');
      if (req.method === 'GET' && path === '/api/early-access') return send(200, { requests: dir.requests({ state: url.searchParams.get('state') ?? '' }) });
      if (req.method === 'POST' && path === '/api/early-access/decide') {
        const b = await body(req);
        const r = dir.decide(b.id, b.approve === true, me.email);
        if (!r) return deny(404, `no request ${b.id}`);
        return send(200, { ok: true, state: r.state, ...(r.code ? { link: `${authOrigin(req)}/?grant=${r.code}` } : {}) });
      }
    }
    if (req.method === 'POST' && path === '/api/orgs') {
      const b = await body(req);
      const slug = Workspaces.check(b.slug || slugify(b.name ?? ''));
      if (spaces.has(slug)) throw new UserError(`"${slug}" is taken`, { status: 409, hint: 'Pick another name for the address.' });
      if (dir.createdBy(me, spaces) >= orgCap) return deny(429, `you have created ${orgCap} organizations, the most this hub allows`, 'Ask the hub host to raise --org-cap, or use one you have.');
      // Plans on: one free organization per signed-in account (organizations the hub owner is in are never free).
      const free = spaces.plans ? spaces.freeCreatedBy(me) : [];
      if (free.length) return deny(402, `you already have a free organization (${free[0]}); an account gets one`, `Use ${free[0]}, or upgrade it to Pro and then create more.`);
      // In early access, an organization takes an approved request's grant (its owners need none).
      if (earlyAccess?.gate && !owner && !dir.useGrant(b.grant, me)) {
        return deny(403, 'nuworq is in early access: making an organization takes an invitation', 'Request access on nuworq.com; the link you get when you are let in makes your organization.');
      }
      try { spaces.create(slug); } catch (e) { if (earlyAccess?.gate && !owner) dir.returnGrant(b.grant); throw e; }
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
      // nuworq itself, as an npm package of the commit this hub runs: public, the same for every workspace.
      if (req.method === 'GET' && path === '/nuworq.tgz') {
        const b = await pkg;
        if (!b) return deny(404, "this hub doesn't run from a git checkout, so it has no package of itself to serve", 'Install nuworq the way this hub was installed, or ask its host.');
        res.writeHead(200, { 'content-type': 'application/gzip', etag: `"${b.sha256}"`, 'cache-control': 'no-cache', 'content-disposition': 'attachment; filename="nuworq.tgz"' });
        return res.end(await readFile(b.file));
      }
      // Its release signature, when one was made for it: installs update only to a package it verifies.
      if (req.method === 'GET' && path === '/nuworq.tgz.sig') {
        const sig = (await pkg) && signatureOf(built);
        if (!sig) return deny(404, "this hub's package isn't signed", 'Installed copies keep their version until a signed release is served (docs/DEPLOY.md, "Signed releases").');
        res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-cache' });
        return res.end(`${sig}\n`);
      }
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
      // Accepted remote work lands through a pull request the hub opens, as the app (also one created since start).
      if (app && hub._app !== app) { hub._app = app; hub.github = prClient(appOf(hub), { web: gh.web }); hub.publicUrl = (!spaces && publicUrl) || origin(req) + base; }
      const cookiePath = `${base}/`;
      const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      // An item's page, as a link for GitHub: the public address when the hub has one.
      const itemLink = (rq, slug) => (item) => `${publicUrl || origin(rq)}${base}/#/p/${encodeURIComponent(slug)}/${item.seq}`;

      // GitHub can't log in: the delivery's signature is its credential, so this answers under any host name
      // (e.g. through a tunnel to a loopback hub). Browsers never send these, and nothing changes without a valid signature.
      let hook;
      if (req.method === 'POST' && (hook = path.match(/^\/api\/hooks\/github\/([^/]+)$/))) {
        const slug = decodeURIComponent(hook[1]);
        const r = receive(hub, slug, { event: req.headers['x-github-event'], signature: req.headers['x-hub-signature-256'], raw: await rawBody(req) });
        // Issues that came in get their one comment; an install brings every open issue in. Both need the app.
        if (!r.ignored && (r.sync || req.headers['x-github-event'] === 'issues')) {
          if (!app) return send(200, { ...r, sync: undefined, github: 'no GitHub App configured: issues that arrive by webhook come in, but the hub can neither list issues nor comment' });
          const p = hub.project(slug);
          const link = itemLink(req, p.slug);
          try {
            r.github = r.sync ? await syncIssues(hub, p, appOf(hub), r.sync, { link }) : await commentIssues(hub, p, appOf(hub), { link });
          } catch (e) {
            r.github = { error: e.message };
          }
        }
        return send(200, r);
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
      // Back from GitHub after an owner created the hub's app. Cross-site, so the Strict session cookie doesn't
      // come along: the single-use state the owner's own request made is what proves it.
      if (req.method === 'GET' && path === '/api/github/app/callback') {
        const state = String(url.searchParams.get('state') ?? '');
        const exp = appStates.get(state);
        appStates.delete(state);
        if (!exp || exp < Date.now() || spaces) return deny(400, 'this GitHub App link was already used, expired, or never started here', 'Start again from the hub: Connect an agent → Create GitHub App.');
        const a = await convert(url.searchParams.get('code') ?? '', { api: gh.api });
        if (appFile) writeFileSync(appFile, JSON.stringify(a, null, 2), { mode: 0o600 });
        app = new GitHubApp({ id: a.id, key: a.key, slug: a.slug, client_id: a.client_id, client_secret: a.client_secret, api: gh.api, web: gh.web });
        for (const p of hub.projects()) {
          hub.event(p, { actor: 'github', type: 'github_app', headline: `The GitHub App ${a.slug || a.id} was created${a.owner ? ` on ${a.owner}` : ''}; install it on this project's repository so workers can push` });
          hub.changed(p);
        }
        // Creating the app doesn't install it: go straight to choosing its repositories (GitHub then returns to setup_url).
        return redirect(res, a.slug ? app.installUrl() : `${base}/#github-app=${encodeURIComponent(a.id)}`);
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
          return send(200, { auth: 'required', role: who?.role ?? null, name: who?.name ?? null, ...(who?.projects ? { projects: who.projects } : {}) });
        }
        if (!who) {
          return deny(401, bearer ? 'invalid or revoked token' : 'login required',
            bearer ? 'Check NUWORQ_TOKEN; tokens are managed with `nuworq token` on the hub host.' : 'Log in at /login.html, or send Authorization: Bearer <token>.');
        }
        // Cookies ride along automatically, so they must prove the request came from this site.
        if (who.via === 'cookie' && unsafe && !sameOrigin(req)) return deny(403, 'missing or mismatched Origin header');
        // A token revokes itself (nuworq disconnect). Bearer only: a browser session logs out instead.
        if (req.method === 'POST' && path === '/api/me/revoke') {
          if (who.via !== 'bearer') return deny(400, 'only a token can revoke itself', 'Send Authorization: Bearer <token>. To sign out of the browser, use Sign out.');
          authz.revoke(who.id);
          return send(200, { ok: true, revoked: who.name });
        }
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
      if (req.method === 'POST' && path === '/api/me/revoke') return send(200, { ok: true, revoked: null }); // no logins here: nothing to revoke
      if (req.method === 'GET' && path === '/api/people/me') return send(200, { person: by, role: personRole });
      // The hub's GitHub App: whether it has one, and the one-click page that creates it (owners, single hub).
      if (req.method === 'GET' && (path === '/api/github/app' || path === '/api/info')) freshSlug();
      if (req.method === 'GET' && path === '/api/github/app') return send(200, { configured: !!app, slug: app?.slug || null, can_create: !spaces && personRole === 'owner' });
      // Install the app for this organization: on a shared hub, the installation is bound to it on the way back.
      if (req.method === 'GET' && path === '/api/github/install') {
        if (!app?.slug) return deny(404, 'this hub has no GitHub App to install', 'The hub host sets one up (docs/GITHUB.md).');
        if (!['owner', 'steward'].includes(personRole)) return deny(403, `a ${personRole} can't install the app for this organization`, 'Ask an owner.');
        return redirect(res, spaces ? `${app.installUrl()}?state=${encodeURIComponent(installState(app, hub.workspace))}` : app.installUrl());
      }
      if (req.method === 'GET' && path === '/api/github/app/new') {
        if (spaces) return deny(403, 'on a hub with workspaces, the host sets up the GitHub App', 'See docs/GITHUB.md: NUWORQ_GITHUB_APP_ID and NUWORQ_GITHUB_APP_KEY_FILE.');
        if (personRole !== 'owner') return deny(403, 'only an owner creates the GitHub App', 'Ask an owner of this hub.');
        const site = publicUrl || origin(req);
        const state = randomBytes(24).toString('base64url');
        for (const [k, exp] of appStates) if (exp < Date.now()) appStates.delete(k);
        appStates.set(state, Date.now() + 3600_000);
        const org = String(url.searchParams.get('org') ?? '').replace(/[^\w.-]/g, '');
        const action = `${gh.web}/${org ? `organizations/${org}/` : ''}settings/apps/new?state=${state}`;
        const m = JSON.stringify(manifest(site, `nuworq ${hostname(new URL(site).host)}`));
        const q = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        // This one page may post a form to GitHub; everything else keeps form-action 'self'.
        res.setHeader('content-security-policy', SECURITY_HEADERS['content-security-policy'].replace("form-action 'self'", `form-action 'self' ${gh.web}`));
        return send(200, `<!doctype html><meta charset="utf-8"><title>Create the nuworq GitHub App</title><link rel="stylesheet" href="${base}/style.css">
<main class="narrow"><h1>Create the nuworq GitHub App</h1>
<p>GitHub creates an app for this hub${org ? ` in <b>${q(org)}</b>` : ' on your account'}: it can push branches, open pull requests and read CI and issues, on the repositories you install it on, and nothing else. You come back here when it's made.</p>
<form method="post" action="${q(action)}"><input type="hidden" name="manifest" value="${q(m)}"><button class="btn primary" type="submit">Create GitHub App</button></form>
<p class="faint">For an organization, open this page with ?org=&lt;name&gt;.</p></main>`, 'text/html; charset=utf-8');
      }
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
        return send(200, { bin: join(WEB, '..', 'bin', 'nuworq.js'), url: ((!spaces && publicUrl) || origin(req)) + base, auth: required ? 'required' : 'local', workspace: hub.workspace, github_app: app ? app.slug || true : (!spaces && personRole === 'owner' ? 'create' : null), ...buildInfo(),
          package: built ? { url: `${(!spaces && publicUrl) || origin(req)}/nuworq.tgz`, sha256: built.sha256, commit: built.commit.slice(0, 7) } : null });
      }
      // "Needs you" is the viewer's own: a person sees what is theirs as act, the rest as worth knowing.
      const viewer = who.person ? by : undefined;
      // Agents get only what a worker needs to find its checkout, for the projects their token may reach.
      if (req.method === 'GET' && path === '/api/projects' && who.role === 'agent') {
        return send(200, hub.projects().filter((p) => !caller.scope || caller.scope.includes(p.slug))
          .map((p) => ({ slug: p.slug, name: p.name, path: p.path, remotes: hub.remotesOf(p), parked: !!p.parked, runner: !!p.runner })));
      }
      if (req.method === 'GET' && path === '/api/projects' && url.searchParams.get('archived')) {
        return send(200, hub.projects({ archived: true }).map((p) => ({ slug: p.slug, name: p.name, archived_at: p.archived_at, remotes: hub.remotesOf(p) })));
      }
      if (req.method === 'GET' && path === '/api/projects') return send(200, projectList(hub, { viewer }));
      // The home (#124): what needs the viewer across every project, in one request; Mark all seen for all of them.
      if (path === '/api/home' || path === '/api/home/seen') {
        if (who.role === 'agent') return deny(403, 'the home is for people', 'Agents start with checkin; workers list projects with GET /api/projects.');
        if (req.method === 'GET' && path === '/api/home') return send(200, homeView(hub, { viewer }));
        if (req.method !== 'POST' || path !== '/api/home/seen') return deny(405, path === '/api/home' ? 'use GET' : 'use POST');
        if (!PERSON_CAN[personRole]?.includes('seen')) return deny(403, `a ${personRole} can't mark projects seen`, 'Ask an owner of this workspace for a different role.');
        for (const p of hub.projects()) hub.humanOp(p.slug, 'seen', {}, by);
        return send(200, { ok: true });
      }
      // Get started (#117): the viewer's checklist, until every step is done or they hide it; then never again.
      if (path === '/api/get-started' || path === '/api/get-started/hide') {
        const me = viewer ?? HUMAN;
        if (req.method === 'POST' && path === '/api/get-started/hide') return send(200, { ok: true, show: false, ...finish(hub.db, me, 'hidden', hub.now()) });
        if (req.method !== 'GET' || path !== '/api/get-started') return deny(405, path === '/api/get-started' ? 'use GET' : 'use POST');
        const gone = finished(hub.db, me);
        if (gone) return send(200, { show: false, complete: gone.how === 'complete', ...gone, steps: [] });
        const gs = getStarted(facts(hub, {
          viewer: me, workspaces: !!spaces, app: await appState(hub), canCreateApp: !spaces && personRole === 'owner',
          installUrl: app?.slug ? app.installUrl() : '', root: spaces ? authOrigin(req) : '',
        }));
        if (gs.complete) finish(hub.db, me, 'complete', hub.now());
        return send(200, { show: !gs.complete, ...gs });
      }
      // The repositories the GitHub App can see, to make a project from one. Single hub only: on a workspaces hub
      // the app is shared, and its installations would show other organizations' repository names.
      if (req.method === 'GET' && path === '/api/github/repos') {
        if (spaces) return deny(403, 'on a hub with workspaces, projects are added by name and remote for now', 'The shared GitHub App would list other organizations\' repositories.');
        if (!['owner', 'steward'].includes(personRole)) return deny(403, `a ${personRole} can't add projects`, 'Ask an owner or steward.');
        if (!app) return deny(404, 'this hub has no GitHub App, so it can\'t list repositories', 'An owner creates one in one click: /api/github/app/new (Connect an agent → GitHub App). Or add the project by name and remote.');
        const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
        const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
        const all = (await app.repos()).filter((r) => !q || r.repo.slice('github.com/'.length).includes(q));
        const repos = all.slice((page - 1) * REPO_PAGE, page * REPO_PAGE).map((r) => ({ ...r, project: hub.projectByRemote(r.repo)?.slug ?? null }));
        return send(200, { repos, next_page: page * REPO_PAGE < all.length ? page + 1 : null });
      }
      if (req.method === 'POST' && path === '/api/projects') {
        if (!['owner', 'steward'].includes(personRole)) return deny(403, `a ${personRole} can't create projects`, 'Ask an owner or steward.');
        const b = await body(req);
        // From a repository: its name, a free slug, its description as the mission, and the remote linked.
        const repo = b.repo ? normRemote(b.repo) : '';
        if (b.repo && !/^github\.com\/[^/]+\/[^/]+$/.test(repo)) return deny(400, `"${b.repo}" isn't a GitHub repository`, 'e.g. github.com/acme/api');
        // By name: a remote typed in (any form git accepts) is linked too.
        const link = repo || (b.remote ? normRemote(b.remote) : '');
        if (b.remote && !link) return deny(400, `"${b.remote}" isn't a remote git understands`, 'e.g. github.com/acme/api or git@github.com:acme/api.git');
        const owner = link && hub.projectByRemote(link);
        if (owner) return deny(409, `${link} is already the project ${owner.name}`, `Open it: /#/p/${owner.slug}`);
        const name = b.name || repo.split('/').at(-1);
        const p = hub.tx(() => {
          let slug = slugify(b.slug || name);
          if (repo) for (let n = 2; hub.projects().some((x) => x.slug === slug); n++) slug = `${slugify(name)}-${n}`;
          const made = hub.project(slug, { create: true, name });
          if (link) hub.addRemote(made, link, by);
          return made;
        });
        if (b.mission) hub.humanOp(p.slug, 'settings', { mission: b.mission });
        hub.changed(p);
        return send(200, { ok: true, slug: p.slug, ...(repo ? { repo, runner_opt_in: true } : {}) });
      }
      if (req.method === 'GET' && path === '/api/tools') {
        return send(200, tools(url.searchParams.get('format') ?? 'mcp', url.searchParams.get('prefix') ?? ''));
      }

      let m;
      if ((m = path.match(/^\/api\/p\/([^/]+)\/view$/)) && req.method === 'GET') {
        hub.sweep();
        return send(200, view(hub, decodeURIComponent(m[1]), { viewer }));
      }
      // What finished work came to, for other tools (docs/API.md is the contract). Agent tokens read only their projects'.
      if ((m = path.match(/^\/api\/p\/([^/]+)\/outcomes$/)) && req.method === 'GET') {
        const slug = decodeURIComponent(m[1]);
        if (caller.scope && !caller.scope.includes(slug)) return deny(403, `this token can't read ${slug}`, 'Use a token made for that project (nuworq token create <name> --role agent --project <slug>).');
        return send(200, outcomes(hub, slug, { since: url.searchParams.get('since'), until: url.searchParams.get('until') }));
      }
      if ((m = path.match(/^\/api\/p\/([^/]+)\/items\/([^/]+)$/)) && req.method === 'GET') {
        return send(200, itemView(hub, decodeURIComponent(m[1]), decodeURIComponent(m[2])));
      }
      // Bring in the open issues of every GitHub repository of the project again (only new ones become items).
      if ((m = path.match(/^\/api\/p\/([^/]+)\/github\/resync$/)) && req.method === 'POST') {
        if (!['owner', 'steward'].includes(personRole)) return deny(403, `a ${personRole} can't resync issues`, 'Ask an owner or steward.');
        if (!app) return deny(424, 'no GitHub App configured', 'Start the hub with NUWORQ_GITHUB_APP_ID and NUWORQ_GITHUB_APP_KEY (docs/GITHUB.md).');
        const p = hub.project(decodeURIComponent(m[1]));
        const repos = hub.remotesOf(p).filter((r) => r.startsWith('github.com/'));
        return send(200, { ok: true, ...(await syncIssues(hub, p, appOf(hub), repos,{ link: itemLink(req, p.slug) })) });
      }
      if ((m = path.match(/^\/api\/p\/([^/]+)\/human\/([a-z]+)$/)) && req.method === 'POST') {
        if (!HUMAN_OP_NAMES.includes(m[2])) throw new UserError(`Unknown action "${m[2]}"`, { status: 404 });
        if (!PERSON_CAN[personRole]?.includes(m[2])) return deny(403, `a ${personRole} can't ${m[2]} here`, 'Ask an owner of this workspace for a different role.');
        const args = await body(req);
        if (personRole === 'member' && m[2] === 'create') args.stage = 'proposed'; // members propose; stewards decide
        if (DECIDES.human.includes(m[2])) await hub.prefetch(decodeURIComponent(m[1]), args);
        const out = hub.humanOp(decodeURIComponent(m[1]), m[2], args, by);
        // "Close them all" on stale issues: the proposals are dropped; now the issues close on GitHub.
        if (out.closing) out.github = app ? await closeStale(hub, hub.project(decodeURIComponent(m[1])), appOf(hub)) : { error: 'no GitHub App configured: the issues stay open on GitHub' };
        return send(200, out);
      }
      if ((m = path.match(/^\/api\/p\/([^/]+)\/agent\/([a-z]+)$/)) && req.method === 'POST') {
        const b = await body(req);
        const agent = header(req, 'agent') || b.agent;
        delete b.agent;
        if (DECIDES.agent.includes(m[2])) await hub.prefetch(decodeURIComponent(m[1]), b, { scope: caller.scope });
        return send(200, hub.agentOp(decodeURIComponent(m[1]), m[2], agent, b, { root: rootOf(req), remote: remoteOf(req), ...caller }));
      }
      // git asks for a credential (nuworq git-credential): a token for the repository of the item this
      // agent holds, minted by the GitHub App for that one repository and an hour. On the record, never shown.
      if (path === '/api/agent/credential' && req.method === 'POST') {
        const b = await body(req);
        const agent = header(req, 'agent') || b.agent;
        if (!app) return deny(404, "this hub has no GitHub App, so it hands out no GitHub tokens", 'An owner creates one in one click (Connect an agent → GitHub App), or the hub host sets NUWORQ_GITHUB_APP_ID and NUWORQ_GITHUB_APP_KEY_FILE (see docs/GITHUB.md). Until then, push with your own credentials.');
        // A worker cloning a project's repository it has no checkout of (nuworq run): read-only, no item needed.
        if (b.purpose === 'clone') {
          const p = hub.project(String(b.project ?? ''));
          if (caller.scope && !caller.scope.includes(p.slug)) return deny(403, `this token can't reach ${p.slug}`, 'Use an agent token for that project.');
          const repo = normRemote(b.repo ?? '');
          if (!hub.remotesOf(p).includes(repo)) return deny(400, `${repo || 'that'} isn't one of ${p.name}'s repositories`, `Its repositories: ${hub.remotesOf(p).join(', ') || 'none yet'}.`);
          const who = caller.token?.name ?? agent ?? 'a worker';
          let t;
          try {
            t = await appOf(hub).mint(repo, CLONE_PERMISSIONS);
          } catch (e) {
            if (e instanceof UserError) {
              hub.event(p, { actor: who, type: 'credential_refused', headline: `No GitHub token for ${who} to clone ${repo}: ${e.message}`, summary: e.hint ?? '', data: { agent: who, repo, purpose: 'clone' } });
              hub.changed(p);
            }
            throw e;
          }
          hub.event(p, {
            actor: who, type: 'credential',
            headline: `${who} got a read-only GitHub token to clone ${t.repo}, until ${new Date(t.expires_at).toISOString().slice(11, 16)} UTC`,
            data: { agent: who, repo: t.repo, purpose: 'clone', expires_at: t.expires_at, token: caller.token?.name ?? null },
          });
          hub.changed(p);
          return send(200, { ok: true, username: 'x-access-token', password: t.token, repo: t.repo, expires_at: t.expires_at });
        }
        const held = hub.q(`SELECT i.* FROM items i WHERE i.holder = ? AND i.stage IN ('active', 'landing') ORDER BY i.updated_at DESC`).all(String(agent ?? ''))
          .map((it) => ({ it, p: hub.q('SELECT * FROM projects WHERE id = ?').get(it.project_id) }))
          .find(({ p }) => !caller.scope || caller.scope.includes(p.slug));
        if (!held) return deny(409, `${agent || 'this agent'} holds no item to push for`, 'Tokens are for the item you hold: claim one (next), then push.');
        const { it, p } = held;
        const repo = it.repo || hub.remotesOf(p)[0] || '';
        // git asks on every fetch and push: the same agent, item and repository reuse the token while it's good.
        const key = `${hub.workspace ?? ''}|${agent}|${it.id}|${repo}`;
        const have = minted.get(key);
        if (have && Date.parse(have.expires_at) - 5 * 60_000 > Date.now()) {
          return send(200, { ok: true, username: 'x-access-token', password: have.token, repo: have.repo, expires_at: have.expires_at });
        }
        let t;
        try {
          t = await appOf(hub).mint(repo);
          for (const [k, v] of minted) if (Date.parse(v.expires_at) < Date.now()) minted.delete(k);
          minted.set(key, t);
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
        if (DECIDES.agent.includes(m[1])) await hub.prefetch('', b, { remote: remoteOf(req), root: rootOf(req), scope: caller.scope });
        return send(200, hub.agentOp('', m[1], agent, b, { root: rootOf(req), remote: remoteOf(req), ...caller }));
      }
      // Push channels: hub-wide (or workspace-wide) ones, and personal ones that get only what that person owns.
      // Agent tokens never reach these. An owner manages them all; a person manages their own.
      const own = who.person && personRole !== 'owner' ? by : null; // null: every channel
      if (req.method === 'GET' && path === '/api/notify') return send(200, { channels: listChannels(hub.db, { person: own }), kinds: KINDS, person: who.person ? by : null });
      if (req.method === 'POST' && path.startsWith('/api/notify') && personRole !== 'owner' && !(own && ['/api/notify', '/api/notify/remove'].includes(path))) {
        return deny(403, 'only an owner manages hub-wide push channels', 'Add one for yourself instead: it gets only what needs you.');
      }
      if (req.method === 'POST' && path === '/api/notify') {
        const b = await body(req);
        const c = addChannel(hub.db, b.kind, b.url, hub.now(), { person: own ?? b.person });
        hub.emit('change', { project: null, at: hub.now() });
        return send(200, { ok: true, ...c });
      }
      if (req.method === 'POST' && path === '/api/notify/remove') {
        const { id } = await body(req);
        if (own && channelOwner(hub.db, id) !== own) return deny(403, 'that channel isn\'t yours', 'You can remove only your own channels.');
        removeChannel(hub.db, id);
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
      if (req.method === 'GET' && path === '/api/claims') {
        return send(200, { claims: hub.claimsSince(url.searchParams.get('agent') ?? '', Number(url.searchParams.get('since')) || 0, { scope: caller.scope }) });
      }
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
