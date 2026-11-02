// What a person's action will do, shown the moment they tap (#393). predict() takes what's on screen (a project's
// view, the home, or an open item) and returns it as it will be once the hub agrees, or null when the result isn't
// one we can know ahead. The hub's own answer then replaces it; a refusal puts back what was there. Pure, so the
// page and the tests share it.

// Where content is on its way: quiet blocks about the size of what comes, never a loading line.
export const placeholder = (rows = 3, { head = true } = {}) =>
  `<div class="ph-block" aria-busy="true" aria-label="Loading">${head ? '<span class="ph h"></span><span class="ph s"></span><span class="ph xs"></span>' : ''}${'<span class="ph ph-row"></span>'.repeat(rows)}</div>`;

const SETTINGS =['autonomy', 'parked', 'runner', 'fresh', 'releases'];
const MESSAGE = { steer: ['steer', 'You steered'], comment: ['comment', 'You noted'], decide: ['decision', 'Decision'] };

// Every object in it that stands for the item ref (lanes, groups, the all-work table, the open item).
function eachItem(v, ref, fn) {
  const seen = new Set();
  (function walk(o) {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    if (!Array.isArray(o) && o.item === ref) fn(o);
    for (const k of Object.keys(o)) walk(o[k]);
  })(v);
}
// The cards that ask for something: a project's attention, or the home's needs.
const cards = (v, keep) => {
  for (const k of ['attention', 'needs']) if (Array.isArray(v[k])) v[k] = v[k].filter((a) => !keep || keep(a));
};
const dropCards = (v, gone) => cards(v, (a) => !gone(a));

export function predict(view, action, body = {}, { now = Date.now() } = {}) {
  if (!view) return null;
  const v = structuredClone(view);
  switch (action) {
    case 'seen': {
      if (!v.since) return null;
      const counts = Object.fromEntries(Object.keys(v.since.counts ?? {}).map((k) => [k, 0]));
      v.since = { ...v.since, at: now, ago: '0s', counts, finished: [] };
      if (v.project) v.project.seen_at = now;
      return v;
    }
    case 'settings': {
      const keys = SETTINGS.filter((k) => k in body);
      if (!keys.length || !v.project) return null;
      for (const k of keys) v.project[k] = body[k];
      if ('autonomy' in body) v.project.autonomy_label = v.project.autonomy_options?.[body.autonomy]?.label ?? v.project.autonomy_label;
      return v;
    }
    case 'accept': {
      if (body.attempt) return null; // a raced item: which attempt lands is the hub's to say
      dropCards(v, (a) => a.kind === 'review' && a.item === body.item);
      if (Array.isArray(v.verifying)) v.verifying = v.verifying.filter((i) => i.item !== body.item);
      eachItem(v, body.item, (o) => { if ('stage' in o) o.stage = 'landing'; });
      return v;
    }
    case 'update': {
      const set = Object.fromEntries(['priority', 'stage'].filter((k) => typeof body[k] === 'string').map((k) => [k, body[k]]));
      if (!Object.keys(set).length || Object.keys(body).some((k) => !['item', 'priority', 'stage'].includes(k))) return null;
      eachItem(v, body.item, (o) => { for (const k of Object.keys(set)) if (k in o) o[k] = set[k]; });
      if (set.stage) dropCards(v, (a) => a.item === body.item && ['proposal', 'unfit'].includes(a.kind));
      return v;
    }
    case 'step': {
      let hit = false;
      for (const k of ['attention', 'needs']) for (const a of v[k] ?? []) {
        if (a.question?.id !== body.question) continue;
        const ticked = new Set(a.ticked ?? []);
        if (body.done) ticked.add(body.step); else ticked.delete(body.step);
        a.ticked = [...ticked].sort((x, y) => x - y);
        hit = true;
      }
      return hit ? v : null;
    }
    case 'answer': dropCards(v, (a) => a.question?.id === body.question); return v;
    case 'confirm': dropCards(v, (a) => a.question?.id === body.question); return v;
    case 'dismiss': dropCards(v, (a) => a.key === body.key); return v;
    case 'unpark': dropCards(v, (a) => a.kind === 'kept-parked' && a.item === body.item); return v;
    case 'steer': case 'comment': case 'decide': {
      // Below 30m a project's view has no activity (#501), but a decision still shows at 5m.
      if (!Array.isArray(v.activity) && !(action === 'decide' && Array.isArray(v.decisions))) return null;
      const [type, said] = MESSAGE[action];
      v.activity?.unshift({ id: `sending-${now}`, type, actor: 'you', item: body.item ?? null, headline: `${said}: ${body.body}`, summary: '', ago: 'now', sending: true });
      if (action === 'decide' && Array.isArray(v.decisions)) v.decisions.unshift({ id: `sending-${now}`, body: body.body, ago: 'now' });
      return v;
    }
    default: return null;
  }
}
