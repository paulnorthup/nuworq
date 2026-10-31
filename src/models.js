// Which model a job runs on (#347): a project's model tiers per agent, cheapest first. Rote jobs (landing, tidying)
// start on the lowest tier; building starts on the top one until there is data that says otherwise (#344);
// reviews (the quality gate) and shaping (judgment) always use the top one. Each failed attempt on an item
// (sent back, stalled, handed off, lease lost) steps its next attempt up one tier.

export const AGENTS = ['claude', 'codex', 'opencode'];
export const ROTE = ['land', 'tidy'];
const MAX_TIERS = 6;

// tiers: { claude: [...] } as set; top: the runner's --model, the one tier when none are set. null: no say.
export function modelFor(tiers, agent, mode, up = 0, top = '') {
  const list = tiers?.[agent]?.length ? tiers[agent] : top ? [top] : [];
  if (!list.length) return null;
  const last = list.length - 1;
  return list[Math.min((ROTE.includes(mode) ? 0 : last) + up, last)];
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
