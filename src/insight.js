// The 0-30-5-30 lens: turns raw state into what a facilitator should see.
//   0   → healthy, irrelevant or nonexistent things are simply absent
//   30s → pulse + the few things that need you, each with the action that moves it on
//   5m  → what's in motion, where time goes, what's next
//   30m → every agent, every event, every layer of detail
import { STAGES, AUTONOMY, OPEN_STAGES, courtOf, dur, providerOf, MIN, HOUR, DAY, HUMAN, LEASE_MS, isHuman } from './core.js';

const FLOW_WINDOW = 14 * DAY;
const json = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// viewer: the person looking ("@handle"), so "needs you" counts only their own; none in local mode.
export function projectList(hub, { viewer } = {}) {
  return hub.projects().map((p) => {
    const v = view(hub, p.slug, { light: true, viewer });
    return { slug: p.slug, name: p.name, mission: p.mission, parked: !!p.parked, path: p.path || null, pulse: v.pulse, needs: v.attention.filter((a) => a.level === 'act').length };
  });
}

export function view(hub, slug, { light = false, viewer } = {}) {
  const p = hub.project(slug);
  const t = hub.now();
  const items = hub.q('SELECT * FROM items WHERE project_id = ? ORDER BY seq').all(p.id);
  const byId = new Map(items.map((i) => [i.id, i]));
  const ref = (i) => `#${i.seq}`;
  const agents = hub.q('SELECT * FROM agents WHERE project_id = ? ORDER BY last_seen DESC').all(p.id);
  const openQs = hub.q(`SELECT * FROM questions WHERE project_id = ? AND status = 'open' ORDER BY at`).all(p.id);
  const dismissed = new Set(hub.q('SELECT key FROM dismissals WHERE project_id = ?').all(p.id).map((d) => d.key));
  const unmet = (i) => hub.unmetDeps(i);
  const lastEvent = (i, types) => hub.q(`SELECT * FROM events WHERE item_id = ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY at DESC, id DESC LIMIT 1`).get(i.id, ...types);

  const in_ = (stage) => items.filter((i) => i.stage === stage);
  const active = in_('active');
  const shaping = in_('proposed').filter((i) => i.holder);
  // Running race attempts: each is its own line of work, with its own agent and lease.
  const racers = hub.q(`SELECT a.* FROM attempts a JOIN items i ON i.id = a.item_id
    WHERE i.project_id = ? AND i.stage = 'active' AND a.stage = 'active' AND a.closed = 0 ORDER BY a.id`).all(p.id);
  const readyFree = in_('ready').filter((i) => !i.holder && !unmet(i).length);
  const shapeable = p.parked ? [] : hub.shapeable(p);
  const recentAgents = agents.filter((a) => !a.signed_off && t - a.last_seen < 30 * MIN);
  const inFlight = active.length + shaping.length;

  // ── attention: what needs you (act) and what's worth knowing (know) ──
  const attention = [];
  const push = (a) => { if (!dismissed.has(a.key)) attention.push(a); };

  for (const q of openQs.filter((q) => q.blocking)) {
    const it = byId.get(q.item_id);
    push({
      key: `q:${q.id}`, level: 'act', kind: 'question', at: q.at,
      headline: q.question,
      sub: [it?.title, `${q.asked_by} asked ${dur(t - q.at)} ago`, it?.stage === 'waiting' && 'work is parked until you answer'].filter(Boolean).join(' · '),
      why: q.context, detail: q.detail,
      item: it ? ref(it) : null,
      question: { id: q.id, options: json(q.options, []), asked_by: q.asked_by },
    });
  }

  if (p.autonomy !== 'full') {
    for (const it of in_('verifying')) {
      const sub = lastEvent(it, ['submitted']);
      const evidence = json(sub?.data, {}).evidence ?? [];
      push({
        key: `review:${it.id}:${sub?.id ?? 0}`, level: 'act', kind: 'review', at: it.stage_since,
        headline: sub?.headline || it.title,
        sub: `${it.title} · ${it.implementer ?? 'an agent'} finished it ${dur(t - it.stage_since)} ago`,
        why: sub?.summary, detail: sub?.detail,
        acceptance: it.acceptance, evidence,
        warn: evidence.length ? null : 'No evidence attached',
        item: ref(it),
        attempts: it.race > 1 ? hub.submissions(it) : undefined, // a race: compare and keep one
      });
    }
  } else {
    for (const it of in_('verifying').filter((i) => !i.holder && t - i.stage_since > 2 * HOUR)) {
      push({
        key: `peer:${it.id}`, level: 'know', kind: 'peer-review-stuck', at: it.stage_since,
        headline: `${ref(it)} has waited ${dur(t - it.stage_since)} for a peer review`,
        sub: it.title, why: 'No other agent has picked it up. Review it yourself, or start another agent.',
        item: ref(it),
      });
    }
  }

  for (const it of in_('proposed')) {
    if (p.autonomy === 'ask') {
      // Only shaped proposals reach you: approving a raw idea isn't a 30-second decision; approving a shaped one is.
      if (!it.acceptance || it.holder) continue;
      const shaped = lastEvent(it, ['shaped']);
      push({
        key: `proposal:${it.id}`, level: 'act', kind: 'proposal', at: shaped?.at ?? it.created_at,
        headline: it.title,
        sub: shaped ? `${shaped.actor} shaped it ${dur(t - shaped.at)} ago` : `${it.created_by === HUMAN ? 'You' : it.created_by} proposed it ${dur(t - it.created_at)} ago`,
        why: [shaped?.headline, it.summary].filter(Boolean).join('\n\n'), acceptance: it.acceptance, item: ref(it),
      });
    } else if (it.created_at > p.seen_at && !isHuman(it.created_by)) {
      push({
        key: `proposal:${it.id}`, level: 'know', kind: 'proposal', at: it.created_at,
        headline: `${it.created_by} proposed: ${it.title}`,
        sub: 'agents can shape this into ready work themselves',
        why: it.summary, item: ref(it),
      });
    }
  }

  for (const it of items.filter((i) => OPEN_STAGES.includes(i.stage) && i.stalls + i.rejections >= 2)) {
    const h = json(it.handoff, null);
    const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
    const parts = [it.rejections && `sent back ${times(it.rejections)}`, it.stalls && `agents went quiet ${times(it.stalls)}`].filter(Boolean).join(', ');
    push({
      key: `struggle:${it.id}:${it.stalls + it.rejections}`, level: 'act', kind: 'struggling', at: it.updated_at,
      headline: it.title,
      sub: `${plural(it.attempts, 'attempt')}: ${parts}`,
      why: [
        h && `Latest: ${h.by === HUMAN ? 'you' : h.by} — "${h.headline}"`,
        'Agents keep failing to land this. The intent may be unclear, the acceptance criteria may be wrong, or it may be too big. Clarify it with a steer, split it, or drop it.',
      ].filter(Boolean).join('\n\n'),
      item: ref(it),
    });
  }

  for (const q of openQs.filter((q) => !q.blocking)) {
    const it = byId.get(q.item_id);
    push({
      key: `q:${q.id}`, level: 'know', kind: 'assumption', at: q.at,
      headline: `${q.asked_by} assumed: ${q.assumption}`,
      sub: [`Q: ${q.question}`, `${dur(t - q.at)} ago`].filter(Boolean).join(' · '),
      why: q.context, item: it ? ref(it) : null,
      question: { id: q.id, options: json(q.options, []), assumption: q.assumption, asked_by: q.asked_by },
    });
  }

  const steers = hub.q(`SELECT n.*, i.seq AS item_seq FROM notes n LEFT JOIN items i ON i.id = n.item_id
      WHERE n.project_id = ? AND n.kind = 'steer' AND n.active = 1 AND n.at > ? ORDER BY n.at DESC`).all(p.id, t - 3 * DAY)
    .map((n) => {
      const acks = hub.q('SELECT * FROM acks WHERE note_id = ? ORDER BY at').all(n.id);
      return { id: n.id, body: n.body, item: n.item_seq ? `#${n.item_seq}` : null, at: n.at, acks: acks.map((a) => ({ agent: a.agent, response: a.response, at: a.at })) };
    });
  for (const s of steers.filter((s) => !s.acks.length && t - s.at > 15 * MIN)) {
    push({
      key: `steer:${s.id}`, level: 'know', kind: 'steer-unseen', at: s.at,
      headline: `No agent has picked up your steer yet (${dur(t - s.at)})`,
      sub: `"${s.body.slice(0, 120)}"`,
      why: recentAgents.length ? 'Agents see steering on their next call to Trellis.' : 'No agents are active right now. They will see it when they check in.',
      item: s.item,
    });
  }

  // Silence must be earned. If nothing is moving and you haven't parked the project, say so.
  const lastAgentSeen = agents.reduce((m, a) => Math.max(m, a.last_seen), 0);
  const picked = shapeable.filter((i) => i.priority === 'now');
  const direction = !p.parked && !inFlight && !readyFree.length && shapeable.length && !picked.length;
  if (direction) {
    const rank = { now: 0, soon: 1, later: 2 };
    const options = [...shapeable].sort((a, b) => rank[a.priority] - rank[b.priority] || a.seq - b.seq).slice(0, 8);
    push({
      key: 'direction', level: 'act', kind: 'direction', at: Math.min(...shapeable.map((i) => i.created_at)),
      headline: 'What matters most?',
      sub: `${plural(shapeable.length, 'idea')}, nothing ready, nothing in flight`,
      why: `Pick one. The next agent shapes it into work (what done means, split if it's big), then it gets built.${recentAgents.length ? '' : ' No agent is connected yet, so you will also need to start one.'} Or park the project if it should stay quiet.`,
      picks: options.map((i) => ({ item: ref(i), title: i.title, summary: i.summary })),
    });
  }
  const claimable = readyFree.length + shapeable.length;
  if (!p.parked && !direction && claimable && !recentAgents.length) {
    push({
      key: `no-agents:${Math.floor(t / (6 * HOUR))}`, level: inFlight ? 'know' : 'act', kind: 'no-agents', at: lastAgentSeen || t,
      headline: readyFree.length ? `${plural(readyFree.length, 'item')} ready, but no agent is working` : `Work is waiting to be shaped, but no agent is working`,
      sub: lastAgentSeen ? `Last agent activity ${dur(t - lastAgentSeen)} ago` : 'No agent has checked in yet',
      why: 'Start an agent pointed at this project. Any model works: Claude Code, Codex, or an open-weight model through any MCP client or the plain CLI. Or park the project if it should stay quiet.',
      start: true,
    });
  } else if (!p.parked && !claimable && !inFlight && recentAgents.length) {
    const approvals = in_('proposed').filter((i) => !i.holder && i.acceptance && p.autonomy === 'ask').length;
    if (in_('waiting').length || approvals) {
      push({
        key: `starved:${Math.floor(t / (6 * HOUR))}`, level: 'know', kind: 'starved', at: t,
        headline: 'Agents are out of work',
        sub: [approvals && `${approvals} shaped proposal${approvals === 1 ? '' : 's'} to approve`, in_('waiting').length && `${in_('waiting').length} waiting on your answer`].filter(Boolean).join(' · '),
        why: 'Everything left is waiting on you.',
      });
    }
  }

  // With people, every "needs you" has owners: whoever steered the item, else the project's stewards.
  // The viewer's own stay act; everyone else's become worth knowing, so "needs you" means you.
  if (hub.hasPeople()) {
    const bySeq = new Map(items.map((i) => [ref(i), i]));
    for (const a of attention.filter((x) => x.level === 'act')) {
      a.owners = hub.ownersOf(p, a.item ? bySeq.get(a.item) : null);
      if (viewer && !a.owners.includes(viewer)) {
        a.level = 'know';
        a.sub = [a.owners.length ? `needs ${a.owners.join(', ')}` : 'needs a steward (none set)', a.sub].filter(Boolean).join(' · ');
      }
    }
  }
  attention.sort((a, b) => (a.level === b.level ? a.at - b.at : a.level === 'act' ? -1 : 1));
  const act = attention.filter((a) => a.level === 'act');

  // ── since you last looked ──
  const sinceEvents = hub.q(`SELECT e.*, i.seq AS item_seq, i.title AS item_title FROM events e LEFT JOIN items i ON i.id = e.item_id
      WHERE e.project_id = ? AND e.at > ? AND e.actor != ? AND e.actor NOT LIKE '@%' ORDER BY e.at DESC`).all(p.id, p.seen_at, HUMAN);
  const finished = sinceEvents.filter((e) => e.type === 'accepted');
  const submitted = sinceEvents.filter((e) => e.type === 'submitted');
  const since = {
    at: p.seen_at,
    ago: p.seen_at ? dur(t - p.seen_at) : null,
    finished: finished.map((e) => ({ item: `#${e.item_seq}`, title: e.item_title, by: e.actor })),
    counts: {
      finished: finished.length,
      submitted: submitted.length,
      started: sinceEvents.filter((e) => e.type === 'claimed').length,
      proposed: sinceEvents.filter((e) => e.type === 'created').length,
      sent_back: sinceEvents.filter((e) => e.type === 'sent_back').length,
      updates: sinceEvents.length,
    },
  };

  // ── pulse: one sentence ──
  const working = new Set([...[...active, ...shaping].map((i) => i.holder).filter(Boolean), ...racers.map((a) => a.agent)]);
  const state = p.parked ? 'parked' : act.length ? 'needs-you' : inFlight ? 'flowing' : claimable ? 'stalled' : 'idle';
  const needs = act.length ? `${plural(act.length, 'thing')} ${act.length === 1 ? 'needs' : 'need'} you.` : 'Nothing needs you.';
  const sentence = (p.parked
    ? ['Parked: nothing new starts, and nothing will ask for you here until you unpark it.', act.length ? `${plural(act.length, 'thing')} already in progress still ${act.length === 1 ? 'needs' : 'need'} you.` : '']
    : [
      needs,
      inFlight
        ? `${plural(working.size, 'agent')} working on ${plural(inFlight, 'item')}${shaping.length ? ` (${shaping.length} being shaped)` : ''}.`
        : readyFree.length ? `${plural(readyFree.length, 'item')} ready, but nobody is working.`
          : shapeable.length ? `Nothing is moving: ${plural(shapeable.length, 'idea')} waiting to be shaped.` : 'No work in flight.',
      p.seen_at && finished.length ? `${finished.length} finished since you last looked.` : '',
    ]).filter(Boolean).join(' ');
  const pulse = { state, sentence, act: act.length, know: attention.length - act.length, working: working.size, active: inFlight };

  if (light) return { pulse, attention };

  // ── in motion ──
  const lines = [
    ...[...active, ...shaping].filter((it) => it.holder).map((it) => ({ it, agent: it.holder, lease: it.lease_until, touching: it.touching, since: it.stage_since })),
    ...racers.map((r) => ({ it: byId.get(r.item_id), agent: r.agent, lease: r.lease_until, touching: r.touching, since: r.at, race: true })),
  ].sort((x, y) => x.it.seq - y.it.seq);
  const motion = lines.map(({ it, agent, lease, touching, since, race }) => {
    const last = race
      ? hub.q(`SELECT * FROM events WHERE item_id = ? AND actor = ? AND type IN ('progress','claimed') ORDER BY at DESC, id DESC LIMIT 1`).get(it.id, agent)
      : hub.q(`SELECT * FROM events WHERE item_id = ? AND type IN ('progress','claimed','shaping') ORDER BY at DESC, id DESC LIMIT 1`).get(it.id);
    const a = agents.find((x) => x.name === agent);
    return {
      item: ref(it), title: it.title, priority: it.priority, agent, model: a?.model ?? '', provider: providerOf(a?.model),
      last: last ? { headline: last.headline, summary: last.summary, ago: dur(t - last.at), type: last.type } : null,
      for: dur(t - since), lease_left: dur(lease - t), attempt: it.attempts,
      quiet: lease - t < LEASE_MS - 10 * MIN, // no milestone or heartbeat in 10 minutes
      touching: json(touching, []),
      heads_up: hub.headsUp(p, agent, it) ?? null,
      shaping: it.stage === 'proposed',
      race: race ? it.race : undefined,
    };
  });

  // ── flow: the lifecycle and whose court the time sits in ──
  const flow = flowStats(hub, p, items, t);

  // ── queues ──
  const brief = (it) => ({
    item: ref(it), title: it.title, priority: it.priority, stage: it.stage, holder: it.holder,
    by: it.created_by, ago: dur(t - it.stage_since), summary: it.summary,
    blocked_by: unmet(it).map(ref), last_worker: it.last_worker, attempts: it.attempts,
    handoff: json(it.handoff, null),
  });
  const rank = { now: 0, soon: 1, later: 2 };
  const queue = in_('ready').sort((a, b) => rank[a.priority] - rank[b.priority] || a.seq - b.seq).map(brief);
  const proposed = in_('proposed').map(brief);
  const waiting = in_('waiting').map(brief);
  const verifying = in_('verifying').map((it) => ({ ...brief(it), implementer: it.implementer, reviewer: it.holder }));
  const done = items.filter((i) => i.stage === 'done' && t - i.stage_since < 3 * DAY)
    .sort((a, b) => b.stage_since - a.stage_since)
    .map((it) => ({ ...brief(it), implementer: it.implementer, accepted: lastEvent(it, ['accepted'])?.actor }));

  // ── agents and their track records ──
  const agentRows = agents.map((a) => {
    const holding = items.filter((i) => i.holder === a.name || racers.some((r) => r.item_id === i.id && r.agent === a.name)).map(ref);
    const idle = t - a.last_seen;
    const status = a.signed_off ? 'signed off' : holding.length ? (idle > 10 * MIN ? 'quiet' : 'working') : idle < 30 * MIN ? 'idle' : 'away';
    const rec = hub.q(`SELECT
        SUM(type = 'submitted') AS submitted,
        SUM(type = 'claimed') AS claimed,
        SUM(type = 'handoff') AS handoffs,
        SUM(type = 'question') AS questions,
        SUM(type = 'assumption') AS assumptions,
        SUM(type = 'created') AS proposed,
        SUM(type = 'accepted') AS reviews_accepted,
        SUM(type = 'learned') AS learned
      FROM events WHERE project_id = ? AND actor = ?`).get(p.id, a.name);
    const landed = hub.q(`SELECT COUNT(*) AS n FROM items WHERE project_id = ? AND implementer = ? AND stage = 'done'`).get(p.id, a.name).n;
    const sentBack = hub.q(`SELECT COUNT(*) AS n FROM events e JOIN items i ON i.id = e.item_id
        WHERE e.project_id = ? AND e.type = 'sent_back' AND i.implementer = ?`).get(p.id, a.name).n;
    const stalls = hub.q(`SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND type = 'lease_expired' AND data LIKE ?`).get(p.id, `%"agent":"${a.name}"%`).n;
    const races = hub.q(`SELECT COUNT(*) AS entered, COALESCE(SUM(a.stage = 'chosen'), 0) AS won FROM attempts a JOIN items i ON i.id = a.item_id
        WHERE i.project_id = ? AND a.agent = ?`).get(p.id, a.name);
    return {
      name: a.name, model: a.model, client: a.client, provider: providerOf(a.model),
      status, line: a.status, holding, last_seen: dur(idle), first_seen: dur(t - a.first_seen),
      record: {
        landed, sent_back: sentBack, stalls,
        claimed: rec.claimed ?? 0, submitted: rec.submitted ?? 0, handoffs: rec.handoffs ?? 0,
        questions: rec.questions ?? 0, assumptions: rec.assumptions ?? 0, proposed: rec.proposed ?? 0,
        reviews: rec.reviews_accepted ?? 0, learned: rec.learned ?? 0,
        races: races.entered, races_won: races.won,
      },
    };
  });

  const decisions = hub.decisions(p).map((d) => ({ id: d.id, body: d.body, ago: dur(t - d.at) }));
  const notes = hub.q(`SELECT n.*, i.seq FROM notes n LEFT JOIN items i ON i.id = n.item_id
      WHERE n.project_id = ? AND n.kind = 'learning' AND n.active = 1 ORDER BY n.at DESC`).all(p.id)
    .map((n) => ({ id: n.id, body: n.body, by: n.author, item: n.seq ? `#${n.seq}` : null, ago: dur(t - n.at) }));
  const activity = hub.q(`SELECT e.*, i.seq AS item_seq FROM events e LEFT JOIN items i ON i.id = e.item_id
      WHERE e.project_id = ? ORDER BY e.at DESC, e.id DESC LIMIT 150`).all(p.id).map((e) => eventOut(e, t));

  return {
    project: { slug: p.slug, name: p.name, mission: p.mission, parked: !!p.parked, path: p.path, autonomy: p.autonomy, autonomy_label: AUTONOMY[p.autonomy].label, autonomy_options: AUTONOMY, seen_at: p.seen_at },
    pulse, since, attention, motion, flow,
    queue, proposed, waiting, verifying, done,
    agents: agentRows, decisions, notes, steers, activity,
    stages: STAGES,
    all: items.map(brief),
  };
}

export function eventOut(e, t) {
  return {
    id: e.id, item: e.item_seq ? `#${e.item_seq}` : null, actor: e.actor, type: e.type,
    headline: e.headline, summary: e.summary, detail: e.detail, data: json(e.data, {}), at: e.at, ago: dur(t - e.at),
  };
}

// Time accounting over the last two weeks: how long work spends in each stage and in whose court.
function flowStats(hub, p, items, t) {
  const from = t - FLOW_WINDOW;
  const court = { agents: 0, queue: 0, you: 0 };
  const stageTime = Object.fromEntries(Object.keys(STAGES).map((s) => [s, 0]));
  const byItem = new Map(items.map((i) => [i.id, i]));
  const rows = hub.q(`SELECT t.* FROM transitions t JOIN items i ON i.id = t.item_id WHERE i.project_id = ? ORDER BY t.item_id, t.at, t.id`).all(p.id);
  const grouped = new Map();
  for (const r of rows) (grouped.get(r.item_id) ?? grouped.set(r.item_id, []).get(r.item_id)).push(r);
  for (const [, trs] of grouped) {
    for (let k = 0; k < trs.length; k++) {
      const s = trs[k].stage;
      if (STAGES[s]?.court == null) continue;
      const start = Math.max(trs[k].at, from);
      const end = k + 1 < trs.length ? trs[k + 1].at : t;
      if (end <= start) continue;
      stageTime[s] += end - start;
      const c = courtOf(s, p.autonomy);
      if (c) court[c] += end - start;
    }
  }
  const total = court.agents + court.queue + court.you;
  const share = (n) => (total ? Math.round((100 * n) / total) : 0);

  // throughput: items accepted per day over the window
  const doneAt = hub.q(`SELECT t.at FROM transitions t JOIN items i ON i.id = t.item_id WHERE i.project_id = ? AND t.stage = 'done' AND t.at > ?`).all(p.id, from);
  const perDay = Array.from({ length: 14 }, () => 0);
  for (const r of doneAt) perDay[Math.min(13, Math.floor((r.at - from) / DAY))]++;

  // cycle time of finished work: first ready → done
  const cycles = [];
  for (const [id, trs] of grouped) {
    const it = byItem.get(id);
    if (it?.stage !== 'done') continue;
    const start = trs.find((x) => x.stage === 'ready')?.at ?? trs[0].at;
    const end = trs.findLast((x) => x.stage === 'done')?.at;
    if (end && end > from) cycles.push(end - start);
  }
  cycles.sort((a, b) => a - b);
  const median = cycles.length ? cycles[Math.floor(cycles.length / 2)] : null;

  let takeaway = null;
  if (total > 30 * MIN) {
    const youStage = stageTime.verifying >= stageTime.waiting ? 'verifying' : 'waiting';
    if (share(court.you) >= 40) {
      takeaway = youStage === 'verifying'
        ? `Work spends ${share(court.you)}% of its time waiting on you, mostly for verification. Review in batches, ask agents for stronger evidence, or move to "Run with it" so agents peer-review.`
        : `Work spends ${share(court.you)}% of its time waiting on you, mostly on questions. Record decisions so agents stop needing to ask, and encourage assumptions over blocking questions.`;
    } else if (share(court.queue) >= 40) {
      takeaway = `Ready work sits idle ${share(court.queue)}% of the time. Agents are the bottleneck: start another worker.`;
    } else {
      takeaway = `Agents hold the ball ${share(court.agents)}% of the time. That's healthy: you're not the bottleneck.`;
    }
  }

  return {
    window: '14d',
    stages: Object.keys(STAGES).map((s) => ({
      stage: s, label: STAGES[s].label, blurb: STAGES[s].blurb, court: courtOf(s, p.autonomy) ?? (STAGES[s].court ? 'backlog' : null),
      count: items.filter((i) => i.stage === s).length, time: dur(stageTime[s]), ms: stageTime[s],
    })),
    court: { agents: share(court.agents), queue: share(court.queue), you: share(court.you), ms: court },
    throughput: perDay,
    finished: doneAt.length,
    median_cycle: median ? dur(median) : null,
    takeaway,
  };
}

// The 5-minute and 30-minute views of one item.
export function itemView(hub, slug, ref) {
  const p = hub.project(slug);
  const t = hub.now();
  const it = hub.item(p, ref);
  const trs = hub.q('SELECT * FROM transitions WHERE item_id = ? ORDER BY at, id').all(it.id);
  const lifecycle = trs.map((r, k) => {
    const end = k + 1 < trs.length ? trs[k + 1].at : ['done', 'dropped'].includes(r.stage) ? r.at : t;
    return { stage: r.stage, label: STAGES[r.stage]?.label, actor: r.actor, at: r.at, ms: end - r.at, time: dur(end - r.at), court: courtOf(r.stage, p.autonomy), current: k === trs.length - 1 };
  });
  const courtTotals = { agents: 0, queue: 0, you: 0 };
  for (const l of lifecycle) if (l.court) courtTotals[l.court] += l.ms;
  const events = hub.q(`SELECT e.*, i.seq AS item_seq FROM events e LEFT JOIN items i ON i.id = e.item_id WHERE e.item_id = ? ORDER BY e.at, e.id`).all(it.id).map((e) => eventOut(e, t));
  const submit = [...events].reverse().find((e) => e.type === 'submitted');
  const questions = hub.q('SELECT * FROM questions WHERE item_id = ? ORDER BY at').all(it.id)
    .map((q) => ({ ...q, options: json(q.options, []), blocking: !!q.blocking, ago: dur(t - q.at) }));
  const steers = hub.q(`SELECT * FROM notes WHERE item_id = ? AND kind = 'steer' ORDER BY at`).all(it.id)
    .map((n) => ({ id: n.id, body: n.body, active: !!n.active, ago: dur(t - n.at), acks: hub.q('SELECT * FROM acks WHERE note_id = ?').all(n.id) }));
  const agentNames = [...new Set(events.filter((e) => !isHuman(e.actor) && e.actor !== 'trellis').map((e) => e.actor))];
  const models = Object.fromEntries(agentNames.map((n) => [n, hub.q('SELECT model FROM agents WHERE project_id = ? AND name = ?').get(p.id, n)?.model ?? '']));
  const parent = hub.itemById(it.parent_id);
  return {
    item: `#${it.seq}`, title: it.title, summary: it.summary, detail: it.detail, acceptance: it.acceptance,
    stage: it.stage, stage_label: STAGES[it.stage].label, stage_blurb: STAGES[it.stage].blurb, court: courtOf(it.stage, p.autonomy),
    priority: it.priority, created_by: it.created_by, created: dur(t - it.created_at), in_stage: dur(t - it.stage_since),
    holder: it.holder, lease_left: it.holder ? dur(it.lease_until - t) : null,
    race: it.race,
    racers: it.race > 1 ? hub.attemptsOf(it).map((a) => ({ agent: a.agent, model: a.model, stage: a.stage, lease_left: a.lease_until ? dur(a.lease_until - t) : null })) : [],
    submissions: hub.submissions(it),
    implementer: it.implementer, last_worker: it.last_worker,
    attempts: it.attempts, stalls: it.stalls, rejections: it.rejections,
    handoff: json(it.handoff, null),
    parent: parent ? { item: `#${parent.seq}`, title: parent.title, stage: parent.stage } : null,
    children: hub.q('SELECT seq, title, stage FROM items WHERE parent_id = ? ORDER BY seq').all(it.id).map((c) => ({ item: `#${c.seq}`, title: c.title, stage: c.stage })),
    depends_on: hub.deps(it).map((d) => ({ item: `#${d.seq}`, title: d.title, stage: d.stage })),
    evidence: submit?.data?.evidence ?? [], submission: submit ?? null,
    questions, steers, lifecycle,
    court_totals: Object.fromEntries(Object.entries(courtTotals).map(([k, v]) => [k, dur(v)])),
    court_ms: courtTotals,
    agents: agentNames.map((n) => ({ name: n, model: models[n], provider: providerOf(models[n]) })),
    events,
  };
}
