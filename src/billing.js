// Billing (#227): a workspace pays through Stripe, and the hub hears about it only from Stripe's signed webhook,
// never from the redirect back. Stripe is plain HTTPS: node:crypto checks its signature, no SDK. Each event
// keeps a per-workspace billing row in the directory (src/directory.js); Workspaces.planInfo follows it.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { envVar } from './names.js';

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
    // The subscription's own events carry its state; this only fills one in when they haven't come yet.
    dir.setBilling(idOf(o.subscription), { workspace: ws, customer: idOf(o.customer) }, { at, status: o.payment_status === 'paid' ? 'active' : null, fill: true });
    return { ok: true, workspace: ws };
  }
  if (/^customer\.subscription\.(created|updated|deleted)$/.test(event.type)) {
    const items = o.items?.data ?? [];
    const known = Object.keys(prices);
    // With prices configured, a subscription to some other product of the same Stripe account isn't ours.
    if (known.length && !items.some((i) => known.includes(i.price?.id))) return { ok: true, ignored: 'not a nuworq price' };
    const plan = prices[items.find((i) => prices[i.price?.id])?.price?.id] ?? null;
    // Newer API versions keep the period on each item; older ones on the subscription.
    const end = ms(o.current_period_end) ?? (Math.max(0, ...items.map((i) => ms(i.current_period_end) ?? 0)) || null);
    const ws = o.metadata?.workspace && spaces.has(o.metadata.workspace) ? o.metadata.workspace : null;
    const row = dir.setBilling(o.id, { workspace: ws, customer: idOf(o.customer) }, {
      at, status: event.type.endsWith('deleted') ? 'canceled' : o.status, period_end: end, cancel_at_period_end: !!o.cancel_at_period_end, plan,
    });
    return { ok: true, workspace: row?.workspace ?? null };
  }
  return { ok: true, ignored: event.type };
}
