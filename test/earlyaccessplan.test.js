import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';
import { Auth } from '../src/auth.js';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const REMY = 'remy@example.com';

// #355: a workspace made with an approved early-access grant starts on Unlimited, and is never sent to Checkout.
describe('early-access workspaces start on Unlimited (#355)', () => {
  test('let in: several agents at once, shown as early access, switchable by the owner, never charged; others stay Free', async () => {
    const sessions = [];
    // What Stripe was asked to do; reading the plan's price (#872, the same for every workspace) isn't that.
    const stripe = http.createServer((req, res) => { if (req.method !== 'GET') sessions.push(req.url); req.resume(); res.end('{}'); });
    const api = `http://127.0.0.1:${await listen(stripe)}`;
    const spaces = new Workspaces({ dir: realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-eaplan-'))), plans: true, owners: [REMY] });
    const server = createServer(spaces, {
      earlyAccess: { owners: [REMY], verify: async () => true, gate: true },
      billing: { webhookSecret: 'whsec', secretKey: 'sk_test_x', prices: { price_pro: 'pro' }, api },
    });
    const base = `http://127.0.0.1:${await listen(server)}`;
    const dir = spaces.directory;
    const as = (email) => `nuworq_id=${dir.createSession(dir.identify(email, 'github').id)}`;
    const call = async (method, path, body, headers = {}) => {
      const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', origin: base, ...headers }, body: body && JSON.stringify(body) });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    const items = (ws) => {
      const hub = spaces.get(ws);
      hub.tx(() => hub.project('app', { create: true }));
      for (let i = 1; i <= 3; i++) hub.humanOp('app', 'create', { title: `Item ${i}`, acceptance: 'x' });
      return (agent, name, args = {}) => hub.agentOp('app', name, agent, args);
    };
    try {
      // Ann asks, Remy lets her in, and her link makes her workspace.
      await call('POST', '/api/early-access', { email: 'ann@example.com', turnstile: 't' });
      const link = (await call('POST', '/api/early-access/decide', { id: dir.requests()[0].id, approve: true }, { cookie: as(REMY) })).json.link;
      const made = await call('POST', '/api/orgs', { slug: 'annco', grant: new URL(link).searchParams.get('grant') }, { cookie: as('ann@example.com') });
      assert.equal(made.status, 200, JSON.stringify(made.json));

      const info = spaces.planInfo('annco');
      assert.deepEqual([info.plan, info.source], ['unlimited', 'early_access']);
      assert.deepEqual(spaces.overview().find((w) => w.name === 'annco').source, 'early_access', 'the admin dashboard says why');

      // Two agents at once.
      const op = items('annco');
      for (const a of ['a1', 'a2']) { op(a, 'checkin'); assert.equal(op(a, 'next').mode, 'work', a); }

      // Never sent to Stripe Checkout: no plans offered, and Checkout is refused.
      const ann = new Auth(spaces.get('annco').db).createToken('ann-ui', 'human', { person: made.json.handle });
      const bill = await call('GET', '/w/annco/api/billing', null, { authorization: `Bearer ${ann}` });
      assert.deepEqual([bill.json.plan, bill.json.plans], ['unlimited', []]);
      assert.equal((await call('POST', '/w/annco/api/billing/checkout', { plan: 'pro' }, { authorization: `Bearer ${ann}` })).status, 409);
      assert.deepEqual(sessions, [], 'Stripe never heard of it');

      // Remy can still switch it to Free and back, as for any workspace.
      spaces.setPlan('annco', 'free', 'remy');
      assert.deepEqual([spaces.planInfo('annco').plan, spaces.planInfo('annco').source], ['free', 'set']);
      spaces.setPlan('annco', 'unlimited', 'remy');
      assert.equal(spaces.planOf('annco'), 'unlimited');

      // A workspace someone signed up for any other way is still Free: the second claim is refused with the upgrade hint.
      spaces.create('bobco');
      dir.identify('bob@example.com', 'github');
      dir.join('bob@example.com', 'bobco', { created: true });
      assert.deepEqual([spaces.planInfo('bobco').plan, spaces.planInfo('bobco').source], ['free', 'default']);
      const bop = items('bobco');
      bop('b1', 'checkin'); bop('b1', 'next');
      bop('b2', 'checkin');
      assert.throws(() => bop('b2', 'next'), (e) => e.status === 402 && /upgrade/i.test(e.hint));
    } finally {
      for (const s of [server, stripe]) { s.close(); s.closeAllConnections(); }
      spaces.close();
    }
  });

  test('a grant given back (its workspace could not be made) marks nothing Unlimited', () => {
    const spaces = new Workspaces({ dir: realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-eaplan-'))), plans: true });
    const dir = spaces.directory;
    try {
      dir.request({ email: 'ann@example.com' });
      const { code } = dir.decide(dir.requests()[0].id, true, 'remy');
      const ann = dir.identify('ann@example.com', 'github');
      assert.equal(dir.useGrant(code, ann, 'annco'), true);
      assert.equal(dir.madeByGrant('annco'), true);
      dir.returnGrant(code);
      assert.equal(dir.madeByGrant('annco'), false);
    } finally { spaces.close(); }
  });
});
