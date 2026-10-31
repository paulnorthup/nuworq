// Which model a job runs on (#347): a project's model tiers per agent, cheapest first. Rote jobs (landing, tidying)
// start on the lowest tier; building starts on the top one until there is data that says otherwise (#344);
// reviews (the quality gate) and shaping (judgment) always use the top one. Each failed attempt on an item
// (sent back, stalled, handed off, lease lost) steps its next attempt up one tier. A share of building jobs tries
// a cheaper model (trials, #348), so there is data to go on.

export const AGENTS = ['claude', 'codex', 'opencode'];
export const ROTE = ['land', 'tidy'];
const MAX_TIERS = 6;

// How hard an item is (#348), rated when it's shaped: unrated counts as standard.
export const DIFFICULTIES = ['rote', 'standard', 'hard'];
export const difficultyOf = (item) => item?.difficulty || 'standard';

// tiers: { claude: [...] } as set; top: the runner's --model, the one tier when none are set. null: no say.
// down: tiers below where the job would start, for a trial on a cheaper model (#348).
export function modelFor(tiers, agent, mode, up = 0, top = '', down = 0) {
  const list = tiers?.[agent]?.length ? tiers[agent] : top ? [top] : [];
  if (!list.length) return null;
  const last = list.length - 1;
  return list[Math.max(0, Math.min((ROTE.includes(mode) ? 0 : last) + up - down, last))];
}

// The model at start in list, up tiers for failed attempts and down for a trial, kept within the list.
export const modelAt = (list, start, up = 0, down = 0) => list[Math.max(0, Math.min(start + up - down, list.length - 1))];

// ── Routing by results (#349) ──
// The project's quality bar: how far below the best model's clean rate, in its cell (job and difficulty), a cheaper
// model may be and still take the job. A model counts in a cell from MIN_ATTEMPTS finished attempts there.
export const QUALITY = {
  best: { label: 'Best quality', bar: 0, means: 'only a model that does as well as the best' },
  balanced: { label: 'Balanced', bar: 0.05, means: 'a cheaper model within 5 points of the best' },
  cheapest: { label: 'Cheapest that passes', bar: 0.15, means: 'the cheapest model within 15 points of the best' },
};
export const MIN_ATTEMPTS = 20;
const JOB_WORDS = { work: 'builds', land: 'landings', tidy: 'tidy jobs', review: 'reviews', shape: 'shapings' };
const pct = (r) => `${Math.round(r * 100)}%`;

// The models a job may run on, cheapest first: local (open-weight) ones count as cheapest (they cost nothing per
// token), but only while llm-proxy says they are ready, and never on hard items. local(m), ready(m): predicates.
export function candidates(list, { difficulty = 'standard', local = () => false, ready = () => false } = {}) {
  const ok = (m) => !local(m) || (difficulty !== 'hard' && ready(m));
  return [...list.filter((m) => local(m)), ...list.filter((m) => !local(m))].filter(ok);
}

// Where a job starts in its list (cheapest first), and why, in one line. stats: { [model]: { attempts, clean } }
// for the job's cell. Reviews and shaping stay on the top tier (the quality gate, and judgment). Elsewhere: the
// cheapest model whose clean rate is within the bar of the best measured one's, once the top tier and it each have
// MIN_ATTEMPTS there; until then, the job's default start (building on the top tier, rote jobs on the cheapest).
export function pickModel(list, { mode, difficulty = 'standard', stats = {}, quality = 'balanced' } = {}) {
  const last = list.length - 1;
  if (last < 0) return null;
  const top = list[last];
  const what = `${difficulty} ${JOB_WORDS[mode] ?? 'jobs'}`;
  if (mode === 'review' || mode === 'shape') return { start: last, why: `${top}: ${JOB_WORDS[mode]} always run on the top tier` };
  const rate = (m) => stats[m]?.clean / stats[m]?.attempts;
  const measured = list.filter((m) => (stats[m]?.attempts ?? 0) >= MIN_ATTEMPTS);
  const fallback = ROTE.includes(mode) ? 0 : last;
  if (!measured.includes(top)) {
    const short = MIN_ATTEMPTS - (stats[top]?.attempts ?? 0);
    return {
      start: fallback,
      why: ROTE.includes(mode) ? `${list[fallback]}: rote jobs start on the cheapest tier until ${top} has ${MIN_ATTEMPTS} finished ${what} to compare against (${short} to go)`
        : `${top}: the top tier, until it has ${MIN_ATTEMPTS} finished ${what} to compare cheaper models against (${short} to go)`,
    };
  }
  const best = measured.reduce((a, m) => (rate(m) > rate(a) ? m : a));
  const bar = (QUALITY[quality] ?? QUALITY.balanced).bar;
  const pick = measured.find((m) => rate(m) >= rate(best) - bar - 1e-9) ?? best;
  const n = (m) => `${pct(rate(m))} of ${stats[m].attempts} ${what} landed clean`;
  return {
    start: list.indexOf(pick),
    why: pick === best ? `${pick}: ${n(pick)}, the best measured` : `${pick}: ${n(pick)}, vs ${best} ${pct(rate(best))}`,
  };
}

// Trials (#348): a share of eligible building jobs runs one tier down, or races a cheaper model against the top
// tier, so nuworq learns what each model can do. Eligible: rated rote or standard, not "now", not operator-only,
// and the project hasn't spent its daily budget. Shares are whole percents.
export function trialEligible(item, { priority, operatorOnly = false, overBudget = false } = {}) {
  return difficultyOf(item) !== 'hard' && priority !== 'now' && !operatorOnly && !overBudget;
}

// The trial the next eligible item gets, given the decisions so far ({ down, race, none } counts): a race while
// races are under their share, else one tier down while those are, else none. Counting, not chance, so the
// shares hold exactly however few items there are.
export function nextTrial({ down = 0, race = 0, none = 0 } = {}, { down: downPct = 10, race: racePct = 0 } = {}) {
  const n = down + race + none + 1;
  if (race + 1 <= (racePct / 100) * n + 1e-9) return 'race';
  if (down + 1 <= (downPct / 100) * n + 1e-9) return 'down';
  return 'none';
}

// A share as set: a whole percent from 0 to 100. Throws a message on anything else.
export function parseShare(v, name) {
  const n = Number(v);
  if (v === '' || v == null || !Number.isInteger(n) || n < 0 || n > 100) throw new Error(`${name} is a whole percent from 0 to 100`);
  return n;
}

// The job a worker takes an item at its stage for.
export const modeAt = (item) => ({ landing: 'land', verifying: 'review', proposed: 'shape' }[item.stage] ?? (item.tidy ? 'tidy' : 'work'));

// What a person typed, made into { agent: [model, ...] }: an object of arrays, or of comma-separated text.
// An agent left blank goes back to the runner's --model. Throws a message on anything else.
export function parseTiers(v) {
  const given = typeof v === 'string' ? JSON.parse(v || '{}') : v ?? {};
  if (typeof given !== 'object' || Array.isArray(given)) throw new Error('model_tiers is per agent, e.g. { "claude": ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"] }');
  const out = {};
  for (const [agent, raw] of Object.entries(given)) {
    if (!AGENTS.includes(agent)) throw new Error(`model_tiers has no agent "${agent}": use ${AGENTS.join(', ')}`);
    const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(',')).map((m) => String(m).trim()).filter(Boolean);
    if (list.some((m) => !/^[\w.:/@-]+$/.test(m))) throw new Error(`model_tiers.${agent}: a model id is letters, digits and . : / @ - _, e.g. claude-haiku-5-5`);
    if (list.length > MAX_TIERS) throw new Error(`model_tiers.${agent}: at most ${MAX_TIERS} tiers`);
    if (list.length) out[agent] = list;
  }
  return out;
}
