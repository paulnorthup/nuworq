// nuworq used to be called Trellis. Everything new uses the new names, and every old one keeps
// working as a silent fallback: these tests hold each fallback to that.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Hub, isSystem } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { openDb } from '../src/db.js';
import { view, itemView } from '../src/insight.js';
import { createServer } from '../src/server.js';
import { createClient, findConfig } from '../src/client.js';
import { findSecret } from '../src/secrets.js';
import { gitFacts } from '../src/git.js';
import { receive } from '../src/github.js';
import { envVar, dataDir, defaultDb } from '../src/names.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));
const OLD_BIN = fileURLToPath(new URL('../bin/trellis.js', import.meta.url));
const sha = (s) => createHash('sha256').update(s).digest();
const tmp = (name) => realpathSync(mkdtempSync(join(tmpdir(), `nuworq-${name}-`)));
const run = (bin, args, opts) => promisify(execFile)(process.execPath, [bin, ...args], opts);
// A child's environment: none of the shell's NUWORQ_* / TRELLIS_*, a throwaway HOME, plus what the test sets.
const envWith = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NUWORQ|TRELLIS)_/.test(k))),
  HOME: tmp('home'), NO_COLOR: '1', ...extra,
});

function start(hub, opts) {
  const server = createServer(hub, opts);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })));
}
const stop = ({ server }) => { server.close(); server.closeAllConnections(); };

// Raw http, so every header (Cookie, Origin, custom names) is exactly what the test says.
function request(port, method, path, { headers = {}, body } = {}) {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, json, text }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('environment: NUWORQ_* first, TRELLIS_* still read', () => {
  test('TRELLIS_<key> is read when NUWORQ_<key> is unset, and NUWORQ_<key> wins when both are set', () => {
    for (const key of ['URL', 'TOKEN', 'PROJECT', 'AGENT', 'MODEL', 'DB', 'PORT', 'HOST', 'HAS', 'PUBLIC_URL', 'DATA_DIR', 'AGENT_TOKEN', 'BASE_DOMAIN']) {
      assert.equal(envVar(key, { [`TRELLIS_${key}`]: 'old' }), 'old', key);
      assert.equal(envVar(key, { [`TRELLIS_${key}`]: 'old', [`NUWORQ_${key}`]: 'new' }), 'new', key);
      assert.equal(envVar(key, { [`NUWORQ_${key}`]: 'new' }), 'new', key);
      assert.equal(envVar(key, {}), undefined, key);
    }
  });

  test('the CLI finds the hub, project and agent from TRELLIS_* alone, and NUWORQ_* wins over them', async () => {
    const hub = new Hub();
    for (const s of ['old-p', 'new-p']) hub.tx(() => hub.project(s, { create: true }));
    const ctx = await start(hub);
    try {
      const cwd = tmp('cwd');
      const old = JSON.parse((await run(BIN, ['checkin'], { cwd, env: envWith({ TRELLIS_URL: ctx.url, TRELLIS_PROJECT: 'old-p', TRELLIS_AGENT: 'old-agent' }) })).stdout);
      assert.equal(old.project, 'old-p');
      assert.equal(old.you, 'old-agent');

      const both = JSON.parse((await run(BIN, ['checkin'], {
        cwd,
        env: envWith({
          TRELLIS_URL: 'http://127.0.0.1:9', NUWORQ_URL: ctx.url,
          TRELLIS_PROJECT: 'old-p', NUWORQ_PROJECT: 'new-p',
          TRELLIS_AGENT: 'old-agent', NUWORQ_AGENT: 'new-agent',
        }),
      })).stdout);
      assert.equal(both.project, 'new-p');
      assert.equal(both.you, 'new-agent');
      assert.deepEqual(view(hub, 'new-p').agents.map((a) => a.name), ['new-agent']);
    } finally {
      stop(ctx);
    }
  });
});

describe('project config: .nuworq.json, else .trellis.json', () => {
  test('.trellis.json is found walking up, and .nuworq.json wins in the same folder', () => {
    const dir = tmp('cfg');
    const deep = join(dir, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(dir, '.trellis.json'), JSON.stringify({ project: 'old', url: 'http://old.example' }));
    assert.deepEqual(findConfig(deep), { file: join(dir, '.trellis.json'), project: 'old', url: 'http://old.example' });
    writeFileSync(join(dir, '.nuworq.json'), JSON.stringify({ project: 'new' }));
    assert.deepEqual(findConfig(deep), { file: join(dir, '.nuworq.json'), project: 'new' });
  });

  test('the nearest folder still wins, whichever name its config has', () => {
    const dir = tmp('cfg');
    mkdirSync(join(dir, 'inner', 'deeper'), { recursive: true });
    writeFileSync(join(dir, '.nuworq.json'), JSON.stringify({ project: 'outer' }));
    writeFileSync(join(dir, 'inner', '.trellis.json'), JSON.stringify({ project: 'inner' }));
    assert.equal(findConfig(join(dir, 'inner', 'deeper')).project, 'inner');
  });

  test('init writes .nuworq.json, and counts an existing .trellis.json as existing config', async () => {
    const dir = tmp('init');
    writeFileSync(join(dir, '.trellis.json'), JSON.stringify({ project: 'old' }) + '\n');
    const env = envWith();
    const kept = (await run(BIN, ['init', '--project', 'fresh', '--url', 'http://127.0.0.1:4747'], { cwd: dir, env })).stdout;
    assert.match(kept, /\.trellis\.json already exists \(use --force to overwrite\)/);
    assert.equal(existsSync(join(dir, '.nuworq.json')), false);

    const forced = (await run(BIN, ['init', '--project', 'fresh', '--url', 'http://127.0.0.1:4747', '--force'], { cwd: dir, env })).stdout;
    assert.match(forced, /Wrote \.nuworq\.json → project "fresh"/);
    assert.match(forced, /claude mcp add --scope user nuworq -- node/);
    assert.equal(findConfig(dir).project, 'fresh');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.trellis.json'), 'utf8')), { project: 'old' }, 'the old file is left alone');
  });
});

describe('data folder: ~/.nuworq, else an existing ~/.trellis', () => {
  const home = (...files) => {
    const h = tmp('home');
    for (const f of files) {
      if (f.endsWith('/')) mkdirSync(join(h, f), { recursive: true });
      else { mkdirSync(join(h, f, '..'), { recursive: true }); writeFileSync(join(h, f), ''); }
    }
    return h;
  };

  test('the folder and database that exist are used, and nothing is moved or created', () => {
    const fresh = home();
    assert.equal(dataDir(fresh), join(fresh, '.nuworq'));
    assert.equal(defaultDb(fresh), join(fresh, '.nuworq', 'nuworq.db'));
    assert.equal(existsSync(join(fresh, '.nuworq')), false);

    const old = home('.trellis/trellis.db');
    assert.equal(dataDir(old), join(old, '.trellis'));
    assert.equal(defaultDb(old), join(old, '.trellis', 'trellis.db'));
    assert.equal(existsSync(join(old, '.nuworq')), false);

    const both = home('.trellis/trellis.db', '.nuworq/');
    assert.equal(dataDir(both), join(both, '.nuworq'));
    assert.equal(defaultDb(both), join(both, '.nuworq', 'nuworq.db'));

    // The owner renamed the folder by hand; the database inside kept its old name.
    const moved = home('.nuworq/trellis.db');
    assert.equal(defaultDb(moved), join(moved, '.nuworq', 'trellis.db'));
    const renamed = home('.nuworq/trellis.db', '.nuworq/nuworq.db');
    assert.equal(defaultDb(renamed), join(renamed, '.nuworq', 'nuworq.db'));
  });

  test('the CLI keeps using an existing ~/.trellis: its trellis.db, workspaces and hub.json', async () => {
    const h = tmp('home');
    const old = join(h, '.trellis');
    const hub = new Hub({ file: join(old, 'trellis.db') });
    hub.tx(() => hub.project('legacy', { create: true }));
    hub.db.close();
    const env = envWith({ HOME: h });

    await run(BIN, ['token', 'create', 'pat', '--role', 'human'], { env });
    assert.deepEqual(new Auth(openDb(join(old, 'trellis.db'))).listTokens().map((t) => t.name), ['pat']);
    await run(BIN, ['workspace', 'create', 'acme'], { env });
    assert.ok(existsSync(join(old, 'workspaces', 'acme.db')));

    // serve writes ~/.trellis/hub.json, and a client with no URL finds the hub through it.
    const serve = spawn(process.execPath, [BIN, 'serve', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error(`serve did not start: ${out}`)), 5000);
        serve.stdout.on('data', (d) => { out += d; if (/is running at/.test(out)) { clearTimeout(timer); resolve(); } });
        serve.on('exit', (code) => reject(new Error(`serve exited ${code}: ${out}`)));
      });
      assert.match(JSON.parse(readFileSync(join(old, 'hub.json'), 'utf8')).url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match((await run(BIN, ['status', '--all'], { env, cwd: tmp('cwd') })).stdout, /legacy/);
    } finally {
      serve.kill('SIGTERM');
    }
    assert.equal(existsSync(join(h, '.nuworq')), false, 'no ~/.nuworq appears next to the old folder');
  });
});

describe('HTTP headers: x-nuworq-*, else x-trellis-*', () => {
  let hub, ctx;
  before(async () => {
    hub = new Hub();
    hub.tx(() => hub.project('demo', { create: true }));
    ctx = await start(hub);
  });
  after(() => stop(ctx));

  test('the hub accepts the old x-trellis-agent, x-trellis-root and x-trellis-remote headers', async () => {
    const r = await request(ctx.port, 'POST', '/api/p/demo/agent/checkin', {
      body: {},
      headers: { 'x-trellis-agent': 'old-1', 'x-trellis-root': encodeURIComponent('/code/demo app'), 'x-trellis-remote': encodeURIComponent('github.com/acme/demo') },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.you, 'old-1');
    assert.equal(hub.project('demo').path, '/code/demo app');
    assert.equal(hub.projectByRemote('github.com/acme/demo')?.slug, 'demo');

    // No project named: the old root header alone finds it.
    const here = await request(ctx.port, 'POST', '/api/agent/checkin', { body: {}, headers: { 'x-trellis-agent': 'old-2', 'x-trellis-root': encodeURIComponent('/code/demo app') } });
    assert.equal(here.status, 200, here.text);
    assert.equal(here.json.project, 'demo');
    assert.equal(here.json.you, 'old-2');
  });

  test('x-nuworq-* wins when both names are sent', async () => {
    const r = await request(ctx.port, 'POST', '/api/p/demo/agent/checkin', { body: {}, headers: { 'x-nuworq-agent': 'new-1', 'x-trellis-agent': 'stale-1' } });
    assert.equal(r.json.you, 'new-1');
    assert.ok(!view(hub, 'demo').agents.some((a) => a.name === 'stale-1'));
  });

  test('the client sends each header under both names, so a hub not yet updated still understands it', async () => {
    let seen;
    const spy = http.createServer((req, res) => { seen = req.headers; res.end('{}'); });
    await new Promise((r) => spy.listen(0, '127.0.0.1', r));
    try {
      await createClient({ url: `http://127.0.0.1:${spy.address().port}`, project: 'p', token: '', cwd: tmp('cwd') }).call('checkin', {}, { agent: 'a1' });
    } finally {
      spy.close();
    }
    assert.equal(seen['x-nuworq-agent'], 'a1');
    assert.equal(seen['x-trellis-agent'], 'a1');
    assert.ok(seen['x-nuworq-root']);
    assert.equal(seen['x-trellis-root'], seen['x-nuworq-root']);
  });
});

describe('tokens: nwq_ now, and trl_ ones still authenticate', () => {
  let hub, ctx, auth;
  before(async () => {
    hub = new Hub();
    hub.tx(() => hub.project('demo', { create: true }));
    ctx = await start(hub, { auth: 'required' });
    auth = ctx.server.auth;
  });
  after(() => stop(ctx));
  // A token as the old code made it: only its hash and first 8 characters are stored.
  const oldToken = (name, role, personId = null) => {
    const token = 'trl_' + randomBytes(32).toString('base64url');
    hub.db.prepare('INSERT INTO tokens (name, role, hash, prefix, person_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(name, role, sha(token), token.slice(0, 8), personId, Date.now());
    return token;
  };

  test('new tokens start nwq_ and invites nwi_', () => {
    assert.match(auth.createToken('fresh-agent', 'agent'), /^nwq_[\w-]{43}$/);
    assert.match(auth.createInvite('member').token, /^nwi_[\w-]{32}$/);
  });

  test('a trl_ agent token still authenticates and works', async () => {
    const old = oldToken('old-agent', 'agent');
    const me = await request(ctx.port, 'GET', '/api/me', { headers: { authorization: `Bearer ${old}` } });
    assert.deepEqual(me.json, { auth: 'required', role: 'agent', name: 'old-agent' });
    const r = await request(ctx.port, 'POST', '/api/p/demo/agent/checkin', { body: {}, headers: { authorization: `Bearer ${old}`, 'x-trellis-agent': 'legacy-bot' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.you, 'legacy-bot');
  });

  test('a trl_ human token still logs in, and a tri_ invite still opens', async () => {
    const person = auth.addPerson('oldtimer', 'owner');
    const old = oldToken('oldtimer-laptop', 'human', person.id);
    const login = await request(ctx.port, 'POST', '/api/login', { body: { token: old } });
    assert.equal(login.status, 200, login.text);
    assert.match(login.headers['set-cookie'][0], /^nuworq_session=/);

    const invite = 'tri_' + randomBytes(24).toString('base64url');
    hub.db.prepare('INSERT INTO invites (hash, role, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(invite), 'steward', Date.now(), Date.now() + 3600_000);
    const peek = await request(ctx.port, 'POST', '/api/invite/peek', { body: { token: invite } });
    assert.deepEqual(peek.json, { ok: true, role: 'steward' });
  });

  test('both token shapes are caught as secrets', () => {
    const tail = Array.from({ length: 43 }, (_, i) => 'abcdefghijKLMNOP0123456789_-'[(i * 7 + 3) % 28]).join('');
    for (const t of [`nwq_${tail}`, `trl_${tail}`]) assert.deepEqual(findSecret({ summary: `use ${t}` }), { path: 'summary', kind: 'a nuworq token' }, t);
  });
});

describe('session cookie: nuworq_session, else trellis_session', () => {
  let hub, ctx, human;
  before(async () => {
    hub = new Hub();
    hub.tx(() => hub.project('demo', { create: true }));
    ctx = await start(hub, { auth: 'required' });
    human = ctx.server.auth.createToken('paul', 'human');
  });
  after(() => stop(ctx));

  test('an old trellis_session cookie still signs you in, and logging out clears nuworq_session', async () => {
    const login = await request(ctx.port, 'POST', '/api/login', { body: { token: human } });
    const sid = login.headers['set-cookie'][0].match(/^nuworq_session=([\w-]+);/)[1];
    const old = `trellis_session=${sid}`;
    assert.deepEqual((await request(ctx.port, 'GET', '/api/me', { headers: { cookie: old } })).json, { auth: 'required', role: 'human', name: 'paul' });
    assert.equal((await request(ctx.port, 'GET', '/api/p/demo/view', { headers: { cookie: old } })).status, 200);
    // Both present: the new one is the one read.
    assert.equal((await request(ctx.port, 'GET', '/api/p/demo/view', { headers: { cookie: `trellis_session=${'x'.repeat(43)}; nuworq_session=${sid}` } })).status, 200);

    const out = await request(ctx.port, 'POST', '/api/logout', { headers: { cookie: old, origin: ctx.url } });
    assert.equal(out.status, 200);
    assert.match(out.headers['set-cookie'][0], /^nuworq_session=; HttpOnly; SameSite=Strict; Path=\/; Max-Age=0$/);
    assert.equal((await request(ctx.port, 'GET', '/api/p/demo/view', { headers: { cookie: old } })).status, 401);
  });
});

describe('worker branches: nuworq/<agent>, and trellis/<agent> from before', () => {
  test('git facts find a trellis/<agent> branch, one named in the evidence, and prefer nuworq/<agent>', () => {
    const dir = tmp('git');
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'f'), '0');
    g('add', '.');
    g('commit', '-qm', 'init');
    for (const b of ['trellis/w1', 'trellis/other']) {
      g('checkout', '-q', '-b', b, 'main');
      writeFileSync(join(dir, 'f'), b);
      g('commit', '-qam', `work on ${b}`);
    }
    g('checkout', '-q', 'main');

    const w1 = gitFacts(dir, 'w1', { headline: 'done' });
    assert.equal(w1.branch, 'trellis/w1');
    assert.deepEqual(w1.commits.map((c) => c.subject), ['work on trellis/w1']);
    assert.equal(gitFacts(dir, 'someone', { headline: 'pushed to trellis/other' }).branch, 'trellis/other');

    g('branch', 'nuworq/w1', 'trellis/w1');
    assert.equal(gitFacts(dir, 'w1', { headline: 'done' }).branch, 'nuworq/w1');
  });

  test('a pull request from trellis/<agent> links to the item that agent holds', () => {
    const hub = new Hub();
    hub.tx(() => hub.project('app', { create: true }));
    hub.humanOp('app', 'settings', { github_secret: 'shh' });
    hub.humanOp('app', 'create', { title: 'Old branch work', acceptance: 'x' });
    hub.agentOp('app', 'next', 'claude-1', {});
    const raw = Buffer.from(JSON.stringify({
      action: 'opened', repository: { full_name: 'paulnorthup/nuworq' },
      pull_request: { number: 9, html_url: 'https://github.com/paulnorthup/nuworq/pull/9', state: 'open', title: 'Old branch work', head: { ref: 'trellis/claude-1', sha: 'a'.repeat(40) } },
    }));
    const signature = 'sha256=' + createHmac('sha256', 'shh').update(raw).digest('hex');
    assert.deepEqual(receive(hub, 'app', { event: 'pull_request', signature, raw }), { ok: true, item: '#1', pr: 9, state: 'open' });
  });
});

describe("the hub's own entries", () => {
  test('"trellis" on events from before still counts as the hub, and both names stay reserved for agents', () => {
    assert.ok(isSystem('nuworq'));
    assert.ok(isSystem('trellis'));
    assert.ok(!isSystem('claude-1'));

    const hub = new Hub();
    const p = hub.tx(() => hub.project('demo', { create: true }));
    const { item } = hub.humanOp('demo', 'create', { title: 'x', acceptance: 'x' });
    hub.agentOp('demo', 'claim', 'claude-1', { item });
    hub.tx(() => hub.event(p, { item: hub.item(p, item), actor: 'trellis', type: 'lease_expired', headline: 'recorded before the rename' }));
    assert.deepEqual(itemView(hub, 'demo', item).agents.map((a) => a.name), ['claude-1']);

    for (const name of ['nuworq', 'trellis', 'Trellis']) assert.throws(() => hub.agentOp('demo', 'checkin', name, {}), /reserved/, name);
  });

  test('seed refuses a hub that already has the project under its old slug', async () => {
    const file = join(tmp('seed'), 'hub.db');
    const hub = new Hub({ file });
    hub.tx(() => hub.project('trellis', { create: true, name: 'Trellis' }));
    hub.db.close();
    await assert.rejects(run(BIN, ['seed', '--db', file], { env: envWith() }), (e) => /already has a "trellis" project/.test(e.stderr));
  });
});

describe('bin/trellis.js', () => {
  test('still runs: help exits 0 and prints the nuworq help', async () => {
    const { stdout } = await run(OLD_BIN, ['help'], { env: envWith() });
    assert.match(stdout, /^nuworq [0-9.]+: a hub where agents do the work and people steer/);
  });

  test('stays a bin in package.json next to nuworq', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.name, 'nuworq');
    assert.deepEqual(pkg.bin, { nuworq: './bin/nuworq.js', trellis: './bin/trellis.js' });
  });

  test('an MCP registration pointing at bin/trellis.js, with TRELLIS_* env, still works', async () => {
    const hub = new Hub();
    hub.tx(() => hub.project('mcp-old', { create: true }));
    const ctx = await start(hub);
    const child = spawn(process.execPath, [OLD_BIN, 'mcp'], {
      env: envWith({ TRELLIS_URL: ctx.url, TRELLIS_PROJECT: 'mcp-old', TRELLIS_AGENT: 'legacy-1', TRELLIS_MODEL: 'gpt-5', TRELLIS_HAS: 'docker,macos' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pending = new Map();
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        pending.get(msg.id)?.(msg);
      }
    });
    let id = 0;
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const myId = ++id;
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 5000);
      pending.set(myId, (m) => { clearTimeout(timer); resolve(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    });
    try {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } });
      assert.equal(init.result.serverInfo.name, 'nuworq');
      const checkin = await rpc('tools/call', { name: 'checkin', arguments: {} });
      assert.ok(!checkin.result.isError, checkin.result.content[0].text);
      assert.equal(JSON.parse(checkin.result.content[0].text).you, 'legacy-1');
      const agent = view(hub, 'mcp-old').agents.find((a) => a.name === 'legacy-1');
      assert.equal(agent.model, 'gpt-5');
      assert.deepEqual(agent.has, ['docker', 'macos']);
    } finally {
      child.kill();
      stop(ctx);
    }
  });
});
