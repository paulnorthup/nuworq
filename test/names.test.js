// Only nuworq's own names are read (#792): its environment variables, config file, data folder and database,
// tokens, session cookie, headers and branches. The product's former name is left nowhere in the repository, and
// no module only re-imports another (a shim like that hid an old name and could hide a bug).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Hub, isSystem } from '../src/core.js';
import { openDb, MIGRATIONS } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createClient, findConfig } from '../src/client.js';
import { envVar, dataDir, defaultDb, CONFIG_FILE } from '../src/names.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// The former name, built so this file doesn't hold it either.
const OLD = ['tre', 'llis'].join('');
const OLD_ENV = OLD.toUpperCase() + '_';
const sha = (s) => createHash('sha256').update(s).digest();
const tmp = (name) => realpathSync(mkdtempSync(join(tmpdir(), `nuworq-${name}-`)));

function start(hub, opts) {
  const server = createServer(hub, opts);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })));
}
const stop = ({ server }) => { server.close(); server.closeAllConnections(); };

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

describe('where nuworq reads its settings', () => {
  test('environment: NUWORQ_<key> only', () => {
    for (const key of ['URL', 'TOKEN', 'PROJECT', 'AGENT', 'DB', 'DATA_DIR', 'REPOS']) {
      assert.equal(envVar(key, { [`NUWORQ_${key}`]: 'new' }), 'new', key);
      assert.equal(envVar(key, { [`${OLD_ENV}${key}`]: 'old' }), undefined, key);
    }
  });

  test('project config: the nearest .nuworq.json, and no file under another name', () => {
    const dir = tmp('cfg');
    const deep = join(dir, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    assert.equal(CONFIG_FILE, '.nuworq.json');
    writeFileSync(join(deep, `.${OLD}.json`), JSON.stringify({ project: 'old' }));
    assert.equal(findConfig(deep), null);
    writeFileSync(join(dir, '.nuworq.json'), JSON.stringify({ project: 'new' }));
    assert.deepEqual(findConfig(deep), { file: join(dir, '.nuworq.json'), project: 'new' });
  });

  test('data folder and database: ~/.nuworq/nuworq.db, whatever else the home holds', () => {
    const h = tmp('home');
    mkdirSync(join(h, `.${OLD}`));
    writeFileSync(join(h, `.${OLD}`, `${OLD}.db`), '');
    assert.equal(dataDir(h), join(h, '.nuworq'));
    assert.equal(defaultDb(h), join(h, '.nuworq', 'nuworq.db'));
    mkdirSync(join(h, '.nuworq'));
    writeFileSync(join(h, '.nuworq', `${OLD}.db`), '');
    assert.equal(defaultDb(h), join(h, '.nuworq', 'nuworq.db'));
  });

  test('package.json installs one command, nuworq', () => {
    assert.deepEqual(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).bin, { nuworq: './bin/nuworq.js' });
  });
});

describe('what the hub accepts', () => {
  let hub, ctx;
  before(async () => {
    hub = new Hub();
    hub.tx(() => hub.project('demo', { create: true }));
    ctx = await start(hub, { auth: 'required' });
  });
  after(() => stop(ctx));

  test('a token without the nwq_ prefix does not authenticate, even with a stored hash', async () => {
    const old = 'trl_' + randomBytes(32).toString('base64url');
    hub.db.prepare('INSERT INTO tokens (name, role, hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)').run('old', 'agent', sha(old), old.slice(0, 8), Date.now());
    assert.equal((await request(ctx.port, 'GET', '/api/p/demo/view', { headers: { authorization: `Bearer ${old}` } })).status, 401);
    const fresh = ctx.server.auth.createToken('fresh', 'human');
    assert.match(fresh, /^nwq_/);
    assert.equal((await request(ctx.port, 'GET', '/api/p/demo/view', { headers: { authorization: `Bearer ${fresh}` } })).status, 200);
  });

  test('only the nuworq_session cookie signs in', async () => {
    const human = ctx.server.auth.createToken('paul', 'human');
    const login = await request(ctx.port, 'POST', '/api/login', { body: { token: human } });
    assert.equal(login.status, 200, login.text);
    const sid = login.headers['set-cookie'][0].match(/^nuworq_session=([\w-]+);/)[1];
    assert.equal((await request(ctx.port, 'GET', '/api/p/demo/view', { headers: { cookie: `nuworq_session=${sid}` } })).status, 200);
    assert.equal((await request(ctx.port, 'GET', '/api/p/demo/view', { headers: { cookie: `${OLD}_session=${sid}` } })).status, 401);
  });
});

describe('headers', () => {
  test('the hub reads x-nuworq-* only', async () => {
    const hub = new Hub();
    hub.tx(() => hub.project('demo', { create: true }));
    const ctx = await start(hub);
    try {
      const r = await request(ctx.port, 'POST', '/api/p/demo/agent/checkin', { body: {}, headers: { 'x-nuworq-agent': 'new-1', [`x-${OLD}-agent`]: 'old-1' } });
      assert.equal(r.json.you, 'new-1');
      const old = await request(ctx.port, 'POST', '/api/p/demo/agent/checkin', { body: {}, headers: { [`x-${OLD}-agent`]: 'old-2' } });
      assert.notEqual(old.json?.you, 'old-2', old.text);
    } finally {
      stop(ctx);
    }
  });

  test('the client sends each header once, as x-nuworq-*', async () => {
    let seen;
    const spy = http.createServer((req, res) => { seen = req.headers; res.end('{}'); });
    await new Promise((r) => spy.listen(0, '127.0.0.1', r));
    try {
      await createClient({ url: `http://127.0.0.1:${spy.address().port}`, project: 'p', token: '', cwd: tmp('cwd') }).call('checkin', {}, { agent: 'a1' });
    } finally {
      spy.close();
    }
    assert.equal(seen['x-nuworq-agent'], 'a1');
    assert.ok(seen['x-nuworq-root']);
    assert.deepEqual(Object.keys(seen).filter((k) => k.startsWith('x-') && !k.startsWith('x-nuworq-')), []);
  });
});

describe("the hub's own entries", () => {
  test('the migration records the former name as "nuworq", and only "nuworq" and "github" count as the hub', () => {
    const file = join(tmp('migrate'), 'hub.db');
    const hub = new Hub({ file });
    const p = hub.tx(() => hub.project('demo', { create: true }));
    const { item } = hub.humanOp('demo', 'create', { title: 'x', acceptance: 'x' });
    hub.tx(() => hub.event(p, { item: hub.item(p, item), actor: OLD, type: 'lease_expired', headline: 'recorded under the former name' }));
    hub.db.exec(`INSERT INTO transitions (item_id, stage, actor, at) VALUES (1, 'ready', '${OLD}', 0)`);
    hub.db.close();
    const d = new DatabaseSync(file);
    d.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
    d.close();

    const db = openDb(file);
    assert.equal(db.prepare('SELECT count(*) AS n FROM events WHERE actor = ?').get(OLD).n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM transitions WHERE actor = ?').get(OLD).n, 0);
    assert.equal(db.prepare(`SELECT actor FROM events WHERE headline = 'recorded under the former name'`).get().actor, 'nuworq');
    db.close();

    assert.ok(isSystem('nuworq'));
    assert.ok(!isSystem(OLD));
  });
});

describe('the repository', () => {
  const tracked = () => execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);

  test('no tracked file mentions the former name, except the upgrade note #792 adds to CHANGELOG.md', () => {
    let out = '';
    try {
      out = execFileSync('git', ['grep', '-n', '-i', '-I', OLD], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) {
      if (e.status !== 1) throw e; // 1: nothing found
    }
    const hits = out.split('\n').filter(Boolean).filter((l) => !/^CHANGELOG\.md:\d+:.*\(#792\)/.test(l));
    assert.deepEqual(hits, [], 'use the nuworq names');
    assert.ok(!tracked().some((f) => f.toLowerCase().includes(OLD)), 'no file is named after it');
  });

  test('no module under bin/, src/, web/ or scripts/ only imports or re-exports another', () => {
    const shims = tracked().filter((f) => /^(bin|src|web|scripts)\/.*\.m?js$/.test(f)).filter((f) => {
      const code = readFileSync(join(ROOT, f), 'utf8')
        .replace(/^#!.*\n/, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/^\s*import\s*(?:[\w*{][\s\S]*?\bfrom\s*)?['"][^'"]+['"]\s*;?/gm, '')
        .replace(/^\s*export\s*(?:\*|\{)[\s\S]*?\bfrom\s*['"][^'"]+['"]\s*;?/gm, '');
      return !code.trim();
    });
    assert.deepEqual(shims, [], 'a module that only points at another hides what runs: import the real one');
  });
});
