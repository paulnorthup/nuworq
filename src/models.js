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
