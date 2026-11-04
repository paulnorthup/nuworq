import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

const SECRET = 'a-long-shared-secret';
const sign = (raw) => 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

const repository = { full_name: 'acme/api', html_url: 'https://github.com/acme/api' };
// A Dependabot alert as GitHub's REST API and webhook carry it.
const alert = (number, { severity = 'high', patched = '4.17.21', state = 'open', pkg = 'lodash' } = {}) => ({
  number, state, html_url: `https://github.com/acme/api/security/dependabot/${number}`,
  dependency: { package: { ecosystem: 'npm', name: pkg }, manifest_path: 'package-lock.json', scope: 'runtime' },
  security_advisory: { ghsa_id: `GHSA-${number}xxx-yyyy-zzzz`, cve_id: `CVE-2026-${1000 + number}`, summary: `Prototype pollution in ${pkg}`, severity },
  security_vulnerability: { package: { ecosystem: 'npm', name: pkg }, severity, vulnerable_version_range: '< 4.17.21', first_patched_version: patched ? { identifier: patched } : null },
});

// GitHub's REST API, as far as alert intake uses it: the installation (with the permissions it has accepted),
// a token (refused for permissions it hasn't), open issues (none) and open alerts, paged by cursor.
function github() {
  const state = { alerts: [alert(1), alert(2, { severity: 'low' })], off: false, perms: { contents: 'write', issues: 'write', metadata: 'read', vulnerability_alerts: 'read' }, issues: [] };
  const server = http.createServer(async (req, res) => {
    const json = (status, b, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(b)); };
    let raw = '';
    for await (const c of req) raw += c;
    const auth = String(req.headers.authorization ?? '');
    if (req.method === 'GET' && req.url === '/repos/acme/api/installation') return json(200, { id: 42, account: { login: 'acme', type: 'Organization' }, permissions: state.perms });
    if (req.method === 'POST' && req.url === '/app/installations/42/access_tokens') {
      const want = Object.keys(JSON.parse(raw).permissions ?? {});
      if (want.some((k) => !state.perms[k])) return json(422, { message: 'The permissions requested are not granted to this installation.' });
      return json(201, { token: 'ghs_t', expires_at: '2026-10-30T13:00:00Z' });
    }
    if (auth !== 'Bearer ghs_t') return json(401, { message: 'Bad credentials' });
    if (req.method === 'GET' && req.url.startsWith('/repos/acme/api/issues?')) return json(200, state.issues);
    if (req.method === 'GET' && req.url.startsWith('/repos/acme/api/dependabot/alerts?state=open&per_page=100')) {
      if (state.off) return json(403, { message: 'Dependabot alerts are disabled for this repository.' });
      // One alert per page, so the cursor is followed.
      const at = Number(new URL(req.url, 'http://x').searchParams.get('after') ?? 0);
      const next = at + 1 < state.alerts.length ? { link: `<http://${req.headers.host}/repos/acme/api/dependabot/alerts?state=open&per_page=100&after=${at + 1}>; rel="next"` } : {};
      return json(200, state.alerts.slice(at, at + 1), next);
    }
    json(404, { message: 'Not Found' });
  });
  return { server, state };
}

describe('Dependabot alerts come in as work (#180)', () => {
  let gh, hub, server, base, clock;
  const deliver = async (event, payload) => {
    const raw = JSON.stringify(payload);
    const r = await fetch(`${base}/api/hooks/github/app`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': sign(raw) }, body: raw });
    return { status: r.status, body: await r.json() };
  };
  const items = () => hub.q('SELECT seq, title, stage, priority, acceptance, summary, repo, created_by FROM items ORDER BY seq').all().map((i) => ({ ...i }));
  const install = () => deliver('installation', { action: 'created', installation: { id: 42 }, repositories: [{ full_name: 'acme/api' }, { full_name: 'acme/elsewhere' }] });
  const dialog = async () => (await (await fetch(`${base}/api/p/app/github`)).json());

  beforeEach(async () => {
    gh = github();
    const api = `http://127.0.0.1:${await listen(gh.server)}`;
    clock = Date.parse('2026-10-30T12:00:00Z');
    hub = new Hub({ clock: () => clock });
    hub.tx(() => hub.project('app', { create: true }));
    hub.addRemote(hub.project('app'), 'git@github.com:acme/api.git', 'you');
    hub.humanOp('app', 'settings', { github_secret: SECRET });
    server = createServer(hub, { githubApp: { id: 1, key: PEM, slug: 'nuworq-test', api } });
    base = `http://127.0.0.1:${await listen(server)}`;
  });
  const close = () => { server.close(); gh.server.close(); };

  test('a created alert is one ready item with the hub-written title and done means; severity sets priority; a redelivery adds nothing', async () => {
    try {
      const r = await deliver('dependabot_alert', { action: 'created', alert: alert(7), repository });
      assert.equal(r.body.created, true);
      await deliver('dependabot_alert', { action: 'created', alert: alert(8, { severity: 'low', pkg: 'minimist', patched: '1.2.8' }), repository });
      const again = await deliver('dependabot_alert', { action: 'created', alert: alert(7), repository });
      assert.equal(again.body.ignored, 'already in');
      const [high, low, ...rest] = items();
      assert.equal(rest.length, 0, 'one item per alert');
      assert.deepEqual({ ...high, summary: undefined }, {
        seq: 1, stage: 'ready', priority: 'now', repo: 'github.com/acme/api', created_by: 'github', summary: undefined,
        title: 'lodash is at 4.17.21 or later in acme/api (GHSA-7xxx-yyyy-zzzz, high)',
        acceptance: "lodash resolves to 4.17.21 or later on main (manifest and lockfile), the project's tests pass, and GitHub shows alert #7 as fixed.",
      });
      for (const want of ['npm', 'package-lock.json', '< 4.17.21', 'First patched: 4.17.21', 'CVE-2026-1007', 'https://github.com/advisories/GHSA-7xxx-yyyy-zzzz', 'Severity: high', 'https://github.com/acme/api/security/dependabot/7']) {
        assert.ok(high.summary.includes(want), `the item says ${want}`);
      }
      assert.equal(low.priority, 'later');
      assert.equal(low.stage, 'ready');
      assert.equal(hub.q('SELECT COUNT(*) AS n FROM questions').get().n, 0, 'no Needs you entry for a routine alert');
      assert.equal(hub.agentOp('app', 'next', 'a1', {}).item, '#1', 'agents get it as work: high before low');
    } finally { close(); }
  });

  test('fixed or dismissed before a claim drops the item; after a claim it stays, with a note; reopened brings it back', async () => {
    try {
      await deliver('dependabot_alert', { action: 'created', alert: alert(1), repository });
      await deliver('dependabot_alert', { action: 'created', alert: alert(2), repository });
      const fixed = await deliver('dependabot_alert', { action: 'fixed', alert: alert(1, { state: 'fixed' }), repository });
      assert.equal(fixed.body.dropped, true);
      assert.equal(items()[0].stage, 'dropped');

      await deliver('dependabot_alert', { action: 'reopened', alert: alert(1), repository });
      assert.equal(items()[0].stage, 'ready', 'the same item, back');
      assert.equal(items().length, 2);

      hub.agentOp('app', 'claim', 'a1', { item: '#2' });
      const dismissed = await deliver('dependabot_alert', { action: 'dismissed', alert: alert(2, { state: 'dismissed' }), repository });
      assert.equal(dismissed.body.noted, true);
      assert.equal(items()[1].stage, 'active');
      assert.ok(hub.q("SELECT 1 FROM events WHERE type = 'comment' AND headline = 'GitHub marked Dependabot alert #2 dismissed; #2 goes on'").get());

      const auto = await deliver('dependabot_alert', { action: 'auto_dismissed', alert: alert(1, { state: 'auto_dismissed' }), repository });
      assert.equal(auto.body.dropped, true);
    } finally { close(); }
  });

  test('an alert reintroduced after its item landed is one new ready item that fixes it; later events follow the new item (#186)', async () => {
    try {
      await deliver('dependabot_alert', { action: 'created', alert: alert(3), repository });
      const p = hub.project('app');
      hub.tx(() => hub.move(hub.item(p, '#1'), 'done', 'you'));
      await deliver('dependabot_alert', { action: 'fixed', alert: alert(3, { state: 'fixed' }), repository });
      assert.equal(items().length, 1, 'fixed after it landed: nothing new');

      const back = await deliver('dependabot_alert', { action: 'reintroduced', alert: alert(3), repository });
      assert.deepEqual({ item: back.body.item, created: back.body.created, fixes: back.body.fixes }, { item: '#2', created: true, fixes: '#1' });
      const [done, fresh, ...rest] = items();
      assert.equal(rest.length, 0);
      assert.equal(done.stage, 'done', 'the landed item stays landed');
      assert.deepEqual({ ...fresh, summary: undefined }, {
        seq: 2, stage: 'ready', priority: 'now', repo: 'github.com/acme/api', created_by: 'github', summary: undefined,
        title: 'lodash is at 4.17.21 or later in acme/api (GHSA-3xxx-yyyy-zzzz, high)',
        acceptance: "lodash resolves to 4.17.21 or later on main (manifest and lockfile), the project's tests pass, and GitHub shows alert #3 as fixed.",
      });
      assert.equal(hub.item(p, '#2').fixes, hub.item(p, '#1').id, 'it repairs the landed item');

      const again = await deliver('dependabot_alert', { action: 'reintroduced', alert: alert(3), repository });
      assert.equal(again.body.ignored, 'already in');
      const reopened = await deliver('dependabot_alert', { action: 'reopened', alert: alert(3), repository });
      assert.equal(reopened.body.ignored, 'already in');
      assert.equal(items().length, 2, 'a redelivery creates nothing more');

      const fixed = await deliver('dependabot_alert', { action: 'fixed', alert: alert(3, { state: 'fixed' }), repository });
      assert.deepEqual({ item: fixed.body.item, dropped: fixed.body.dropped }, { item: '#2', dropped: true });
      assert.deepEqual(items().map((i) => i.stage), ['done', 'dropped'], 'the new item drops, not the done one');
    } finally { close(); }
  });

  test('on install, every open alert of the project\'s repositories comes in once; other repositories are ignored', async () => {
    try {
      const r = await install();
      assert.deepEqual(r.body.alerts, { alerts: 2 }, 'both pages of alerts');
      assert.deepEqual(items().map((i) => [i.seq, i.priority]), [[1, 'now'], [2, 'later']]);
      await install();
      const re = await fetch(`${base}/api/p/app/github/resync`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${server.personKey}` }, body: '{}' });
      assert.deepEqual((await re.json()).alerts, { alerts: 2 });
      assert.equal(items().length, 2, 'nothing new');
      const other = await deliver('dependabot_alert', { action: 'created', alert: alert(9), repository: { full_name: 'acme/elsewhere' } });
      assert.equal(other.status, 200);
      assert.equal(items().length, 2, 'not one of the project\'s repositories');
      assert.equal((await dialog()).alerts[0].state, 'on');
    } finally { close(); }
  });

  test('an alert with no patched version comes in as a proposal with the three options', async () => {
    try {
      await deliver('dependabot_alert', { action: 'created', alert: alert(3, { patched: null, severity: 'critical' }), repository });
      const [it] = items();
      assert.equal(it.stage, 'proposed');
      assert.equal(it.acceptance, '');
      assert.equal(it.priority, 'now');
      assert.match(it.title, /^Decide what to do about lodash in acme\/api: no patched version yet/);
      assert.match(it.summary, /1\. Replace the package[\s\S]*2\. Accept the risk: dismiss alert #3 on GitHub[\s\S]*3\. Wait for a patched version/);
      assert.equal(hub.q('SELECT COUNT(*) AS n FROM questions').get().n, 0);
    } finally { close(); }
  });

  test('alerts off, or a permission not accepted, shows in the GitHub dialog with steps; issues and other webhooks carry on', async () => {
    try {
      gh.state.off = true;
      gh.state.issues = [{ number: 5, title: 'An issue', body: '', state: 'open', labels: [], author_association: 'OWNER', html_url: 'https://github.com/acme/api/issues/5' }];
      const r = await install();
      assert.equal(r.body.github.issues, 1, 'the issue still came in');
      assert.deepEqual(r.body.alerts, { alerts: 0, problems: ['acme/api: off'] });
      let [line] = (await dialog()).alerts;
      assert.equal(line.state, 'off');
      assert.match(line.line, /Dependabot alerts are off for acme\/api/);
      assert.deepEqual(line.steps, [
        { do: "Open acme/api's code security settings", where: 'https://github.com/acme/api/settings/security_analysis' },
        { do: 'Next to "Dependabot alerts", click "Enable"', check: "This line in the project's GitHub dialog turns green, and open alerts arrive as items within a minute" },
      ]);
      const pr = await deliver('pull_request', { action: 'opened', pull_request: { number: 3, title: 'Fix #1', state: 'open', head: { ref: 'x', sha: 'abc' } }, repository });
      assert.equal(pr.status, 200, 'other webhooks still work');

      // The installation hasn't accepted the new permission.
      gh.state.off = false;
      delete gh.state.perms.vulnerability_alerts;
      clock += 31_000;
      [line] = (await dialog()).alerts;
      assert.equal(line.state, 'permission');
      assert.equal(line.steps[0].where, 'https://github.com/organizations/acme/settings/installations/42');
      assert.match(line.steps[1].do, /Review request.*Accept new permissions/);

      // Accepted: the dialog asks again and the line turns green; the open alerts come in.
      gh.state.perms.vulnerability_alerts = 'read';
      assert.equal((await dialog()).alerts[0].state, 'permission', 'asked at most every 30 seconds');
      clock += 31_000;
      [line] = (await dialog()).alerts;
      assert.equal(line.state, 'on');
      assert.equal(line.steps, undefined);
      assert.equal(items().filter((i) => i.created_by === 'github' && /GHSA/.test(i.title)).length, 2);
    } finally { close(); }
  });
});
