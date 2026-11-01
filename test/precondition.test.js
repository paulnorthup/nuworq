import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { itemView, view } from '../src/insight.js';
import { tools } from '../src/protocol.js';
import { normPrecondition, check, runChecks, privateAddress, credentialAllows, semver, compareSemver, firstVersion } from '../src/precondition.js';

const MIN = 60_000;

// A vendor API the work waits on: answers with `state` (status, body); `hang` never answers. Counts requests.
async function vendor() {
  const state = { status: 503, body: 'not yet', hang: false, hits: 0, auth: [] };
  const server = http.createServer((req, res) => {
    state.hits++;
    state.auth.push(req.headers.authorization ?? null);
    if (state.hang) return;
    if (state.redirect) { res.writeHead(302, { location: state.redirect }); return res.end(); }
    res.writeHead(state.status, { 'content-type': 'application/json' });
    res.end(typeof state.body === 'string' ? state.body : JSON.stringify(state.body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => { server.closeAllConnections(); server.close(); } };
}

function setup() {
  let t = Date.UTC(2026, 9, 29, 9);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('w', { create: true }));
  hub.humanOp('w', 'settings', { autonomy: 'full' });
  return { hub, advance: (ms) => (t += ms), item: (n) => hub.item(hub.project('w'), `#${n}`) };
}

describe('preconditions: work that waits on an outside fact', () => {
  test('forgiving input: a URL alone, names for credentials, never secrets', () => {
    assert.deepEqual(normPrecondition('https://api.example.com/v2'), { kind: 'http', url: 'https://api.example.com/v2', status: 200 });
    assert.deepEqual(normPrecondition({ url: 'https://x.test/f', json_path: 'a.b', equals: true, credential: 'vendor' }),
      { kind: 'http', url: 'https://x.test/f', status: 200, json_path: 'a.b', equals: true, credential: 'VENDOR' });
    assert.equal(normPrecondition({}), null, '{} clears');
    assert.equal(normPrecondition(null), null);
    assert.throws(() => normPrecondition('ftp://x.test'), /http\(s\) URL/);
    assert.throws(() => normPrecondition('https://user:pw@x.test'), /can't carry credentials/);
    assert.throws(() => normPrecondition({ url: 'https://x.test', credential: 'Bearer abc.def' }), /a name, not a secret/);
    const { hub } = setup();
    assert.throws(() => hub.agentOp('w', 'propose', 'a', { title: 'T', precondition: { url: 'https://x.test', contains: 'ghp_' + 'a'.repeat(36) } }), /GitHub token/);
  });

  test('held out of next while the fake fails; ready, with an event saying what passed, once it answers', async () => {
    const v = await vendor();
    try {
      const { hub, advance, item } = setup();
      hub.agentOp('w', 'propose', 'shaper', { title: 'Use the v2 export', acceptance: 'x', precondition: { url: `${v.url}/v2/features`, json_path: 'export', equals: true } });
      assert.equal(item(1).stage, 'outside');
      assert.notEqual(hub.agentOp('w', 'next', 'builder').item, '#1');
      assert.throws(() => hub.agentOp('w', 'claim', 'builder', { item: '#1' }), /waits on something outside this hub: .*\/v2\/features answers 200, export is true \(not checked yet\)/);

      await runChecks(hub);
      assert.equal(item(1).stage, 'outside');
      const ctx = hub.agentOp('w', 'look', 'builder', { item: '#1' });
      assert.equal(ctx.precondition.met, false);
      assert.match(ctx.precondition.last_check.detail, /answered 503, not 200/);

      v.state.status = 200; v.state.body = { export: false };
      advance(MIN);
      await runChecks(hub);
      assert.equal(item(1).stage, 'outside');
      assert.match(hub.agentOp('w', 'look', 'builder', { item: '#1' }).precondition.last_check.detail, /export is false/);

      v.state.body = { export: true };
      advance(2 * MIN);
      await runChecks(hub);
      assert.equal(item(1).stage, 'ready');
      const passed = hub.q(`SELECT headline FROM events WHERE type = 'precondition_passed'`).get();
      assert.match(passed.headline, /#1's precondition passed: http:\/\/127\.0\.0\.1:\d+\/v2\/features answers 200, export is true; it's ready/);
      assert.equal(hub.agentOp('w', 'next', 'builder').item, '#1');

      // Time spent outside is external: in the item's court totals and in flow.
      assert.equal(itemView(hub, 'w', '#1').court_ms.external, 3 * MIN);
      assert.ok(view(hub, 'w').flow.court.ms.external >= 3 * MIN);
      assert.ok(view(hub, 'w').flow.court.external > 0);
    } finally { v.close(); }
  });

  test('backoff doubles from 1m to a 1h cap; one host is asked at most every 10s', async () => {
    const v = await vendor();
    try {
      const { hub, advance, item } = setup();
      hub.agentOp('w', 'propose', 'a', { title: 'A', acceptance: 'x', precondition: `${v.url}/a` });
      const gaps = [];
      for (let k = 0; k < 8; k++) {
        await runChecks(hub);
        const it = item(1);
        gaps.push((it.next_check - hub.now()) / MIN);
        advance(it.next_check - hub.now());
      }
      assert.deepEqual(gaps, [1, 2, 4, 8, 16, 32, 60, 60]);

      // Two items on one host, both due: one check now, the other no sooner than 10s later.
      hub.agentOp('w', 'propose', 'a', { title: 'B', acceptance: 'x', precondition: `${v.url}/b` });
      hub.agentOp('w', 'propose', 'a', { title: 'C', acceptance: 'x', precondition: `${v.url}/c` });
      advance(61 * MIN); // past the 10s since the last /a check, and A is due again too
      const hits = v.state.hits;
      await runChecks(hub);
      assert.equal(v.state.hits - hits, 1, 'one request to the host');
      advance(5_000);
      await runChecks(hub);
      assert.equal(v.state.hits - hits, 1, 'still within 10s');
      advance(5_000);
      await runChecks(hub);
      assert.equal(v.state.hits - hits, 2);
    } finally { v.close(); }
  });

  test('a check that hangs keeps no request waiting', async () => {
    const v = await vendor();
    v.state.hang = true;
    const { hub, item } = setup();
    hub.agentOp('w', 'propose', 'a', { title: 'Hangs', acceptance: 'x', precondition: `${v.url}/slow` });
    const server = createServer(hub, { sweepMs: 3_600_000 });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const pending = runChecks(hub, { timeoutMs: 1_500 });
      await new Promise((r) => setTimeout(r, 50)); // the check is in flight
      const t0 = performance.now();
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/p/w/view`);
      assert.equal(res.status, 200);
      assert.ok(performance.now() - t0 < 300, `answered in ${Math.round(performance.now() - t0)}ms`);
      await pending;
      assert.match(JSON.parse(item(1).last_check).detail, /didn't answer/);
    } finally { server.close(); v.close(); }
  });

  test('agents set, see and clear it through propose/refine and the item context', async () => {
    for (const format of ['mcp', 'openai', 'anthropic']) {
      for (const t of tools(format)) {
        const name = t.name ?? t.function.name;
        const props = (t.inputSchema ?? t.input_schema ?? t.function?.parameters).properties;
        assert.equal(!!props.precondition, ['propose', 'refine'].includes(name), `${format} ${name}`);
      }
    }
    const { hub, item } = setup();
    hub.agentOp('w', 'propose', 'a', { title: 'Later', acceptance: 'x' });
    assert.equal(item(1).stage, 'ready');
    const r = hub.agentOp('w', 'refine', 'a', { item: '#1', precondition: 'https://vendor.test/v2' });
    assert.match(JSON.stringify(r), /waits on: https:\/\/vendor\.test\/v2 answers 200/);
    assert.equal(item(1).stage, 'outside');
    const job = hub.agentOp('w', 'look', 'a', { item: '#1' });
    assert.equal(job.precondition.waits_for, 'https://vendor.test/v2 answers 200');
    assert.equal(job.precondition.last_check, null);
    hub.agentOp('w', 'refine', 'a', { item: '#1', precondition: {} });
    assert.equal(item(1).stage, 'ready');
    assert.equal(hub.agentOp('w', 'look', 'a', { item: '#1' }).precondition, undefined);
  });

  test('credentials come from the hub host by name; a shared hub lends neither them nor its private network', async () => {
    const v = await vendor();
    try {
      v.state.status = 200;
      const pre = normPrecondition({ url: `${v.url}/x`, credential: 'VENDOR' });
      assert.deepEqual(await check(pre, { env: {} }), { ok: false, detail: "NUWORQ_CRED_VENDOR isn't set on the hub's host" });
      const asked = v.state.auth.length;
      assert.match((await check(pre, { env: { NUWORQ_CRED_VENDOR: 'k1' } })).detail, /isn't allowed for 127\.0\.0\.1: .*NUWORQ_CRED_VENDOR_HOSTS/, 'no hosts named: sent nowhere');
      assert.equal(v.state.auth.length, asked, 'and the vendor was never asked');
      assert.match((await check(pre, { env: { NUWORQ_CRED_VENDOR: 'k1', NUWORQ_CRED_VENDOR_HOSTS: 'api.vendor.com,.vendor.io' } })).detail, /isn't allowed for 127\.0\.0\.1/, 'another host named: not this one');
      assert.equal((await check(pre, { env: { NUWORQ_CRED_VENDOR: 'k1', NUWORQ_CRED_VENDOR_HOSTS: 'api.vendor.com, 127.0.0.1' } })).ok, true);
      assert.equal(v.state.auth.at(-1), 'Bearer k1');
      assert.ok(credentialAllows('VENDOR', 'eu.vendor.io', { NUWORQ_CRED_VENDOR_HOSTS: '.vendor.io' }));
      assert.ok(credentialAllows('VENDOR', 'vendor.io', { NUWORQ_CRED_VENDOR_HOSTS: '.vendor.io' }));
      assert.ok(!credentialAllows('VENDOR', 'evilvendor.io', { NUWORQ_CRED_VENDOR_HOSTS: '.vendor.io' }));
      // The allowed host redirects elsewhere: the credential doesn't follow.
      const evil = await vendor();
      try {
        v.state.redirect = `${evil.url.replace('127.0.0.1', 'localhost')}/steal`;
        const r = await check(pre, { env: { NUWORQ_CRED_VENDOR: 'k1', NUWORQ_CRED_VENDOR_HOSTS: '127.0.0.1' } });
        assert.equal(r.ok, false);
        assert.match(r.detail, /answered 302/);
        assert.equal(evil.state.hits, 0, 'the redirect target never saw the request');
      } finally { evil.close(); v.state.redirect = null; }
      const hits = v.state.hits;
      assert.match((await check(normPrecondition(`${v.url}/x`), { shared: true })).detail, /^couldn't check 127\.0\.0\.1:\d+: a shared hub reaches only public addresses/);
      assert.match((await check(normPrecondition('https://vendor.test/x'), { shared: true, resolve: async () => ({ address: '169.254.169.254' }) })).detail, /^couldn't check vendor\.test/);
      assert.equal(v.state.hits, hits, 'a shared hub never asked the private address');
      for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '::1', 'fd00::1', 'fe80::1']) assert.ok(privateAddress(ip), ip);
      for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.ok(!privateAddress(ip), ip);
    } finally { v.close(); }
  });
});

describe('version preconditions: work that waits for a version', () => {
  test('semver precedence', () => {
    const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0',
      '1.2.0-alpha', '1.2.0-alpha.1', '1.2.0-beta', '1.2.0-rc.1', '1.2.0', '1.2.9', '1.2.10', '2.0.0'];
    for (let i = 0; i + 1 < order.length; i++) {
      assert.ok(compareSemver(order[i], order[i + 1]) < 0, `${order[i]} < ${order[i + 1]}`);
      assert.ok(compareSemver(order[i + 1], order[i]) > 0, `${order[i + 1]} > ${order[i]}`);
    }
    assert.equal(compareSemver('v2.0.0', '2.0.0'), 0);
    assert.equal(compareSemver('2.0.0+build.7', '2.0.0'), 0, 'build metadata is ignored');
    assert.equal(compareSemver('1.2.0-rc.1+b1', '1.2.0-rc.1+b2'), 0);
    for (const bad of ['2.1', '2', 'x.y.z', '01.2.3', '1.2.3-', '']) assert.equal(semver(bad), null, bad);
    assert.equal(firstVersion('nuworq 2.1.0 (build 7)'), '2.1.0');
    assert.equal(firstVersion('tag v1.2.0-rc.1, out soon'), '1.2.0-rc.1');
    assert.equal(firstVersion('no version here, just 1.2'), null);
  });

  test('forgiving input, with a hint for what it refuses', () => {
    assert.deepEqual(normPrecondition({ kind: 'version', url: 'https://x.test/v', json_path: 'version', min: 'v2.1.0' }), { kind: 'version', url: 'https://x.test/v', json_path: 'version', min: 'v2.1.0' });
    for (const repo of ['acme/api', 'github.com/acme/api', 'https://github.com/acme/api.git']) {
      assert.deepEqual(normPrecondition({ kind: 'release', repo, min: '1.0.0' }), { kind: 'release', repo: 'acme/api', min: '1.0.0' }, repo);
    }
    const { hub } = setup();
    for (const [precondition, why] of [
      [{ kind: 'version', url: 'https://x.test/v' }, /needs min/],
      [{ kind: 'version', url: 'https://x.test/v', min: '2.1' }, /"2\.1" isn't a semver version/],
      [{ kind: 'release', repo: 'acme/api', min: 'latest' }, /isn't a semver version/],
      [{ kind: 'release', min: '1.0.0' }, /must be a GitHub repository/],
      [{ kind: 'nightly', url: 'https://x.test' }, /kind "nightly" isn't known/],
    ]) {
      assert.throws(() => hub.agentOp('w', 'propose', 'a', { title: 'T', acceptance: 'x', precondition }), (e) => why.test(e.message) && /e\.g\./.test(e.hint), JSON.stringify(precondition));
      hub.agentOp('w', 'propose', 'a', { title: 'Plain', acceptance: 'x' });
      assert.throws(() => hub.agentOp('w', 'refine', 'a', { item: '#1', precondition }), why);
    }
  });

  test('outside while the fake reports 2.0.9; ready at 2.1.0, with an event naming both versions', async () => {
    const v = await vendor();
    try {
      const { hub, advance, item } = setup();
      v.state.status = 200; v.state.body = { version: '2.0.9' };
      hub.agentOp('w', 'propose', 'a', { title: 'Use 2.1', acceptance: 'x', precondition: { kind: 'version', url: `${v.url}/version`, json_path: 'version', min: '2.1.0' } });
      assert.equal(item(1).stage, 'outside');
      assert.match(hub.agentOp('w', 'look', 'a', { item: '#1' }).precondition.waits_for, /\/version version reports 2\.1\.0 or later/);
      await runChecks(hub);
      assert.equal(item(1).stage, 'outside');
      assert.match(JSON.parse(item(1).last_check).detail, /reports 2\.0\.9, below 2\.1\.0/);

      v.state.body = { version: '2.1.0-rc.1' };
      advance(MIN);
      await runChecks(hub);
      assert.equal(item(1).stage, 'outside', 'a prerelease of min is below it');

      v.state.body = { version: 'v2.1.0' };
      advance(2 * MIN);
      await runChecks(hub);
      assert.equal(item(1).stage, 'ready');
      assert.match(hub.q(`SELECT headline FROM events WHERE type = 'precondition_passed'`).get().headline, /#1's precondition passed: .*\/version reports 2\.1\.0, at least 2\.1\.0; it's ready/);

      // Without json_path: the first version in a text body.
      v.state.body = 'nuworq 3.0.0 (abc123)';
      assert.deepEqual(await check(normPrecondition({ kind: 'version', url: `${v.url}/v`, min: '3.0.0' })), { ok: true, detail: `${v.url}/v reports 3.0.0, at least 3.0.0` });
      assert.match((await check(normPrecondition({ kind: 'version', url: `${v.url}/v`, min: '3.0.1' }))).detail, /reports 3\.0\.0, below 3\.0\.1/);
      assert.match((await check(normPrecondition({ kind: 'version', url: `${v.url}/v`, min: '3.0.1' }), { shared: true, allow: ['127.0.0.1'] })).detail, /reports a version below 3\.0\.1$/, 'a shared hub hides the value');
    } finally { v.close(); }
  });

  test('a release precondition goes ready when the latest tag reaches min, through the app where it is installed', async () => {
    const releases = { 'acme/api': 'v1.4.2' }, auth = [];
    const gh = http.createServer((req, res) => {
      auth.push(req.headers.authorization ?? null);
      const m = req.url.match(/^\/repos\/([^/]+\/[^/]+)\/releases\/latest$/);
      const tag = m && releases[m[1]];
      res.writeHead(tag ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(tag ? { tag_name: tag } : { message: 'Not Found' }));
    });
    await new Promise((r) => gh.listen(0, '127.0.0.1', r));
    const api = `http://127.0.0.1:${gh.address().port}`;
    try {
      const { hub, advance, item } = setup();
      hub.agentOp('w', 'propose', 'a', { title: 'Adopt 1.5', acceptance: 'x', precondition: { kind: 'release', repo: 'acme/api', min: '1.5.0' } });
      assert.equal(hub.agentOp('w', 'look', 'a', { item: '#1' }).precondition.waits_for, 'the latest release of acme/api is 1.5.0 or later');
      await runChecks(hub, { github: { api } });
      assert.equal(item(1).stage, 'outside');
      assert.match(JSON.parse(item(1).last_check).detail, /acme\/api's latest release is 1\.4\.2, below 1\.5\.0/);
      assert.equal(auth.at(-1), null, 'no app: the public API');

      releases['acme/api'] = 'v1.5.0';
      advance(MIN);
      // An app installed on the repo lends a read token; one that isn't falls back to the public API.
      const app = { api, mint: async (repo, perms) => { assert.deepEqual(perms, { metadata: 'read', contents: 'read' }); if (repo !== 'github.com/acme/api') throw new Error('not installed'); return { token: 'inst-1' }; } };
      await runChecks(hub, { github: { app } });
      assert.equal(item(1).stage, 'ready');
      assert.equal(auth.at(-1), 'Bearer inst-1');
      assert.match(hub.q(`SELECT headline FROM events WHERE type = 'precondition_passed'`).get().headline, /acme\/api's latest release is 1\.5\.0, at least 1\.5\.0; it's ready/);

      hub.agentOp('w', 'propose', 'a', { title: 'Other', acceptance: 'x', precondition: { kind: 'release', repo: 'other/lib', min: '1.0.0' } });
      advance(MIN);
      await runChecks(hub, { github: { app } });
      assert.equal(auth.at(-1), null);
      assert.match(JSON.parse(item(2).last_check).detail, /other\/lib has no releases yet/);

      // A shared hub's app reads only the project's own repositories.
      hub.agentOp('w', 'refine', 'a', { item: '#2', precondition: { kind: 'release', repo: 'acme/api', min: '1.0.0' } });
      advance(MIN);
      await runChecks(hub, { shared: true, github: { app } });
      assert.equal(auth.at(-1), null, 'acme/api is not this project\'s repository');
      assert.equal(item(2).stage, 'ready', 'and the public API still answers');
    } finally { gh.closeAllConnections(); gh.close(); }
  });
});

describe('date preconditions: work that waits for a day', () => {
  test('a date: forgiving input, a day alone starts at midnight UTC', async () => {
    assert.deepEqual(normPrecondition({ kind: 'date', after: '2026-11-08' }), { kind: 'date', after: '2026-11-08' });
    assert.deepEqual(normPrecondition({ kind: 'date', after: '2026-11-08T09:30:00+01:00' }), { kind: 'date', after: '2026-11-08T08:30:00.000Z' });
    assert.throws(() => normPrecondition({ kind: 'date' }), /needs after/);
    assert.throws(() => normPrecondition({ kind: 'date', after: 'next week' }), /isn't a date/);
    assert.throws(() => normPrecondition({ kind: 'date', after: '2026-13-40' }), /isn't a date/);
    const pre = { kind: 'date', after: '2026-11-08' };
    assert.deepEqual(await check(pre, { now: Date.UTC(2026, 10, 7, 23, 59) }), { ok: false, detail: 'not 2026-11-08 yet' });
    assert.deepEqual(await check(pre, { now: Date.UTC(2026, 10, 8) }), { ok: true, detail: "it's 2026-11-08 or later" });
    // Defined once (#529): propose carries the schema, refine refers to it.
    const propose = tools('mcp').find((t) => t.name === 'propose').inputSchema.properties.precondition.properties;
    assert.ok(propose.kind.enum.includes('date') && propose.after);
  });

  test('a date: outside, asking no one and nothing, until the day; then ready on the sweep', async () => {
    const { hub, advance, item } = setup(); // 2026-10-29 09:00 UTC
    let fetched = 0;
    const fetch = async () => { fetched++; throw new Error('no network'); };
    hub.agentOp('w', 'propose', 'shaper', { title: 'Check the live hub a week on', acceptance: 'x', precondition: { kind: 'date', after: '2026-11-01' } });
    assert.equal(item(1).stage, 'outside');
    assert.equal(hub.q(`SELECT COUNT(*) n FROM questions`).get().n, 0, 'no question for a person');
    assert.notEqual(hub.agentOp('w', 'next', 'builder').item, '#1');
    assert.equal(hub.agentOp('w', 'look', 'builder', { item: '#1' }).precondition.waits_for, "it's 2026-11-01 or later");

    await runChecks(hub, { fetch });
    assert.equal(item(1).stage, 'outside');
    assert.equal(item(1).next_check, Date.UTC(2026, 10, 1), 'looks again on the day, no backoff');
    advance(MIN);
    await runChecks(hub, { fetch });
    assert.equal(item(1).check_fails, 1, 'not due before the day');

    // Waiting on purpose is not overdue, however long it is.
    hub.humanOp('w', 'settings', { wait_days: 1 });
    advance(2 * 24 * 60 * MIN);
    assert.equal(view(hub, 'w').attention.filter((a) => a.kind === 'outside-overdue').length, 0);

    advance(24 * 60 * MIN); // 2026-11-01 09:01
    await runChecks(hub, { fetch });
    assert.equal(item(1).stage, 'ready');
    assert.equal(fetched, 0);
    assert.match(hub.q(`SELECT headline FROM events WHERE type = 'precondition_passed'`).get().headline, /#1's precondition passed: it's 2026-11-01 or later; it's ready/);

    // A day already come leaves the work ready at once, proposed or refined.
    hub.agentOp('w', 'propose', 'shaper', { title: 'Past', acceptance: 'x', precondition: { kind: 'date', after: '2026-10-01' } });
    assert.equal(item(2).stage, 'ready');
    hub.agentOp('w', 'refine', 'shaper', { item: '#2', precondition: { kind: 'date', after: '2026-12-01' } });
    assert.equal(item(2).stage, 'outside');
    hub.agentOp('w', 'refine', 'shaper', { item: '#2', precondition: { kind: 'date', after: '2026-10-31' } });
    assert.equal(item(2).stage, 'ready');
  });
});
