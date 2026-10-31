import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';
import { billingFromEnv, verifySignature, billingLine } from '../src/billing.js';

const SECRET = 'whsec_test';
const DAY = 24 * 60 * 60 * 1000;
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const sign = (raw, { secret = SECRET, t = Math.floor(Date.now() / 1000) } = {}) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;

function post(port, path, raw, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json, text }); });
    });
    req.on('error', reject);
    req.end(raw);
  });
}

describe('billing is configured from the environment, and off by default', () => {
  test('no webhook secret: off; the prices map price ids to plan names', () => {
    assert.equal(billingFromEnv({}), null);
    assert.equal(billingFromEnv({ NUWORQ_STRIPE_SECRET_KEY: 'sk_x' }), null, 'nothing can be verified without the webhook secret');
    assert.deepEqual(billingFromEnv({ NUWORQ_STRIPE_SECRET_KEY: 'sk_x', NUWORQ_STRIPE_WEBHOOK_SECRET: 'whsec', NUWORQ_STRIPE_PRICES: 'pro=price_1, team=price_2' }),
      { secretKey: 'sk_x', webhookSecret: 'whsec', prices: { price_1: 'pro', price_2: 'team' } });
  });

  test('the signature: HMAC-SHA256 of "t.body", any v1 matches, within 5 minutes', () => {
    const raw = Buffer.from('{"id":"evt"}');
    const now = Date.now(), t = Math.floor(now / 1000);
    const good = sign(raw, { t });
    assert.equal(verifySignature(SECRET, good, raw, now), true);
    assert.equal(verifySignature(SECRET, `t=${t},v1=${'0'.repeat(64)},${good.split(',')[1]}`, raw, now), true, 'any v1');
    assert.equal(verifySignature('whsec_other', good, raw, now), false);
    assert.equal(verifySignature(SECRET, good, Buffer.from('{"id":"evt2"}'), now), false, 'another body');
    assert.equal(verifySignature(SECRET, good, raw, now + 6 * 60_000), false, 'stale');
    assert.equal(verifySignature(SECRET, `t=${t}`, raw, now), false);
    assert.equal(verifySignature(SECRET, '', raw, now), false);
  });

  test('a hub without billing answers the webhook 404, signed or not', async () => {
    const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-billing-off-')), plans: true });
    const server = createServer(spaces, {});
    const port = await listen(server);
    try {
      const raw = JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: {} } });
      const r = await post(port, '/api/stripe/webhook', raw, { 'stripe-signature': sign(raw) });
      assert.equal(r.status, 404);
      assert.match(r.json.hint, /NUWORQ_STRIPE_WEBHOOK_SECRET/);
    } finally { server.close(); spaces.close(); }
  });
});

describe("Stripe's signed webhook puts a workspace on a paid plan (#227)", () => {
  let spaces, server, port, now;
  const created = () => Math.floor(now / 1000);
  const deliver = (event, opts = {}) => {
    const raw = JSON.stringify(event);
    return post(port, '/api/stripe/webhook', raw, { 'stripe-signature': opts.signature ?? sign(raw, opts) });
  };
  const plan = (ws) => spaces.planInfo(ws);
  const sub = (id, fields = {}, type = 'customer.subscription.updated', ev = `evt_${Math.random().toString(36).slice(2)}`) => ({
    id: ev, type, created: created(),
    data: { object: { id, customer: 'cus_1', status: 'active', cancel_at_period_end: false, items: { data: [{ price: { id: 'price_pro' }, current_period_end: Math.floor((now + 30 * DAY) / 1000) }] }, ...fields } },
  });
  const checkout = (ws, subscription, ev = `evt_${Math.random().toString(36).slice(2)}`) => ({
    id: ev, type: 'checkout.session.completed', created: created(),
    data: { object: { client_reference_id: ws, customer: 'cus_1', subscription, payment_status: 'paid' } },
  });

  before(async () => {
    now = Date.parse('2026-11-01T00:00:00Z');
    spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-billing-')), plans: true, clock: () => now });
    for (const ws of ['acme', 'beta', 'gamma']) {
      spaces.create(ws);
      spaces.directory.identify(`ann@${ws}.test`, 'github');
      spaces.directory.join(`ann@${ws}.test`, ws, { created: true }); // someone signed up for it: Free
    }
    server = createServer(spaces, { billing: { webhookSecret: SECRET, secretKey: '', prices: { price_pro: 'pro' } } });
    port = await listen(server);
  });
  after(() => { server.close(); server.closeAllConnections(); spaces.close(); });

  test('a good signature changes the plan; a bad or stale one is refused and changes nothing', async () => {
    assert.equal(plan('acme').plan, 'free');
    const ev = checkout('acme', 'sub_a');
    for (const opts of [{ secret: 'whsec_wrong' }, { t: created() - 6 * 60 }, { signature: 'garbage' }]) {
      const r = await deliver(ev, opts);
      assert.equal(r.status, 400, JSON.stringify(opts));
      assert.equal(plan('acme').plan, 'free');
    }
    const r = await deliver(ev);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { ok: true, workspace: 'acme' });
    assert.equal(plan('acme').plan, 'unlimited');
    assert.equal(plan('acme').source, 'billing');
    // Its subscription's own event fills in the period and the plan's name.
    assert.equal((await deliver(sub('sub_a'))).status, 200);
    assert.deepEqual(plan('acme').billing, { status: 'active', period_end: now + 30 * DAY, cancel_at_period_end: false, plan: 'pro', line: 'paid until 2026-12-01' });
  });

  test('an event seen before is acknowledged and ignored', async () => {
    const ev = sub('sub_a', { status: 'past_due' }, 'customer.subscription.updated', 'evt_once');
    assert.equal((await deliver(ev)).json.duplicate, undefined);
    assert.equal(plan('acme').billing.line, 'payment failed');
    assert.equal(plan('acme').plan, 'unlimited', 'past_due still pays while Stripe retries');
    const again = { ...ev, data: { object: { ...ev.data.object, status: 'active' } } };
    const r = await deliver(again);
    assert.equal(r.status, 200);
    assert.equal(r.json.duplicate, true);
    assert.equal(plan('acme').billing.status, 'past_due', 'the replay changed nothing');
  });

  test('a cancelled subscription drops to Free only after its period ends', async () => {
    await deliver(checkout('beta', 'sub_b'));
    await deliver(sub('sub_b', { customer: 'cus_b', cancel_at_period_end: true }));
    assert.equal(plan('beta').billing.line, 'cancels 2026-12-01');
    assert.equal(plan('beta').plan, 'unlimited');
    await deliver(sub('sub_b', { customer: 'cus_b', status: 'canceled' }, 'customer.subscription.deleted'));
    assert.equal(plan('beta').plan, 'unlimited', 'paid until the period ends');
    assert.equal(plan('beta').billing.line, 'cancelled, paid until 2026-12-01');
    now += 31 * DAY;
    assert.equal(plan('beta').plan, 'free');
    assert.equal(plan('beta').source, 'default');
    assert.equal(plan('beta').billing.line, 'cancelled');
    now -= 31 * DAY;
  });

  test('a plan the hub owner set by hand wins over billing', async () => {
    await deliver(checkout('gamma', 'sub_g'));
    assert.equal(plan('gamma').source, 'billing');
    spaces.setPlan('gamma', 'free', 'paul@example.com');
    assert.equal(plan('gamma').plan, 'free');
    assert.equal(plan('gamma').source, 'set');
    assert.equal(plan('gamma').billing.status, 'active', 'its billing still shows');
  });

  test("events out of order: a subscription's event before its checkout, and an older event after a newer one", async () => {
    spaces.create('delta');
    spaces.directory.identify('ann@delta.test', 'github');
    spaces.directory.join('ann@delta.test', 'delta', { created: true });
    const early = sub('sub_d', { customer: 'cus_d' }, 'customer.subscription.created');
    assert.deepEqual((await deliver(early)).json, { ok: true, workspace: null });
    assert.equal(plan('delta').plan, 'free', 'no workspace named yet');
    await deliver(checkout('delta', 'sub_d'));
    assert.deepEqual([plan('delta').plan, plan('delta').billing.line], ['unlimited', 'paid until 2026-12-01'], 'the checkout names it; the state stays the subscription\'s');
    // An update stamped earlier than the one applied changes nothing.
    await deliver({ ...sub('sub_d', { customer: 'cus_d', status: 'canceled' }), created: created() - 60 });
    assert.equal(plan('delta').billing.status, 'active');
  });

  test("a subscription to some other product isn't ours; other events are acknowledged", async () => {
    const other = sub('sub_x', { items: { data: [{ price: { id: 'price_other' } }] }, metadata: { workspace: 'acme' } });
    assert.equal((await deliver(other)).json.ignored, 'not a nuworq price');
    assert.equal((await deliver({ id: 'evt_inv', type: 'invoice.paid', created: created(), data: { object: {} } })).json.ignored, 'invoice.paid');
    assert.equal((await deliver(checkout('nope', 'sub_n'))).json.ignored, 'no workspace or subscription');
  });

  test('the line the dashboard shows', () => {
    const end = Date.parse('2026-12-01T00:00:00Z');
    assert.equal(billingLine({ status: 'trialing', period_end: end }, now), 'trial until 2026-12-01');
    assert.equal(billingLine({ status: 'unpaid' }, now), 'payment failed');
    assert.equal(billingLine({ status: 'incomplete' }, now), 'incomplete');
    assert.equal(billingLine(null, now), null);
  });
});
