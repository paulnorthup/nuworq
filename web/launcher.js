// The quick launcher (#290): ⌘K, then a number or a few letters to open any item, go anywhere, change a setting,
// act on what needs you, or create, without the mouse. Pure: app.js fetches the index once when it opens (GET
// /api/launcher), renders what this returns and runs what is picked; typing makes no request.
// Each command's `run` is data app.js carries out: { go: hash } | { action } | { zoom } | { open: { slug, item, focus } }
// | { human: op, slug, body, msg }. A command with `confirm` takes a second Enter, after that line is shown.

const LIMIT = 12; // a short ranked list (Hick's law): narrow it by typing, not by scrolling

// fzf-style matching: the query's letters must appear in order (spaces are free). A letter at a word start, right
// after the previous one, or early in the text scores higher. Returns the best score and the matched positions.
// Cheap before costly: a text whose letters aren't in order is out after one pass, and the table only spans, per
// query letter, from its earliest possible place (greedy from the left) to its latest (greedy from the right).
let buf = { size: 0 };
const grow = (size) => {
  if (size > buf.size) buf = { size, best: new Float64Array(size), carry: new Float64Array(size), from: new Int32Array(size), carryAt: new Int32Array(size) };
  return buf;
};
const wordy = (c) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57); // a-z 0-9, on lower-cased text
export function fuzzy(query, text) {
  const q = String(query).toLowerCase().replace(/\s+/g, ''), t = String(text ?? '').toLowerCase();
  if (!q) return { score: 0, hits: [] };
  const m = q.length, n = t.length;
  if (m > n) return null;
  const lo = new Int32Array(m), hi = new Int32Array(m);
  for (let j = 0, i = 0; j < m; j++, i++) {
    i = t.indexOf(q[j], i);
    if (i < 0) return null;
    lo[j] = i;
  }
  for (let j = m - 1, i = n - 1; j >= 0; j--, i--) hi[j] = i = t.lastIndexOf(q[j], i);
  const H = hi[m - 1];
  const bonus = (i) => 1 + (i === 0 || !wordy(t.charCodeAt(i - 1)) ? 8 : 0);
  // best[j][i]: q[0..j] matched with q[j] at i. carry[j][i]: the best of best[j][k≤i], less 1 per letter skipped since.
  // Row j is written over lo[j]..H and reads row j-1 over lo[j]-1..H-1, which that row wrote.
  const { best, carry, from, carryAt } = grow(m * n);
  for (let j = 0; j < m; j++) {
    const r = j * n, p = r - n, c = q[j];
    for (let i = lo[j]; i <= H; i++) {
      let b = -Infinity, f = -1;
      if (i <= hi[j] && t[i] === c) {
        if (j === 0) b = bonus(i) - Math.min(i, 20) * 0.2;
        else {
          const run = best[p + i - 1] + 6, gap = carry[p + i - 1];
          if (run >= gap) { b = bonus(i) + run; f = i - 1; } else { b = bonus(i) + gap; f = carryAt[p + i - 1]; }
        }
      }
      best[r + i] = b; from[r + i] = f;
      const prev = i > lo[j] ? carry[r + i - 1] - 1 : -Infinity;
      if (b >= prev) { carry[r + i] = b; carryAt[r + i] = i; } else { carry[r + i] = prev; carryAt[r + i] = carryAt[r + i - 1]; }
    }
  }
  const last = (m - 1) * n;
  let end = -1;
  for (let i = lo[m - 1]; i <= H; i++) if (best[last + i] > -Infinity && (end < 0 || best[last + i] > best[last + end])) end = i;
  if (end < 0) return null;
  const score = best[last + end], hits = new Array(m);
  for (let j = m - 1, i = end; j >= 0; i = from[j * n + i], j--) hits[j] = i;
  return { score, hits };
}

// The text with its matched letters in <mark>.
export function marked(text, hits, esc) {
  if (!hits?.length) return esc(text);
  const on = new Set(hits);
  return [...String(text)].map((c, i) => (on.has(i) ? `<mark>${esc(c)}</mark>` : esc(c))).join('');
}

const quote = (s) => `“${s.length > 60 ? `${s.slice(0, 60)}…` : s}”`;
const PRIORITIES = ['now', 'soon', 'later'];
const ZOOMS = ['30s', '5m', '30m'];

// Every command this viewer may run here, before any typing. ctx: { index, current (slug or null), view (the open
// project's view or null), zoom, role, billingOwner, theme (this browser's appearance) }. index.can is what the viewer's role may do (PERSON_CAN):
// nothing it doesn't allow is listed, and removing or deleting anything never is.
// The appearances a browser can choose (#485): web/app.js draws them as the rail's Appearance setting.
export const THEMES = [['device', 'Match device'], ['light', 'Light'], ['dark', 'Dark']];
export function commands({ index, current = null, view = null, zoom = '30s', role = 'owner', billingOwner = false, theme = 'device' }) {
  const can = new Set(index.can ?? []);
  const names = new Map((index.projects ?? []).map((p) => [p.slug, p.name]));
  const out = [];
  const go = (label, run, hint = 'Go to') => out.push({ kind: 'go', label, hint, run });
  // Go places
  for (const p of index.projects ?? []) go(p.name, { go: `#/p/${encodeURIComponent(p.slug)}` }, 'Project');
  go('All projects', { go: '#/' });
  if (role === 'owner') go('Analytics', { go: '#/analytics' });
  if (billingOwner) go('Workspace settings', { action: 'workspace-settings' });
  go('Notifications', { action: 'notify' });
  go('Connect an agent', { action: 'connect' });
  go('Keyboard shortcuts', { action: 'shortcuts' });
  // Change settings: depth anywhere; the open project's own settings, by role.
  const set = (label, confirm, run) => out.push({ kind: 'set', label, hint: 'Change', confirm, run });
  for (const k of ZOOMS) if (k !== zoom) set(`Depth ${k}`, `Depth: ${zoom} → ${k}. Only what you see changes.`, { zoom: k });
  // Appearance (#485): in this browser only.
  const now = THEMES.find(([k]) => k === theme)?.[1] ?? THEMES[0][1];
  for (const [k, label] of THEMES) if (k !== theme) set(`Appearance: ${label}`, `Appearance: ${now} → ${label}, in this browser only.`, { theme: k });
  const P = view?.project;
  if (P && current === P.slug) {
    const h = (body, msg) => ({ human: 'settings', slug: P.slug, body, msg });
    if (can.has('settings')) {
      for (const [k, o] of Object.entries(P.autonomy_options ?? {})) {
        if (k === P.autonomy) continue;
        set(`Autonomy: ${o.label}`, `Autonomy on ${P.name}: ${P.autonomy_options[P.autonomy]?.label ?? P.autonomy} → ${o.label}. Agents are told.`, h({ autonomy: k }, 'Autonomy changed; agents have been told'));
      }
      if (P.parked) set(`Unpark ${P.name}`, `Unpark ${P.name}: work starts again, and it can ask for you.`, h({ parked: false }, 'Unparked'));
      else set(`Park ${P.name}`, `Park ${P.name}: no new work starts and nothing here asks for you until you unpark it.`, h({ parked: true }, 'Parked'));
      if (P.runner) set('Staffing off', `Staffing off on ${P.name}: nuworq run starts no new workers here; running ones finish.`, h({ runner: false }, '`nuworq run` will no longer start workers here'));
      else set('Staffing on', `Staffing on for ${P.name}: nuworq run starts headless workers whenever work is waiting. They can cost money.`, h({ runner: true }, '`nuworq run` may now start workers here'));
    }
    if (can.has('update')) {
      for (const g of view.groups ?? []) {
        for (const pr of PRIORITIES) {
          if (pr === g.priority) continue;
          set(`${g.item} ${g.title}: priority ${pr}`, `${g.item} priority: ${g.priority} → ${pr}. Everything in the milestone ranks at least ${pr}.`,
            { human: 'update', slug: P.slug, body: { item: g.item, priority: pr }, msg: `${g.item} is ${pr}` });
        }
      }
    }
  }
  // Act on Needs you: a one-step action takes a second Enter; one that needs words opens the item at its text box.
  for (const a of index.needs ?? []) {
    const where = a.project && a.project !== current ? ` · ${names.get(a.project) ?? a.project}` : '';
    const need = (label, run, confirm) => out.push({ kind: 'needs', label, hint: `Needs you${where}`, run, confirm, needs: a.key });
    const open = (focus) => ({ open: { slug: a.project, item: a.item, focus } });
    const pname = names.get(a.project) ?? a.project;
    if (a.kind === 'review' && a.item) {
      if (can.has('accept')) need(`Accept ${a.item}: ${a.headline}`, { human: 'accept', slug: a.project, body: { item: a.item }, msg: `Accepted ${a.item}` }, `Accept ${a.item} in ${pname}: it is done once it lands on main.`);
      if (can.has('sendback')) need(`Send ${a.item} back: ${a.headline}`, open('sendback'));
      if (!can.has('accept')) need(`Open ${a.item}: ${a.headline}`, open());
    } else if (a.kind === 'proposal' && a.item && can.has('update')) {
      need(`Approve ${a.item}: ${a.headline}`, { human: 'update', slug: a.project, body: { item: a.item, stage: 'ready' }, msg: 'Approved: ready for any agent' }, `Approve ${a.item} in ${pname}: it becomes ready for any agent, as written.`);
    } else if (a.kind === 'question' && a.question && a.item && can.has('answer')) {
      need(`Answer ${a.item}: ${a.headline}`, open(`ans-${a.question}`));
    } else if (a.item && a.project) {
      need(`Open ${a.item}: ${a.headline}`, open());
    } else if (a.project) {
      need(a.headline, { go: `#/p/${encodeURIComponent(a.project)}` });
    }
  }
  return out;
}

// What typing makes of it: create commands, only for the open project, only with text, and always last.
function creates(text, { current, index, can }) {
  if (!text || !current) return [];
  const name = (index.projects ?? []).find((p) => p.slug === current)?.name ?? current;
  const out = [];
  if (can.has('create')) out.push({ kind: 'create', label: `Propose ${quote(text)}`, hint: `New in ${name}`, confirm: `New proposal in ${name}: ${quote(text)}. An agent shapes it into work.`,
    run: { human: 'create', slug: current, body: { title: text, stage: 'proposed' }, msg: 'Proposed: an agent shapes it next' } });
  if (can.has('steer')) out.push({ kind: 'create', label: `Tell ${name}'s agents ${quote(text)}`, hint: 'Steer', confirm: `Steer every agent on ${name}: ${quote(text)}. Each must acknowledge it.`,
    run: { human: 'steer', slug: current, body: { body: text }, msg: 'Steer sent: agents will acknowledge it' } });
  return out;
}

// The ranked results for a query. Items: an exact number first (the open project's, then each other project's),
// then title matches, the open project's ahead of the rest; on All projects (no current) every project ranks
// equally. With nothing typed: what needs you, then recently opened items. recent: [{ p, n }], newest first.
export function rank(index, query, ctx = {}) {
  const { current = null, recent = [], limit = LIMIT } = ctx;
  const can = new Set(index.can ?? []);
  const cmds = commands({ ...ctx, index });
  const q = String(query ?? '').trim();
  const name = (slug) => (index.projects ?? []).find((p) => p.slug === slug)?.name ?? slug;
  const item = (i, hits = []) => ({ kind: 'item', label: i.t, hits, ref: `#${i.n}`, slug: i.p, stage: i.s, project: i.p === current ? null : name(i.p),
    run: { open: { slug: i.p, item: `#${i.n}` } } });
  if (!q) {
    const byKey = new Map((index.items ?? []).map((i) => [`${i.p}#${i.n}`, i]));
    const recents = recent.map((r) => byKey.get(`${r.p}#${r.n}`)).filter(Boolean).map((i) => ({ ...item(i), hint: 'Recent' }));
    return [...cmds.filter((c) => c.kind === 'needs'), ...recents].slice(0, limit);
  }
  const num = q.match(/^#?(\d+)$/)?.[1];
  const scored = [];
  for (const i of index.items ?? []) {
    const here = !current || i.p === current;
    if (num && i.n === Number(num)) { scored.push({ r: item(i), tier: here ? 0 : 1, score: 0 }); continue; }
    const f = fuzzy(q, i.t);
    if (f) scored.push({ r: item(i, f.hits), tier: here ? 2 : 3, score: f.score });
  }
  for (const c of cmds) {
    const f = fuzzy(q, c.label);
    if (f) scored.push({ r: { ...c, hits: f.hits }, tier: 2, score: f.score });
  }
  scored.sort((a, b) => a.tier - b.tier || b.score - a.score);
  const made = num ? [] : creates(q, { current, index, can }); // a number is looking something up, not writing
  return [...scored.slice(0, limit - made.length).map((s) => s.r), ...made];
}

// The launcher's list: one row per result, the selected one marked; an item shows its stage as its pill.
export function resultsHtml(results, { sel = 0, stages = {}, esc }) {
  if (!results.length) return '<div class="ln-empty">Nothing matches. Try a number, or fewer letters.</div>';
  const pill = (s) => `<span class="stage-pill ${s === 'done' ? 'done' : `court-${stages[s]?.court ?? ''}`}">${esc(stages[s]?.label ?? s)}</span>`;
  return results.map((r, i) => `<button class="ln-row${i === sel ? ' on' : ''}" role="option" aria-selected="${i === sel}" data-ln="${i}">
    ${r.kind === 'item'
      ? `<span class="ln-ref">${esc(r.ref)}</span><span class="ln-label">${marked(r.label, r.hits, esc)}</span>${r.project ? `<span class="ln-hint">${esc(r.project)}</span>` : r.hint ? `<span class="ln-hint">${esc(r.hint)}</span>` : ''}${pill(r.stage)}`
      : `<span class="ln-label">${marked(r.label, r.hits, esc)}</span><span class="ln-hint">${esc(r.hint ?? '')}</span>`}
  </button>`).join('');
}

// The second Enter: what will change and what follows, in place of the list.
export const confirmHtml = (r, { esc }) => `<div class="ln-confirm" role="alert"><p>${esc(r.confirm)}</p>
  <div class="ln-keys"><button class="btn primary small" data-ln-apply>Apply <kbd>Enter</kbd></button><button class="btn ghost small" data-ln-back>Back <kbd>Esc</kbd></button></div></div>`;
