import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

// GitHub, as far as listing goes: two installations (acme: 3 repos; globex: 30, so there is a second page),
// a metadata token per installation, and the repositories each token can see.
function github() {
  const repos = {
    1: ['api', 'web', 'cli'].map((n) => ({ full_name: `acme/${n}`, name: n, description: `Acme ${n}`, private: n === 'cli' })),
    2: Array.from({ length: 30 }, (_, i) => ({ full_name: `globex/r${String(i).padStart(2, '0')}`, name: `r${String(i).padStart(2, '0')}`, description: null, private: false })),
  };
  const state = { mints: [] };
  const server = http.createServer((req, res) => {
    const json = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    const auth = String(req.headers.authorization ?? '');
    let m;
    if (req.method === 'GET' && req.url === '/app/installations?per_page=100&page=1') return json(200, [{ id: 1 }, { id: 2 }]);
    if (req.method === 'POST' && (m = req.url.match(/^\/app\/installations\/(\d+)\/access_tokens$/))) {
      state.mints.push(Number(m[1]));
      return json(201, { token: `ghs_${m[1]}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (req.method === 'GET' && req.url === '/installation/repositories?per_page=100&page=1' && (m = auth.match(/^Bearer ghs_(\d+)$/))) {
      return json(200, { total_count: repos[m[1]].length, repositories: repos[m[1]] });
    }
    json(404, { message: 'Not Found' });
  });
  return { server, state };
}

async function hubWithApp({ auth = 'local' } = {}) {
  const gh = github();
  const api = `http://127.0.0.1:${await listen(gh.server)}`;
  const hub = new Hub();
  const server = createServer(hub, { auth, githubApp: { id: 1, key: PEM, slug: 'nuworq-test', api } });
  const base = `http://127.0.0.1:${await listen(server)}`;
  const call = async (method, path, body, headers = {}) => {
    // Creating a project is the person's act: their key rides along (#900).
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${server.personKey}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  return { gh, hub, server, call, close: () => { server.close(); gh.server.close(); } };
}

describe('"+ Project" from the repositories the GitHub App can see', () => {
  test('lists every installation\'s repositories, 30 a page, filtered by q, with linked ones marked; tokens reused', async () => {
    const { gh, hub, call, close } = await hubWithApp();
    try {
      hub.tx(() => hub.project('core', { create: true }));
      hub.addRemote(hub.project('core'), 'git@github.com:acme/api.git', 'you');
      const one = await call('GET', '/api/github/repos');
      assert.equal(one.status, 200);
      assert.equal(one.json.repos.length, 30);
      assert.equal(one.json.next_page, 2);
      assert.deepEqual(one.json.repos[0], { repo: 'github.com/acme/api', name: 'api', description: 'Acme api', private: false, project: 'core' });
      assert.equal(one.json.repos[1].project, null);
      const two = await call('GET', '/api/github/repos?page=2');
      assert.equal(two.json.repos.length, 3);
      assert.equal(two.json.next_page, null);
      assert.deepEqual([...one.json.repos, ...two.json.repos].map((r) => r.repo.split('/')[1]).filter((o, i, a) => a.indexOf(o) === i), ['acme', 'globex'], 'both installations');
      assert.deepEqual((await call('GET', '/api/github/repos?q=ACME')).json.repos.map((r) => r.name), ['api', 'cli', 'web']);
      assert.deepEqual((await call('GET', '/api/github/repos?q=acme/w')).json.repos.map((r) => r.name), ['web']);
      assert.deepEqual(gh.state.mints, [1, 2], 'one metadata token per installation, reused across listings');
    } finally { close(); }
  });

  test('picking one creates the project from it: name, slug, mission, remote; a linked repo is a 409; slugs never collide', async () => {
    const { hub, call, close } = await hubWithApp();
    try {
      const r = await call('POST', '/api/projects', { repo: 'https://github.com/Acme/web.git', mission: 'Acme web' });
      assert.deepEqual(r.json, { ok: true, slug: 'web', repo: 'github.com/acme/web', runner_opt_in: true });
      const p = hub.project('web');
      assert.equal(p.name, 'web');
      assert.equal(p.mission, 'Acme web');
      assert.deepEqual(hub.remotesOf(p), ['github.com/acme/web']);

      const again = await call('POST', '/api/projects', { repo: 'github.com/acme/web' });
      assert.equal(again.status, 409);
      assert.match(again.json.error, /github\.com\/acme\/web is already the project web/);

      hub.tx(() => hub.project('cli', { create: true }));
      const cli = await call('POST', '/api/projects', { repo: 'github.com/acme/cli' });
      assert.equal(cli.json.slug, 'cli-2', 'an unlinked project named cli keeps its name; the new one gets its own');
      assert.deepEqual(hub.remotesOf(hub.project('cli')), []);
      assert.equal((await call('POST', '/api/projects', { repo: 'gitlab.com/x/y' })).status, 400);

      // By name, with a remote typed in: linked the same way, and a remote already in a project is a 409.
      const byName = await call('POST', '/api/projects', { name: 'Proxy', remote: 'git@gitlab.com:acme/proxy.git' });
      assert.deepEqual(byName.json, { ok: true, slug: 'proxy' });
      assert.deepEqual(hub.remotesOf(hub.project('proxy')), ['gitlab.com/acme/proxy']);
      const taken = await call('POST', '/api/projects', { name: 'Proxy two', remote: 'https://gitlab.com/acme/proxy' });
      assert.equal(taken.status, 409);
      assert.match(taken.json.error, /gitlab\.com\/acme\/proxy is already the project Proxy/);
      assert.equal(hub.projects().some((x) => x.name === 'Proxy two'), false, 'nothing half-made');
    } finally { close(); }
  });

  test('without an app: 404 with how to make one; agent tokens: 403; a workspaces hub: 403', async () => {
    const hub = new Hub();
    const plain = createServer(hub);
    const base = `http://127.0.0.1:${await listen(plain)}`;
    try {
      const r = await fetch(`${base}/api/github/repos`);
      assert.equal(r.status, 404);
      assert.match((await r.json()).hint, /Create|api\/github\/app\/new/);
    } finally { plain.close(); }

    const { server, call, close } = await hubWithApp({ auth: 'required' });
    try {
      const agent = server.auth.createToken('bot', 'agent');
      assert.equal((await call('GET', '/api/github/repos', null, { authorization: `Bearer ${agent}` })).status, 403);
    } finally { close(); }

    const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-np-')) });
    spaces.create('acme');
    const { Auth } = await import('../src/auth.js');
    const boss = new Auth(spaces.get('acme').db).createToken('boss', 'human');
    const ws = createServer(spaces, { githubApp: { id: 1, key: PEM, api: 'http://127.0.0.1:9' } });
    const wsBase = `http://127.0.0.1:${await listen(ws)}`;
    try {
      const r = await fetch(`${wsBase}/w/acme/api/github/repos`, { headers: { authorization: `Bearer ${boss}` } });
      assert.equal(r.status, 403);
    } finally { ws.close(); }
  });
});
