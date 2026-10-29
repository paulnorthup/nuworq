import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError, HUMAN_OP_NAMES, HUMAN, PERSON_CAN } from './core.js';
import { view, itemView, projectList } from './insight.js';
import { tools, guide } from './protocol.js';
import { Auth, SESSION_MS } from './auth.js';
import { Workspaces } from './workspaces.js';
import { KINDS, addChannel, listChannels, removeChannel, testChannels } from './notify.js';
import { receive } from './github.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8' };
const MAX_BODY = 1024 * 1024;
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const COOKIE = 'trellis_session';
const LOGIN_WINDOW = 10 * 60_000, LOGIN_MAX_FAILS = 10;
// What an agent-role token may reach in required mode.
const AGENT_ROUTES = [/^POST \/api\/p\/[^/]+\/agent\/[a-z]+$/, /^POST \/api\/agent\/[a-z]+$/, /^GET \/api\/(tools|guide|info|me|route|where)$/, /^GET \/agents\.md$/];
const LOOPBACK = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

// auth: 'local' (no login; loopback only) or 'required' (tokens + sessions).
// target: one Hub (today's single hub), or a Workspaces registry: then each request is resolved to a
// workspace by subdomain of baseDomain or a /w/<slug>/ path prefix, and login is always required.
export function createServer(target, { auth = 'local', trustProxy = false, baseDomain = '', sweepMs = 15_000, publicUrl = '' } = {}) {
  const spaces = target instanceof Workspaces ? target : null;
  const required = spaces ? true : auth === 'required';
  const failures = new Map(); // ip → [timestamps of failed logins]
  // Per hub: its tokens and sessions, and the browsers streaming its changes. Nothing is shared across hubs.
  const scopes = new Map();
  const scopeOf = (hub) => {
    let s = scopes.get(hub);
    if (!s) {
      s = { authz: new Auth(hub.db), clients: new Set() };
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
  const cookieOf = (req) => {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return null;
  };
  const sameOrigin = (req) => {
    try { return new URL(req.headers.origin).host === hostOf(req); } catch { return false; }
  };
  const recentFailures = (ip) => {
    const now = Date.now();
    const list = (failures.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW);
    failures.set(ip, list);
    if (failures.size > 10_000) failures.clear();
    return list;
  };

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
      // Which hub: the only one, or the workspace this address names.
      let hub = target, base = '';
      if (spaces) {
        const host = hostname(hostOf(req));
        const sub = baseDomain && host.endsWith(`.${baseDomain}`) ? host.slice(0, -baseDomain.length - 1) : null;
        const pre = sub == null ? path.match(/^\/w\/([^/]+)(\/.*)?$/) : null;
        const slug = sub ?? (pre ? decodeURIComponent(pre[1]) : null);
        if (slug == null) {
          if (path === '/api/health') return send(200, { ok: true, name: 'trellis', workspaces: true });
          return deny(404, 'this address names no workspace', `Use <workspace>.${baseDomain || '<base-domain>'} or /w/<workspace>/.`);
        }
        hub = spaces.get(slug);
        if (!hub) return deny(404, `no workspace "${slug}"`, 'Workspaces are created on the hub host: trellis workspace create <name>.');
        if (pre) {
          base = `/w/${pre[1]}`;
          path = pre[2] ?? '';
          if (!path) { res.writeHead(308, { location: `${base}/` }); return res.end(); }
        }
      }
      const { authz, clients } = scopeOf(hub);
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
      if (req.method === 'GET' && path === '/api/health') return send(200, { ok: true, name: 'trellis' });
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
        res.setHeader('set-cookie', `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=${SESSION_MS / 1000}${https(req) ? '; Secure' : ''}`);
        return send(200, { ok: true, name: t.name });
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
        res.setHeader('set-cookie', `${COOKIE}=${r.sid}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=${SESSION_MS / 1000}${https(req) ? '; Secure' : ''}`);
        const who = `@${r.person.handle}`;
        for (const p of hub.projects()) {
          hub.event(p, { actor: who, type: 'joined', headline: `${who} joined as ${r.person.role}${r.invitedBy ? `, invited by ${r.invitedBy}` : ''}` });
          hub.changed(p);
        }
        return send(200, { ok: true, person: who, role: r.person.role });
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
            bearer ? 'Check TRELLIS_TOKEN; tokens are managed with `trellis token` on the hub host.' : 'Log in at /login.html, or send Authorization: Bearer <token>.');
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
          return send(200, { ok: true, person: path === '/api/people' ? authz.addPerson(b.handle, b.role, { name: b.name, email: b.email }) : authz.setRole(b.handle, b.role) });
        } catch (e) {
          throw new UserError(e.message);
        }
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
        return send(200, { bin: join(WEB, '..', 'bin', 'trellis.js'), url: origin(req) + base, auth: required ? 'required' : 'local', workspace: hub.workspace });
      }
      // "Needs you" is the viewer's own: a person sees what is theirs as act, the rest as worth knowing.
      const viewer = who.person ? by : undefined;
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
      if (req.method === 'GET' && (path === '/agents.md' || path === '/api/guide')) {
        return send(200, guide({ project: url.searchParams.get('project') ?? '<project>', url: origin(req) + base, via: url.searchParams.get('via') ?? 'tools' }), TYPES['.md']);
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
        const agent = req.headers['x-trellis-agent'] || b.agent;
        delete b.agent;
        return send(200, hub.agentOp(decodeURIComponent(m[1]), m[2], agent, b, { root: rootOf(req), remote: remoteOf(req), ...caller }));
      }
      // No project named: the agent's folder picks it, or the hub routes the agent to the most valuable work.
      if ((m = path.match(/^\/api\/agent\/([a-z]+)$/)) && req.method === 'POST') {
        const b = await body(req);
        const agent = req.headers['x-trellis-agent'] || b.agent;
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
        const results = await testChannels(hub.db, { baseUrl: publicUrl || origin(req) + base, now: () => hub.now() });
        hub.emit('change', { project: null, at: hub.now() });
        return send(200, { ok: results.every((r) => r.ok), results });
      }
      if (req.method === 'GET' && path === '/api/route') return send(200, hub.route('', { runner: !!url.searchParams.get('runner'), scope: caller.scope, powers: who.role === 'agent' ? who.powers : null }));
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

const rootOf = (req) => { try { return decodeURIComponent(req.headers['x-trellis-root'] ?? ''); } catch { return ''; } };
const remoteOf = (req) => { try { return decodeURIComponent(req.headers['x-trellis-remote'] ?? ''); } catch { return ''; } };

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
