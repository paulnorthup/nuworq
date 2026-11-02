import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { Workspaces } from '../src/workspaces.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { mirror, fetchMirror, mirrorPath } from '../src/git.js';
import { GitHubApp, installState } from '../src/ghapp.js';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));

// A stand-in ssh that records how it was called and refuses; GIT_SSH_COMMAND set for the hub points at
// another one, which must never run for a hosted organization.
function sshes() {
  const dir = tmp('nuworq-iso-ssh-');
  const own = join(dir, 'own.log'), hubs = join(dir, 'hub.log');
  writeFileSync(join(dir, 'hub-ssh'), `#!/bin/sh\necho "$@" >> '${hubs}'\nexit 255\n`, { mode: 0o755 });
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'ssh'), `#!/bin/sh\necho "$@" >> '${own}'\nexit 255\n`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND, GIT_SSH: process.env.GIT_SSH };
  process.env.PATH = `${join(dir, 'bin')}:${process.env.PATH}`;
  process.env.GIT_SSH_COMMAND = join(dir, 'hub-ssh');
  delete process.env.GIT_SSH;
  return {
    dir,
    own: () => (existsSync(own) ? readFileSync(own, 'utf8') : ''),
    hub: () => (existsSync(hubs) ? readFileSync(hubs, 'utf8') : ''),
    restore: () => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; },
  };
}

// A hosted hub reads only what an organization was granted (#59).
describe('a shared hub keeps organizations apart', () => {
  test('no path on the hub\'s disk: linking one is refused, and one already linked is never fetched; a single hub is unchanged', () => {
    const spaces = new Workspaces({ dir: tmp('nuworq-iso-ws-'), repos: tmp('nuworq-iso-repos-') });
    try {
      spaces.create('acme');
      const hub = spaces.get('acme');
      hub.tx(() => hub.project('app', { create: true }));
      for (const r of ['/srv/git/other-tenant', 'file:///srv/git/other-tenant']) {
        assert.throws(() => hub.addRemote(hub.project('app'), r, 'you'), (e) => e.status === 400 && /path on the hub's machine/.test(e.message) && !!e.hint);
      }
      assert.ok(hub.agentOp('app', 'checkin', 'a1', {}, { remote: '/srv/git/other-tenant' }), 'a checkin from such a folder still works');
      assert.deepEqual(hub.remotesOf(hub.project('app')), []);
      // One linked before this rule: never read.
      hub.q('INSERT INTO project_remotes (project_id, remote, at) VALUES (?, ?, ?)').run(hub.project('app').id, '/srv/git/other-tenant', 0);
      assert.equal(hub.repoFor(hub.project('app')), null);
      assert.ok(!existsSync(mirrorPath(hub.repos, '/srv/git/other-tenant')), 'nothing was cloned');

      const single = new Hub();
      single.tx(() => single.project('app', { create: true }));
      assert.equal(single.addRemote(single.project('app'), '/srv/git/mine', 'you'), '/srv/git/mine');
    } finally { spaces.close(); }
  });

  test("over SSH only with the organization's own deploy key, never the hub's identity", async () => {
    const s = sshes();
    try {
      const keys = join(s.dir, 'keys');
      const repos = join(s.dir, 'repos');
      // No key of its own, no app token: refused without running ssh at all, in the background or not.
      assert.match(mirror(repos, 'github.com/acme/api', { keys, hosted: true }).error, /no access to github\.com\/acme\/api yet/);
      assert.match((await fetchMirror(repos, 'github.com/acme/api', { keys, hosted: true })).error, /no access to github\.com\/acme\/api yet/);
      assert.equal(s.hub(), '');
      assert.equal(s.own(), '');
      // With its own key: that key, even though the hub's GIT_SSH_COMMAND says otherwise.
      mkdirSync(join(keys, 'github.com', 'acme'), { recursive: true });
      writeFileSync(join(keys, 'github.com', 'acme', 'api'), 'a private key\n', { mode: 0o600 });
      assert.ok((await fetchMirror(repos, 'github.com/acme/api', { keys, hosted: true })).error, 'refused by the stand-in ssh');
      assert.match(s.own(), new RegExp(`-i ${keys}/github\\.com/acme/api -o IdentitiesOnly=yes`));
      assert.equal(s.hub(), '', "the hub's own ssh never ran");
      // A single hub still honours the hub's GIT_SSH_COMMAND.
      await fetchMirror(repos, 'github.com/acme/web', { keys });
      assert.notEqual(s.hub(), '');
    } finally { s.restore(); }
  });

  test('an app installation belongs to the organization it was installed from; others get no token for its repositories', async () => {
    // GitHub: one installation (42) that reaches acme/api.
    // Installers: code "alice" is a person who can see installation 42 (and 7); "mallory" sees only 99.
    // "reader" sees 42 too, as a plain member of acme, and 8, on carol's account (#478).
    const mints = [], users = { alice: [42, 7], mallory: [99], reader: [42, 8] };
    const accounts = { 42: { login: 'acme', type: 'Organization' }, 7: { login: 'alice', type: 'User' }, 8: { login: 'carol', type: 'User' }, 99: { login: 'mallory', type: 'User' } };
    const roles = { alice: { acme: 'admin' }, reader: { acme: 'member' } };
    const api = http.createServer(async (req, res) => {
      const json = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      let raw = '';
      for await (const c of req) raw += c;
      if (req.method === 'POST' && req.url === '/login/oauth/access_token') {
        const b = JSON.parse(raw);
        return json(200, b.client_id === 'cid' && b.client_secret === 'csec' && users[b.code] ? { access_token: `ghu_${b.code}` } : { error: 'bad_verification_code' });
      }
      if (req.url.startsWith('/user/installations')) {
        const who = String(req.headers.authorization).replace('Bearer ghu_', '');
        return users[who] ? json(200, { total_count: users[who].length, installations: users[who].map((id) => ({ id, account: accounts[id] })) }) : json(401, {});
      }
      const who = String(req.headers.authorization).replace('Bearer ghu_', '');
      if (req.url === '/user') return users[who] ? json(200, { login: who }) : json(401, {});
      const org = req.url.match(/^\/user\/memberships\/orgs\/([^/?]+)$/)?.[1];
      if (org) return roles[who]?.[org] ? json(200, { state: 'active', role: roles[who][org] }) : json(404, {});
      if (req.url === '/repos/acme/api/installation') return json(200, { id: 42 });
      if (req.url === '/app/installations/42/access_tokens') { mints.push(1); return json(201, { token: 'ghs_x', expires_at: new Date(Date.now() + 3600e3).toISOString() }); }
      json(404, {});
    });
    const apiUrl = `http://127.0.0.1:${await listen(api)}`;
    const spaces = new Workspaces({ dir: tmp('nuworq-iso-app-') });
    spaces.create('alpha');
    spaces.create('bravo');
    const app = new GitHubApp({ id: 1, key: PEM, slug: 'nuworq-test', client_id: 'cid', client_secret: 'csec', api: apiUrl, web: apiUrl });
    const server = createServer(spaces, { githubApp: app });
    const url = `http://127.0.0.1:${await listen(server)}`;
    const installed = (state, id = 42, code = 'alice') => fetch(`${url}/api/github/installed?installation_id=${id}&state=${encodeURIComponent(state)}${code ? `&code=${code}` : ''}`, { redirect: 'manual' });
    const as = (ws) => app.scoped((id) => spaces.directory.installation(id) === ws);
    try {
      // Before anyone installed from inside an organization, neither gets a token.
      await assert.rejects(as('bravo').mint('github.com/acme/api'), (e) => e.status === 403 && /installed for another workspace/.test(e.message));

      assert.equal((await installed('alpha.9999999999999.forged')).status, 400, 'a forged state binds nothing');
      // A real state from bravo, but an installation_id its installer can't see: alpha's, forged into the redirect.
      const forged = await installed(installState(app, 'bravo'), 42, 'mallory');
      assert.equal(forged.status, 403);
      assert.match((await forged.json()).error, /installation 42 isn't on your account or a GitHub organization you're an admin of/);
      assert.equal(spaces.directory.installation(42), null, 'nothing bound');
      const noCode = await installed(installState(app, 'bravo'), 42, '');
      assert.equal(noCode.status, 400);
      assert.match((await noCode.json()).hint, /Request user authorization \(OAuth\) during installation/);
      assert.equal((await installed(installState(app, 'bravo'), 42, 'expired')).status, 400, 'a code GitHub refuses binds nothing');
      // Seeing an installation isn't owning it (#478): a member of acme who isn't its admin, and a collaborator on
      // carol's repositories, bind nothing.
      assert.equal((await installed(installState(app, 'bravo'), 42, 'reader')).status, 403, "acme's plain member");
      assert.equal((await installed(installState(app, 'bravo'), 8, 'reader')).status, 403, "carol's collaborator");
      assert.equal(spaces.directory.installation(42), null);
      assert.equal(spaces.directory.installation(8), null);
      assert.equal(await app.installedBy('alice', 7), true, 'an installation on your own account is yours');

      const ok = await installed(installState(app, 'alpha'));
      assert.equal(ok.status, 302);
      assert.equal(ok.headers.get('location'), '/w/alpha/#github-installed');
      assert.equal(spaces.directory.installation(42), 'alpha');
      assert.equal((await installed(installState(app, 'bravo'))).status, 409, 'the first binding stands');

      assert.equal((await as('alpha').mint('github.com/acme/api')).token, 'ghs_x');
      await assert.rejects(as('bravo').mint('github.com/acme/api'), (e) => e.status === 403 && /install/i.test(e.hint));
      assert.equal(mints.length, 1, 'bravo never got as far as a token');
      assert.equal((await app.mint('github.com/acme/api')).token, 'ghs_x', 'the unscoped app (single hub) is unchanged');
      // An app without its client id and secret can't check, so it binds nothing.
      await assert.rejects(new GitHubApp({ id: 1, key: PEM, api: apiUrl, web: apiUrl }).installedBy('alice', 42), (e) => e.status === 424 && /NUWORQ_GITHUB_APP_CLIENT_ID/.test(e.hint));

      // Get started: both organizations link acme/api, but only alpha's checklist counts the app as installed.
      for (const ws of ['alpha', 'bravo']) {
        const hub = spaces.get(ws);
        hub.addRemote(hub.tx(() => hub.project('api', { create: true })), 'github.com/acme/api', 'you');
      }
      const github = async (ws) => {
        const token = new Auth(spaces.get(ws).db).createToken(`gs-${ws}`, 'human');
        const gs = await (await fetch(`${url}/w/${ws}/api/get-started`, { headers: { authorization: `Bearer ${token}` } })).json();
        return gs.steps.find((s) => s.key === 'github').done;
      };
      assert.equal(await github('alpha'), true);
      assert.equal(await github('bravo'), false, "alpha's installation isn't bravo's");
      assert.equal(await as('bravo').installed('github.com/acme/api'), false);
      assert.equal(await as('bravo').installed(), false, 'scoped: never "installed anywhere"');
      assert.equal(await app.installed('github.com/acme/api'), true, 'unscoped: unchanged');
    } finally {
      server.close();
      api.close();
      spaces.close();
    }
  });

  test("the sweep's release preconditions read GitHub only through the workspace's own installation (#758)", async () => {
    // acme/api is private: its latest release answers only to a token, minted through installation 42 (alpha's).
    const api = http.createServer((req, res) => {
      const json = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.url === '/repos/acme/api/installation') return json(200, { id: 42, account: { login: 'acme' } });
      if (req.method === 'POST' && req.url === '/app/installations/42/access_tokens') return json(201, { token: 'ghs_alpha', expires_at: new Date(Date.now() + 3600e3).toISOString() });
      if (req.url === '/repos/acme/api/releases/latest') return req.headers.authorization === 'Bearer ghs_alpha' ? json(200, { tag_name: 'v9.9.9' }) : json(404, { message: 'Not Found' });
      json(404, { message: 'Not Found' });
    });
    const apiUrl = `http://127.0.0.1:${await listen(api)}`;
    const spaces = new Workspaces({ dir: tmp('nuworq-iso-pre-') });
    const item = {};
    for (const ws of ['alpha', 'bravo']) {
      spaces.create(ws);
      const hub = spaces.get(ws);
      hub.tx(() => hub.project('w', { create: true }));
      hub.humanOp('w', 'settings', { autonomy: 'full' });
      // bravo links alpha's private repository too, and waits on its release.
      hub.q('INSERT INTO project_remotes (project_id, remote, at) VALUES (?, ?, ?)').run(hub.project('w').id, 'github.com/acme/api', 0);
      hub.agentOp('w', 'propose', 'a', { title: 'Adopt', acceptance: 'x', precondition: { kind: 'release', repo: 'acme/api', min: '1.0.0' } });
      item[ws] = () => hub.item(hub.project('w'), '#1');
    }
    spaces.directory.bindInstallation(42, 'alpha');
    const app = new GitHubApp({ id: 1, key: PEM, api: apiUrl, web: apiUrl });
    const server = createServer(spaces, { githubApp: app, github: { api: apiUrl, web: apiUrl }, sweepMs: 20 });
    try {
      for (let i = 0; i < 250 && !(item.alpha().last_check && item.bravo().last_check); i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(item.alpha().stage, 'ready', 'alpha reads its own repository');
      assert.match(JSON.parse(item.alpha().last_check).detail, /9\.9\.9/);
      const b = item.bravo();
      assert.equal(b.stage, 'outside', "bravo gets no token through alpha's installation");
      assert.doesNotMatch(JSON.parse(b.last_check).detail, /9\.9\.9/, 'and learns no tag');
    } finally {
      server.close();
      api.close();
      spaces.close();
    }
  });
});
