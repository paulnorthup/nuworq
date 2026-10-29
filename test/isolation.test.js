import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { Workspaces } from '../src/workspaces.js';
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
    const mints = [];
    const api = http.createServer(async (req, res) => {
      const json = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      for await (const _ of req);
      if (req.url === '/repos/acme/api/installation') return json(200, { id: 42 });
      if (req.url === '/app/installations/42/access_tokens') { mints.push(1); return json(201, { token: 'ghs_x', expires_at: new Date(Date.now() + 3600e3).toISOString() }); }
      json(404, {});
    });
    const apiUrl = `http://127.0.0.1:${await listen(api)}`;
    const spaces = new Workspaces({ dir: tmp('nuworq-iso-app-') });
    spaces.create('alpha');
    spaces.create('bravo');
    const app = new GitHubApp({ id: 1, key: PEM, slug: 'nuworq-test', api: apiUrl });
    const server = createServer(spaces, { githubApp: app });
    const url = `http://127.0.0.1:${await listen(server)}`;
    const installed = (state, id = 42) => fetch(`${url}/api/github/installed?installation_id=${id}&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
    const as = (ws) => app.scoped((id) => spaces.directory.installation(id) === ws);
    try {
      // Before anyone installed from inside an organization, neither gets a token.
      await assert.rejects(as('bravo').mint('github.com/acme/api'), (e) => e.status === 403 && /installed for another organization/.test(e.message));

      assert.equal((await installed('alpha.9999999999999.forged')).status, 400, 'a forged state binds nothing');
      const ok = await installed(installState(app, 'alpha'));
      assert.equal(ok.status, 302);
      assert.equal(ok.headers.get('location'), '/w/alpha/#github-installed');
      assert.equal(spaces.directory.installation(42), 'alpha');
      assert.equal((await installed(installState(app, 'bravo'))).status, 409, 'the first binding stands');

      assert.equal((await as('alpha').mint('github.com/acme/api')).token, 'ghs_x');
      await assert.rejects(as('bravo').mint('github.com/acme/api'), (e) => e.status === 403 && /install/i.test(e.hint));
      assert.equal(mints.length, 1, 'bravo never got as far as a token');
      assert.equal((await app.mint('github.com/acme/api')).token, 'ghs_x', 'the unscoped app (single hub) is unchanged');
    } finally {
      server.close();
      api.close();
      spaces.close();
    }
  });
});
