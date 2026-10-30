// The 0-30-5-30 lens: turns raw state into what a facilitator should see.
//   0   → healthy, irrelevant or nonexistent things are simply absent
//   30s → pulse + the few things that need you, each with the action that moves it on
//   5m  → what's in motion, where time goes, what's next
//   30m → every agent, every event, every layer of detail
import { STAGES, AUTONOMY, OPEN_STAGES, CLAIM_TYPES, courtOf, dur, providerOf, MIN, HOUR, DAY, HUMAN, LEASE_MS, isHuman, isSystem, preconditionOut } from './core.js';
import { gitWarning } from './git.js';
import { prsOf } from './github.js';
import { WAIT_DAYS } from './precondition.js';
import { humanCost, verification } from './outcomes.js';
import { OPERATOR_TAGS } from './protocol.js';

const FLOW_WINDOW = 14 * DAY;
const CHURN_WINDOW = 15 * MIN;
const CHURN_AGENTS = 3;
const json = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// viewer: the person looking ("@handle"), so "needs you" counts only their own; none in local mode.
export function projectList(hub, { viewer } = {}) {
  return hub.projects().map((p) => projectLine(hub, p, view(hub, p.slug, { light: true, viewer })));
}

const projectLine = (hub, p, v) => ({ slug: p.slug, name: p.name, mission: p.mission, parked: !!p.parked, path: p.path || null, remotes: hub.remotesOf(p), runner: !!p.runner, pulse: v.pulse, needs: v.attention.filter((a) => a.level === 'act').length });

// The home: does anything need you, anywhere? One aggregate pulse, every act entry of the viewer's across
// projects (tagged with its project, oldest first as on a project page), then one line per project. 5m adds
// worth knowing per project and what's in motion. A parked project's state and agents never set the pulse,
// but what it already asked of you (a blocking question, work to verify) still needs you, so it counts here as
// it does on its own line and badge (#152). Parking only stops new asks: direction and staffing.
const URGENCY = ['needs-you', 'stalled', 'flowing', 'idle'];
export function homeView(hub, { viewer } = {}) {
  const t = hub.now();
  const rows = hub.projects().map((p) => ({ p, v: view(hub, p.slug, { light: true, viewer }) }));
  const tag = (p) => ({ slug: p.slug, name: p.name });
  const live = rows.filter(({ p }) => !p.parked);
  const needs = rows.flatMap(({ p, v }) => v.attention.filter((a) => a.level === 'act').map((a) => ({ ...a, project: tag(p) })))
    .sort((a, b) => a.at - b.at);
  const state = needs.length ? 'needs-you' : URGENCY.find((s) => live.some(({ v }) => v.pulse.state === s)) ?? 'idle';
  const across = (n) => (n > 1 ? ` across ${plural(n, 'project')}` : '');
  const working = live.reduce((n, { v }) => n + v.pulse.working, 0), inFlight = live.reduce((n, { v }) => n + v.pulse.active, 0);
  const stalled = live.filter(({ v }) => v.pulse.state === 'stalled').length;
  const finished = rows.flatMap(({ p, v }) => v.since.finished.map((f) => ({ ...f, project: tag(p) })));
  const sentence = [
    needs.length ? `${plural(needs.length, 'thing')}${across(new Set(needs.map((a) => a.project.slug)).size)} ${needs.length === 1 ? 'needs' : 'need'} you.` : 'Nothing needs you.',
    inFlight ? `${plural(working, 'agent')} working on ${plural(inFlight, 'item')}${across(live.filter(({ v }) => v.pulse.active).length)}.`
      : stalled ? `Nothing is moving: work is waiting in ${plural(stalled, 'project')}.` : 'No work in flight.',
    finished.length ? `${finished.length} finished since you last looked.` : '',
  ].filter(Boolean).join(' ');
  const counts = {};
  for (const { v } of rows) for (const [k, n] of Object.entries(v.since.counts)) counts[k] = (counts[k] ?? 0) + n;
  const seen = live.map(({ p }) => p.seen_at).filter(Boolean);
  const motion = rows.flatMap(({ p }) => hub.q(`SELECT seq, title, stage, holder AS agent FROM items WHERE project_id = ? AND holder IS NOT NULL AND holder != '' AND stage IN ('active', 'proposed', 'landing')
      UNION ALL SELECT i.seq, i.title, i.stage, a.agent FROM attempts a JOIN items i ON i.id = a.item_id WHERE i.project_id = ? AND i.stage = 'active' AND a.stage = 'active' AND a.closed = 0
      ORDER BY seq`).all(p.id, p.id)
    .map((r) => ({ agent: r.agent, item: `#${r.seq}`, title: r.title, stage: r.stage, project: tag(p) })));
  return {
    pulse: {
      state, sentence, act: needs.length, working, active: inFlight,
      since: { at: seen.length ? Math.min(...seen) : 0, ago: seen.length ? dur(t - Math.min(...seen)) : null, counts, finished },
    },
    needs,
    projects: rows.map(({ p, v }) => projectLine(hub, p, v)),
    worth_knowing: rows.map(({ p, v }) => ({ ...tag(p), count: v.attention.filter((a) => a.level !== 'act').length })).filter((w) => w.count),
    motion,
  };
}

// The repository an item lands in, short (acme/api), when the project has several; null with one.
function repoTag(remotes, it) {
  return remotes.length > 1 ? (it.repo || remotes[0]).split('/').slice(-2).join('/') : null;
}

export function view(hub, slug, { light = false, viewer } = {}) {
  const p = hub.project(slug);
  const t = hub.now();
  const items = hub.q('SELECT * FROM items WHERE project_id = ? ORDER BY seq').all(p.id);
  const byId = new Map(items.map((i) => [i.id, i]));
  const ref = (i) => `#${i.seq}`;
  const remotes = hub.remotesOf(p);
  const agents = hub.q('SELECT * FROM agents WHERE project_id = ? ORDER BY last_seen DESC').all(p.id);
  const openQs = hub.q(`SELECT * FROM questions WHERE project_id = ? AND status = 'open' ORDER BY at`).all(p.id);
  const dismissed = new Set(hub.q('SELECT key FROM dismissals WHERE project_id = ?').all(p.id).map((d) => d.key));
  const unmet = (i) => hub.unmetDeps(i);
  const lastEvent = (i, types) => hub.q(`SELECT * FROM events WHERE item_id = ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY at DESC, id DESC LIMIT 1`).get(i.id, ...types);

  const in_ = (stage) => items.filter((i) => i.stage === stage);
  const active = in_('active');
  const shaping = in_('proposed').filter((i) => i.holder);
  const landing = in_('landing');
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

  // A question to an issue's reporter comes to you only once they've had reporter_wait hours to answer on GitHub.
  const wait = p.reporter_wait * HOUR;
  // A question to an operator is an operator session's to answer (next mode "answer"), never yours.
  for (const q of openQs.filter((q) => q.blocking && q.audience !== 'operator' && !(q.reporter && t - q.at < wait))) {
    const it = byId.get(q.item_id);
    // An operator's escalation carries the question it was asked, who asked it, and what the operator found.
    const orig = q.escalates ? hub.q('SELECT question, asked_by FROM questions WHERE id = ?').get(q.escalates) : null;
    push({
      key: `q:${q.id}`, level: 'act', kind: 'question', at: q.reporter ? q.at + wait : q.at,
      headline: q.question,
      sub: [it?.title, orig ? `${q.asked_by} (operator) escalated ${orig.asked_by}'s question ${dur(t - q.at)} ago` : `${q.asked_by} asked ${q.reporter ? `@${q.reporter} on GitHub ` : ''}${dur(t - q.at)} ago`,
        q.reporter && 'no reply yet', it?.stage === 'waiting' && 'work is parked until you answer'].filter(Boolean).join(' · '),
      why: [orig && `${orig.asked_by} asked an operator: "${orig.question}"`, q.context].filter(Boolean).join('\n\n'), detail: q.detail,
      item: it ? ref(it) : null, parked: it?.stage === 'waiting', // answering can keep it parked
      question: { id: q.id, options: json(q.options, []), asked_by: q.asked_by },
      steps: json(q.steps, []),
      // The steps this viewer has ticked (#162), counting from 1; each person ticks their own.
      ticked: hub.q('SELECT step FROM step_ticks WHERE question_id = ? AND person = ? ORDER BY step').all(q.id, viewer ?? HUMAN).map((r) => r.step),
      ...(orig ? { escalation: { question: orig.question, asked_by: orig.asked_by }, evidence: json(q.evidence, []) } : {}),
    });
  }

  // What an operator settled on its own in the last day, so you can glance at it.
  const settled = hub.q(`SELECT * FROM questions q WHERE project_id = ? AND audience = 'operator' AND status = 'answered' AND answered_at > ?
    AND NOT EXISTS (SELECT 1 FROM questions e WHERE e.escalates = q.id AND e.status = 'answered') ORDER BY answered_at`).all(p.id, t - DAY);
  for (const q of settled) {
    const it = byId.get(q.item_id);
    push({
      key: `opanswer:${q.id}`, level: 'know', kind: 'operator-answered', at: q.answered_at,
      headline: `Operator answered ${q.asked_by}: ${q.answer}`,
      sub: [`Q: ${q.question}`, `${q.answered_by} · ${dur(t - q.answered_at)} ago`].join(' · '),
      why: q.context, item: it ? ref(it) : null,
    });
  }

  // Unless no operator has been here for a day: then one line, so the questions don't wait forever.
  const forOperator = openQs.filter((q) => q.audience === 'operator');
  if (forOperator.length && !agents.some((a) => t - a.last_seen < DAY && json(a.has, []).includes('operator'))) {
    push({
      key: `operator:${forOperator[0].id}`, level: 'act', kind: 'operator-missing', at: forOperator[0].at,
      headline: `${plural(forOperator.length, 'question')} ${forOperator.length === 1 ? 'waits' : 'wait'} for an operator; none connected`,
      sub: forOperator.map((q) => q.question).slice(0, 3).join(' · '),
      why: 'Agents asked an operator: a trusted, attended session that checks in with has: ["operator"] to run things, grant permissions or verify on real infra. None has checked in here in the last day. Start an operator session (the guide\'s Operators section says how).',
      guide: '/agents.md#operators',
    });
  }

  // Work someone answered on but kept parked: it waits for them to say go.
  for (const it of in_('waiting').filter((i) => i.parked_by && !openQs.some((q) => q.blocking && q.item_id === i.id))) {
    const ans = hub.q(`SELECT answer FROM questions WHERE item_id = ? AND status = 'answered' ORDER BY answered_at DESC LIMIT 1`).get(it.id);
    push({
      key: `parked:${it.id}:${it.stage_since}`, level: 'act', kind: 'kept-parked', at: it.updated_at,
      headline: `${ref(it)} is parked by ${it.parked_by === HUMAN ? 'you' : it.parked_by}: agents don't get it until it's unparked`,
      sub: [it.title, ans && `answered: ${ans.answer}`].filter(Boolean).join(' · '),
      why: 'You answered its question and asked to keep it parked. Unpark it when it should go back to the agents.',
      item: ref(it), parked_by: it.parked_by,
    });
  }

  // Accepted work that nobody lands: worth knowing whatever the autonomy.
  for (const it of landing.filter((i) => !i.holder && t - i.stage_since > HOUR)) {
    push({
      key: `land:${it.id}`, level: 'know', kind: 'landing-stuck', at: it.stage_since,
      headline: `${ref(it)} was accepted ${dur(t - it.stage_since)} ago but isn't on main yet`,
      sub: it.title, why: `No agent has landed ${it.branch || 'its branch'}. Start an agent; land jobs come before any other work.`,
      item: ref(it), start: true,
    });
  }

  // Work that has waited outside past the project's limit: the fact may never come, or the check may be wrong.
  const waitMs = (p.wait_days || WAIT_DAYS) * DAY;
  for (const it of in_('outside').filter((i) => t - i.stage_since > waitMs)) {
    const pre = preconditionOut(it);
    push({
      key: `outside:${it.id}:${it.stage_since}`, level: 'know', kind: 'outside-overdue', at: it.stage_since,
      headline: `${ref(it)} has waited ${dur(t - it.stage_since)} on something outside the hub`,
      sub: [it.title, pre?.last_check ? `last check ${dur(t - pre.last_check.at)} ago: ${pre.last_check.detail}` : 'not checked yet'].join(' · '),
      why: `It waits until ${pre?.waits_for}. If that will never happen, or the check is wrong, edit or remove the precondition; "Check now" asks again on the next sweep.`,
      item: ref(it),
    });
  }

  // The hub's GitHub App can't read a repository for its mirror: it falls back to a deploy key, if there is one.
  for (const remote of remotes) {
    const trouble = hub.mirrorTrouble(remote);
    if (!trouble) continue;
    push({
      key: `app-read:${remote}:${trouble.since}`, level: 'know', kind: 'app-read', at: trouble.since,
      headline: `The hub can't read ${remote} through its GitHub App`,
      sub: trouble.error,
      why: `${trouble.hint ? `${trouble.hint} ` : ''}Meanwhile accepted work there lands by hand instead of through a pull request, and the hub fetches it with a deploy key, if it has one; without either, it can't tell when work there reaches main.`,
    });
  }

  // Agents keep arriving and leaving with nothing: routed here for work they can't take.
  const churnSince = t - CHURN_WINDOW;
  const arrivals = hub.q(`SELECT actor, MIN(id) AS first FROM events WHERE project_id = ? AND type = 'checkin' AND at >= ? GROUP BY actor ORDER BY first`).all(p.id, churnSince);
  const claims = hub.q(`SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND at >= ? AND type IN (${CLAIM_TYPES.map(() => '?').join(',')})`).get(p.id, churnSince, ...CLAIM_TYPES).n;
  if (arrivals.length >= CHURN_AGENTS && !claims) {
    push({
      key: `churn:${Math.min(...arrivals.map((a) => a.first))}`, level: 'know', kind: 'churn', at: t,
      headline: `${arrivals.length} agents checked in to ${p.name} in the last ${dur(CHURN_WINDOW)} and none took any work`,
      sub: arrivals.map((a) => a.actor).join(', '),
      why: 'They were sent here but found nothing they could claim. Check what the waiting work needs against what the agents declared (has), and which projects `nuworq run` staffs.',
    });
  }

  if (p.autonomy !== 'full') {
    for (const it of in_('verifying')) {
      const sub = lastEvent(it, ['submitted']);
      const { evidence = [], git = null } = json(sub?.data, {});
      push({
        key: `review:${it.id}:${sub?.id ?? 0}`, level: 'act', kind: 'review', at: it.stage_since,
        headline: sub?.headline || it.title,
        sub: `${it.title} · ${it.implementer ?? 'an agent'} finished it ${dur(t - it.stage_since)} ago`,
        why: sub?.summary, detail: sub?.detail,
        acceptance: it.acceptance, evidence, git,
        warn: [evidence.length ? null : 'No evidence attached', gitWarning(git)].filter(Boolean).join(' · ') || null,
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

  for (const it of in_('verifying')) {
    for (const pr of prsOf(hub, p, it).filter((x) => x.ci === 'fail' && x.state !== 'closed')) {
      const failed = pr.checks.filter((c) => !['success', 'neutral', 'skipped', 'pending'].includes(c.conclusion));
      push({
        key: `ci:${it.id}:${pr.number}:${pr.sha}`, level: 'act', kind: 'ci-failing', at: it.stage_since,
        headline: `CI is failing on ${it.title}`,
        sub: `PR #${pr.number} · ${failed.map((c) => c.name).join(', ')}`,
        why: 'The work is waiting for review, but its pull request fails CI. Send it back with what failed, or look at the checks first.',
        item: ref(it), pr: { url: pr.url, number: pr.number, checks: failed },
      });
    }
  }

  // Accepted work whose pull request waits for a person's approval on GitHub: one card per PR.
  for (const it of in_('landing')) {
    for (const pr of hub.q(`SELECT * FROM prs WHERE item_id = ? AND state = 'open' AND blocked = 'review'`).all(it.id)) {
      push({
        key: `pr-review:${it.id}:${pr.number}`, level: 'act', kind: 'pr-review', at: it.stage_since,
        headline: `Approve PR #${pr.number} on GitHub: ${it.title}`,
        sub: `PR #${pr.number} · the repository requires a person's approval`,
        why: 'The work is accepted and its checks pass, but the repository needs a person to approve the pull request. Approve it on GitHub; auto-merge does the rest.',
        item: ref(it), pr: { url: pr.url, number: pr.number },
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
      why: recentAgents.length ? 'Agents see steering on their next call to nuworq.' : 'No agents are active right now. They will see it when they check in.',
      item: s.item,
    });
  }

  // Work that needs something no agent seen in the last day has: it would wait forever unnoticed.
  const fitAgents = agents.filter((a) => t - a.last_seen < DAY).map((a) => json(a.has, []));
  for (const it of [...readyFree, ...shapeable]) {
    const missing = json(it.needs, []).filter((tag) => !fitAgents.some((has) => has.includes(tag)));
    if (!missing.length) continue;
    push({
      key: `unfit:${it.id}:${missing.join(',')}`, level: 'know', kind: 'unfit', at: it.stage_since,
      headline: `${ref(it)} needs ${missing.join(', ')}; no agent connected in the last day has it`,
      sub: it.title,
      why: missing.some((tag) => OPERATOR_TAGS.includes(tag))
        ? `Only an operator that declares ${missing.join(', ')} at checkin (has) is offered it. Start an operator session (see Operators in the guide, /agents.md), or change what the item needs.`
        : `Only agents that declare ${missing.join(', ')} at checkin (has) are offered it. Start one on a machine that has it, or change what the item needs.`,
      item: ref(it), missing, keep: json(it.needs, []).filter((t) => !missing.includes(t)),
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

  if (!p.parked) {
    for (const c of hub.q('SELECT id, kind, last_error, failing_since FROM channels WHERE failing_since IS NOT NULL').all()) {
      push({
        key: `notify:${c.id}:${c.failing_since}`, level: 'know', kind: 'notify-failing', at: c.failing_since,
        headline: `Push notifications to ${c.kind} are failing (${c.last_error})`,
        sub: `since ${dur(t - c.failing_since)} ago · retried once`,
        why: 'Things that need you are not reaching your phone or chat. Check the channel under Notifications, or run `nuworq notify test`.',
      });
    }
  }

  // With people, every "needs you" has owners: whoever steered the item, else the project's stewards.
  // The viewer's own stay act; everyone else's become worth knowing, so "needs you" means you.
  if (hub.hasPeople()) {
    const bySeq = new Map(items.map((i) => [ref(i), i]));
    for (const a of attention.filter((x) => x.level === 'act')) {
      // Work kept parked is the parker's to release.
      a.owners = a.parked_by?.startsWith('@') ? [a.parked_by] : hub.ownersOf(p, a.item ? bySeq.get(a.item) : null);
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

  if (light) return { pulse, attention, since };

  // ── in motion ──
  const lines = [
    ...[...active, ...shaping, ...landing].filter((it) => it.holder).map((it) => ({ it, agent: it.holder, lease: it.lease_until, touching: it.touching, since: it.stage_since })),
    ...racers.map((r) => ({ it: byId.get(r.item_id), agent: r.agent, lease: r.lease_until, touching: r.touching, since: r.at, race: true })),
  ].sort((x, y) => x.it.seq - y.it.seq);
  const motion = lines.map(({ it, agent, lease, touching, since, race }) => {
    const last = race
      ? hub.q(`SELECT * FROM events WHERE item_id = ? AND actor = ? AND type IN ('progress','claimed') ORDER BY at DESC, id DESC LIMIT 1`).get(it.id, agent)
      : hub.q(`SELECT * FROM events WHERE item_id = ? AND type IN ('progress','claimed','shaping') ORDER BY at DESC, id DESC LIMIT 1`).get(it.id);
    const a = agents.find((x) => x.name === agent);
    return {
      item: ref(it), title: it.title, priority: it.priority, repo: repoTag(remotes, it), agent, model: a?.model ?? '', provider: providerOf(a?.model),
      last: last ? { headline: last.headline, summary: last.summary, ago: dur(t - last.at), type: last.type } : null,
      for: dur(t - since), lease_left: dur(lease - t), attempt: it.attempts,
      quiet: lease - t < LEASE_MS - 10 * MIN, // no milestone or heartbeat in 10 minutes
      touching: json(touching, []),
      heads_up: hub.headsUp(p, agent, it) ?? null,
      shaping: it.stage === 'proposed',
      landing: it.stage === 'landing',
      race: race ? it.race : undefined,
    };
  });

  // ── flow: the lifecycle and whose court the time sits in ──
  const flow = flowStats(hub, p, items, t);

  // ── queues ──
  const brief = (it) => ({
    item: ref(it), title: it.title, priority: it.priority, stage: it.stage, holder: it.holder,
    needs: json(it.needs, []), size: it.size || null, repo: repoTag(remotes, it), by: it.created_by, ago: dur(t - it.stage_since), summary: it.summary,
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
    // Who answers for this agent: the person who minted its token, or the runner it belongs to.
    const tok = a.token_id != null ? hub.q(`SELECT t.runner, m.handle FROM tokens t LEFT JOIN people m ON m.id = t.minted_by WHERE t.id = ?`).get(a.token_id) : null;
    const via = tok?.runner ? `runner ${tok.runner}` : tok?.handle ? `via @${tok.handle}` : null;
    const races = hub.q(`SELECT COUNT(*) AS entered, COALESCE(SUM(a.stage = 'chosen'), 0) AS won FROM attempts a JOIN items i ON i.id = a.item_id
        WHERE i.project_id = ? AND a.agent = ?`).get(p.id, a.name);
    return {
      name: a.name, model: a.model, client: a.client, provider: providerOf(a.model), tokens: a.tokens ? a.tokens.split(',') : [], via, has: json(a.has, []),
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
    project: { slug: p.slug, name: p.name, mission: p.mission, parked: !!p.parked, path: p.path, runner: !!p.runner, fresh: !!p.fresh, autonomy: p.autonomy, autonomy_label: AUTONOMY[p.autonomy].label, autonomy_options: AUTONOMY, seen_at: p.seen_at, github: !!p.github_secret, remotes: hub.remotesOf(p) },
    pulse, since, attention, motion, flow,
    queue, proposed, waiting, verifying, done,
    agents: agentRows, runners: hub.runnersOf(p), decisions, notes, steers, activity,
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
  const court = { agents: 0, queue: 0, you: 0, external: 0 }; // external: waiting on a fact outside the hub
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
  const total = court.agents + court.queue + court.you + court.external;
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
    court: { agents: share(court.agents), queue: share(court.queue), you: share(court.you), external: share(court.external), ms: court },
    throughput: perDay,
    finished: doneAt.length,
    median_cycle: median ? dur(median) : null,
    takeaway,
    cost: costStats(hub, p, from),
    verification: verificationStats(hub, p, items, from),
    you: youStats(hub, p, from, t),
  };
}

// Whether verification held up for work that landed in the window (#176): escapes (a later item fixes it) and
// peer verdicts a person overturned, per model as builder and as reviewer. Null until something landed.
function verificationStats(hub, p, items, from) {
  const landed = items.filter((i) => i.stage === 'done' && i.stage_since > from);
  if (!landed.length) return null;
  const modelOf = (agent) => (agent ? hub.q('SELECT model FROM agents WHERE project_id = ? AND name = ?').get(p.id, agent)?.model || null : null);
  return verification(hub, landed, modelOf);
}

// What the work cost you over the window (#175): your actions per landed item, and how long act-level Needs you
// entries waited until you resolved them (median). The court share above is time work waits on you; this is your effort.
function youStats(hub, p, from, t) {
  const c = humanCost(hub, p, from, t);
  return { actions: c.actions, landed: c.landed, per_landed: c.per_landed, median_wait: c.median_wait_ms == null ? null : dur(c.median_wait_ms), waits: c.waits };
}

// What finished work cost over the window, per model: median and total per finished item, tokens too
// (a local model has no price), and everything spent in the window. Null when nothing was recorded.
// Measured numbers win: an agent's reported rows on an item drop out once llm-proxy measured it there.
const COUNTED = `(u.source = 'llm-proxy' OR NOT EXISTS (SELECT 1 FROM usage m WHERE m.item_id = u.item_id AND m.agent = u.agent AND m.source = 'llm-proxy'))`;

function costStats(hub, p, from) {
  const spent = hub.q(`SELECT COUNT(*) AS n, SUM(cost_usd) AS usd FROM usage u WHERE project_id = ? AND at > ? AND ${COUNTED}`).get(p.id, from);
  if (!spent.n) return null;
  // One row per finished item and model; its cost is unknown (null) if any part of it is.
  const rows = hub.q(`SELECT u.model, u.item_id, SUM(u.input_tokens + u.output_tokens) AS tokens,
      SUM(u.cost_usd) AS usd, COUNT(u.cost_usd) = COUNT(*) AS priced
    FROM usage u JOIN items i ON i.id = u.item_id
    WHERE i.project_id = ? AND i.stage = 'done' AND ${COUNTED}
      AND (SELECT MAX(t.at) FROM transitions t WHERE t.item_id = i.id AND t.stage = 'done') > ?
    GROUP BY u.model, u.item_id`).all(p.id, from);
  const mid = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const models = new Map();
  for (const r of rows) (models.get(r.model) ?? models.set(r.model, []).get(r.model)).push(r);
  const by_model = [...models].map(([model, rs]) => {
    const priced = rs.filter((r) => r.priced).map((r) => r.usd);
    return {
      model: model || null, items: rs.length,
      median_usd: mid(priced), total_usd: priced.length ? priced.reduce((a, b) => a + b, 0) : null,
      median_tokens: mid(rs.map((r) => r.tokens)), total_tokens: rs.reduce((a, r) => a + r.tokens, 0),
    };
  }).sort((a, b) => (b.total_usd ?? 0) - (a.total_usd ?? 0) || b.total_tokens - a.total_tokens);
  return { by_model, spend_usd: spent.usd ?? null };
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
  const courtTotals = { agents: 0, queue: 0, you: 0, external: 0 };
  for (const l of lifecycle) if (l.court) courtTotals[l.court] += l.ms;
  const events = hub.q(`SELECT e.*, i.seq AS item_seq FROM events e LEFT JOIN items i ON i.id = e.item_id WHERE e.item_id = ? ORDER BY e.at, e.id`).all(it.id).map((e) => eventOut(e, t));
  const submit = [...events].reverse().find((e) => e.type === 'submitted');
  const questions = hub.q('SELECT * FROM questions WHERE item_id = ? ORDER BY at').all(it.id)
    .map((q, _, all) => {
      const orig = q.escalates ? all.find((o) => o.id === q.escalates) : null;
      return {
        ...q, options: json(q.options, []), blocking: !!q.blocking, ago: dur(t - q.at), evidence: json(q.evidence, []), steps: json(q.steps, []),
        escalation: orig ? { question: orig.question, asked_by: orig.asked_by } : undefined,
      };
    });
  const steers = hub.q(`SELECT * FROM notes WHERE item_id = ? AND kind = 'steer' ORDER BY at`).all(it.id)
    .map((n) => ({ id: n.id, body: n.body, active: !!n.active, ago: dur(t - n.at), acks: hub.q('SELECT * FROM acks WHERE note_id = ?').all(n.id) }));
  const agentNames = [...new Set(events.filter((e) => !isHuman(e.actor) && !isSystem(e.actor)).map((e) => e.actor))];
  const models = Object.fromEntries(agentNames.map((n) => [n, hub.q('SELECT model FROM agents WHERE project_id = ? AND name = ?').get(p.id, n)?.model ?? '']));
  const parent = hub.itemById(it.parent_id);
  return {
    item: `#${it.seq}`, title: it.title, summary: it.summary, detail: it.detail, acceptance: it.acceptance,
    stage: it.stage, stage_label: STAGES[it.stage].label, stage_blurb: STAGES[it.stage].blurb, court: courtOf(it.stage, p.autonomy),
    priority: it.priority, needs: json(it.needs, []), size: it.size || null, repo: repoTag(hub.remotesOf(p), it),
    created_by: it.created_by, created: dur(t - it.created_at), in_stage: dur(t - it.stage_since),
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
    // Escapes (#176): the landed item this one repairs, and the later items that repair this one.
    fixes: (() => { const f = it.fixes && hub.itemById(it.fixes); return f ? { item: `#${f.seq}`, title: f.title } : null; })(),
    fixed_by: hub.q('SELECT seq, title, stage FROM items WHERE fixes = ? ORDER BY seq').all(it.id).map((f) => ({ item: `#${f.seq}`, title: f.title, stage: f.stage })),
    evidence: submit?.data?.evidence ?? [], git: submit?.data?.git ?? null, git_warning: gitWarning(submit?.data?.git), submission: submit ?? null,
    prs: prsOf(hub, p, it),
    questions, steers, lifecycle,
    court_totals: Object.fromEntries(Object.entries(courtTotals).map(([k, v]) => [k, dur(v)])),
    court_ms: courtTotals,
    agents: agentNames.map((n) => ({ name: n, model: models[n], provider: providerOf(models[n]) })),
    usage: hub.usageOf(it), // null: nothing recorded
    precondition: preconditionOut(it) ?? null,
    events,
  };
}
