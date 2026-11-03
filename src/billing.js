// Billing (#227): a workspace pays through Stripe, and the hub hears about it only from Stripe's signed webhook,
// never from the redirect back. Stripe is plain HTTPS: node:crypto checks its signature, no SDK. Each event
// keeps a per-workspace billing row in the directory (src/directory.js); Workspaces.planInfo follows it.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { envVar } from './names.js';
import { deliver } from './notify.js';

export const TOLERANCE_MS = 5 * 60 * 1000; // a signature older (or newer) than this is refused: no replays
// A subscription in one of these makes its workspace paid; a cancelled one stays paid until its period ends.
export const PAID = new Set(['active', 'trialing', 'past_due']);

// From the environment only, and off unless set: NUWORQ_STRIPE_SECRET_KEY, NUWORQ_STRIPE_WEBHOOK_SECRET and
// NUWORQ_STRIPE_PRICES ("pro=price_123,team=price_456"). Without the webhook secret nothing can be verified: null.
export function billingFromEnv(env = process.env) {
  const webhookSecret = String(envVar('STRIPE_WEBHOOK_SECRET', env) ?? '').trim();
  if (!webhookSecret) return null;
  const prices = {};
  for (const pair of String(envVar('STRIPE_PRICES', env) ?? '').split(',')) {
    const [plan, price] = pair.split('=').map((s) => s?.trim());
    if (plan && price) prices[price] = plan;
  }
  return { secretKey: String(envVar('STRIPE_SECRET_KEY', env) ?? '').trim(), webhookSecret, prices };
}

// Whether the Stripe-Signature header ("t=<unix seconds>,v1=<hex>,v1=…") signs raw: HMAC-SHA256 of "t.raw"
// with the endpoint's secret, matching any v1, with t within TOLERANCE_MS of now.
export function verifySignature(secret, header, raw, now = Date.now()) {
  if (!secret || !header) return false;
  const parts = String(header).split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!Number.isFinite(t) || Math.abs(now - t * 1000) > TOLERANCE_MS) return false;
  const want = createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
  return parts.filter(([k, v]) => k === 'v1' && /^[0-9a-f]{64}$/i.test(v ?? ''))
    .some(([, v]) => timingSafeEqual(Buffer.from(v, 'hex'), want));
}

// Whether a billing row makes its workspace paid at now.
export function paid(b, now = Date.now()) {
  if (!b) return false;
  if (PAID.has(b.status)) return true;
  return b.status === 'canceled' && !!b.period_end && b.period_end > now;
}

// One line for the hub owners: "paid until 2026-12-01", "cancels 2026-12-01", "payment failed", or null.
export function billingLine(b, now = Date.now()) {
  if (!b?.status) return null;
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  if (b.status === 'past_due' || b.status === 'unpaid') return 'payment failed';
  if (b.status === 'canceled') return b.period_end > now ? `cancelled, paid until ${day(b.period_end)}` : 'cancelled';
  if (b.cancel_at_period_end && b.period_end) return `cancels ${day(b.period_end)}`;
  if (PAID.has(b.status)) return `${b.status === 'trialing' ? 'trial' : 'paid'}${b.period_end ? ` until ${day(b.period_end)}` : ''}`;
  return b.status.replace(/_/g, ' ');
}

// Whether a payment failed and nothing was paid since (#231): an invoice.payment_failed not yet followed by an
// invoice.paid, or Stripe saying past_due/unpaid after the last payment.
export function failing(b) {
  if (!b) return false;
  return !!b.failed_at || (['past_due', 'unpaid'].includes(b.status) && b.event_at > (b.paid_at ?? 0));
}

const day = (t) => new Date(t).toISOString().slice(0, 10);
const planName = (b) => { const p = String(b?.plan || 'pro'); return p[0].toUpperCase() + p.slice(1); };

// The workspace's billing in plain words, for its owner (#231): "Pro, renews 2026-12-01", "Pro until
// 2026-12-01, then Free", "Payment failed: update your card by 2026-11-08 to keep Pro". null: nothing paid (Free).
export function billingState(b, now = Date.now()) {
  if (!b?.status) return null;
  const plan = planName(b);
  if (failing(b)) {
    return paid(b, now) ? `Payment failed: update your card ${b.pay_by > now ? `by ${day(b.pay_by)}` : 'now'} to keep ${plan}`
      : `Payment failed: ${plan} has stopped. Update your card to start it again`;
  }
  if (!paid(b, now)) return null;
  if (b.status === 'canceled' || b.cancel_at_period_end) return b.period_end ? `${plan} until ${day(b.period_end)}, then Free` : `${plan}, cancelled`;
  const kind = b.status === 'trialing' ? `${plan} trial` : plan;
  return b.period_end ? `${kind}, renews ${day(b.period_end)}` : kind;
}

// The Needs you entry a failed payment raises for the workspace's owners (#231), or null. settings: the address
// of the workspace's settings (where Manage billing is). It goes once invoice.paid arrives.
export function paymentEntry(b, settings, now = Date.now()) {
  if (!failing(b)) return null;
  const at = b.failed_at ?? b.event_at;
  const plan = planName(b);
  return {
    key: `payment-failed:${b.subscription}:${at}`, level: 'act', kind: 'payment-failed', at,
    headline: billingState(b, now), sub: 'this workspace',
    why: `Stripe couldn't take the payment for ${plan}. It retries the card for a while; once it gives up, the workspace goes back to Free and runs one agent at a time.`,
    how: [
      { do: 'Open Workspace settings and click Manage billing: it opens Stripe\'s billing page for this workspace', where: settings },
      { do: 'Under Payment method, click Add payment method, enter the new card and make it the default. If an invoice shows as unpaid, click it and pay it with that card' },
      { do: 'Click Return to nuworq', check: `Workspace settings read "${plan}, renews <date>" again, and this card is gone` },
    ],
  };
}

// The Stripe customer portal for a customer (#231): POST /v1/billing_portal/sessions over fetch. Returns its url;
// throws with Stripe's message. billing.api: Stripe's address (tests point it at a fake).
export async function portalSession(billing, customer, returnUrl, { fetch = globalThis.fetch } = {}) {
  const res = await fetch(`${billing.api || 'https://api.stripe.com'}/v1/billing_portal/sessions`, {
    method: 'POST', signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${billing.secretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ customer, return_url: returnUrl }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.url) throw new Error(`Stripe didn't open the billing portal: ${j.error?.message ?? `HTTP ${res.status}`}`);
  return j.url;
}

// A failed payment, pushed once to the personal notification channels of the workspace's owners (#231): the
// workspace's hub-wide channels reach people who don't manage billing. Never throws: a failing channel is recorded on it.
export async function pushFailed(hub, b, settings, opts = {}) {
  const channels = hub.db.prepare(`SELECT c.* FROM channels c JOIN people p ON c.person = '@' || p.handle WHERE p.role = 'owner' ORDER BY c.id`).all();
  const e = paymentEntry(b, settings, hub.now());
  if (!e || !channels.length) return [];
  const title = `nuworq: payment failed for ${hub.workspace ?? 'your workspace'}`;
  const msg = { title, url: settings, text: [title, e.headline, `→ ${settings}`].join('\n'), entries: [] };
  return Promise.all(channels.map((c) => deliver(hub.db, c, msg, { guard: true, ...opts }))); // billing is a shared host's
}

const ms = (s) => (Number(s) > 0 ? Number(s) * 1000 : null);
const idOf = (x) => (typeof x === 'string' ? x : x?.id ?? null);

// Apply one verified event. spaces: the Workspaces registry. Returns { ok, ignored?, duplicate?, workspace? }.
// An event id seen before is acknowledged and ignored. Events Stripe sends out of order are fine: a subscription
// event before its checkout keeps its row by subscription id, and the checkout then names the workspace.
export function applyEvent(spaces, event, { prices = {} } = {}) {
  const dir = spaces.directory;
  if (!event?.id || !event.type) return { ok: true, ignored: 'not an event' };
  if (dir.eventSeen(event.id)) return { ok: true, duplicate: true };
  const r = apply(spaces, event, prices);
  dir.markEvent(event.id); // after, so an event that failed half-way is applied again when Stripe retries
  return r;
}

function apply(spaces, event, prices) {
  const dir = spaces.directory;
  const o = event.data?.object ?? {};
  const at = ms(event.created) ?? dir.now();
  if (event.type === 'checkout.session.completed') {
    const ws = String(o.client_reference_id ?? '');
    if (!spaces.has(ws) || !o.subscription) return { ok: true, ignored: 'no workspace or subscription' };
    // The subscription's own events carry its state; this only fills one in when they haven't come yet. A checkout
    // doesn't say what it sold (#478), so with prices configured it only names the workspace: the subscription's
    // events, which do, decide whether it's paid.
    const status = o.payment_status === 'paid' && !Object.keys(prices).length ? 'active' : null;
    dir.setBilling(idOf(o.subscription), { workspace: ws, customer: idOf(o.customer) }, { at, status, fill: true });
    return { ok: true, workspace: ws };
  }
  if (/^customer\.subscription\.(created|updated|deleted)$/.test(event.type)) {
    const items = o.items?.data ?? [];
    const known = Object.keys(prices);
    // With prices configured, a subscription to some other product of the same Stripe account isn't ours. One the
    // hub keeps (a checkout named it, or it was ours and changed to another price) pays for nothing from now on.
    if (known.length && !items.some((i) => known.includes(i.price?.id))) {
      if (!dir.billingRow(o.id)) return { ok: true, ignored: 'not a nuworq price' };
      const row = dir.setBilling(o.id, { customer: idOf(o.customer) }, { at, status: 'canceled', plan: null });
      return { ok: true, workspace: row?.workspace ?? null, paid_for: 'nothing: not a nuworq price' };
    }
    const plan = prices[items.find((i) => prices[i.price?.id])?.price?.id] ?? null;
    // Newer API versions keep the period on each item; older ones on the subscription.
    const end = ms(o.current_period_end) ?? (Math.max(0, ...items.map((i) => ms(i.current_period_end) ?? 0)) || null);
    const ws = o.metadata?.workspace && spaces.has(o.metadata.workspace) ? o.metadata.workspace : null;
    const row = dir.setBilling(o.id, { workspace: ws, customer: idOf(o.customer) }, {
      at, status: event.type.endsWith('deleted') ? 'canceled' : o.status, period_end: end, cancel_at_period_end: !!o.cancel_at_period_end, plan,
    });
    return { ok: true, workspace: row?.workspace ?? null };
  }
  // A renewal that failed, or was paid (#231). Only for a subscription the hub already keeps: anything else on the
  // same Stripe account isn't ours. Newer API versions name the subscription under parent.subscription_details.
  if (event.type === 'invoice.payment_failed' || event.type === 'invoice.paid') {
    const subscription = idOf(o.subscription) ?? idOf(o.parent?.subscription_details?.subscription);
    const failed = event.type === 'invoice.payment_failed';
    // next_payment_attempt: Stripe's next retry; none means it has stopped retrying.
    const row = subscription && dir.setPayment(subscription, { at, failed, pay_by: failed ? ms(o.next_payment_attempt) : null });
    if (!row) return { ok: true, ignored: 'not a subscription the hub keeps' };
    return { ok: true, workspace: row.workspace, ...(failed && row.failed_at === at && row.workspace ? { failed: true } : {}) };
  }
  return { ok: true, ignored: event.type };
}

// ── Checkout (#228): a Free workspace's owner pays; the webhook above changes the plan ──

export const TERMS = 'https://nuworq.com/terms';
export const PRIVACY = 'https://nuworq.com/privacy';

// Whether people can pay: a secret key to open Checkout with, and at least one price to sell. billingFromEnv's
// webhook secret is already there, or billing would be null.
export const canSell = (billing) => !!(billing?.secretKey && Object.keys(billing.prices ?? {}).length);

// The plans on sale, in NUWORQ_STRIPE_PRICES order: [{ plan, price, label }].
export const plansOf = (billing) => Object.entries(billing?.prices ?? {})
  .map(([price, plan]) => ({ plan, price, label: plan.charAt(0).toUpperCase() + plan.slice(1) }));

// ── What a plan gives and costs (#872): said before Checkout opens, in settings and in Free's refusal ──

export const GIVES = 'any number of agents side by side'; // what every paid plan gives over Free
export const OFFER_MS = 60 * 60 * 1000; // how long a price read from Stripe is trusted before it's read again

// "$19 a month", "€190 a year", "$5 every 3 months", from a Stripe Price; null without an amount.
export function priceText(p) {
  if (!Number.isFinite(p?.unit_amount) || !p.currency) return null;
  const currency = p.currency.toUpperCase();
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  const n = p.unit_amount / 10 ** digits;
  const money = new Intl.NumberFormat('en', { style: 'currency', currency, ...(Number.isInteger(n) ? { maximumFractionDigits: 0 } : {}) }).format(n);
  const { interval, interval_count: k = 1 } = p.recurring ?? {};
  if (!interval) return money;
  return k > 1 ? `${money} every ${k} ${interval}s` : `${money} a ${interval}`;
}

// Each plan on sale with what it gives and its price as Stripe has it: [{ plan, label, gives, price }]. The price
// is the configured Stripe Price's own (GET /v1/prices/<id>), never written down here, so it can't drift from
// what Checkout charges. Read once an hour; a price Stripe won't give stays null and the line says "see Checkout".
export async function offers(billing, { now = Date.now() } = {}) {
  const cache = (billing.offerCache ??= new Map());
  await Promise.all(plansOf(billing).map(async ({ price }) => {
    const c = cache.get(price);
    if (c && now - c.at < OFFER_MS) return;
    try {
      const r = await fetch(`${billing.api ?? 'https://api.stripe.com'}/v1/prices/${encodeURIComponent(price)}`, {
        signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${billing.secretKey}` },
      });
      cache.set(price, { at: now, text: r.ok ? priceText(await r.json()) : null });
    } catch { cache.set(price, { at: now - OFFER_MS + 60_000, text: c?.text ?? null }); } // try again in a minute
  }));
  return offersNow(billing);
}

// The same from what's already been read, for a caller that can't wait (an agent's refused claim).
export const offersNow = (billing) => plansOf(billing)
  .map(({ plan, price, label }) => ({ plan, label, gives: GIVES, price: billing.offerCache?.get(price)?.text ?? null }));

// One plan in one line: "Pro: any number of agents side by side, $19 a month".
export const offerLine = (o) => `${o.label}: ${o.gives}, ${o.price ?? 'price shown at Checkout'}`;

// Stripe's API: form-encoded POST, JSON back. billing.api points it at a fake in tests. Throws on anything
// but 2xx, with Stripe's own message.
export async function stripe(billing, path, params) {
  const body = new URLSearchParams();
  const add = (k, v) => {
    if (v === undefined || v === null) return;
    if (typeof v === 'object') for (const [kk, vv] of Object.entries(v)) add(`${k}[${kk}]`, vv);
    else body.append(k, String(v));
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  const r = await fetch(`${billing.api ?? 'https://api.stripe.com'}${path}`, {
    method: 'POST', body, signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${billing.secretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json?.error?.message ?? `Stripe answered ${r.status}`);
  return json;
}

// A Checkout Session that subscribes workspace to plan's price. home: the workspace's address; Stripe returns
// to its settings either way, and only the webhook changes the plan. Returns Stripe's session ({ id, url }).
export function checkout(billing, { workspace, plan, home, email = null, customer = null }) {
  const sale = plansOf(billing).find((p) => p.plan === plan);
  if (!sale) throw new Error(`"${plan}" is not on sale`);
  return stripe(billing, '/v1/checkout/sessions', {
    mode: 'subscription',
    line_items: { 0: { price: sale.price, quantity: 1 } },
    client_reference_id: workspace,
    // So the subscription's own events name the workspace too, whatever order they come in.
    subscription_data: { metadata: { workspace } },
    metadata: { workspace },
    ...(customer ? { customer } : email ? { customer_email: email } : {}),
    success_url: `${home}/?checkout=done#/settings`,
    cancel_url: `${home}/#/settings`,
    custom_text: { submit: { message: `By subscribing you agree to nuworq's [Terms](${TERMS}) and [Privacy Policy](${PRIVACY}).` } },
  });
}
