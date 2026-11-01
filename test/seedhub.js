// A hub the size of nuworq's own (#538): about 500 items in every stage, 450 agents and 10k events, built the
// same way every time (a fixed clock and no randomness), so two runs of view, checkin, next, look and route on it
// can be compared output for output.
import { Hub } from '../src/core.js';

export const SLUG = 'big';
const MIN = 60_000;

export function seedHub({ items: total = 500, agents: crowd = 450, progress = 20 } = {}) {
  let t = Date.UTC(2026, 9, 1, 9);
  const hub = new Hub({ clock: () => t });
  const tick = (ms = MIN) => (t += ms);
  let step = MIN;
  const op = (name, agent, args) => { tick(step); try { return hub.agentOp(SLUG, name, agent, args); } catch (e) { if (process.env.SEED_DEBUG) console.log(name, agent, args.item, e.message); return null; } };
  hub.tx(() => hub.project(SLUG, { create: true }));
  hub.humanOp(SLUG, 'settings', { autonomy: 'full' });
  hub.humanOp(SLUG, 'decide', { body: 'Zero runtime dependencies.' });

  const names = Array.from({ length: crowd }, (_, k) => `claude-${(k * 7919).toString(16).padStart(4, '0').slice(-4)}${k}`);
  const has = (k) => [['macos'], ['linux', 'docker'], ['browser'], [], ['macos', 'browser']][k % 5];
  for (const [k, n] of names.entries()) op('checkin', n, { has: has(k), model: k % 9 ? 'claude-opus-5-5' : 'claude-sonnet-5-5', status: `on duty ${k}` });

  // Milestones every 25 items, their parts after them; every 7th item waits on the one before it.
  let milestone = null;
  for (let s = 1; s <= total; s++) {
    tick();
    const args = { title: `Item ${s}: ${['fix', 'build', 'shape', 'check'][s % 4]} the ${['view', 'runner', 'guide', 'hub'][s % 3]}`, acceptance: s % 11 ? `It works (${s})` : '', priority: ['now', 'soon', 'later'][s % 3] };
    if (s % 25 === 1) { hub.humanOp(SLUG, 'create', { ...args, title: `Milestone ${s}` }); milestone = s; continue; }
    if (milestone && s % 3) args.parent = `#${milestone}`;
    if (s % 7 === 0) args.depends_on = [`#${s - 1}`];
    if (s % 13 === 0) args.needs = ['browser'];
    if (s % 17 === 0) args.needs = ['operator', 'infra'];
    if (s % 5 === 0) op('propose', names[s % crowd], { ...args, summary: `Proposed by an agent (${s})` });
    else hub.humanOp(SLUG, 'create', { ...args, ...(s % 19 === 0 ? { stage: 'proposed' } : {}) });
  }

  // Work, item by item: an agent claims it, reports progress and submits; another reviews it. Some is sent back,
  // handed off or asked about; the last stretch stays in flight.
  let a = 0;
  const who = () => names[a++ % crowd];
  const inFlight = [];
  for (let s = 2; s <= total; s++) {
    if (s % 25 === 1 || s % 10 === 4) continue; // milestones wait for their parts; some work is never started
    const ref = `#${s}`, agent = who();
    if (s > total - 40 && s % 2) { inFlight.push([agent, ref]); continue; }
    if (!op('claim', agent, { item: ref })) continue;
    const it = hub.item(hub.project(SLUG), ref);
    if (it.stage === 'proposed') {
      op('refine', agent, { item: ref, acceptance: 'Shaped: it works', difficulty: 'standard', difficulty_why: 'one module' });
      op('submit', agent, { item: ref, headline: `Shaped ${ref}` });
      continue;
    }
    op('progress', agent, { item: ref, headline: `Started ${ref}`, touching: [`src/${s % 9}.js`] });
    for (let k = 0; k < progress; k++) op('progress', agent, { item: ref, headline: `Step ${k} on ${ref}` });
    if (s % 23 === 0) op('ask', agent, { item: ref, question: `Which way for ${ref}?`, blocking: s % 2 === 0, assumption: s % 2 ? 'the simple one' : undefined });
    if (s % 29 === 0) op('learn', agent, { note: `Field note ${s}: run npm test first`, item: ref });
    if (s % 31 === 0) op('comment', agent, { item: ref, body: `A comment on ${ref}` });
    if (s % 9 === 0) { op('handoff', agent, { item: ref, headline: `Handing off ${ref}` }); continue; }
    op('submit', agent, { item: ref, headline: `Done ${ref}`, evidence: [{ label: 'npm test: passed' }] });
    if (s % 6 === 0) continue; // waits for a review
    const reviewer = who();
    if (op('claim', reviewer, { item: ref })) op('review', reviewer, { item: ref, verdict: s % 8 ? 'accept' : 'reject', headline: s % 8 ? 'Looks right' : 'Missing tests' });
  }
  // Questions for the operator and the human, a steer, and the agents still working report in.
  op('ask', names[3], { question: 'Run the probe on the VM?', to: 'operator', blocking: false, assumption: 'later' });
  hub.humanOp(SLUG, 'steer', { body: 'Prefer small changes.' });
  step = 5000; // within one lease: the last work stays in flight
  for (const [agent, ref] of inFlight) op('claim', agent, { item: ref }) && op('progress', agent, { item: ref, headline: `On ${ref}`, touching: ['src/core.js'] });
  for (const n of names.slice(0, 40)) op('checkin', n, {});
  return { hub, names, tick, now: () => t };
}
