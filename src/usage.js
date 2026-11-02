// Tokens and cost per item. Agents may report usage on progress/submit/handoff; workers started by
// `nuworq worker --run` / `nuworq run` have it read from their CLI's own JSON output (a tap), and
// the runner posts it when the agent exits. Write-mostly: nothing here sits on a hot path.

import { UserError } from './core.js'; // used only at call time, so the import cycle is harmless

const count = (v, what) => {
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new UserError(`usage.${what} must be a number ≥ 0, got "${v}"`, { hint: 'e.g. usage: { input_tokens: 12000, output_tokens: 3400, cost_usd: 0.21, model: "claude-opus-5-5" }' });
  return n;
};

// Forgiving: camelCase or snake_case, strings for numbers. Cost null means unknown (a local model), not free.
// Returns null for no usage at all.
export function normUsage(u) {
  if (u == null || u === '') return null;
  if (typeof u === 'string') { try { u = JSON.parse(u); } catch { throw new UserError('usage must be an object', { hint: 'e.g. usage: { input_tokens: 12000, output_tokens: 3400, cost_usd: 0.21 }' }); } }
  if (typeof u !== 'object' || Array.isArray(u)) throw new UserError('usage must be an object', { hint: 'e.g. usage: { input_tokens: 12000, output_tokens: 3400, cost_usd: 0.21 }' });
  const input = Math.round(count(u.input_tokens ?? u.inputTokens ?? u.input, 'input_tokens'));
  const output = Math.round(count(u.output_tokens ?? u.outputTokens ?? u.output, 'output_tokens'));
  const rawCost = u.cost_usd ?? u.costUsd ?? u.cost;
  const cost = rawCost == null || rawCost === '' ? null : count(rawCost, 'cost_usd');
  const model = String(u.model ?? '').trim().slice(0, 100);
  if (!input && !output && cost == null) return null;
  // estimated: priced by nuworq from the run's tokens, not by its CLI (#761).
  return { input_tokens: input, output_tokens: output, cost_usd: cost, model, ...(u.estimated === true || u.estimated === 'true' ? { estimated: true } : {}) };
}

// Split one run's usage across the items it worked on, by weight (time held). Integer tokens; the
// last share takes the rounding remainder so the totals stay exact.
export function split(u, weights) {
  const total = weights.reduce((a, w) => a + w, 0);
  let inLeft = u.input_tokens, outLeft = u.output_tokens, costLeft = u.cost_usd;
  return weights.map((w, k) => {
    const share = total ? w / total : 1 / weights.length;
    if (k === weights.length - 1) return { ...u, input_tokens: inLeft, output_tokens: outLeft, cost_usd: costLeft };
    const part = { ...u, input_tokens: Math.round(u.input_tokens * share), output_tokens: Math.round(u.output_tokens * share), cost_usd: u.cost_usd == null ? null : u.cost_usd * share };
    inLeft -= part.input_tokens; outLeft -= part.output_tokens;
    if (costLeft != null) costLeft -= part.cost_usd;
    return part;
  });
}

// Reading usage from an agent CLI's JSON output, line by line. Each line returns the text worth showing
// a person (the log stays readable), or null to show nothing; usage() is what the run cost so far.
// Which CLIs: claude (-p --output-format stream-json --verbose: the final `result` event has
// total_cost_usd and usage; `system/init` names the model), codex (exec --json: `turn.completed`
// carries token counts, no cost), opencode (run --format json: `step_finish` parts carry tokens and cost),
// pi (-p --mode json: an assistant `message_end` carries its usage, cost.total among it).
// While it runs (#761), claude's spend so far is estimated from each assistant message's usage and the model's
// price, so a runaway run can be stopped and counted before it exits; its `result` replaces the estimate. A run
// killed before its `result` keeps the estimate, marked estimated: true. Codex is priced from the same table.
export function tap(agent, { model = '' } = {}) {
  let input = 0, output = 0, cost = null, seen = false, name = model, estimated = false;
  const add = (i, o, c) => { seen = true; input += Number(i) || 0; output += Number(o) || 0; if (c != null && Number.isFinite(Number(c))) cost = (cost ?? 0) + Number(c); };
  const text = (blocks) => (Array.isArray(blocks) ? blocks.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n') : '') || null;
  // claude's messages so far, by id: stream-json repeats a message's usage on each of its content blocks.
  const messages = new Map();
  let finished = false;
  const estimate = () => {
    if (finished || !messages.size) return;
    const t = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    for (const u of messages.values()) {
      t.input += Number(u.input_tokens) || 0; t.output += Number(u.output_tokens) || 0;
      t.cache_read += Number(u.cache_read_input_tokens) || 0; t.cache_write += Number(u.cache_creation_input_tokens) || 0;
    }
    seen = true; estimated = true;
    input = t.input + t.cache_read + t.cache_write; output = t.output;
    cost = priceOf(name, t);
  };
  const parsers = {
    claude(e) {
      if (e.type === 'system' && e.subtype === 'init') { name ||= e.model ?? ''; return null; }
      if (e.type === 'assistant') {
        const m = e.message ?? {};
        if (m.usage) { messages.set(m.id ?? messages.size, m.usage); name ||= m.model ?? ''; estimate(); }
        return text(m.content);
      }
      if (e.type === 'result') {
        finished = true; estimated = false; input = 0; output = 0; cost = null;
        const u = e.usage ?? {};
        // Cached input is still input the model read: count it, so tokens match the bill.
        add((u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), u.output_tokens, e.total_cost_usd);
        if (!name && e.modelUsage) name = Object.keys(e.modelUsage)[0] ?? '';
        return null;
      }
      return null;
    },
    codex(e) {
      if (e.type === 'turn.completed') {
        // Its input_tokens include the cached ones.
        const u = e.usage ?? {};
        const cached = Number(u.cached_input_tokens) || 0;
        add(u.input_tokens, u.output_tokens, priceOf(name, { input: Math.max((Number(u.input_tokens) || 0) - cached, 0), cache_read: cached, output: Number(u.output_tokens) || 0 }));
        return null;
      }
      if (e.type === 'item.completed' && e.item?.type === 'agent_message') return e.item.text ?? null;
      return null;
    },
    opencode(e) {
      if (e.type === 'step_finish') {
        const t = e.part?.tokens ?? {};
        add((t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0), (t.output ?? 0) + (t.reasoning ?? 0), e.part?.cost);
        return null;
      }
      if (e.type === 'text') return e.part?.text ?? null;
      return null;
    },
    // pi -p --mode json: each assistant message's message_end carries that call's usage, priced from pi's catalog.
    pi(e) {
      if (e.type !== 'message_end' || e.message?.role !== 'assistant') return null;
      const u = e.message.usage ?? {};
      add((u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), u.output, u.cost?.total);
      if (!name && e.message.provider && e.message.model) name = `${e.message.provider}/${e.message.model}`;
      return text(e.message.content);
    },
  };
  const parse = parsers[agent];
  return {
    line(l) {
      if (!parse) return l;
      let e;
      try { e = JSON.parse(l); } catch { return l; } // not JSON: a warning or the shell's own output
      if (!e || typeof e !== 'object') return l;
      return parse(e);
    },
    // Local models (Ollama) report tokens but cost nothing anyone pays: cost unknown, shown as "—".
    // Through llm-proxy (proxy/<model>) the CLI can't price the model; the hub measures it there (#76).
    usage() {
      if (!seen) return null;
      const unpriced = /^(ollama|proxy)\//.test(name);
      return { input_tokens: input, output_tokens: output, cost_usd: unpriced ? null : cost, model: name.replace(/^(ollama|proxy)\//, ''), ...(estimated ? { estimated: true } : {}) };
    },
    // Dollars so far, for the runner's caps: 0 while unknown.
    spent() { return /^(ollama|proxy)\//.test(name) ? 0 : cost ?? 0; },
  };
}

// Dollars per million tokens, for a run its CLI didn't price (#761): a claude run killed before its `result`, and
// codex, which reports tokens only. First match wins; cache reads cost a tenth of input, cache writes 1.25×.
// A model not here is unpriced (cost null), never $0.
const PRICES = [
  [/opus-4(-[01])?(-\d{8})?$|claude-3-opus/, 15, 75], // Opus 4 and 4.1; later ones cost less
  [/opus/, 5, 25],
  [/sonnet/, 3, 15],
  [/haiku-3-5|3-5-haiku/, 0.8, 4],
  [/haiku/, 1, 5],
  [/^gpt-5(\.\d+)?-mini/, 0.25, 2],
  [/^gpt-5(\.\d+)?-nano/, 0.05, 0.4],
  [/^gpt-5(\.\d+)?(-codex)?$|^gpt-5(\.\d+)?-codex/, 1.25, 10],
  [/^codex-mini/, 1.5, 6],
];
// tokens: { input, output, cache_read, cache_write }. null when the model has no price here.
export function priceOf(model, { input = 0, output = 0, cache_read = 0, cache_write = 0 } = {}) {
  const m = String(model ?? '').toLowerCase().replace(/^(anthropic|openai)\//, '');
  const row = m && PRICES.find(([re]) => re.test(m));
  if (!row) return null;
  const [, i, o] = row;
  return (input * i + cache_read * i * 0.1 + cache_write * i * 1.25 + output * o) / 1e6;
}

// A stream splitter for tap(): feed chunks, get whole lines.
export function lines(onLine) {
  let buf = '';
  return {
    write(chunk) {
      buf += chunk;
      let k;
      while ((k = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, k)); buf = buf.slice(k + 1); }
    },
    end() { if (buf) onLine(buf); buf = ''; },
  };
}
