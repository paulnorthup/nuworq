// The 0-30-5-30 lens: turns raw state into what a facilitator should see.
//   0   → healthy, irrelevant or nonexistent things are simply absent
//   30s → pulse + the few things that need you, each with the action that moves it on
//   5m  → what's in motion, where time goes, what's next
//   30m → every agent, every event, every layer of detail
import { STAGES, AUTONOMY, OPEN_STAGES, CLAIM_TYPES, courtOf, waitsForOk, dur, providerOf, MIN, HOUR, DAY, HUMAN, SYSTEM, HANDBACKS, LEASE_MS, isHuman, isSystem, preconditionOut } from './core.js';
import { randomUUID } from 'node:crypto';
import { gitWarning } from './git.js';
import { prsOf } from './github.js';
import { WAIT_DAYS, STUCK_ERRORS, dateAt, describe as describePrecondition } from './precondition.js';
import { PASS_ON } from './issues.js';
import { humanCost, verification } from './outcomes.js';
import { OPERATOR_TAGS } from './protocol.js';
import { wiringEntry } from './appwiring.js';
import { bounceOf, sentence as endSentence } from './bounce.js';

const FLOW_WINDOW = 14 * DAY;
const CHURN_WINDOW = 15 * MIN;
const RUNNER_ON_DUTY = 5 * MIN; // a runner that polled this recently is on duty (#185): ten of its default 30s polls
const CHURN_AGENTS = 3;
// One worker's run worth a person's look (#767): past this spend so far, or this long.
const RUN_USD = 50;
const RUN_MS = HOUR;
// The guide's Start an operator (#712), opened at that part; relative, so it stays in the workspace.
export const OPERATOR_GUIDE = 'guide#operator';
const json = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
// The 30-second line's first part (#506): how many things need you, and how many of them are now ("4 things need
// you, 3 now."). where: " across 2 projects" on the home.
const needsLine = (cards, where = '') => {
  const n = cards.length, now = cards.filter((a) => a.priority === 'now').length;
  if (!n) return 'Nothing needs you.';
  const head = `${plural(n, 'thing')}${where} ${n === 1 ? 'needs' : 'need'} you`;
  return `${head}${!now ? '' : n === 1 ? ' now' : now === n ? ', all now' : `, ${now} now`}.`;
};
const NEEDS_LINE = /^(Nothing needs you\.|\d+ things?( across \d+ projects)? needs? you( now|, all now|, \d+ now)?\.)/;
// A steer as one plain line (#550): an answer's change of course is what to do instead; anything else, its first
// sentence. The whole text stays behind it.
export const plainSteer = (body) => {
  const s = String(body ?? '').replace(/^Change of course(?: on #\d+)?: you assumed "[\s\S]*?"\. Instead: /, '').trim();
  const first = s.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? s;
  const line = first.length > 160 ? `${first.slice(0, 159)}…` : first;
  return line.charAt(0).toUpperCase() + line.slice(1);
};

// viewer: the person looking ("@handle"), so "needs you" counts only their own; none in local mode.
export function projectList(hub, { viewer } = {}) {
  return hub.projects().map((p) => projectLine(hub, p, view(hub, p.slug, { light: true, viewer })));
}

const projectLine = (hub, p, v) => ({ slug: p.slug, name: p.name, mission: p.mission, parked: !!p.parked, path: p.path || null, remotes: hub.remotesOf(p), runner: !!p.runner, sandbox_hosts: json(p.sandbox_hosts, []), worker_commands: json(p.worker_commands, []), operators: liveOperators(hub, p), pulse: v.pulse, needs: v.attention.filter((a) => a.level === 'act').length });

// The operator sessions a project has (#559), for nuworq up: checked in as operators, not signed off, and seen in the
// last day. An idle operator only listens, which leaves last_seen alone, and one that ends signs itself off (#558).
export const liveOperators = (hub, p) => hub.q(`SELECT name, machine, last_seen FROM agents WHERE project_id = ? AND role = 'operator' AND signed_off = 0 AND last_seen > ? ORDER BY last_seen DESC`)
  .all(p.id, hub.now() - DAY).map((a) => ({ name: a.name, machine: a.machine || null, last_seen: dur(hub.now() - a.last_seen) }));

// The home: does anything need you, anywhere? One aggregate pulse, every act entry of the viewer's across
// projects (tagged with its project, ranked as on a project page: byNeed), then one line per project. 5m adds
// worth knowing per project and what's in motion. A parked project's state and agents never set the pulse,
// but what it already asked of you (a blocking question, work to verify) still needs you, so it counts here as
// it does on its own line and badge (#152). Parking only stops new asks: direction and staffing.
const URGENCY = ['needs-you', 'stalled', 'flowing', 'idle'];
// An agent's role, where it runs and its job (core.js presenceOf), by name; null for a name the hub doesn't know.
function presenceNamed(hub, p, name) {
  const a = name ? hub.q('SELECT * FROM agents WHERE project_id = ? AND name = ?').get(p.id, name) : null;
  return a ? hub.presenceOf(p, a) : null;
}

// Whether an agent shows in the app's lists of agents (#441): while it holds work, or within an hour of when it
// was last seen. Signing off takes it out at once. Gone agents stay in item history, analytics and the 30m view's
// "Show earlier agents".
export const PRESENT_FOR = HOUR;
export const isPresent = (a, holding, t) => holding.length > 0 || (!a.signed_off && t - a.last_seen < PRESENT_FOR);

export function homeView(hub, { viewer } = {}) {
  const t = hub.now();
  const rows = hub.projects().map((p) => ({ p, v: view(hub, p.slug, { light: true, viewer }) }));
  const tag = (p) => ({ slug: p.slug, name: p.name });
  const live = rows.filter(({ p }) => !p.parked);
  const once = new Set();
  const needs = rows.flatMap(({ p, v }) => v.attention.filter((a) => a.level === 'act').map((a) => ({ ...a, project: tag(p) })))
    .filter((a) => !a.hubwide || (!once.has(a.key) && once.add(a.key)))
    .sort(byNeed);
  const state = needs.length ? 'needs-you' : URGENCY.find((s) => live.some(({ v }) => v.pulse.state === s)) ?? 'idle';
  const across = (n) => (n > 1 ? ` across ${plural(n, 'project')}` : '');
  const working = live.reduce((n, { v }) => n + v.pulse.working, 0), inFlight = live.reduce((n, { v }) => n + v.pulse.active, 0);
  const stalled = live.filter(({ v }) => v.pulse.state === 'stalled').length;
  const finished = rows.flatMap(({ p, v }) => v.since.finished.map((f) => ({ ...f, project: tag(p) })));
  const sentence = [
    needsLine(needs, across(new Set(needs.map((a) => a.project.slug)).size)),
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
    .map((r) => ({ agent: r.agent, presence: presenceNamed(hub, p, r.agent), item: `#${r.seq}`, title: r.title, stage: r.stage, project: tag(p) })));
  // The agents here now across live projects (#441), for the home to count by role.
  const agents = live.flatMap(({ p }) => {
    const snap = hub.snap(p); // the jobs they hold, from one load (#538)
    return hub.q('SELECT * FROM agents WHERE project_id = ? ORDER BY last_seen DESC').all(p.id)
      .map((a) => ({ a, presence: hub.presenceOf(p, a, snap) }))
      .filter(({ a, presence }) => isPresent(a, presence.job ? [presence.job] : [], t))
      .map(({ a, presence }) => ({ name: a.name, model: a.model, ...presence, project: tag(p) }));
  });
  return {
    pulse: {
      state, sentence, act: needs.length, working, active: inFlight,
      since: { at: seen.length ? Math.min(...seen) : 0, ago: seen.length ? dur(t - Math.min(...seen)) : null, counts, finished },
    },
    needs,
    projects: rows.map(({ p, v }) => projectLine(hub, p, v)),
    worth_knowing: rows.map(({ p, v }) => ({ ...tag(p), count: v.attention.filter((a) => a.level !== 'act').length })).filter((w) => w.count),
    motion,
    agents,
  };
}

// The home with one more act entry that belongs to the workspace, not a project (#231: a failed payment): in Needs
// you as now, since it holds up all the workspace's work (#505), counted in the pulse and its sentence.
export function withEntry(h, entry) {
  const needs = [{ priority: 'now', priority_why: "now: it holds up all of the workspace's work", holds: 3, ...entry, project: null }, ...h.needs].sort(byNeed);
  const sentence = h.pulse.sentence.replace(NEEDS_LINE, needsLine(needs));
  return { ...h, needs, pulse: { ...h.pulse, state: 'needs-you', act: needs.length, sentence } };
}

// Needs you ranks the way agents' work does (#505). Each card carries the priority of the work it holds up and
// why, in one line: a card about an item takes the item's effective priority (its milestone's or a dependent's,
// when higher); one that holds up all of a project's or the workspace's work is now; a question about no item
// takes the highest priority of the items it names, else soon. Cards rank by a person's pick, then priority, then
// what they hold up (a blocking question parking work, then a review or PR holding a landing, then a milestone's
// part), then oldest first. Worth knowing keeps its own order.
const RANK = { now: 0, soon: 1, later: 2 };
const ALL_WORK = new Set(['app-wiring', 'plan-limit', 'operator-missing', 'direction', 'no-agents', 'payment-failed']);
const SPENDING = new Set(['budget-near', 'run-spend']); // #767
const HOLDS_LANDING = new Set(['review', 'ci-failing', 'pr-review']);
export const byNeed = (a, b) => (b.picked ? 1 : 0) - (a.picked ? 1 : 0) || (RANK[a.priority] ?? 1) - (RANK[b.priority] ?? 1)
  || (a.holds ?? 3) - (b.holds ?? 3) || a.at - b.at;

function prioritize(hub, p, attention, items) {
  const eff = hub.effectivePriorities(p);
  const bySeq = new Map(items.map((i) => [`#${i.seq}`, i]));
  const byId = new Map(items.map((i) => [i.id, i]));
  const picked = new Set(hub.q(`SELECT DISTINCT e.item_id FROM events e JOIN items i ON i.id = e.item_id
    WHERE e.project_id = ? AND e.type = 'picked' AND i.stage NOT IN ('done', 'dropped')`).all(p.id).map((r) => r.item_id));
  const ancestor = (it, id) => { for (let x = byId.get(it.parent_id); x; x = byId.get(x.parent_id)) if (x.id === id) return true; return false; };
  const of = (it) => {
    const e = eff.get(it.id) ?? { priority: it.priority, from: null };
    const from = e.from && items.find((i) => i.seq === e.from);
    return { priority: e.priority, from: from ? `#${from.seq}` : null, why: !from ? `${e.priority}: #${it.seq}'s own priority` : ancestor(it, from.id) ? `${e.priority}: part of #${from.seq}` : `${e.priority}: #${from.seq} waits on it` };
  };
  for (const a of attention) {
    const it = a.item ? bySeq.get(a.item) : null;
    let r;
    if (ALL_WORK.has(a.kind)) r = { priority: 'now', why: `now: it holds up all of ${a.hubwide ? "the hub's" : `${p.name}'s`} work` };
    else if (SPENDING.has(a.kind)) r = { priority: 'now', why: 'now: money is spent while it waits' };
    else if (it) r = of(it);
    else if (a.kind === 'question') {
      // A question about no item parks what it names, e.g. "Drop #136-#139?" (the question only: its why can quote
      // an outsider's reply).
      const named = [...String(a.headline).matchAll(/#(\d+)/g)].map((m) => bySeq.get(`#${m[1]}`)).filter((i) => i && eff.has(i.id)).map(of);
      r = named.sort((x, y) => RANK[x.priority] - RANK[y.priority])[0] ?? { priority: 'soon', why: 'soon: it is about no item' };
    } else r = { priority: 'soon', why: 'soon: it is about no item' };
    a.priority = r.priority;
    a.priority_why = r.why;
    if (r.from) a.priority_from = r.from; // inherited: the card says "from #468" (#506)
    if (it && picked.has(it.id)) a.picked = true;
    a.holds = a.kind === 'question' && a.parked ? 0 : HOLDS_LANDING.has(a.kind) ? 1 : it?.parent_id ? 2 : 3;
  }
}

// The repository an item lands in, short (acme/api), when the project has several; null with one.
function repoTag(remotes, it) {
  return remotes.length > 1 ? (it.repo || remotes[0]).split('/').slice(-2).join('/') : null;
}

// A project's page (#501): built once per change from what the hub holds, kept until the project changes or 15
// seconds pass (so "5m ago" stays true), shared by every tab, the home and the Notifier. What differs per viewer
// (whose "needs you" is whose, the steps they ticked, the GitHub App card) is laid on top, then cut to the depth:
// 30s and 5m send counts and the lists they show; 30m sends the rest, the item list and past agents in pages.
// No depth: everything, as before.
export const VIEW_TTL = 15_000;
export const DEPTHS = ['30s', '5m', '30m'];
export const PAGE = { all: 100, agents: 50 };

export function view(hub, slug, { light = false, viewer, depth, pages = {} } = {}) {
  const p = hub.project(slug);
  const built = cachedBase(hub, p, light);
  const v = personalize(hub, p, built, viewer);
  if (light) return { pulse: v.pulse, attention: v.attention, since: v.since };
  return DEPTHS.includes(depth) ? atDepth(v, depth, pages) : v;
}

// Only a hub the server runs caches (cacheViews): there every write a page shows says so (hub.changed); a test
// that writes the database itself, or moves the clock, reads it built afresh.
function cachedBase(hub, p, light) {
  if (!hub.cacheViews) return build(hub, p, hub.now(), { light });
  const cache = (hub._views ??= new Map());
  const key = hub.changeOf(p), t = hub.now();
  const have = cache.get(p.id);
  if (have && have.key === key && t - have.at < VIEW_TTL) return have;
  const fresh = { key, at: t, ...build(hub, p, t) };
  cache.set(p.id, fresh);
  return fresh;
}

// The viewer's own page from the shared one: the GitHub App card for those it's for, the steps they ticked, and
// everyone else's "needs you" as worth knowing, then ranked and counted again for the pulse.
function personalize(hub, p, { v, priv }, viewer) {
  const attention = v.attention.map((a) => {
    if (!a._ticks) return a;
    return Object.fromEntries(Object.entries(a).map(([k, x]) => (k === '_ticks' ? ['ticked', x[viewer ?? HUMAN] ?? []] : [k, x])));
  });
  const wiring = hub.appWiring?.(viewer);
  if (wiring && !priv.dismissed.has(wiringEntry(wiring).key)) {
    const a = { ...wiringEntry(wiring), level: 'act', kind: 'app-wiring', hubwide: true, priority: 'now', priority_why: "now: it holds up all of the hub's work", holds: 3 };
    if (priv.people) a.owners = priv.stewards;
    attention.splice(priv.wiringAt, 0, a);
  }
  if (viewer && priv.people) {
    for (const [k, a] of attention.entries()) {
      if (a.level !== 'act' || a.owners.includes(viewer)) continue;
      attention[k] = { ...a, level: 'know', sub: [a.owners.length ? `needs ${a.owners.join(', ')}` : 'needs a steward (none set)', a.sub].filter(Boolean).join(' · ') };
    }
  }
  attention.sort((a, b) => (a.level !== b.level ? (a.level === 'act' ? -1 : 1) : a.level === 'act' ? byNeed(a, b) : a.at - b.at));
  const act = attention.filter((a) => a.level === 'act');
  return { ...v, attention, pulse: pulseOf(p, priv.pulse, act, attention.length) };
}

// The pulse in one sentence, from what the page counted and what needs this viewer (cards).
function pulseOf(p, { inFlight, working, shaping, readyFree, shapeable, claimable, finished }, cards, all) {
  const act = cards.length;
  const state = p.parked ? 'parked' : act ? 'needs-you' : inFlight ? 'flowing' : claimable ? 'stalled' : 'idle';
  const needs = needsLine(cards);
  const sentence = (p.parked
    ? ['Parked: nothing new starts, and nothing will ask for you here until you unpark it.', act ? `${plural(act, 'thing')} already in progress still ${act === 1 ? 'needs' : 'need'} you.` : '']
    : [
      needs,
      inFlight
        ? `${plural(working, 'agent')} working on ${plural(inFlight, 'item')}${shaping ? ` (${shaping} being shaped)` : ''}.`
        : readyFree ? `${plural(readyFree, 'item')} ready, but nobody is working.`
          : shapeable ? `Nothing is moving: ${plural(shapeable, 'idea')} waiting to be shaped.` : 'No work in flight.',
      p.seen_at && finished ? `${finished} finished since you last looked.` : '',
    ]).filter(Boolean).join(' ');
  return { state, sentence, act, know: all - act, working, active: inFlight };
}

// The page cut to a depth. Every depth: the pulse, needs you and worth knowing, in motion, Flow (with the last
// items of each stage, for its stage pills), milestones, runners, and counts of what isn't sent. 5m adds the
// first of Up next, Recently finished and the field notes, steering and decisions. 30m adds the rest, history,
// and the item list and earlier agents a page at a time (pages: how many of each the page has asked for).
// Agents: the ones here now, and any other the page names, so it can say who they are.
function atDepth(v, depth, pages) {
  const z = DEPTHS.indexOf(depth);
  const board = v.all.filter((i) => i.stage !== 'dropped' && !i.old);
  const light = (i) => ({ item: i.item, title: i.title, stage: i.stage, priority: i.priority, last_worker: i.last_worker, repo: i.repo, at: i.at, ago: i.ago, ...(i.feedback ? { feedback: true } : {}) });
  const stage_items = {};
  for (const s of z >= 1 ? Object.keys(v.stages) : []) { // 30s sends no stage lists (#750): the page lists a stage from 5m
    const here = board.filter((i) => i.stage === s);
    const fb = here.filter((i) => i.feedback).slice(-25);
    stage_items[s] = [...new Set([...here.slice(-25), ...fb])].sort((a, b) => a.item.slice(1) - b.item.slice(1)).map(light);
  }
  const gone = v.agents.filter((a) => !a.present);
  const counts = {
    items: v.all.length, board: board.length, dropped: v.all.length - board.length - v.all.filter((i) => i.old).length,
    old: v.all.filter((i) => i.old).length, agents: v.agents.length, agents_gone: gone.length,
    queue: v.queue.length, done: v.done.length, notes: v.notes.length,
  };
  const { all, agents, activity, queue, done, notes, steers, decisions, proposed, waiting, verifying, ...out } = v;
  Object.assign(out, { depth, counts });
  // 30s draws each row of In motion as who, what and how long: not the last words, the files or the heads-up.
  if (z === 0) out.motion = v.motion.map(({ last, touching, heads_up, ...m }) => ({ ...m, ...(last ? { last: { ago: last.ago, at: last.at } } : {}) }));
  if (z >= 1) out.stage_items = stage_items;
  // At 5m, the first field notes, and every one waiting for a person's tap or named in Direction today (#552), so
  // its recommendation and its source link have their note.
  const waits = (n) => n.advice && !n.advice.by && n.advice.do !== 'keep';
  const sourced = new Set((v.direction ?? []).map((d) => Number(/^note (\d+)$/.exec(d.source)?.[1])).filter(Boolean));
  const notes5m = [...new Set([...notes.filter((n) => waits(n) || sourced.has(n.id)), ...notes.slice(0, 3)])];
  if (z >= 1) Object.assign(out, { queue: z >= 2 ? queue : queue.slice(0, 5), done: z >= 2 ? done : done.slice(0, 5), notes: z >= 2 ? notes : notes5m, steers, decisions });
  const more = (k) => Math.max(PAGE[k], Number(pages[k]) || 0);
  if (z >= 2) {
    const rows = [...board].sort((a, b) => b.item.slice(1) - a.item.slice(1));
    Object.assign(out, { activity, proposed, waiting, verifying, all: rows.slice(0, more('all')).map(light), dropped: v.all.filter((i) => i.stage === 'dropped').map(light) });
  }
  // Since you last looked lists the first 6 of what finished; counts.finished says how many.
  out.since = { ...v.since, finished: v.since.finished.slice(0, 6) };
  const earlier = new Set(z >= 2 ? gone.slice(0, more('agents')).map((a) => a.name) : []);
  // 30s names the agents in the sections it draws (#750): Needs you, In motion, milestones and the project.
  const named = namesIn(z >= 1 ? out : [out.attention, out.motion, out.groups, out.project], new Set(gone.map((a) => a.name)));
  const line = (a) => ({ name: a.name, model: a.model, role: a.role, where: a.where, job: a.job, present: !!a.present });
  out.agents = agents.filter((a) => a.present || earlier.has(a.name) || named.has(a.name))
    .map((a) => (z === 0 || !(a.present || earlier.has(a.name)) ? line(a) : a)); // 30s: a line each, here now or not
  if (z >= 2) out.earlier = [...earlier]; // the page of "Show earlier agents", by name
  return out;
}

// The names of the given agents that a value mentions anywhere (an actor, a holder, a worker).
function namesIn(value, names) {
  const found = new Set();
  (function walk(o) {
    if (typeof o === 'string') { if (names.has(o)) found.add(o); return; }
    if (!o || typeof o !== 'object') return;
    for (const k in o) walk(o[k]);
  })(value);
  return found;
}

// light: only the pulse, attention and since (the home and the Notifier, uncached).
function build(hub, p, t, { light = false } = {}) {
  const items = hub.q('SELECT * FROM items WHERE project_id = ? ORDER BY seq').all(p.id);
  const byId = new Map(items.map((i) => [i.id, i]));
  const ref = (i) => `#${i.seq}`;
  const remotes = hub.remotesOf(p);
  const agents = hub.q('SELECT * FROM agents WHERE project_id = ? ORDER BY last_seen DESC').all(p.id);
  // Only what can still be acted on: never a question about work that landed or was dropped (#182), but steps a
  // person still has to do for work that landed (#692) are theirs to do, blocking or not, as is an escalation of them.
  const openQs = hub.q(`SELECT q.* FROM questions q LEFT JOIN items i ON i.id = q.item_id LEFT JOIN questions o ON o.id = q.escalates
    WHERE q.project_id = ? AND q.status = 'open' AND (i.id IS NULL OR i.stage NOT IN ('done', 'dropped')
      OR (i.stage = 'done' AND (q.steps != '[]' OR (o.status = 'open' AND o.steps != '[]')))) ORDER BY q.at`).all(p.id);
  const landedSteps = (q) => byId.get(q.item_id)?.stage === 'done';
  const dismissed = new Set(hub.q('SELECT key FROM dismissals WHERE project_id = ?').all(p.id).map((d) => d.key));
  const snap = hub.snap(p); // dependencies, jobs and records from one load (#538)
  const unmet = (i) => hub.unmetDeps(i, snap);
  const lastEvent = (i, types) => hub.q(`SELECT * FROM events WHERE item_id = ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY at DESC, id DESC LIMIT 1`).get(i.id, ...types);

  const in_ = (stage) => items.filter((i) => i.stage === stage);
  // Who an agent named in an entry is, for the page to say "Worker · mac-mini runner" rather than its id (#240).
  const presence = (name) => presenceNamed(hub, p, name);
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
  // How long since at, inside an entry's headline or sub (#689). push takes it out again and sends it beside the
  // text (headline_at, sub_at: [at, as said]), so the page renders it with ago() and its tick keeps it current:
  // a minute passing then redraws no card.
  // Titles, questions and headlines in the same sentence are written by agents and outsiders (#781): a mark carries
  // this view's own random token, so written text can't forge one, and control characters left over are dropped.
  const mark = randomUUID();
  const timeIn = (at) => `\u0001${mark}${at}\u0002${dur(t - at)}\u0003`;
  const marked = new RegExp(`\u0001${mark}(\\d+)\u0002([^\u0003]*)\u0003`, 'g');
  const timed = (a, f) => {
    const times = [];
    a[f] = a[f].replace(marked, (m, at, said) => (times.push([Number(at), said]), said));
    if (times.length) a[`${f}_at`] = times;
  };
  const push = (a) => {
    for (const f of ['headline', 'sub']) {
      if (typeof a[f] !== 'string') continue;
      timed(a, f);
      a[f] = a[f].replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    }
    if (!dismissed.has(a.key)) attention.push(a);
  };

  // A question to an issue's reporter comes to you only once they've had reporter_wait hours to answer on GitHub.
  const wait = p.reporter_wait * HOUR;
  // A question to an operator is an operator session's to answer (next mode "answer"); with no operator here for a
  // day it's yours too (#712): its steps to tick and its answer box, as if asked of you, and the guide's operator part.
  // A reply held from someone outside the project (#471) comes to you at once, to pass on or answer yourself.
  const operatorHere = agents.some((a) => t - a.last_seen < DAY && json(a.has, []).includes('operator'));
  const carded = (q) => (q.audience === 'operator'
    ? !operatorHere && (q.blocking || landedSteps(q) || json(q.steps, []).length > 0) // steps wait for someone even when the asker went on
    : (q.blocking || landedSteps(q)) && !(q.reporter && !q.held_reply && t - q.at < wait));
  for (const q of openQs.filter(carded)) {
    const forOperator = q.audience === 'operator';
    const it = byId.get(q.item_id);
    // An operator's escalation carries the question it was asked, who asked it, and what the operator found.
    const orig = q.escalates ? hub.q('SELECT question, asked_by FROM questions WHERE id = ?').get(q.escalates) : null;
    const held = q.reporter && q.held_reply;
    push({
      key: `q:${q.id}`, level: 'act', kind: 'question', at: q.reporter && !held ? q.at + wait : q.at,
      headline: q.question,
      sub: [it?.title, orig ? `${q.asked_by} (operator) escalated ${orig.asked_by}'s question ${timeIn(q.at)} ago` : `${q.asked_by} asked ${q.reporter ? `@${q.reporter} on GitHub ` : ''}${timeIn(q.at)} ago`,
        held ? `@${q.reporter} replied; they have no write access, so it waits for you to pass it on` : q.reporter && 'no reply yet',
        forOperator && 'no operator connected, so you can do it',
        it?.stage === 'waiting' && 'work is parked until you answer', landedSteps(q) && `${ref(it)} landed; ${orig ? 'its' : 'these'} steps are still to do`].filter(Boolean).join(' · '),
      why: [held && `@${q.reporter} replied on GitHub (${q.held_url}):\n\n${q.held_reply.split('\n').map((l) => `> ${l}`).join('\n')}`,
        orig && `${orig.asked_by} asked an operator: "${orig.question}"`,
        forOperator && `${q.asked_by} asked an operator: a Claude Code session someone keeps open, acting with their access, for the work workers aren't allowed to do. None has checked in here in the last day, so it's yours: do the steps and answer, and ${q.asked_by} gets your answer as an operator's. Or start an operator and leave it to them.`,
        q.context].filter(Boolean).join('\n\n'), detail: q.detail,
      ...(forOperator ? { operator: true, guide: OPERATOR_GUIDE } : {}),
      item: it ? ref(it) : null, parked: it?.stage === 'waiting', // answering can keep it parked
      question: { id: q.id, options: [...(held ? [PASS_ON] : []), ...json(q.options, [])], asked_by: q.asked_by },
      agent: q.asked_by, presence: presence(q.asked_by),
      steps: json(q.steps, []),
      // The steps each person has ticked (#162), counting from 1; each person ticks their own (personalize).
      _ticks: ticksOf(hub, q.id),
      ...(orig ? { escalation: { question: orig.question, asked_by: orig.asked_by }, evidence: json(q.evidence, []) } : {}),
    });
  }

  // What an operator marked for people in the last day (#497): a change it made on a live system, or a call no
  // decision covers. Its other answers live only in their item's history.
  const settled = hub.q(`SELECT * FROM questions q WHERE project_id = ? AND audience = 'operator' AND status = 'answered' AND for_people = 1 AND answered_at > ?
    AND NOT EXISTS (SELECT 1 FROM questions e WHERE e.escalates = q.id AND e.status = 'answered') ORDER BY answered_at`).all(p.id, t - DAY);
  for (const q of settled) {
    const it = byId.get(q.item_id);
    push({
      key: `opanswer:${q.id}`, level: 'know', kind: 'operator-answered', at: q.answered_at,
      headline: `Operator answered ${q.asked_by}: ${q.answer}`,
      sub: [`Q: ${q.question}`, `${q.answered_by} · ${timeIn(q.answered_at)} ago`].join(' · '),
      why: q.context, item: it ? ref(it) : null,
    });
  }

  // Tidy results and field-note reviews never show here (#497): they stay in their items' history.

  // Unless no operator has been here for a day: those with steps or blocking work are cards above; the rest, one
  // line, so they don't wait forever.
  const forOperator = operatorHere ? [] : openQs.filter((q) => q.audience === 'operator' && !carded(q));
  if (forOperator.length) {
    push({
      key: `operator:${forOperator[0].id}`, level: 'act', kind: 'operator-missing', at: forOperator[0].at,
      headline: `${plural(forOperator.length, 'question')} ${forOperator.length === 1 ? 'waits' : 'wait'} for an operator; none connected`,
      sub: forOperator.map((q) => `Q${q.id}: ${q.question}`).slice(0, 3).join(' · '),
      questions: forOperator.map((q) => q.id), // by number (#710): ⌘K's "q207" lands on this card
      why: 'Agents asked an operator: a Claude Code session someone keeps open, acting with their access, for the work workers aren\'t allowed to do. None has checked in here in the last day. `nuworq up` starts one for each project that doesn\'t have one yet. To start one yourself, open a terminal in the project\'s folder, run `claude`, then type `/nuworq:operator`.',
      guide: OPERATOR_GUIDE,
    });
  }

  // Work someone answered on but kept parked: it waits for them to say go.
  for (const it of in_('waiting').filter((i) => i.parked_by && !openQs.some((q) => q.blocking && q.item_id === i.id))) {
    // Or the hub parked it (#734): handed back again and again with nothing submitted, as when its worker keeps dying.
    if (it.parked_by === SYSTEM) {
      const h = json(it.handoff, null);
      push({
        key: `parked:${it.id}:${it.stage_since}`, level: 'act', kind: 'kept-parked', at: it.stage_since,
        headline: `${ref(it)} was handed back ${HANDBACKS} times with nothing submitted; nuworq parked it`,
        sub: [it.title, h && `last: ${h.by}: "${h.headline}"`].filter(Boolean).join(' · '),
        why: `Its workers keep stopping before they submit: they hand it back, sign off or exit (a runner's worker that crashes signs off). Read its history for where each one stopped, then clarify it, split it or drop it, and unpark it when it should go back to the agents.${h?.summary ? `\n\nThe last note, from ${h.by}:\n\n${h.summary.split('\n').map((l) => `> ${l}`).join('\n')}` : ''}`,
        item: ref(it), parked_by: it.parked_by,
      });
      continue;
    }
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
      headline: `${ref(it)} was accepted ${timeIn(it.stage_since)} ago but isn't on main yet`,
      sub: it.title, why: `No agent has landed ${it.branch || 'its branch'}. Connect an agent; land jobs come before any other work.`,
      item: ref(it), start: true,
    });
  }

  // Work that has waited outside past the project's limit: the fact may never come, or the check may be wrong.
  // Not a wait for a date: that one waits on purpose, and its day comes by itself.
  const waitMs = (p.wait_days || WAIT_DAYS) * DAY;
  for (const it of in_('outside').filter((i) => t - i.stage_since > waitMs && !/"kind":"date"/.test(i.precondition))) {
    const pre = preconditionOut(it);
    push({
      key: `outside:${it.id}:${it.stage_since}`, level: 'know', kind: 'outside-overdue', at: it.stage_since,
      headline: `${ref(it)} has waited ${timeIn(it.stage_since)} on something outside the hub`,
      sub: [it.title, pre?.last_check ? `last check ${timeIn(pre.last_check.at)} ago: ${pre.last_check.detail}` : 'not checked yet'].join(' · '),
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

  // The hub's GitHub App is missing events or permissions the hub handles (#220): its owners, with the steps.
  // The same entry on every project; the home shows it once (hubwide). Whose it is differs per viewer: personalize
  // puts it here.
  const wiringAt = attention.length;

  // Free's limit stopped a second agent here (#228): the workspace's owners can upgrade, while billing is on.
  // Gone once the plan isn't Free, the agent got work, or an hour has passed without another refusal.
  const refused = hub.planRefused;
  const upgrade = refused?.project === p.id && t - refused.at < HOUR && hub.planLimit?.() && hub.upgradeUrl?.();
  if (upgrade && !hub.working().has(refused.agent)) {
    push({
      key: `plan-limit:${refused.agent}`, level: 'act', kind: 'plan-limit', at: refused.at, upgrade,
      headline: `${refused.agent} is waiting: the Free plan runs one agent at a time, and ${refused.working.join(', ')} is working`,
      sub: `refused ${timeIn(refused.at)} ago`,
      why: `On Free, a second agent waits until the first finishes or hands off. ${hub.upgradeOffer?.() || 'Pro runs any number side by side'}. Upgrade opens Stripe Checkout; the plan changes within a minute once Stripe confirms the payment.`,
      owners: hub.q("SELECT handle FROM people WHERE role = 'owner' ORDER BY handle").all().map((r) => `@${r.handle}`),
    });
  }

  // Spend before it surprises anyone (#767): 80% of today's budget for workers here, once a day (the key is the
  // day's), until a person pauses staffing. At 100% runners start no one new, so it's then or never.
  const staff = p.runner ? hub.staffing(p) : null;
  if (staff?.budget && !staff.paused && staff.spent_today >= 0.8 * staff.budget) {
    const day = Math.floor(t / DAY) * DAY;
    push({
      key: `budget:${day}`, level: 'act', kind: 'budget-near', at: t,
      headline: `${p.name} has spent $${staff.spent_today.toFixed(2)} of its $${staff.budget.toFixed(2)} daily budget; it resets at 00:00 UTC, in ${dur(day + DAY - t)}`,
      sub: staff.spent_today >= staff.budget ? 'all spent: no new workers start until then' : `${Math.round((staff.spent_today / staff.budget) * 100)}% spent; at 100% no new workers start`,
      why: "Every agent's recorded cost here today counts, and running workers' spend so far. Raise the budget if the work is worth it, or pause runners: running workers finish, and no new ones start until you resume.",
      actions: ['raise-budget', 'pause-runners'],
    });
  }
  // One worker past $50 or an hour (#767), once per run (the key is its start): Stop it, or let it go on.
  for (const w of p.runner ? hub.workerRuns(p) : []) {
    if (w.usd <= RUN_USD && t - w.since <= RUN_MS) continue;
    const it = items.find((i) => i.holder === w.name && OPEN_STAGES.includes(i.stage));
    const spent = w.usd > 0 ? `has spent $${w.usd.toFixed(2)}` : 'has run';
    push({
      key: `run-spend:${w.runner}:${w.name}:${w.since}`, level: 'act', kind: 'run-spend', at: w.since,
      headline: `${w.name} ${spent}${it ? ` on ${ref(it)}` : ''} ${w.usd > 0 ? 'over' : ''} ${dur(t - w.since)}`.replace(/ +/g, ' '),
      sub: [it?.title, `runs on ${w.runner}`].filter(Boolean).join(' · '),
      why: `A worker usually finishes a job well under $${RUN_USD} and an hour. Stop it if it's stuck: its runner stops it on its next poll, and the job goes back to the queue. Or let it go on: its runner's own caps (--max-minutes, --worker-usd) still stop it.`,
      item: it ? ref(it) : null, agent: w.name, presence: presence(w.name), actions: ['stop-worker'],
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
        sub: `${it.title} · ${it.implementer ?? 'an agent'} submitted it ${timeIn(it.stage_since)} ago`,
        why: sub?.summary, detail: sub?.detail,
        acceptance: it.acceptance, evidence, git,
        warn: [evidence.length ? null : 'No evidence attached', gitWarning(git)].filter(Boolean).join(' · ') || null,
        item: ref(it), agent: it.implementer, presence: presence(it.implementer),
        attempts: it.race > 1 ? hub.submissions(it) : undefined, // a race: compare and keep one
      });
    }
  } else {
    for (const it of in_('verifying').filter((i) => !i.holder && t - i.stage_since > 2 * HOUR)) {
      push({
        key: `peer:${it.id}`, level: 'know', kind: 'peer-review-stuck', at: it.stage_since,
        headline: `${ref(it)} has waited ${timeIn(it.stage_since)} for a peer review`,
        sub: it.title, why: 'No other agent has picked it up. Review it yourself, or start another agent.',
        item: ref(it),
      });
    }
  }

  for (const it of in_('proposed')) {
    if (waitsForOk(p, it)) {
      // Only shaped proposals reach you: approving a raw idea isn't a 30-second decision; approving a shaped one is.
      if (!it.acceptance || it.holder) continue;
      const shaped = lastEvent(it, ['shaped']);
      push({
        key: `proposal:${it.id}`, level: 'act', kind: 'proposal', at: shaped?.at ?? it.created_at,
        headline: it.title,
        sub: shaped ? `${shaped.actor} shaped it ${timeIn(shaped.at)} ago` : `${it.created_by === HUMAN ? 'You' : it.created_by} proposed it ${timeIn(it.created_at)} ago`,
        why: [shaped?.headline, it.summary].filter(Boolean).join('\n\n'), acceptance: it.acceptance, item: ref(it),
      });
    }
    // An agent's raw proposal isn't for you (#497): agents shape it into ready work themselves.
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

  // Work that keeps bouncing (#564), said from its history: only when a person can help, with that person's step.
  // Accepted work in landing is agents' to put on main, and a stuck land job is its own signal: nothing for the human (#216).
  for (const it of items.filter((i) => OPEN_STAGES.includes(i.stage) && i.stage !== 'landing' && i.stalls + i.rejections >= 2)) {
    const b = bounceOf(hub, p, it, { agents, openQs, unmet, t });
    if (!b?.step) continue; // a review loop with a fix to build, a dependency someone can take, lapses from restarts
    const s = b.step;
    // A blocking question already has its own card: it carries why the work bounces, rather than a second card.
    const own = s.kind === 'answer' && attention.find((a) => a.key === `q:${s.question.id}`);
    if (own) { own.why = [`${ref(it)} keeps bouncing. ${b.line}`, own.why].filter(Boolean).join('\n\n'); continue; }
    push({
      key: `struggle:${it.id}:${b.failures}:${s.kind}`, level: 'act', kind: 'struggling', at: it.updated_at,
      headline: it.title,
      sub: `Bounced ${b.failures === 2 ? 'twice' : `${b.failures} times`} · ${s.kind === 'answer' ? `answer question ${s.question.id}` : s.kind === 'capability' ? `start ${s.missing.some((m) => OPERATOR_TAGS.includes(m)) ? 'an operator' : 'an agent'} with ${s.missing.join(', ')}` : 'clarify, split or drop it'}`,
      why: [endSentence(`What happened: ${b.happened}`), endSentence(`Now it waits on ${b.waits}`),
        s.kind === 'clarify' && `It keeps failing the same way: ${s.why}. The intent may be unclear, the acceptance wrong, or it may be too big. Clarify it with a steer, split it, or drop it.`,
      ].filter(Boolean).join('\n\n'),
      item: ref(it), step: s.kind,
      ...(s.kind === 'answer' ? { question: { id: s.question.id, question: s.question.question, options: json(s.question.options, []), asked_by: s.question.asked_by } } : {}),
      ...(s.kind === 'capability' ? { how: capabilitySteps(p, s.target, s.missing) } : {}),
    });
  }

  for (const q of openQs.filter((q) => !q.blocking && !landedSteps(q) && !(q.audience === 'operator' && carded(q)))) {
    const it = byId.get(q.item_id);
    push({
      key: `q:${q.id}`, level: 'know', kind: 'assumption', at: q.at,
      headline: `${q.asked_by} assumed: ${q.assumption}`,
      sub: [`Q: ${q.question}`, `${timeIn(q.at)} ago`].filter(Boolean).join(' · '),
      why: q.context, item: it ? ref(it) : null,
      question: { id: q.id, options: json(q.options, []), assumption: q.assumption, asked_by: q.asked_by },
    });
  }

  // Your steering: what a person wrote (#550). An operator's answer to a worker and the hub's own notices reach agents
  // all the same, but a person can't judge them: they show on their item, or as facts in the history.
  const steers = hub.q(`SELECT n.*, i.seq AS item_seq FROM notes n LEFT JOIN items i ON i.id = n.item_id
      WHERE n.project_id = ? AND n.kind = 'steer' AND n.active = 1 AND n.notice = 0 AND n.at > ? ORDER BY n.at DESC`).all(p.id, t - 3 * DAY)
    .filter((n) => isHuman(n.author))
    .map((n) => {
      const acks = hub.q('SELECT * FROM acks WHERE note_id = ? ORDER BY at').all(n.id);
      return { id: n.id, body: n.body, by: n.author, item: n.item_seq ? `#${n.item_seq}` : null, at: n.at, acks: acks.map((a) => ({ agent: a.agent, response: a.response, at: a.at })) };
    });
  // Only a steer a person wrote: one made from an answer ("Change of course") is the answerer's (#497).
  for (const s of steers.filter((s) => isHuman(s.by) && !s.acks.length && t - s.at > 15 * MIN)) {
    push({
      key: `steer:${s.id}`, level: 'know', kind: 'steer-unseen', at: s.at,
      headline: `No agent has picked up your steer yet (${timeIn(s.at)})`,
      sub: `"${s.body.slice(0, 120)}"`,
      why: recentAgents.length ? 'Agents see steering on their next call to nuworq.' : 'No agents are active right now. They will see it when they check in.',
      item: s.item,
    });
  }

  // Work that needs something no agent seen in the last day has: it would wait forever unnoticed.
  const fitAgents = agents.filter((a) => t - a.last_seen < DAY).map((a) => json(a.has, []));
  const stalledGroups = stalledGroupsOf(hub, p, readyFree, { agents, t });
  for (const it of [...readyFree, ...shapeable]) {
    const missing = json(it.needs, []).filter((tag) => !fitAgents.some((has) => has.includes(tag)));
    if (!missing.length) continue;
    const forOperator = missing.some((tag) => OPERATOR_TAGS.includes(tag));
    push({
      key: `unfit:${it.id}:${missing.join(',')}`, level: 'know', kind: 'unfit', at: it.stage_since,
      headline: forOperator ? `${ref(it)} waits for the operator: needs ${missing.join(', ')}` : `${ref(it)} needs ${missing.join(', ')}; no agent connected in the last day has it`,
      sub: it.title,
      why: forOperator
        ? `Only an operator that declares ${missing.join(', ')} at checkin (has) is offered it. Start an operator session (see Operators in the guide, /agents.md), or change what the item needs.`
        : `Only agents that declare ${missing.join(', ')} at checkin (has) are offered it. Start one on a machine that has it, or change what the item needs.`,
      item: ref(it), missing, keep: json(it.needs, []).filter((t) => !missing.includes(t)),
      // Infrastructure work can't go to just any agent: the fix is an operator session, not dropping the need.
      ...(forOperator ? { operator: true, how: capabilitySteps(p, it, missing) } : {}),
    });
  }
  for (const [group, { it, missing }] of stalledGroups) {
    const g = group === it.seq ? it : items.find((i) => i.seq === group);
    push({
      key: `group-stalled:${g.id}:${missing.join(',')}`, level: 'act', kind: 'group-stalled', at: it.stage_since + 4 * HOUR,
      headline: `"${g.title}" is stalled: ${ref(it)} needs ${missing.join(', ')}`,
      sub: `${g.id === it.id ? 'It' : `Its next step, ${ref(it)},`} has waited ${timeIn(it.stage_since)}; no agent connected in 4 hours has ${missing.join(', ')}`,
      why: `${ref(g)} is "now", and its next step needs ${missing.join(', ')}, which no agent connected in the last 4 hours has. Nothing else can move it.`,
      item: ref(it), group: ref(g), missing, how: capabilitySteps(p, it, missing),
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
  // Capacity (#173): work someone holds, a claim in the last 30 minutes, or a runner up for this project. An
  // agent that only checked in, looked, asked or commented isn't working on anything. A runner that asked where
  // work is in the last few minutes is about to start a worker, even before its first report (#185). Once a runner
  // here is reporting, its report decides: one that skips this project or paused itself still polls, but no
  // worker is coming, and #173 says why.
  const claimedLately = !!hub.q(`SELECT 1 FROM events WHERE project_id = ? AND at > ? AND type IN (${CLAIM_TYPES.map(() => '?').join(',')}) LIMIT 1`).get(p.id, t - 30 * MIN, ...CLAIM_TYPES);
  const runners = hub.runnersOf(p);
  const reporting = runners.some((r) => ['up', 'skipping', 'paused'].includes(r.state));
  const onDuty = !!p.runner && !reporting && t - (p.runner_polled_at ?? 0) < RUNNER_ON_DUTY;
  const capacity = items.some((i) => i.holder) || racers.length > 0 || claimedLately || onDuty || runners.some((r) => r.state === 'up');
  // Starting an agent is no answer for work only an operator can do (#137): that waits quietly, above.
  const generic = (i) => !json(i.needs, []).some((tag) => OPERATOR_TAGS.includes(tag));
  const anyoneReady = readyFree.filter(generic).length;
  if (!p.parked && !direction && anyoneReady + shapeable.filter(generic).length && !capacity) {
    const idle = idleCause(hub, p, t);
    push({
      key: `no-agents:${Math.floor(t / (6 * HOUR))}`, level: inFlight ? 'know' : 'act', kind: 'no-agents', at: lastAgentSeen || t,
      headline: anyoneReady ? `${plural(anyoneReady, 'item')} ready, but no agent is working` : `Work is waiting to be shaped, but no agent is working`,
      sub: idle.sub, why: idle.why, cause: idle.cause, how: idle.how, staff: idle.staff,
      start: true,
    });
  }
  // Agents out of work because the rest waits on you isn't news (#497): what waits on you is already in Needs you.

  if (!p.parked) {
    for (const c of hub.q('SELECT id, kind, last_error, failing_since FROM channels WHERE failing_since IS NOT NULL').all()) {
      push({
        key: `notify:${c.id}:${c.failing_since}`, level: 'know', kind: 'notify-failing', at: c.failing_since,
        headline: `Push notifications to ${c.kind} are failing (${c.last_error})`,
        sub: `since ${timeIn(c.failing_since)} ago · retried once`,
        why: 'Things that need you are not reaching your phone or chat. Check the channel under Notifications, or run `nuworq notify test`.',
      });
    }
  }

  // With people, every "needs you" has owners: whoever steered the item, else the project's stewards.
  // The viewer's own stay act; everyone else's become worth knowing (personalize), so "needs you" means you.
  const people = hub.hasPeople();
  if (people) {
    const bySeq = new Map(items.map((i) => [ref(i), i]));
    for (const a of attention.filter((x) => x.level === 'act')) {
      // Work kept parked is the parker's to release.
      // Some are the workspace owners' alone (an upgrade).
      a.owners ??= a.parked_by?.startsWith('@') ? [a.parked_by] : hub.ownersOf(p, a.item ? bySeq.get(a.item) : null);
    }
  }
  prioritize(hub, p, attention, items);

  // ── since you last looked ──
  // Counted in SQL; only what finished is loaded (#538).
  const agentsSince = `e.project_id = ? AND e.at > ? AND e.actor != ? AND e.actor NOT LIKE '@%'`;
  const sinceCounts = new Map(hub.q(`SELECT e.type, COUNT(*) AS n FROM events e WHERE ${agentsSince} GROUP BY e.type`).all(p.id, p.seen_at, HUMAN).map((r) => [r.type, r.n]));
  const finished = hub.q(`SELECT e.actor, i.seq AS item_seq, i.title AS item_title FROM events e LEFT JOIN items i ON i.id = e.item_id
      WHERE ${agentsSince} AND e.type = 'accepted' ORDER BY e.at DESC`).all(p.id, p.seen_at, HUMAN);
  const since = {
    at: p.seen_at,
    ago: p.seen_at ? dur(t - p.seen_at) : null,
    finished: finished.map((e) => ({ item: `#${e.item_seq}`, title: e.item_title, by: e.actor })),
    counts: {
      finished: finished.length,
      submitted: sinceCounts.get('submitted') ?? 0,
      started: sinceCounts.get('claimed') ?? 0,
      proposed: sinceCounts.get('created') ?? 0,
      sent_back: sinceCounts.get('sent_back') ?? 0,
      updates: [...sinceCounts.values()].reduce((a, b) => a + b, 0),
    },
  };

  // ── pulse: one sentence, counted per viewer (personalize) ──
  const working = new Set([...[...active, ...shaping].map((i) => i.holder).filter(Boolean), ...racers.map((a) => a.agent)]);
  const priv = {
    pulse: { inFlight, working: working.size, shaping: shaping.length, readyFree: readyFree.length, shapeable: shapeable.length, claimable, finished: finished.length },
    wiringAt, dismissed, people, stewards: people ? hub.stewardsOf(p) : [],
  };
  if (light) return { v: { pulse: null, attention, since }, priv };

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
      last: last ? { headline: last.headline, summary: last.summary, ago: dur(t - last.at), at: last.at, type: last.type } : null,
      for: dur(t - since), since_at: since, lease_left: dur(lease - t), lease_until: lease, attempt: it.attempts,
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
    needs: json(it.needs, []), size: it.size || null, repo: repoTag(remotes, it), by: it.created_by, ago: dur(t - it.stage_since), at: it.stage_since, summary: it.summary,
    blocked_by: unmet(it).map(ref), last_worker: it.last_worker, attempts: it.attempts,
    handoff: json(it.handoff, null),
    ...(it.feedback ? { feedback: true } : {}), // approved feedback about nuworq (#295)
    ...(it.stage === 'done' && t - it.stage_since >= RECENT ? { old: true } : {}), // off the board; search finds it (#442)
  });
  const rank = { now: 0, soon: 1, later: 2 };
  const queue = in_('ready').sort((a, b) => rank[a.priority] - rank[b.priority] || a.seq - b.seq).map(brief);
  const proposed = in_('proposed').map(brief);
  const waiting = in_('waiting').map(brief);
  const verifying = in_('verifying').map((it) => ({ ...brief(it), implementer: it.implementer, reviewer: it.holder }));
  const done = recentlyDone(items, t).map(({ it, parts }) => ({ ...brief(it), implementer: it.implementer, accepted: lastEvent(it, ['accepted'])?.actor,
    ...(parts ? { parts: parts.map((c) => ({ item: ref(c), title: c.title, stage: c.stage })) } : {}) }));

  // ── agents and their track records ──
  // What each holds, in seq order: its own items and its running race attempts.
  const holdingOf = new Map();
  for (const i of items) {
    for (const name of new Set([i.holder, ...racers.filter((r) => r.item_id === i.id).map((r) => r.agent)].filter(Boolean))) {
      (holdingOf.get(name) ?? holdingOf.set(name, []).get(name)).push(ref(i));
    }
  }
  // Who answers for each agent: the person who minted its token, or the runner it belongs to. Not a later person
  // who got a removed minter's id (#865).
  const tokenIds = agents.map((a) => a.token_id).filter((id) => id != null);
  const tokens = new Map(tokenIds.length ? hub.q(`SELECT t.id, t.runner, m.handle FROM tokens t LEFT JOIN people m ON m.id = t.minted_by AND m.created_at <= t.created_at WHERE t.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(tokenIds)).map((r) => [r.id, r]) : []);
  const agentRows = agents.map((a) => {
    const holding = holdingOf.get(a.name) ?? [];
    const idle = t - a.last_seen;
    const status = a.signed_off ? 'signed off' : holding.length ? (idle > 10 * MIN ? 'quiet' : 'working') : idle < PRESENT_FOR ? 'idle' : 'away';
    const rec = snap.records.get(a.name) ?? {};
    const tok = a.token_id != null ? tokens.get(a.token_id) : null;
    const via = tok?.runner ? `runner ${tok.runner}` : tok?.handle ? `via @${tok.handle}` : null;
    return {
      name: a.name, model: a.model, client: a.client, provider: providerOf(a.model), tokens: a.tokens ? a.tokens.split(',') : [], via, has: json(a.has, []),
      status, present: isPresent(a, holding, t), line: a.status, holding, last_seen: dur(idle), seen_at: a.last_seen, first_seen: dur(t - a.first_seen),
      ...hub.presenceOf(p, a, snap), // role, where it runs, its current job (#238)
      record: {
        landed: rec.landed ?? 0, sent_back: rec.sent_back ?? 0, stalls: rec.stalls ?? 0,
        claimed: rec.claimed ?? 0, submitted: rec.submitted ?? 0, handoffs: rec.handoffs ?? 0,
        questions: rec.questions ?? 0, assumptions: rec.assumptions ?? 0, proposed: rec.proposed ?? 0,
        reviews: rec.reviews ?? 0, learned: rec.learned ?? 0,
        races: rec.races ?? 0, races_won: rec.races_won ?? 0,
      },
    };
  });

  // Memory distilled for people (#552): each decision and field note with its gist, a field note with the review's
  // advice, and Direction today.
  const advice = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  const decisions = hub.decisions(p).map((d) => ({ id: d.id, body: d.body, gist: d.gist || null, ago: dur(t - d.at), at: d.at }));
  const notes = hub.q(`SELECT n.*, i.seq FROM notes n LEFT JOIN items i ON i.id = n.item_id
      WHERE n.project_id = ? AND n.kind = 'learning' AND n.active = 1 ORDER BY n.always DESC, n.at DESC`).all(p.id)
    .map((n) => ({ id: n.id, body: n.body, gist: n.gist || null, advice: advice(n.advice), by: n.author, item: n.seq ? `#${n.seq}` : null, ago: dur(t - n.at), at: n.at, always: !!n.always }));
  const directionToday = advice(p.direction) ?? [];
  const activity = hub.q(`SELECT e.*, i.seq AS item_seq FROM events e LEFT JOIN items i ON i.id = e.item_id
      WHERE e.project_id = ? ORDER BY e.at DESC, e.id DESC LIMIT 150`).all(p.id).map((e) => eventOut(e, t));

  const v = {
    // runners_here (#643): runners that reached this project in the last week; staffing is offered only once one has.
    project: { slug: p.slug, name: p.name, mission: p.mission, parked: !!p.parked, path: p.path, runner: !!p.runner, staffing: hub.staffing(p), runners_here: hub.runnersFor(p.slug).length, fresh: !!p.fresh, security: !!p.security, live: !!p.live, releases: p.releases || 'off', ci: p.ci || 'auto', autonomy: p.autonomy, autonomy_label: AUTONOMY[p.autonomy].label, autonomy_options: AUTONOMY, seen_at: p.seen_at, github: !!p.github_secret, remotes: hub.remotesOf(p), worker_commands: json(p.worker_commands, []) },
    pulse: null, since, attention, motion, flow, // pulse: personalize's
    ...groupsOf(hub, p, items, { agents, openQs, t, stalled: stalledGroups }),
    queue, proposed, waiting, verifying, done,
    agents: agentRows, runners: hub.runnersOf(p), decisions, notes, steers, direction: directionToday, activity,
    stages: STAGES,
    all: items.map(brief),
  };
  return { v, priv };
}

// Who has ticked which of a question's steps: person → the steps, counting from 1.
function ticksOf(hub, id) {
  const out = {};
  for (const r of hub.q('SELECT person, step FROM step_ticks WHERE question_id = ? ORDER BY step').all(id)) (out[r.person] ??= []).push(r.step);
  return out;
}

// How to get work that needs capabilities nobody connected has picked up (#201): an operator session for what
// only an operator has (infra, admin, running claude), else a worker on a machine that has it. Numbered steps.
function capabilitySteps(p, it, missing) {
  const ref = (i) => `#${i.seq}`;
  const seen = `${ref(it)} is claimed within a few minutes, and this entry goes away`;
  if (missing.some((tag) => OPERATOR_TAGS.includes(tag))) {
    return [
      { do: `In ${p.name}'s folder on the machine that can do it, print the operator line`, where: `nuworq operator --project ${p.slug} --has ${missing.join(',')}`, check: `It prints "Declare: operator, ${missing.filter((m) => m !== 'operator').join(', ')}" and a /nuworq:operator line` },
      { do: 'Open Claude Code in that folder (the terminal or the desktop app\'s Code tab) and type the /nuworq:operator line it printed', where: 'claude', check: seen },
    ];
  }
  return [{ do: `On a machine that has ${missing.join(', ')}, start a worker that declares it`, where: `nuworq worker --agent claude --run --project ${p.slug} --has ${missing.join(',')}`, check: seen }];
}

// Why nothing is working on a project with claimable work (#173), from what the runners last said (#171): one
// cause, the one fix, and the steps when a person has to act. cause: no-runner | budget | unstaffed | skipping | paused.
function idleCause(hub, p, t) {
  const rs = hub.runnersFor(p.slug);
  const live = rs.filter((r) => ['up', 'skipping', 'paused'].includes(r.state));
  const run = 'nuworq run --workers 1';
  const check = 'The Runners section of this project page (depth 5m) lists it as up within a minute';
  const budget = rs.find((r) => r.state === 'stopped' && /max-usd/.test(r.stopped ?? ''));
  if (!live.length && budget) {
    return {
      cause: 'budget', sub: `${budget.name} stopped ${budget.last_seen} ago: ${budget.stopped}`,
      why: `The runner on ${budget.machine || budget.name} stopped because it spent its budget (--max-usd). Start it again with a higher budget, or wait and start it tomorrow.`,
      how: [{ do: `On ${budget.machine || 'that machine'}, start the runner again with a higher budget`, where: `${run} --max-usd 10`, check }],
    };
  }
  if (!live.length) {
    const last = [...rs].sort((a, b) => b.seen_at - a.seen_at)[0];
    return {
      cause: 'no-runner',
      sub: last ? `No runner is up: ${last.name} was last seen ${last.last_seen} ago${last.machine ? ` on ${last.machine}` : ''}` : 'No runner has ever reported here',
      why: `No runner (\`nuworq run\`) is up for this project${last ? `: ${last.name} went quiet ${last.last_seen} ago${last.machine ? ` on ${last.machine}` : ''}` : ''}. Start a runner, or connect an agent yourself. Or park the project if it should stay quiet.`,
      // Not staffed yet (#643): the runner staffs it as it starts (--staff), rather than a switch nothing could act on
      // yet. Its install doesn't repeat that: a service that re-staffed on every start would undo turning it off.
      how: [
        p.runner ? { do: `On ${last?.machine || 'a machine connected to this hub'}, start a runner`, where: run, check }
          : { do: `On ${last?.machine || 'a machine connected to this hub'}, start a runner that staffs this project`, where: `${run} --staff ${p.slug}`, check },
        { do: 'To keep it going after the terminal closes and across reboots, install it instead', where: `${run} --install` },
      ],
    };
  }
  if (!p.runner) {
    return {
      cause: 'unstaffed', sub: `${plural(live.length, 'runner')} up, but this project isn't staffed`,
      why: `${live.map((r) => r.name).join(', ')} ${live.length === 1 ? 'is' : 'are'} up, but this project isn't staffed with \`nuworq run\`. One click staffs it.`,
      how: [{ do: 'Click "Staff it with nuworq run" on this card', check: 'The Runners section of this project page (depth 5m) shows a worker within a poll' }],
      staff: true,
    };
  }
  const skipping = live.filter((r) => r.state === 'skipping');
  if (skipping.length === live.length) {
    const r = skipping[0];
    return {
      cause: 'skipping', sub: `Every runner skips this project: ${r.skipping.reason}`,
      why: `${skipping.map((x) => x.name).join(', ')} ${skipping.length === 1 ? 'leaves' : 'leave'} this project alone${r.skipping.for ? ` for ${r.skipping.for}` : ''}. ${r.name} said: ${r.skipping.reason}.`,
      how: [
        { do: `On ${r.machine || r.name}, fix what the runner said: ${r.skipping.reason}`, where: 'tail ~/.nuworq/logs/run.log', check: 'The runner no longer says it skips this project' },
        { do: 'Wait one poll (30 seconds by default)', check },
      ],
    };
  }
  const paused = live.filter((r) => r.state === 'paused');
  const r = paused[0] ?? live[0];
  return {
    cause: 'paused', sub: `Runners paused: ${r.paused?.reason ?? 'they paused themselves'}`,
    why: `${paused.map((x) => x.name).join(', ')} paused ${paused.length === 1 ? 'itself' : 'themselves'}${r.paused ? ` for ${r.paused.for}` : ''}: ${r.paused?.reason ?? 'workers kept failing'}. ${paused.length === 1 ? 'It starts' : 'They start'} again on ${paused.length === 1 ? 'its' : 'their'} own after that; if it keeps happening, the workers' logs say why.`,
    how: [{ do: `On ${r.machine || r.name}, read the last worker's log to see why it failed`, where: 'ls -t ~/.nuworq/logs | head', check: 'The runner shows up again after the pause' }],
  };
}

// Whether an item waits on the person (#200): a blocking question only they can answer, work they kept parked,
// a shaped proposal to approve, or (unless agents verify each other) work to verify. Work parked on an
// operator's question isn't theirs.
function waitsOnYou(p, i, openQs) {
  return !!i.parked_by || openQs.some((q) => q.item_id === i.id && q.blocking && q.audience !== 'operator')
    || (i.stage === 'proposed' && !i.holder && !!i.acceptance && waitsForOk(p, i))
    || (i.stage === 'verifying' && !i.holder && p.autonomy !== 'full');
}

// Done work stays on the board this long (#442), in Recently finished; after that only search, the launcher,
// analytics and history show it.
export const RECENT = 3 * DAY;

// Recently finished, newest first (#442): [{ it, parts }]. A finished milestone is one line carrying its parts
// (the ones not dropped), and the parts it carries don't get lines of their own.
export function recentlyDone(items, t) {
  const kids = new Map();
  for (const i of items) if (i.parent_id) kids.set(i.parent_id, [...(kids.get(i.parent_id) ?? []), i]);
  const recent = items.filter((i) => i.stage === 'done' && t - i.stage_since < RECENT).sort((a, b) => b.stage_since - a.stage_since);
  const folds = new Set(recent.filter((i) => kids.has(i.id)).map((i) => i.id));
  const byId = new Map(items.map((i) => [i.id, i]));
  const folded = (i, seen = new Set()) => {
    for (let p = byId.get(i.parent_id); p && !seen.has(p.id); seen.add(p.id), p = byId.get(p.parent_id)) if (folds.has(p.id)) return true;
    return false;
  };
  return recent.filter((i) => !folded(i)).map((it) => ({ it, parts: folds.has(it.id) ? kids.get(it.id).filter((c) => c.stage !== 'dropped').sort((a, b) => a.seq - b.seq) : null }));
}

const GROUP_STATE = { you: 0, stuck: 1, moving: 2, queued: 3, waiting: 4 };

// The "now" groups stalled on a capability (#201): a group's next step, ready for 4 hours, needs something no
// agent connected in the last 4 hours has. Group seq → { it: its oldest such step, missing }. Needs you calls
// such a group stalled, and its line under Groups says Stuck (#214): one rule, so they never disagree.
export function stalledGroupsOf(hub, p, readyFree, { agents, t }) {
  const fitLately = agents.filter((a) => t - a.last_seen < 4 * HOUR).map((a) => json(a.has, []));
  const eff = hub.effectivePriorities(p);
  const stalled = new Map();
  for (const it of readyFree) {
    const missing = json(it.needs, []).filter((tag) => !fitLately.some((has) => has.includes(tag)));
    const e = eff.get(it.id);
    if (!missing.length || e?.priority !== 'now' || it.stage !== 'ready' || t - it.stage_since <= 4 * HOUR) continue;
    const group = e.from ?? it.seq;
    if (!stalled.has(group) || stalled.get(group).it.stage_since > it.stage_since) stalled.set(group, { it, missing });
  }
  return stalled;
}

// The project's groups (#200), for the 30-second view: each top-level item with children and open work, as
// one line: how far along it is, the priority it ranks at (#198), and whether it is moving, waiting on you,
// stuck (with the one reason) or queued for the next agent. Plus how many open items are in no group.
export function groupsOf(hub, p, items, { agents, openQs, t, stalled = new Map() }) {
  const kids = new Map();
  for (const i of items) if (i.parent_id) kids.set(i.parent_id, [...(kids.get(i.parent_id) ?? []), i]);
  const under = (i, seen = new Set([i.id])) => (kids.get(i.id) ?? []).filter((c) => !seen.has(c.id) && seen.add(c.id))
    .flatMap((c) => [c, ...under(c, seen)]);
  const open = (i) => !['done', 'dropped'].includes(i.stage);
  const ref = (i) => `#${i.seq}`;
  const eff = hub.effectivePriorities(p);
  const fitAgents = agents.filter((a) => t - a.last_seen < DAY).map((a) => json(a.has, []));
  const missingOf = (i) => json(i.needs, []).filter((tag) => !fitAgents.some((has) => has.includes(tag)));
  const shapeable = new Set(p.parked ? [] : hub.shapeable(p).map((i) => i.id));
  const groups = items.filter((g) => !g.parent_id && kids.has(g.id)).map((g) => {
    const all = under(g);
    const members = [g, ...all].filter(open);
    if (!members.length) return null;
    const e = eff.get(g.id) ?? { priority: g.priority, from: null };
    // The group itself is its last step (#270): done counts it only once closed, so an open one is never full.
    const parts = all.filter((i) => i.stage !== 'dropped'), partsDone = parts.filter((i) => i.stage === 'done').length;
    // Every part done: the reason says so, and that closing the group is what's left, before the usual one.
    const allIn = parts.length && partsDone === parts.length ? `All ${parts.length} parts done · closing ${ref(g)} itself is the last step · ` : '';
    const line = { item: ref(g), title: g.title, priority: g.priority, effective: e.priority, from: e.from ? `#${e.from}` : null,
      done: partsDone + (g.stage === 'done' ? 1 : 0), total: parts.length + 1, allIn };
    // What Needs you calls stalled is Stuck here too, for the same step and capability, whatever else moves:
    // by the step, so a "now" sub-group or a "now" dependent outside the group counts too (#266).
    const st = [...stalled.values()].filter((s) => members.some((i) => i.id === s.it.id))
      .sort((a, b) => a.it.stage_since - b.it.stage_since)[0];
    if (st) {
      return { ...line, state: 'stuck', reason: st.missing.some((tag) => OPERATOR_TAGS.includes(tag))
        ? `${ref(st.it)} needs an operator (${st.missing.join(', ')}); none has checked in for 4 hours`
        : `${ref(st.it)} needs ${st.missing.join(', ')}; no agent connected in 4 hours has it` };
    }
    const yours = members.filter((i) => waitsOnYou(p, i, openQs));
    if (yours.length) return { ...line, state: 'you', reason: `${yours.map(ref).join(', ')} ${yours.length === 1 ? 'waits' : 'wait'} on you` };
    const busy = members.filter((i) => i.holder || ['active', 'landing', 'verifying'].includes(i.stage));
    if (busy.length) {
      const who = [...new Set(busy.map((i) => i.holder).filter(Boolean))];
      return { ...line, state: 'moving', holders: who, reason: who.length ? `${who.join(', ')} on ${busy.filter((i) => i.holder).map(ref).join(', ')}` : `${busy.map(ref).join(', ')} being verified or landed` };
    }
    const ready = members.filter((i) => (i.stage === 'ready' && !i.holder && !hub.unmetDeps(i).length) || shapeable.has(i.id));
    const fit = ready.filter((i) => !missingOf(i).length);
    if (fit.length) return { ...line, state: 'queued', reason: `${fit.map(ref).join(', ')} ready for the next agent` };
    if (ready.length) {
      const it = ready[0], missing = missingOf(it);
      return { ...line, state: 'stuck', reason: missing.some((tag) => OPERATOR_TAGS.includes(tag))
        ? `${ref(it)} needs an operator (${missing.join(', ')}); none has checked in today`
        : `${ref(it)} needs ${missing.join(', ')}; no agent connected in the last day has it` };
    }
    // The rest waits (#746): on its own time (a day, a check that runs but isn't met yet, work that moves, an
    // operator who holds the question), or stuck until something changes. Stuck says what; waiting, until when.
    const w = pick(members.map((i) => waitOf(i, new Set(), { parts: false })));
    if (!w) return { ...line, state: 'stuck', reason: 'nothing in it can start' };
    return { ...line, state: w.state, reason: w.reason, ...(w.state === 'waiting' && w.until ? { until: w.until } : {}) };
  }).filter(Boolean).map(({ allIn, ...g }) => ({ ...g, reason: allIn + g.reason }));

  // The wait that speaks for several (#746): stuck first, then you, then work that can start or moves, then the
  // wait that ends soonest. null for none.
  function pick(waits) {
    const ws = waits.filter(Boolean), first = (s) => ws.find((x) => x.state === s);
    return first('stuck') ?? first('you') ?? first('queued') ?? first('moving')
      ?? ws.sort((a, b) => (a.until?.at ?? Infinity) - (b.until?.at ?? Infinity))[0] ?? null;
  }
  // What one open item waits on (#746): { state, reason, until? }; why is the reason without the item, so a
  // dependency's reads on ("#522 waits on #575, which waits until Nov 15"). null: nothing here decides it.
  // parts: false for a milestone's own members, whose parts are members too and speak for themselves.
  function waitOf(i, seen = new Set(), { parts: viaParts = true } = {}) {
    if (seen.has(i.id)) return { state: 'stuck', reason: `${ref(i)} waits on work that waits on it` };
    seen.add(i.id);
    const out = (state, why, until) => ({ state, why, reason: `${ref(i)} ${why}`, ...(until ? { until } : {}) });
    if (waitsOnYou(p, i, openQs)) return out('you', 'waits on you');
    if (i.holder) return out('moving', `is with ${i.holder}`);
    if (['active', 'landing', 'verifying'].includes(i.stage)) return out('moving', i.stage === 'active' ? 'is being built' : `is being ${i.stage === 'landing' ? 'landed' : 'verified'}`);
    // A milestone waits for its parts, and they speak for themselves; any other dependency is told through.
    const deps = i.stage === 'ready' ? hub.unmetDeps(i).filter((d) => d.parent_id !== i.id) : [];
    if (deps.length) {
      const ws = deps.map((d) => ({ d, w: waitOf(d, new Set(seen)) }));
      const dw = pick(ws.map((x) => x.w)) ?? { state: 'stuck', why: 'nothing in it can start' }, d = ws.find((x) => x.w === dw)?.d ?? deps[0];
      return out(dw.state === 'stuck' ? 'stuck' : dw.state === 'you' ? 'you' : 'waiting', `waits on ${ref(d)}, which ${dw.why}`, dw.until);
    }
    if ((i.stage === 'ready' && !hub.unmetDeps(i).length) || shapeable.has(i.id)) {
      const missing = missingOf(i);
      if (!missing.length) return out('queued', 'is ready for the next agent');
      return out('stuck', missing.some((tag) => OPERATOR_TAGS.includes(tag))
        ? `needs an operator (${missing.join(', ')}); none has checked in today`
        : `needs ${missing.join(', ')}; no agent connected in the last day has it`);
    }
    const q = i.stage === 'waiting' && openQs.find((x) => x.item_id === i.id && x.blocking && x.audience === 'operator');
    if (q) return out('waiting', q.held_by && q.held_until > t ? `waits for the operator (${q.held_by} has it)` : 'waits for an operator');
    if (i.stage === 'outside' && i.precondition) {
      const pre = json(i.precondition, {}), last = json(i.last_check, null);
      if (pre.kind === 'date') {
        const until = { item: ref(i), ...untilOf(pre) };
        return until.at <= t ? out('queued', `starts now: ${until.text} has come`) : out('waiting', `waits until ${until.text}`, until);
      }
      if ((last?.errors ?? 0) >= STUCK_ERRORS) return out('stuck', `can't be checked (${last.detail}): fix or clear its precondition, "${describePrecondition(pre)}"`);
      return out('waiting', `waits until ${describePrecondition(pre)}`);
    }
    // A milestone met as a dependency or a sub-milestone waits as its parts do.
    if (!viaParts) return null;
    const parts = (kids.get(i.id) ?? []).filter(open).map((k) => ({ k, w: waitOf(k, new Set(seen)) }));
    const kw = pick(parts.map((x) => x.w));
    return kw && out(kw.state, `waits on its part ${ref(parts.find((x) => x.w === kw).k)}, which ${kw.why}`, kw.until);
  }

  // Waiting milestones step out of the list (#746): they come back when their wait ends, soonest first.
  const waiting = groups.filter((x) => x.state === 'waiting')
    .sort((a, b) => (a.until?.at ?? Infinity) - (b.until?.at ?? Infinity) || a.item.slice(1) - b.item.slice(1));
  const shown = groups.filter((x) => x.state !== 'waiting');
  shown.sort((a, b) => PRIORITY_ORDER[a.effective] - PRIORITY_ORDER[b.effective] || GROUP_STATE[a.state] - GROUP_STATE[b.state] || a.item.slice(1) - b.item.slice(1));
  const ungrouped = items.filter((i) => open(i) && !i.parent_id && !kids.has(i.id)).length;
  return { groups: shown, groups_waiting: waiting, ungrouped };
}

// When a dated wait ends (#746): { at, text, time? }, a day as written ("Nov 15") or a time in UTC ("Nov 2, 20:50 UTC";
// the page shows it in the device's own zone, web/milestones.js).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function untilOf(pre) {
  const at = dateAt(pre), d = new Date(at), day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return { at, text: /T/.test(pre.after) ? `${day}, ${d.toISOString().slice(11, 16)} UTC` : day, ...(/T/.test(pre.after) ? { time: true } : {}) };
}
const PRIORITY_ORDER = { now: 0, soon: 1, later: 2 };

// A group's map (#200): the whole tree under an item, any depth, with what each item is doing, who holds it,
// what it waits on, its pull requests and open questions, and whether it waits on you.
function mapOf(hub, p, root) {
  const openQs = hub.q(`SELECT * FROM questions WHERE project_id = ? AND status = 'open' ORDER BY at`).all(p.id);
  const seen = new Set();
  const node = (i) => {
    seen.add(i.id);
    const kids = hub.q('SELECT * FROM items WHERE parent_id = ? ORDER BY seq').all(i.id).filter((c) => !seen.has(c.id));
    return {
      item: `#${i.seq}`, title: i.title, stage: i.stage, priority: i.priority, holder: i.holder || null,
      depends_on: hub.deps(i).map((d) => `#${d.seq}`),
      prs: prsOf(hub, p, i).map((pr) => ({ url: pr.url, number: pr.number, repo: pr.repo, state: pr.state, ci: pr.ci })),
      questions: openQs.filter((q) => q.item_id === i.id).map((q) => ({ id: q.id, question: q.question, blocking: !!q.blocking, to: q.audience || 'human' })),
      needs_you: waitsOnYou(p, i, openQs),
      children: kids.map(node),
    };
  };
  return node(root);
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
  const models = new Map(hub.q('SELECT name, model FROM agents WHERE project_id = ?').all(p.id).map((a) => [a.name, a.model])); // one load (#538)
  const modelOf = (agent) => (agent ? models.get(agent) || null : null);
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
  hub.reask(it); // kept waiting by "not yet" a day ago or more: ask again (#819)
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
  // A person's steering on it, and what agents and the hub told each other about it (#550): an operator's change of
  // course, a drop or move notice to whoever held it (sent to the holder, so it names the item rather than sits on it).
  const allSteers = hub.q(`SELECT * FROM notes WHERE kind = 'steer' AND (item_id = ? OR (project_id = ? AND item_id IS NULL AND notice = 1 AND body GLOB ?)) ORDER BY at`)
    .all(it.id, p.id, `#${it.seq} was *`);
  const steers = allSteers.filter((n) => isHuman(n.author) && !n.notice)
    .map((n) => ({ id: n.id, body: n.body, by: n.author, active: !!n.active, ago: dur(t - n.at), at: n.at, acks: hub.q('SELECT * FROM acks WHERE note_id = ?').all(n.id) }));
  const told = allSteers.filter((n) => !isHuman(n.author) || n.notice).map((n) => {
    const from = n.notice ? 'nuworq' : hub.q('SELECT role FROM agents WHERE project_id = ? AND name = ?').get(p.id, n.author)?.role === 'operator' ? 'Operator' : n.author;
    const retires = !n.active ? 'Retired.' : n.item_id ? `Retires when #${it.seq} lands.` : '';
    return { id: n.id, from, author: n.author, to: n.target || 'every agent', line: plainSteer(n.body), body: n.body, retires, at: n.at };
  });
  const agentNames = [...new Set(events.filter((e) => !isHuman(e.actor) && !isSystem(e.actor)).map((e) => e.actor))];
  const models = Object.fromEntries(agentNames.map((n) => [n, hub.q('SELECT model FROM agents WHERE project_id = ? AND name = ?').get(p.id, n)?.model ?? '']));
  const parent = hub.itemById(it.parent_id);
  return {
    item: `#${it.seq}`, title: it.title, summary: it.summary, detail: it.detail, acceptance: it.acceptance,
    breaking: it.breaking || null, // who must do what once it ships (#398)
    change: it.change || null, // feature, fix or internal, for the release's bump (#863)
    stage: it.stage, stage_label: STAGES[it.stage].label, stage_blurb: STAGES[it.stage].blurb, court: courtOf(it.stage, p.autonomy),
    priority: it.priority, effective_priority: hub.effectiveLabel(p, it) ?? null, needs: json(it.needs, []), size: it.size || null, repo: repoTag(hub.remotesOf(p), it),
    model_why: it.route_why || null, // which model routing picked for its job, and why (#349)
    created_by: it.created_by, created: dur(t - it.created_at), created_at: it.created_at, in_stage: dur(t - it.stage_since), stage_since: it.stage_since,
    holder: it.holder, lease_left: it.holder ? dur(it.lease_until - t) : null, lease_until: it.holder ? it.lease_until : null,
    race: it.race,
    ...(waitsForOk(p, it) ? { waits_for_ok: true } : {}), // a shaped proposal waits for a person's approval (#296)
    racers: it.race > 1 ? hub.attemptsOf(it).map((a) => ({ agent: a.agent, model: a.model, stage: a.stage, lease_left: a.lease_until ? dur(a.lease_until - t) : null, lease_until: a.lease_until || null })) : [],
    submissions: hub.submissions(it),
    implementer: it.implementer, last_worker: it.last_worker,
    attempts: it.attempts, stalls: it.stalls, rejections: it.rejections,
    handoff: json(it.handoff, null),
    parent: parent ? { item: `#${parent.seq}`, title: parent.title, stage: parent.stage } : null,
    children: hub.q('SELECT seq, title, stage FROM items WHERE parent_id = ? ORDER BY seq').all(it.id).map((c) => ({ item: `#${c.seq}`, title: c.title, stage: c.stage })),
    map: hub.q('SELECT 1 FROM items WHERE parent_id = ? LIMIT 1').get(it.id) ? mapOf(hub, p, it) : null, // a group's whole tree (#200)
    depends_on: hub.deps(it).map((d) => ({ item: `#${d.seq}`, title: d.title, stage: d.stage })),
    // Escapes (#176): the landed item this one repairs, and the later items that repair this one.
    fixes: (() => { const f = it.fixes && hub.itemById(it.fixes); return f ? { item: `#${f.seq}`, title: f.title } : null; })(),
    fixed_by: hub.q('SELECT seq, title, stage FROM items WHERE fixes = ? ORDER BY seq').all(it.id).map((f) => ({ item: `#${f.seq}`, title: f.title, stage: f.stage })),
    evidence: submit?.data?.evidence ?? [], git: submit?.data?.git ?? null, git_warning: gitWarning(submit?.data?.git), submission: submit ?? null,
    prs: prsOf(hub, p, it),
    questions, steers, told, lifecycle,
    // Why it keeps bouncing, in one line (#564), while it's open and outside landing: whether or not a person can help.
    bounce: OPEN_STAGES.includes(it.stage) && it.stage !== 'landing' && it.stalls + it.rejections >= 2
      ? bounceOf(hub, p, it, {
        agents: hub.q('SELECT * FROM agents WHERE project_id = ? ORDER BY last_seen DESC').all(p.id),
        openQs: hub.q(`SELECT * FROM questions WHERE project_id = ? AND status = 'open' ORDER BY at`).all(p.id),
        unmet: (i) => hub.unmetDeps(i), t,
      })?.line ?? null : null,
    court_totals: Object.fromEntries(Object.entries(courtTotals).map(([k, v]) => [k, dur(v)])),
    court_ms: courtTotals,
    agents: agentNames.map((n) => ({ name: n, model: models[n], provider: providerOf(models[n]) })),
    usage: hub.usageOf(it), // null: nothing recorded
    precondition: preconditionOut(it) ?? null,
    events,
  };
}
