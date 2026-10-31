// A project anyone may watch (#358): what agents are doing on it, read-only, with no sign-in.
//
// Only what this file names leaves the hub. Everything is copied field by field from the project's view and
// outcomes, never spread: item numbers, titles and stages, the agent and model on each, counts, durations and
// costs. Never a summary, detail, headline, evidence, field note, question, answer, steer, decision, email,
// token or machine name. test/live.test.js seeds each of those with a marker and checks none gets out.
import { view } from './insight.js';
import { outcomes, tally } from './outcomes.js';
import { dur } from './core.js';

export const LIVE_TTL_MS = 15_000; // computed at most this often per project; also what proxies may cache
const LANDED_SHOWN = 12;

// hub → slug → { at, data }: one hub may serve many visitors the same answer.
const cache = new WeakMap();

// The public view of a project, or null when it isn't watchable (unknown, or the owner hasn't turned it on).
export function liveView(hub, slug) {
  const p = hub.q('SELECT * FROM projects WHERE slug = ?').get(String(slug));
  if (!p?.live) return null;
  const now = Date.now();
  const mine = cache.get(hub) ?? new Map();
  cache.set(hub, mine);
  const hit = mine.get(p.slug);
  if (hit && now - hit.at < LIVE_TTL_MS) return hit.data;
  const data = compute(hub, p);
  mine.set(p.slug, { at: now, data });
  return data;
}

function compute(hub, p) {
  const v = view(hub, p.slug);
  const t = hub.now();
  const reviewing = new Set(v.verifying.map((i) => `${i.item} ${i.reviewer}`));
  const motion = v.motion.map((m) => ({
    item: m.item, title: m.title, agent: m.agent, model: m.model || null,
    stage: m.shaping ? 'shaping' : m.landing ? 'landing' : reviewing.has(`${m.item} ${m.agent}`) ? 'reviewing' : 'building',
    for: m.for,
  }));
  const working = new Set(motion.map((m) => m.agent)).size;
  const state = p.parked ? 'parked' : motion.length ? 'flowing' : 'idle';
  const sentence = p.parked ? 'Paused for now: nothing new starts.'
    : motion.length ? `${working} agent${working === 1 ? '' : 's'} working on ${motion.length} item${motion.length === 1 ? '' : 's'} right now.`
      : 'No agent is working right now.';

  const o = outcomes(hub, p.slug, { since: 0, until: t });
  const all = tally(o.items);
  const landed = o.items.filter((i) => i.outcome === 'landed').sort((a, b) => b.done_at - a.done_at).slice(0, LANDED_SHOWN)
    .map((i) => ({ item: i.item, title: i.title, agent: i.implementer, model: i.model, ago: dur(t - i.done_at), cycle: i.cycle_ms != null ? dur(i.cycle_ms) : null }));
  const f = v.flow;
  return {
    project: { slug: p.slug, name: p.name },
    at: t,
    pulse: { state, sentence, working, active: motion.length },
    motion,
    flow: {
      window: f.window,
      stages: f.stages.map((s) => ({ stage: s.stage, label: s.label, count: s.count, court: s.court })),
      court: { agents: f.court.agents, queue: f.court.queue, you: f.court.you, external: f.court.external },
      throughput: [...f.throughput],
    },
    landed,
    totals: {
      since: o.items.length ? Math.min(...o.items.map((i) => i.done_at)) : null,
      landed: all.landed, sent_back: all.sent_back,
      median_cycle: all.median_cycle_ms != null ? dur(all.median_cycle_ms) : null,
      cost_per_landed: all.cost_per_landed,
    },
    early_access: 'https://nuworq.com/early-access',
  };
}
