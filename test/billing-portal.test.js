import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspaces } from '../src/workspaces.js';
import { Auth } from '../src/auth.js';
import { addChannel } from '../src/notify.js';
import { createServer } from '../src/server.js';
import { billingState, failing } from '../src/billing.js';

// #231: a paying owner manages billing in Stripe's portal, and hears about a failed payment before the plan drops.
const SECRET = 'whsec_test';
const DAY = 24 * 60 * 60 * 1000;
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const sign = (raw) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex')}`; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake Stripe (the portal sessions it was asked for) that is also a push receiver (what each channel got).
async function fakeStripe() {
  const sessions = [], pushes = [];
  let refuse = false;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (req.url === '/v1/billing_portal/sessions') {
      sessions.push({ auth: req.headers.authorization, type: req.headers['content-type'], form: Object.fromEntries(new URLSearchParams(raw)) });
      res.writeHead(refuse ? 400 : 200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(refuse ? { error: { message: 'No configuration provided' } } : { id: 'bps_1', url: 'https://billing.stripe.test/p/session_1' }));
    }
    pushes.push({ to: req.url.slice(1), msg: JSON.parse(raw) });
    res.end('ok');
  });
  const port = await listen(server);
  return { sessions, pushes, url: `http://127.0.0.1:${port}`, refuse: (on) => { refuse = on; }, close: () => { server.close(); server.closeAllConnections(); } };
}

describe("a paying owner manages billing in Stripe's portal (#231)", () => {
  let spaces, server, port, stripe, now, tok;
  const call = async (who, method, path, body, ws = 'acme') => {
    const res = await fetch(`http://127.0.0.1:${port}/w/${ws}${path}`, { method, headers: { authorization: `Bearer ${tok[who]}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const deliver = async (event) => {
    const raw = JSON.stringify({ created: Math.floor(now / 1000), ...event, id: event.id ?? `evt_${Math.random().toString(36).slice(2)}` });
    const res = await fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sign(raw) }, body: raw });
    return res.json();
  };
  const sub = (fields = {}, type = 'customer.subscription.updated') => deliver({
    type, data: { object: { id: 'sub_a', customer: 'cus_a', status: 'active', cancel_at_period_end: false, items: { data: [{ price: { id: 'price_pro' }, current_period_end: Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000) }] }, ...fields } },
  });
  const invoice = (type, fields = {}) => deliver({ type, data: { object: { id: 'in_1', customer: 'cus_a', parent: { subscription_details: { subscription: 'sub_a' } }, ...fields } } });

  before(async () => {
    process.env.NUWORQ_ALLOW_PRIVATE_HOSTS = '127.0.0.1'; // the hub host's setting: the push sink is local
    now = Date.parse('2026-11-01T00:00:00Z');
    stripe = await fakeStripe();
    spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-portal-')), plans: true, clock: () => now });
    tok = {};
    for (const ws of ['acme', 'free']) {
      spaces.create(ws);
      spaces.directory.identify(`own@${ws}.test`, 'github');
      spaces.directory.join(`own@${ws}.test`, ws, { created: true });
      const auth = new Auth(spaces.get(ws).db);
      auth.addPerson(`own${ws}`, 'owner', { email: `own@${ws}.test` });
      tok[ws === 'acme' ? 'own' : 'freeown'] = auth.createToken(`own-${ws}`, 'human', { person: `own${ws}` });
      if (ws === 'acme') {
        auth.addPerson('mem', 'member');
        tok.mem = auth.createToken('mem-l', 'human', { person: 'mem' });
        addChannel(spaces.get(ws).db, 'webhook', `${stripe.url}/owner`, now, { person: 'ownacme' });
        addChannel(spaces.get(ws).db, 'webhook', `${stripe.url}/member`, now, { person: 'mem' });
        addChannel(spaces.get(ws).db, 'webhook', `${stripe.url}/everyone`, now);
      }
    }
    server = createServer(spaces, { billing: { webhookSecret: SECRET, secretKey: 'sk_test_1', prices: { price_pro: 'pro' }, api: stripe.url } });
    port = await listen(server);
    await deliver({ type: 'checkout.session.completed', data: { object: { client_reference_id: 'acme', customer: 'cus_a', subscription: 'sub_a', payment_status: 'paid' } } });
    await sub();
  });
  after(() => { delete process.env.NUWORQ_ALLOW_PRIVATE_HOSTS; server.close(); server.closeAllConnections(); stripe.close(); spaces.close(); });

  test('the owner sees the state in plain words, and Manage billing opens the portal for their customer, back to the settings', async () => {
    const b = await call('own', 'GET', '/api/billing');
    assert.equal(b.status, 200);
    assert.deepEqual(b.json, {
      on: true, owner: true, plan: 'unlimited', state: 'Pro, renews 2026-12-01', failing: false, manage: true,
      plans: [], terms: 'https://nuworq.com/terms', privacy: 'https://nuworq.com/privacy',
    });
    const p = await call('own', 'POST', '/api/billing/portal', {});
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.equal(p.json.url, 'https://billing.stripe.test/p/session_1');
    assert.deepEqual(stripe.sessions.at(-1), {
      auth: 'Bearer sk_test_1', type: 'application/x-www-form-urlencoded',
      form: { customer: 'cus_a', return_url: `http://127.0.0.1:${port}/w/acme/#/settings` },
    });
  });

  test("only the owner opens the portal: a member gets 403 naming the owner and sees no state", async () => {
    const n = stripe.sessions.length;
    const p = await call('mem', 'POST', '/api/billing/portal', {});
    assert.equal(p.status, 403);
    assert.match(p.json.hint, /@ownacme/);
    assert.deepEqual((await call('mem', 'GET', '/api/billing')).json, { on: true, owner: false, owners: ['@ownacme'] });
    assert.equal(stripe.sessions.length, n, 'Stripe was never asked');
  });

  test('a workspace with no subscription reads Free, with Upgrade and no Manage billing; the portal says to upgrade first', async () => {
    assert.deepEqual((await call('freeown', 'GET', '/api/billing', undefined, 'free')).json, {
      on: true, owner: true, plan: 'free', state: null, failing: false, manage: false,
      plans: [{ plan: 'pro', label: 'Pro' }], terms: 'https://nuworq.com/terms', privacy: 'https://nuworq.com/privacy',
    });
    const p = await call('freeown', 'POST', '/api/billing/portal', {}, 'free');
    assert.equal(p.status, 409);
    assert.match(p.json.hint, /Upgrade/);
  });

  test("Stripe refusing is a 502 with its message", async () => {
    stripe.refuse(true);
    try {
      const p = await call('own', 'POST', '/api/billing/portal', {});
      assert.equal(p.status, 502);
      assert.match(p.json.error, /No configuration provided/);
    } finally { stripe.refuse(false); }
  });

  test('a failed payment: Needs you for the owner with steps, a push to their channel only, cleared by invoice.paid', async () => {
    const retry = Date.parse('2026-11-08T00:00:00Z');
    const r = await invoice('invoice.payment_failed', { next_payment_attempt: retry / 1000 });
    assert.deepEqual(r, { ok: true, workspace: 'acme', failed: true });
    const b = (await call('own', 'GET', '/api/billing')).json;
    assert.equal(b.state, 'Payment failed: update your card by 2026-11-08 to keep Pro');
    assert.equal(b.failing, true);
    assert.equal(b.plan, 'unlimited', 'still Pro while Stripe retries');

    const home = (await call('own', 'GET', '/api/home')).json;
    const e = home.needs[0];
    assert.equal(e.kind, 'payment-failed');
    assert.equal(e.project, null, "the workspace's own, not a project's");
    assert.equal(e.headline, b.state);
    assert.equal(home.pulse.state, 'needs-you');
    assert.match(home.pulse.sentence, /^1 thing needs you\./);
    assert.deepEqual(e.how.map((s) => s.do.split(' ').slice(0, 2).join(' ')), ['Open Workspace', 'Under Payment', 'Click Return']);
    assert.equal(e.how[0].where, `http://127.0.0.1:${port}/w/acme/#/settings`);
    assert.match(e.how[2].check, /Pro, renews/);
    assert.equal((await call('mem', 'GET', '/api/home')).json.needs.length, 0, 'a member is not asked');

    for (let i = 0; i < 50 && !stripe.pushes.length; i++) await wait(10);
    await wait(20);
    assert.deepEqual(stripe.pushes.map((p) => p.to), ['owner'], "only the owners' own channels");
    assert.match(stripe.pushes[0].msg.text, /payment failed for acme[\s\S]*update your card by 2026-11-08/);
    assert.equal(stripe.pushes[0].msg.url, `http://127.0.0.1:${port}/w/acme/#/settings`);

    // Stripe's next retry fails too: the same failure, pushed once.
    now += DAY;
    assert.equal((await invoice('invoice.payment_failed', { next_payment_attempt: (retry + 3 * DAY) / 1000 })).failed, undefined);
    assert.equal((await call('own', 'GET', '/api/home')).json.needs[0].key, e.key);
    await wait(30);
    assert.equal(stripe.pushes.length, 1);

    now += DAY;
    await invoice('invoice.paid');
    const after = (await call('own', 'GET', '/api/billing')).json;
    assert.deepEqual([after.state, after.failing], ['Pro, renews 2026-12-01', false]);
    assert.equal((await call('own', 'GET', '/api/home')).json.needs.length, 0, 'cleared');
  });

  test('cancelling in the portal keeps Pro until the period ends, then Free', async () => {
    await sub({ cancel_at_period_end: true });
    assert.equal((await call('own', 'GET', '/api/billing')).json.state, 'Pro until 2026-12-01, then Free');
    await sub({ status: 'canceled' }, 'customer.subscription.deleted');
    assert.deepEqual((await call('own', 'GET', '/api/billing')).json.plan, 'unlimited');
    now = Date.parse('2026-12-02T00:00:00Z');
    const b = (await call('own', 'GET', '/api/billing')).json;
    assert.deepEqual([b.plan, b.state], ['free', null]);
  });

  test("an invoice for a subscription the hub doesn't keep is ignored", async () => {
    assert.equal((await deliver({ type: 'invoice.payment_failed', data: { object: { subscription: 'sub_other' } } })).ignored, 'not a subscription the hub keeps');
  });
});

describe('billing off shows nothing (#231)', () => {
  test('the billing routes answer 404', async () => {
    const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-portal-off-')), plans: true });
    spaces.create('acme');
    const auth = new Auth(spaces.get('acme').db);
    auth.addPerson('own', 'owner');
    const t = auth.createToken('own-l', 'human', { person: 'own' });
    const server = createServer(spaces, {});
    const port = await listen(server);
    try {
      for (const [method, path] of [['GET', '/api/billing'], ['POST', '/api/billing/portal']]) {
        const res = await fetch(`http://127.0.0.1:${port}/w/acme${path}`, { method, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
        assert.equal(res.status, 404, path);
      }
      const home = await (await fetch(`http://127.0.0.1:${port}/w/acme/api/home`, { headers: { authorization: `Bearer ${t}` } })).json();
      assert.equal(home.needs.length, 0);
    } finally { server.close(); spaces.close(); }
  });
});

describe('the state in plain words (#231)', () => {
  const now = Date.parse('2026-11-01T00:00:00Z'), end = Date.parse('2026-12-01T00:00:00Z');
  test('each state', () => {
    assert.equal(billingState({ status: 'active', period_end: end, plan: 'team' }, now), 'Team, renews 2026-12-01');
    assert.equal(billingState({ status: 'trialing', period_end: end }, now), 'Pro trial, renews 2026-12-01');
    assert.equal(billingState({ status: 'past_due', period_end: end, event_at: now }, now), 'Payment failed: update your card now to keep Pro');
    assert.equal(billingState({ status: 'unpaid', event_at: now }, now), 'Payment failed: Pro has stopped. Update your card to start it again');
    assert.equal(billingState({ status: 'canceled', period_end: now - 1 }, now), null);
    assert.equal(billingState(null, now), null);
    assert.equal(failing({ status: 'past_due', event_at: now, paid_at: now + 1 }), false, 'paid since Stripe said past_due');
  });
});
