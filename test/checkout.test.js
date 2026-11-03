import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';
import { Auth } from '../src/auth.js';
import { view } from '../src/insight.js';
import { priceText, offers, offerLine, OFFER_MS } from '../src/billing.js';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const PRICES = { price_pro: 'pro' };

// A fake Stripe: records each Checkout Session the hub asks for, answers with its URL. fail: answer 400. Its Pro
// price is $19 a month (state.price), and it counts how often the hub reads it.
function fakeStripe() {
  const sessions = [];
  const state = { fail: false, price: { id: 'price_pro', unit_amount: 1900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, reads: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/v1/prices/price_pro' && !state.fail) {
        state.reads++;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(state.price));
      }
      res.writeHead(state.fail ? 400 : req.url === '/v1/checkout/sessions' ? 200 : 404, { 'content-type': 'application/json' });
      if (state.fail) return res.end(JSON.stringify({ error: { message: 'No such price: price_pro' } }));
      sessions.push({ auth: req.headers.authorization, type: req.headers['content-type'], form: Object.fromEntries(new URLSearchParams(raw)) });
      res.end(JSON.stringify({ id: `cs_${sessions.length}`, url: `https://checkout.stripe.test/c/cs_${sessions.length}` }));
    });
  });
  return { server, sessions, state };
}

// A Free workspace (someone signed up for it) with an owner (ann) and a member (bob), each with a human token.
function workspace(spaces, name) {
  spaces.create(name);
  spaces.directory.identify(`ann@${name}.test`, 'github');
  spaces.directory.join(`ann@${name}.test`, name, { created: true });
  const hub = spaces.get(name);
  hub.tx(() => hub.project('app', { create: true }));
  for (let i = 1; i <= 3; i++) hub.humanOp('app', 'create', { title: `Item ${i}`, acceptance: 'x' });
  const auth = new Auth(hub.db);
  auth.addPerson('ann', 'owner', { email: `ann@${name}.test` });
  auth.addPerson('bob', 'member', { email: `bob@${name}.test` });
  return { hub, ann: auth.createToken('ann-ui', 'human', { person: 'ann' }), bob: auth.createToken('bob-ui', 'human', { person: 'bob' }) };
}

describe('a Free workspace\'s owner upgrades through Stripe Checkout (#228)', () => {
  let spaces, server, url, stripe, acme;
  const call = (ws, token, path, body) => fetch(`${url}/w/${ws}${path}`, {
    method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));

  before(async () => {
    stripe = fakeStripe();
    const api = `http://127.0.0.1:${await listen(stripe.server)}`;
    spaces = new Workspaces({ dir: realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-checkout-'))), plans: true });
    acme = workspace(spaces, 'acme');
    server = createServer(spaces, { billing: { webhookSecret: 'whsec', secretKey: 'sk_test_x', prices: PRICES, api } });
    url = `http://127.0.0.1:${await listen(server)}`;
  });
  after(() => { for (const s of [server, stripe.server]) { s.close(); s.closeAllConnections(); } spaces.close(); });

  test('the owner sees Upgrade and opens Checkout for the plan: price, mode, workspace, URLs, terms', async () => {
    const b = await call('acme', acme.ann, '/api/billing');
    assert.equal(b.status, 200);
    assert.deepEqual([b.json.on, b.json.plan, b.json.owner, b.json.plans],
      [true, 'free', true, [{ plan: 'pro', label: 'Pro', gives: 'any number of agents side by side', price: '$19 a month' }]], 'what Pro gives and costs, before Checkout (#872)');

    const r = await call('acme', acme.ann, '/api/billing/checkout', { plan: 'pro' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.url, 'https://checkout.stripe.test/c/cs_1');
    const [s] = stripe.sessions;
    assert.equal(s.auth, 'Bearer sk_test_x');
    assert.equal(s.type, 'application/x-www-form-urlencoded');
    assert.equal(s.form.mode, 'subscription');
    assert.equal(s.form['line_items[0][price]'], 'price_pro');
    assert.equal(s.form['line_items[0][quantity]'], '1');
    assert.equal(s.form.client_reference_id, 'acme');
    assert.equal(s.form['subscription_data[metadata][workspace]'], 'acme', 'its subscription events name the workspace too');
    assert.equal(s.form.customer_email, 'ann@acme.test');
    assert.equal(s.form.success_url, `${url}/w/acme/?checkout=done#/settings`);
    assert.equal(s.form.cancel_url, `${url}/w/acme/#/settings`);
    assert.match(s.form['custom_text[submit][message]'], /\(https:\/\/nuworq\.com\/terms\).*\(https:\/\/nuworq\.com\/privacy\)/);
  });

  test("a member can't: 403 naming the owner; an unknown plan is a 400; Stripe refusing is a 502 with Stripe's words", async () => {
    const seen = stripe.sessions.length;
    const b = await call('acme', acme.bob, '/api/billing');
    assert.deepEqual([b.json.owner, b.json.owners], [false, ['@ann']]);
    const r = await call('acme', acme.bob, '/api/billing/checkout', { plan: 'pro' });
    assert.equal(r.status, 403);
    assert.match(r.json.hint, /Ask @ann/);
    assert.equal((await call('acme', acme.ann, '/api/billing/checkout', { plan: 'gold' })).status, 400);
    stripe.state.fail = true;
    const bad = await call('acme', acme.ann, '/api/billing/checkout', { plan: 'pro' });
    stripe.state.fail = false;
    assert.equal(bad.status, 502);
    assert.match(bad.json.error, /No such price/);
    assert.equal(stripe.sessions.length, seen, 'no session for any of them');
  });

  test("Free's limit: the refusal links the workspace's settings, and the owners get one Needs you entry with Upgrade", async () => {
    const op = (agent, name, args = {}) => acme.hub.agentOp('app', name, agent, args);
    op('a1', 'checkin');
    assert.equal(op('a1', 'next').mode, 'work');
    op('a2', 'checkin');
    assert.throws(() => op('a2', 'next'), (e) => e.status === 402 && e.hint.includes(`${url}/w/acme/#/settings`)
      && e.hint.includes('upgrade it to Pro: any number of agents side by side, $19 a month, at '));
    const entry = (viewer) => view(acme.hub, 'app', { viewer }).attention.find((a) => a.kind === 'plan-limit');
    const e = entry('@ann');
    assert.equal(e.level, 'act');
    assert.match(e.headline, /a2 is waiting: the Free plan runs one agent at a time, and a1 is working/);
    assert.equal(e.upgrade, `${url}/w/acme/#/settings`);
    assert.match(e.why, /Pro: any number of agents side by side, \$19 a month\./);
    assert.equal(entry('@bob').level, 'know', 'a member hears of it, but it needs the owner');
    // Once a1 hands off, a2 gets work, and the entry goes.
    op('a1', 'handoff', { item: '#1', headline: 'Out' });
    op('a2', 'next');
    assert.equal(entry('@ann'), undefined);
  });

  test('a paid workspace shows no Upgrade, and Checkout is a 409', async () => {
    spaces.setPlan('acme', 'unlimited', 'host'); // last: it stays paid
    const b = await call('acme', acme.ann, '/api/billing');
    assert.deepEqual([b.json.plan, b.json.plans], ['unlimited', []]);
    assert.equal((await call('acme', acme.ann, '/api/billing/checkout', { plan: 'pro' })).status, 409);
  });
});

test('billing off (the default): no Upgrade anywhere, Checkout answers 404, the refusal links nothing', async () => {
  const spaces = new Workspaces({ dir: realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-checkout-off-'))), plans: true });
  const { hub, ann } = workspace(spaces, 'acme');
  const server = createServer(spaces, {});
  const url = `http://127.0.0.1:${await listen(server)}`;
  try {
    const get = await fetch(`${url}/w/acme/api/billing`, { headers: { authorization: `Bearer ${ann}` } });
    assert.equal(get.status, 404);
    const post = await fetch(`${url}/w/acme/api/billing/checkout`, { method: 'POST', headers: { authorization: `Bearer ${ann}`, 'content-type': 'application/json' }, body: '{"plan":"pro"}' });
    assert.equal(post.status, 404);
    const op = (agent, name) => hub.agentOp('app', name, agent, {});
    op('a1', 'checkin'); op('a1', 'next'); op('a2', 'checkin');
    assert.throws(() => op('a2', 'next'), (e) => e.status === 402 && !/https?:/.test(e.hint));
    assert.equal(view(hub, 'app', { viewer: '@ann' }).attention.find((a) => a.kind === 'plan-limit'), undefined);
  } finally { server.close(); server.closeAllConnections(); spaces.close(); }
});

test("Workspace settings say what Pro gives and costs above Upgrade; a paid workspace isn't offered it (#872)", async () => {
  const { billingSection } = await import('../web/billing.js');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const pro = { plan: 'pro', label: 'Pro', gives: 'any number of agents side by side', price: '$19 a month' };
  const html = billingSection({ owner: true, plan: 'free', plans: [pro], terms: 't', privacy: 'p' }, { esc });
  assert.match(html, /<b>Pro<\/b>: any number of agents side by side, <b>\$19 a month<\/b>\./);
  assert.ok(html.indexOf('$19 a month') < html.indexOf('Upgrade to Pro'), 'the price comes before the button');
  assert.match(billingSection({ owner: true, plan: 'free', plans: [{ ...pro, price: null }] }, { esc }), /Pro<\/b>: any number of agents side by side, price shown at Checkout\./);
  assert.doesNotMatch(billingSection({ owner: true, plan: 'unlimited', plans: [] }, { esc }), /a month/);
});

test('a price in words, as Stripe has it (#872)', () => {
  const p = (unit_amount, currency, interval, interval_count = 1) => ({ unit_amount, currency, recurring: interval && { interval, interval_count } });
  assert.equal(priceText(p(1900, 'usd', 'month')), '$19 a month');
  assert.equal(priceText(p(1950, 'usd', 'month')), '$19.50 a month');
  assert.equal(priceText(p(19000, 'eur', 'year')), '€190 a year');
  assert.equal(priceText(p(1500, 'usd', 'month', 3)), '$15 every 3 months');
  assert.equal(priceText(p(2000, 'jpy', 'month')), '¥2,000 a month', 'a currency without cents');
  assert.equal(priceText(p(500, 'usd', null)), '$5');
  assert.equal(priceText({ currency: 'usd' }), null, 'no amount (a metered price): nothing made up');
});

test("the price is read from Stripe once an hour; one Stripe won't give says Checkout shows it (#872)", async () => {
  const stripe = fakeStripe();
  const api = `http://127.0.0.1:${await listen(stripe.server)}`;
  try {
    const billing = { secretKey: 'sk', prices: { price_pro: 'pro' }, api };
    const t = 1_000_000;
    assert.equal(offerLine((await offers(billing, { now: t }))[0]), 'Pro: any number of agents side by side, $19 a month');
    stripe.state.price = { ...stripe.state.price, unit_amount: 2900 };
    await offers(billing, { now: t + OFFER_MS - 1 });
    assert.equal(stripe.state.reads, 1, 'within the hour: not read again');
    assert.equal((await offers(billing, { now: t + OFFER_MS }))[0].price, '$29 a month', 'a changed price shows after the hour');
    const gone = { secretKey: 'sk', prices: { price_gone: 'pro' }, api };
    assert.equal(offerLine((await offers(gone))[0]), 'Pro: any number of agents side by side, price shown at Checkout');
  } finally { stripe.server.close(); stripe.server.closeAllConnections(); }
});
