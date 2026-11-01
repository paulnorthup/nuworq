import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { APP_EVENTS, manifest } from '../src/ghapp.js';
import { wiringGaps, wiringEntry, appSettingsUrl } from '../src/appwiring.js';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const ALL = { permissions: { ...manifest('https://hub.test', 'nuworq').default_permissions }, events: [...APP_EVENTS] };
const until = async (fn, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (await fn()) return true;
  return false;
};

describe("the hub checks its GitHub App's events and permissions (#220)", () => {
  test('missing events, a missing permission, and everything present', () => {
    assert.equal(wiringGaps(ALL), null, 'everything there: nothing to say');
    assert.equal(wiringGaps({ ...ALL, permissions: { ...ALL.permissions, contents: 'admin' } }), null, 'more than asked is fine');

    const none = wiringGaps({ ...ALL, events: [] });
    assert.deepEqual(none, { events: APP_EVENTS, permissions: [] });
    assert.equal(wiringGaps({ ...ALL, events: [] }, { events: false }), null, 'a hub GitHub can\'t deliver to needs no events');

    const read = wiringGaps({ ...ALL, permissions: { ...ALL.permissions, issues: 'read' }, events: APP_EVENTS.filter((e) => e !== 'dependabot_alert') });
    assert.deepEqual(read.permissions, [{ name: 'issues', want: 'write', have: 'read' }]);
    assert.deepEqual(read.events, ['dependabot_alert']);

    const e = wiringEntry({ gaps: read, url: 'https://github.com/settings/apps/nuworq/permissions', installations: 'https://github.com/settings/installations', since: 1 });
    assert.match(e.headline, /missing a permission and an event/);
    assert.match(e.why, /GitHub issues won't come in as work/);
    assert.match(e.why, /Dependabot alerts won't come in as work/);
    assert.equal(e.how[0].where, 'https://github.com/settings/apps/nuworq/permissions');
    assert.ok(e.how.some((s) => /Issues to "Read and write"/.test(s.do)), 'the exact permission and level');
    assert.ok(e.how.some((s) => /tick "Dependabot alert"/.test(s.do)), 'the exact box to tick');
    assert.ok(e.how.some((s) => /Save changes/.test(s.do)));
    assert.ok(e.how.some((s) => /Accept new permissions/.test(s.do) && s.where), 'installations accept a new permission');

    // Members is an organization permission (#478): its step names that section, not the repository one.
    const { members, ...older } = ALL.permissions;
    const org = wiringGaps({ ...ALL, permissions: { ...older, issues: 'read' } });
    assert.deepEqual(org.permissions.map((p) => p.name), ['issues', 'members']);
    const how = wiringEntry({ gaps: org, url: 'u', installations: 'i', since: 1 }).how.map((s) => s.do);
    assert.ok(how.includes('Under "Repository permissions", set Issues to "Read and write"'), how.join('\n'));
    assert.ok(how.includes('Under "Organization permissions", set Members to "Read-only"'), how.join('\n'));

    assert.equal(appSettingsUrl({ slug: 'nuworq', owner: { login: 'acme', type: 'Organization' } }), 'https://github.com/organizations/acme/settings/apps/nuworq/permissions');
    assert.equal(appSettingsUrl({ slug: 'nuworq', owner: { login: 'paul', type: 'User' } }), 'https://github.com/settings/apps/nuworq/permissions');
  });

  test('the owners see one Needs you entry with the steps; it clears once GitHub reports them, and a GitHub that doesn\'t answer says nothing', async () => {
    const said = { status: 200, body: { id: 1234, slug: 'nuworq', owner: { login: 'paul', type: 'User' }, permissions: ALL.permissions, events: [] } };
    let asked = 0;
    const gh = http.createServer((req, res) => {
      if (req.url === '/app') asked++;
      res.writeHead(req.url === '/app' ? said.status : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/app' ? said.body : {}));
    });
    const api = `http://127.0.0.1:${await listen(gh)}`;
    const hub = new Hub();
    for (const slug of ['api', 'web']) hub.tx(() => hub.project(slug, { create: true }));
    const server = createServer(hub, { githubApp: { id: 1234, key: PEM, webhook_secret: 's', api }, sweepMs: 20, appCheckMs: 0 });
    const url = `http://127.0.0.1:${await listen(server)}`;
    const entries = async (slug = 'api') => (await (await fetch(`${url}/api/p/${slug}/view`)).json()).attention.filter((a) => a.kind === 'app-wiring');
    const home = async () => (await (await fetch(`${url}/api/home`)).json()).needs.filter((a) => a.kind === 'app-wiring');
    try {
      assert.ok(await until(async () => (await entries()).length === 1), 'missing events reach Needs you');
      const [e] = await entries();
      assert.equal(e.level, 'act');
      assert.match(e.headline, /missing 7 events/);
      assert.equal(e.how[0].where, 'https://github.com/settings/apps/nuworq/permissions');
      assert.equal((await home()).length, 1, 'once on the home, not once per project');

      // GitHub stops answering: the hub asks again later and keeps what it last knew, saying nothing new.
      said.status = 502;
      const before = asked;
      assert.ok(await until(() => asked > before + 1), 'asks again');
      assert.equal((await entries()).length, 1);

      // Everything ticked on GitHub: the entry clears itself.
      Object.assign(said, { status: 200, body: { ...said.body, events: [...APP_EVENTS] } });
      assert.ok(await until(async () => (await entries()).length === 0), 'cleared');
      assert.equal((await home()).length, 0);
    } finally {
      for (const s of [server, gh]) { s.close(); s.closeAllConnections(); }
    }
  });

  test('no App, or one GitHub never answers for: nothing shows', async () => {
    const hubWith = () => { const h = new Hub(); h.tx(() => h.project('api', { create: true })); return h; };
    const plain = createServer(hubWith(), { sweepMs: 20, appCheckMs: 0 });
    const quiet = createServer(hubWith(), { githubApp: { id: 1, key: PEM, webhook_secret: 's', api: 'http://127.0.0.1:9' }, sweepMs: 20, appCheckMs: 0 });
    try {
      for (const s of [plain, quiet]) {
        const at = `http://127.0.0.1:${await listen(s)}`;
        await new Promise((r) => setTimeout(r, 200));
        assert.deepEqual((await (await fetch(`${at}/api/p/api/view`)).json()).attention.filter((a) => a.kind === 'app-wiring'), []);
      }
    } finally {
      for (const s of [plain, quiet]) { s.close(); s.closeAllConnections(); }
    }
  });
});
