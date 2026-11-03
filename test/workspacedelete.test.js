import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspaces } from '../src/workspaces.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { createClient } from '../src/client.js';
import { run } from '../src/runner.js';

// #799: a workspace's owner deletes it in the app, typing its name; it goes exactly as `nuworq workspace remove` does.

function request(port, method, path, { headers = {}, body } = {}) {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const DAY = 24 * 60 * 60 * 1000;

describe('deleting a workspace from the app', () => {
  let ctx;
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuworq-wsdel-'));
    const spaces = new Workspaces({ dir });
    const server = createServer(spaces, {});
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    ctx = { spaces, server, port: server.address().port, dir };
  });
  after(() => { ctx.server.close(); ctx.server.closeAllConnections(); ctx.spaces.close(); });
  const call = (method, path, opts) => request(ctx.port, method, path, opts);

  // A workspace with an owner, a member and an agent, a project with an item, and its directory rows.
  function workspace(name) {
    ctx.spaces.create(name);
    const hub = ctx.spaces.get(name);
    hub.tx(() => hub.project('rockets', { create: true }));
    hub.humanOp('rockets', 'create', { title: 'Launch', acceptance: 'x' });
    const auth = new Auth(hub.db);
    const tokens = {
      owner: auth.createToken('ann', 'human', { personRole: 'owner' }),
      member: auth.createToken('bob', 'human', { personRole: 'member' }),
      agent: auth.createToken('bot', 'agent'),
    };
    hub.db.prepare("UPDATE people SET email = 'ann@acme.test', verified_at = 1 WHERE handle = 'ann'").run();
    const d = ctx.spaces.directory;
    d.identify('ann@acme.test', 'github');
    d.join('ann@acme.test', name, { created: true });
    d.bindInstallation(Math.floor(Math.random() * 1e9) + 1, name);
    return { hub, tokens };
  }
  // The hub's log line, kept for the test that reads it rather than printed.
  const logged = [];
  const del = async (name, token, typed = name) => {
    const was = console.log;
    console.log = (...a) => logged.push(a.join(' '));
    try { return await call('POST', `/w/${name}/api/workspace/delete`, { headers: bearer(token), body: { name: typed } }); } finally { console.log = was; }
  };

  test('an owner deletes it: its files, copies and directory rows go, the hub logs who and when, and the name starts clean', async () => {
    const { tokens } = workspace('acme');
    const adopted = join(ctx.dir, 'acme-adopted.db');
    writeFileSync(adopted, 'the single hub it came from');
    ctx.spaces.directory.setting('adopted:acme', adopted);
    const info = await call('GET', '/w/acme/api/workspace', { headers: bearer(tokens.owner) });
    assert.equal(info.status, 200, info.text);
    assert.deepEqual([info.json.owner, info.json.renewing, info.json.github.length], [true, false, 1]);
    assert.match(info.json.github[0].url, /^https:\/\/github\.com\/settings\/installations\/\d+$/, "where to uninstall the app");

    const r = await del('acme', tokens.owner);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.deleted, r.json.home], ['acme', `http://127.0.0.1:${ctx.port}/`], 'back to their list of workspaces');
    assert.ok(logged.some((l) => /^Workspace acme deleted by @ann \(ann@acme\.test\) at \d{4}-\d\d-\d\dT/.test(l)), logged.join('\n'));
    for (const f of ['acme.db', 'acme.db-wal', 'acme.db-shm']) assert.ok(!existsSync(join(ctx.dir, f)), f);
    assert.ok(!existsSync(adopted), 'the copy it was adopted from goes too');
    assert.ok(!ctx.spaces.list().includes('acme'));
    const d = ctx.spaces.directory;
    assert.equal(d.db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE workspace = 'acme'").get().n, 0);
    assert.deepEqual(d.installationsOf('acme'), []);
    assert.ok(ctx.spaces.deleted('acme'));

    ctx.spaces.create('acme');
    assert.equal(ctx.spaces.deleted('acme'), null, 'the next acme is not "deleted"');
    assert.equal((await call('GET', '/w/acme/api/projects', { headers: bearer(tokens.agent) })).status, 401, "the old tokens are just unknown to the new one");
    assert.deepEqual(ctx.spaces.get('acme').projects(), []);
    ctx.spaces.remove('acme');
  });

  test('a member, an agent, a wrong name and a plan that renews are each refused, and nothing is removed', async () => {
    const { tokens } = workspace('beta');
    const member = await del('beta', tokens.member);
    assert.equal(member.status, 403);
    assert.match(member.json.hint, /@ann/, 'names who can');
    assert.equal((await call('GET', '/w/beta/api/workspace', { headers: bearer(tokens.member) })).json.owner, false);
    assert.equal((await del('beta', tokens.agent)).status, 403);
    const wrong = await del('beta', tokens.owner, 'Beta');
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.hint, /exactly: beta/);
    assert.equal((await del('beta', tokens.owner, '')).status, 400);
    ctx.spaces.directory.setBilling('sub_beta', { workspace: 'beta', customer: 'cus_beta' }, { status: 'active', period_end: Date.now() + 20 * DAY });
    const renews = await del('beta', tokens.owner);
    assert.equal(renews.status, 409);
    assert.match(renews.json.hint, /Cancel the plan first/);
    assert.equal((await call('GET', '/w/beta/api/workspace', { headers: bearer(tokens.owner) })).json.renewing, true);
    assert.ok(existsSync(join(ctx.dir, 'beta.db')));
    assert.deepEqual(ctx.spaces.get('beta').projects().map((p) => p.slug), ['rockets']);
    assert.equal(ctx.spaces.deleted('beta'), null);

    // Set to end at the period's end: it may go.
    ctx.spaces.directory.setBilling('sub_beta', {}, { status: 'active', period_end: Date.now() + 20 * DAY, cancel_at_period_end: true });
    assert.equal((await call('GET', '/w/beta/api/workspace', { headers: bearer(tokens.owner) })).json.renewing, false);
    assert.equal((await del('beta', tokens.owner)).status, 200);
    assert.ok(!existsSync(join(ctx.dir, 'beta.db')));
  });

  test("its old tokens get one clear error, its members a page that says so, and a runner stops polling", async () => {
    const { tokens } = workspace('gamma');
    assert.equal((await del('gamma', tokens.owner)).status, 200);
    for (const t of [tokens.agent, tokens.member]) {
      const r = await call('GET', '/w/gamma/api/route', { headers: bearer(t) });
      assert.equal(r.status, 410);
      assert.equal(r.json.error, 'Workspace gamma was deleted');
      assert.equal(r.json.hint, 'Run nuworq disconnect to forget it here.');
    }
    const page = await call('GET', '/w/gamma/');
    assert.equal(page.status, 410);
    assert.match(page.text, /The workspace <b>gamma<\/b> was deleted by its owner/);
    assert.equal((await call('GET', '/w/gamma/style.css')).status, 200, 'the page keeps its styles');
    assert.equal((await call('GET', '/w/nobody/api/route')).status, 404, 'a name never used is still unknown');

    const client = createClient({ url: `http://127.0.0.1:${ctx.port}/w/gamma`, token: tokens.agent, cwd: tmpdir() });
    let asked = 0;
    const lines = [];
    const out = await run({
      routes: () => { asked++; return client.get('/api/route?runner=1'); },
      launch: async () => assert.fail('nothing to launch'),
      log: (l) => lines.push(l),
      sleep: async () => {},
      pollSeconds: 1,
    });
    assert.equal(asked, 1, 'asked once, then stopped');
    assert.equal(out.deleted, true);
    assert.ok(lines.includes('Workspace gamma was deleted. Run nuworq disconnect to forget it here.'), lines.join('\n'));
    assert.ok(!lines.some((l) => /retrying/.test(l)), lines.join('\n'));
  });

  test("Workspace settings show for a workspace's owners on a hub that takes no payments", async () => {
    const { tokens } = workspace('delta');
    assert.equal((await call('GET', '/w/delta/api/billing', { headers: bearer(tokens.owner) })).status, 404, 'no billing here');
    assert.equal((await call('GET', '/w/delta/api/workspace', { headers: bearer(tokens.owner) })).json.owner, true);
    const { S, setState } = await import('../web/store.js');
    const { railHtml, wsOwner } = await import('../web/views/rail.js');
    const entry = () => railHtml().includes('data-action="workspace-settings"');
    setState({ me: { org: 'delta', orgs: [] }, person: { person: '@ann', role: 'owner' }, billing: null });
    assert.ok(wsOwner() && entry(), "an owner's rail has it");
    setState({ person: { person: '@bob', role: 'member' } });
    assert.ok(!wsOwner() && !entry(), "a member's doesn't");
    setState({ me: { auth: 'local' }, person: { person: 'you', role: 'owner' } });
    assert.ok(!entry(), 'a hub without workspaces offers nothing new');
    assert.equal(S.billing, null);
  });
});

test('the CLI remove and the app share one path: remove marks the name deleted until it is taken again', () => {
  const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-wsdel-')) });
  spaces.directory.identify('ann@acme.test', 'github'); // a hub that has served it has a directory
  spaces.create('acme');
  spaces.remove('acme');
  assert.ok(spaces.deleted('acme') > 0);
  assert.equal(spaces.deleted('never'), null);
  spaces.create('acme');
  assert.equal(spaces.deleted('acme'), null);
  spaces.close();
});
