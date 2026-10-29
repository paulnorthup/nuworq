// What finished work came to, for other tools to read (GET /api/p/<project>/outcomes; documented in
// docs/API.md, which is the contract). Built only from what the hub already records.
const DAY = 24 * 60 * 60 * 1000;
export const OUTCOMES_VERSION = 1;

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

// since/until: ms, the window an item must have finished (done or dropped) in. Default: the last 30 days.
export function outcomes(hub, slug, { since, until } = {}) {
  const p = hub.project(slug);
  const to = Number.isFinite(Number(until)) && until !== '' && until != null ? Number(until) : hub.now();
  const from = Number.isFinite(Number(since)) && since !== '' && since != null ? Number(since) : to - 30 * DAY;
  const finished = hub.q(`SELECT * FROM items WHERE project_id = ? AND stage IN ('done', 'dropped') AND stage_since >= ? AND stage_since <= ?
    ORDER BY stage_since, seq`).all(p.id, from, to);
  const modelOf = (agent) => (agent ? hub.q('SELECT model FROM agents WHERE project_id = ? AND name = ?').get(p.id, agent)?.model || null : null);
  const items = finished.map((it) => {
    const claimed = hub.q(`SELECT MIN(at) AS at FROM events WHERE item_id = ? AND type = 'claimed'`).get(it.id).at;
    const usage = (hub.usageOf(it)?.rows ?? []).filter((r) => !r.superseded)
      .map((r) => ({ agent: r.agent, model: r.model, source: r.source, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cost_usd: r.cost_usd }));
    return {
      item: `#${it.seq}`, title: it.title, size: it.size || null, repo: hub.repoOf(p, it) || null,
      outcome: it.stage === 'done' ? 'landed' : 'dropped',
      done_at: it.stage_since,
      cycle_ms: claimed != null ? it.stage_since - claimed : null,
      sent_back: it.rejections, stalls: it.stalls, attempts: it.attempts,
      implementer: it.implementer || null, model: modelOf(it.implementer),
      usage,
    };
  });
  const groups = new Map();
  for (const i of items) {
    const k = i.model ?? '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  const by_model = [...groups].map(([model, list]) => {
    const rows = list.flatMap((i) => i.usage);
    const sum = (key) => rows.reduce((a, r) => a + (r[key] ?? 0), 0);
    return {
      model: model || null,
      landed: list.filter((i) => i.outcome === 'landed').length,
      dropped: list.filter((i) => i.outcome === 'dropped').length,
      sent_back: list.reduce((a, i) => a + i.sent_back, 0),
      stalls: list.reduce((a, i) => a + i.stalls, 0),
      median_cycle_ms: median(list.filter((i) => i.outcome === 'landed').map((i) => i.cycle_ms)),
      input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'),
      cost_usd: rows.length && rows.every((r) => r.cost_usd != null) ? sum('cost_usd') : null,
    };
  });
  return { version: OUTCOMES_VERSION, project: p.slug, since: from, until: to, items, by_model };
}
