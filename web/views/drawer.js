// The drawer (#602): the open item, as markup from the state. Pure: it reads the store (fields marked 'drawer' in
// web/store.js) and touches no page.
import { ago } from '../ago.js';
import { credit } from '../credit.js';
import { checkChip } from '../checks.js';
import { dotClass } from '../timeline.js';
import { mapParts } from '../groupmap.js';
import { prioritySeg as milestonePriority } from '../milestones.js';
import { ackList } from '../acks.js';
import { preconditionSection } from '../precondition.js';
import { placeholder } from '../instant.js';
import { S } from '../store.js';
import { commits, esc, inline, md, plural, refLink, repoTag, stageAge, when } from './html.js';
import { attemptsGrid, courtOf, named, stagePill, who, z } from './parts.js';

const prioritySeg = (item, priority) => milestonePriority(item, priority, { esc });

// A milestone's map in the drawer: the nested tree, each item with its stage, who holds it, what it waits on,
// its pull requests and open questions, and a mark on what needs you. At each level what's left comes first,
// and the done parts fold behind one line until tapped (#215). Dropped parts show only at 30m, behind
// "Show dropped" (#442).
function groupMap(n) {
  const li = (c) => `<li>${mapLine(c)}${kids(c)}</li>`;
  const kids = (x) => {
    const { open, folded, label, dropped } = mapParts(x.children);
    const key = `mapdone:${x.item}`, shown = S.open.has(key);
    const fold = folded.length ? `<li class="m-fold"><button class="link" data-action="toggle" data-key="${esc(key)}" aria-expanded="${shown}">${shown ? `Hide ${label}` : label}</button></li>` : '';
    const dkey = `mapdrop:${x.item}`, dshown = S.open.has(dkey);
    const drops = z() >= 2 && dropped.length ? `<li class="m-fold"><button class="link" data-action="toggle" data-key="${esc(dkey)}" aria-expanded="${dshown}">${dshown ? 'Hide dropped' : `Show dropped (${dropped.length})`}</button></li>${dshown ? dropped.map(li).join('') : ''}` : '';
    if (!open.length && !fold && !drops) return '';
    return `<ul>${open.map(li).join('')}${fold}${shown ? folded.map(li).join('') : ''}${drops}</ul>`;
  };
  return `<div class="map">${kids(n)}</div>`;
}
function mapLine(n) {
  return `<div class="m-line${n.needs_you ? ' you' : ''}">${refLink(n.item)} <span class="m-title">${esc(n.title)}</span> ${stagePill(n.stage, courtOf(n.stage))}${n.holder ? ` ${who(n.holder)}` : ''}${n.needs_you ? ' <span class="tag you">needs you</span>' : ''}
    ${n.depends_on.length ? `<span class="age">waits on ${n.depends_on.map(refLink).join(', ')}</span>` : ''}${n.prs.map((pr) => ` <a href="${esc(pr.url)}" target="_blank" rel="noopener">PR #${pr.number}${pr.ci === 'fail' ? ' ✗' : pr.ci === 'pass' ? ' ✓' : ''}</a>`).join('')}</div>
    ${n.questions.map((q) => `<div class="m-q">${q.to === 'operator' ? 'To the operator' : q.blocking ? 'Asks you' : 'Assumed'}: ${esc(q.question)}</div>`).join('')}`;
}

// What an item cost, per agent and model. A local model has tokens but no price: its cost is "—".
function usageTable(u) {
  const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  // Measured by llm-proxy: model time, and failed requests and cold loads when there were any.
  const secs = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`);
  const measured = (r) => (r.duration_ms == null ? '' : ` · ${secs(r.duration_ms)} model time${r.failures ? ` · ${r.failures} failed` : ''}${r.cold_loads ? ` · ${r.cold_loads} cold loads` : ''}`);
  const line = (r) => `${tok(r.input_tokens)} in · ${tok(r.output_tokens)} out · ${r.cost_usd == null ? '—' : `$${r.cost_usd.toFixed(2)}`}${measured(r)}`;
  const tag = (r) => (r.source === 'llm-proxy' ? ' · measured' : r.superseded ? ' · reported, superseded' : r.source === 'agent' ? ' · reported' : '');
  return `<div class="d-sec"><div class="label">Usage</div><dl class="kv">
    ${u.rows.map((r) => `<dt>${who(r.agent, r.model)} <span class="age">${esc(r.model || '?')}${tag(r)}</span></dt><dd>${r.superseded ? `<s>${line(r)}</s>` : line(r)}</dd>`).join('')}
    <dt><b>Total</b></dt><dd><b>${line(u.total)}</b></dd></dl></div>`;
}

// ── item drawer: 30s header, 5m body, 30m deep dive ──
// Null when no item is open: the drawer is then hidden.
export function drawerHtml() {
  if (!S.itemRef) return null;
  const it = S.item;
  if (!it) return placeholder(4);
  const holderLine = {
    proposed: it.holder
      ? `<b>${who(it.holder)}</b> is shaping it · lease ${when(it, 'lease_left', 'lease_until', true)} left`
      : `<b>Proposed</b> by ${who(it.created_by)} ${when(it, 'created', 'created_at')} ago. ${it.waits_for_ok && it.acceptance ? 'Shaped and waiting for your approval.' : `Nothing needed from you: ${it.holder ? `${who(it.holder)} is shaping it now` : it.priority === 'now' ? 'the next free agent shapes it first' : 'a free agent shapes it into ready work'}.`}`,
    ready: `<b>Ready</b> for ${it.race > 1 ? `${it.race} agents at once (a race)` : 'any agent'} · waiting ${stageAge(it)}${it.depends_on.some((x) => !['done', 'dropped'].includes(x.stage)) ? ' · blocked by dependencies' : ''}`,
    active: it.race > 1
      ? `<b>Race of ${it.race}</b> · ${stageAge(it)} so far · ${it.racers.map((r) => `${who(r.agent, r.model)} ${r.stage === 'active' ? `on it, lease ${when(r, 'lease_left', 'lease_until', true)} left` : esc(r.stage)}`).join(' · ') || 'no one yet'}`
      : `<b>${who(it.holder)}</b> is on it · ${stageAge(it)} so far · lease ${when(it, 'lease_left', 'lease_until', true)} left`,
    waiting: `<b>Waiting on you</b> for ${stageAge(it)}: an agent parked it to ask a question.`,
    verifying: `<b>Verifying</b> · ${who(it.implementer)} finished it ${stageAge(it)} ago${it.holder ? ` · ${who(it.holder)} is reviewing` : ''}`,
    landing: `<b>Landing</b> · accepted; ${it.holder ? `${who(it.holder)} is putting it on main` : 'the next free agent puts it on main'}`,
    done: `<b>Done</b> ${stageAge(it)} ago${it.implementer ? ` · ${credit({ implementer: it.implementer }, who)}` : ''}`,
    dropped: `<b>Dropped</b> ${stageAge(it)} ago`,
  }[it.stage];

  const actions = [];
  const raced = it.submissions?.filter((s) => s.stage === 'submitted').length > 1;
  if (it.stage === 'verifying') {
    if (!raced) actions.push(`<button class="btn primary" data-action="accept" data-item="${it.item}">Accept</button>`);
    actions.push(S.reveal.has('dsb') ? `<div class="inline-form grow"><input data-draft="sb:${it.item}" id="sb:${it.item}" placeholder="What's missing?"><button class="btn primary" data-action="sendback" data-item="${it.item}">Send back</button></div>`
      : `<button class="btn" data-action="reveal" data-key="dsb">Send back…</button>`);
  }
  // Only "Check with me" waits on you; otherwise this is an optional shortcut, so it mustn't look like a request.
  // One primary per drawer (#193): when Approve moves it on, "Make it next" steps back.
  const approves = it.waits_for_ok && it.acceptance;
  if (it.stage === 'proposed' && it.priority !== 'now') actions.push(`<button class="btn${approves ? '' : ' primary'}" data-action="pick" data-item="${it.item}" title="Agents shape and build this first">Make it next</button>`);
  if (it.stage === 'proposed') actions.push(approves
    ? `<button class="btn primary" data-action="approve" data-item="${it.item}" title="It becomes ready as written">Approve</button>`
    : `<button class="btn" data-action="approve" data-item="${it.item}" title="Optional: agents shape proposals on their own. This makes it ready as written.">Skip shaping</button>`);
  if (it.stage === 'done') actions.push(`<button class="btn" data-action="reopen" data-item="${it.item}">Reopen</button>`);
  if (!['done', 'dropped'].includes(it.stage)) actions.push(`<button class="btn ghost" data-action="drop" data-item="${it.item}">Drop</button>`);
  if (it.stage === 'dropped') actions.push(`<button class="btn" data-action="reopen" data-item="${it.item}">Restore</button>`);
  actions.push(`<button class="btn ghost" data-action="edit-item">Edit</button>`);
  if (!it.precondition && !S.editPre && ['proposed', 'ready', 'waiting'].includes(it.stage)) actions.push(`<button class="btn ghost" data-action="edit-pre" title="Hold it until a URL answers, or until a person says so">Wait on…</button>`);

  const life = it.lifecycle;
  const totalMs = life.reduce((n, l) => n + (l.court ? l.ms : 0), 0) || 1;
  const lifebar = life.filter((l) => l.court && l.ms > 0).map((l) => {
    const pct = (100 * l.ms) / totalMs;
    return `<span class="${l.court}" style="flex:${Math.max(pct, 1.5)}" title="${esc(l.label)} · ${esc(l.time)}${l.actor ? ` · ${esc(l.actor)}` : ''}">${pct > 14 ? esc(l.label) : ''}</span>`;
  }).join('');

  const handoff = it.handoff && it.stage !== 'done' ? `<div class="d-sec"><div class="label">${it.handoff.kind === 'sent_back' ? 'Sent back' : 'Where the last agent left off'}</div>
    <div class="handoff"><div class="by">${who(it.handoff.by)} · ${ago(it.handoff.at)} ago</div><b>${esc(it.handoff.headline)}</b>${it.handoff.summary ? md(it.handoff.summary) : ''}</div></div>` : '';

  const questions = it.questions.length ? `<div class="d-sec"><div class="label">Questions <span class="count">${it.questions.length}</span></div>
    ${it.questions.map((q) => `<div class="q ${q.status} ${q.blocking ? 'blocking' : ''}">
      <div class="meta">${who(q.asked_by)} · ${q.escalation ? `escalated ${esc(q.escalation.asked_by)}'s question` : q.blocking ? 'blocking' : 'non-blocking'} · ${when(q)} ago · ${esc(q.status)}</div>
      <div><b>${esc(q.question)}</b></div>${q.escalation ? `<div class="a">${esc(q.escalation.asked_by)} asked an operator: <i>${esc(q.escalation.question)}</i></div>` : ''}${q.context ? md(q.context) : ''}
      ${q.evidence?.length ? `<div class="evidence">${q.evidence.map((e) => `<span class="ev">${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.label)}</a>` : esc(e.label)}</span>`).join('')}</div>` : ''}
      ${q.assumption ? `<div class="a">Assumed: <i>${esc(q.assumption)}</i></div>` : ''}
      ${q.answer ? `<div class="a">Answer: <b>${esc(q.answer)}</b></div>` : q.status === 'confirmed' ? '<div class="a">You confirmed the assumption.</div>'
        : q.status === 'shipped' ? `<div class="a">Shipped with this assumption${q.closed_reason ? ` (${esc(q.closed_reason)})` : ''}. To change it now, steer or propose new work.</div>`
        : q.status === 'withdrawn' ? `<div class="a">Withdrawn${q.closed_reason ? `: ${esc(q.closed_reason)}` : ''}.</div>` : ''}
      ${q.status === 'open' ? `<div class="answer">${q.options.length ? `<div class="opts">${q.options.map((o) => `<button class="opt" data-action="answer" data-q="${q.id}" data-answer="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
        <div class="answer-row"><input data-draft="ans-${q.id}" id="ans-${q.id}" placeholder="${q.blocking ? 'Your answer…' : 'Override with…'}"><button class="btn primary" data-action="${q.blocking ? 'answer-text' : 'override'}" data-q="${q.id}" data-src="ans-${q.id}">${q.blocking ? 'Answer' : 'Override'}</button>
        ${q.blocking ? '' : `<button class="btn" data-action="confirm" data-q="${q.id}">Confirm</button>`}</div></div>` : ''}
    </div>`).join('')}</div>` : '';

  const steers = it.steers.length ? `<div class="d-sec"><div class="label">Your steering</div>${it.steers.map((s) => `<div class="q"><div>${esc(s.body)}</div>
      <div class="meta">${when(s)} ago</div><div class="acks">${ackList({ acks: s.acks, key: `dacks:${s.id}`, open: S.open.has(`dacks:${s.id}`), responses: true, empty: 'not acknowledged yet' }, { esc })}</div></div>`).join('')}</div>` : '';
  // What agents and the hub told each other about it (#550): one plain line each, who to whom, the whole text behind it.
  const told = it.told?.length ? `<div class="d-sec"><div class="label" data-new="agents-told">Agents told each other</div><div class="rows">${it.told.map((s) => {
    const key = `told:${s.id}`, open = S.open.has(key);
    return `<div class="told-item" data-key="${key}"><button class="row-item" data-action="toggle" data-key="${key}" aria-expanded="${open}" title="${esc(s.author)}">
        <span class="h"><b>${esc(s.from)}</b> to ${esc(s.to)}: ${esc(s.line)}</span><span class="age">${s.retires ? `${esc(s.retires)} · ` : ''}${when(s)} ago</span></button>
      ${open ? `<div class="told-body">${md(s.body)}</div>` : ''}</div>`;
  }).join('')}</div></div>` : '';

  const edit = S.editItem ? `<div class="d-sec"><div class="label">Edit</div><div class="add-work" style="margin:0">
      <input data-draft="ei-title" id="ei-title" value="${esc(it.title)}">
      <textarea data-draft="ei-summary" id="ei-summary" placeholder="Summary">${esc(it.summary)}</textarea>
      <textarea data-draft="ei-acceptance" id="ei-acceptance" placeholder="Done means…">${esc(it.acceptance)}</textarea>
      <label class="field-label">Part of <input data-draft="ei-parent" id="ei-parent" value="${esc(it.parent?.item ?? '')}" placeholder="e.g. #12: the milestone it belongs to; empty for none" inputmode="numeric"></label>
      <label class="field-label">Fixes a landed item <input data-draft="ei-fixes" id="ei-fixes" value="${esc(it.fixes?.item ?? '')}" placeholder="e.g. #12: the landed item this repairs (counts as an escape)" inputmode="numeric"></label>
      <div class="row"><div class="seg">${['now', 'soon', 'later'].map((p) => `<button class="${(S.drafts['ei-priority'] ?? it.priority) === p ? 'on' : ''}" data-action="ei-priority" data-p="${p}">${p}</button>`).join('')}</div>
      ${it.stage !== 'active' ? `<div class="seg" title="Race: how many agents attempt it at once, each on its own; you keep the best">${[1, 2, 3].map((n) => `<button class="${+(S.drafts['ei-race'] ?? it.race) === n ? 'on' : ''}" data-action="ei-race" data-n="${n}">${n === 1 ? '1 agent' : `race ${n}`}</button>`).join('')}</div>` : ''}
      <span style="flex:1"></span><button class="btn ghost" data-action="edit-item">Cancel</button><button class="btn primary" data-action="save-item" data-item="${it.item}">Save</button></div></div></div>` : '';

  const deep = S.deep ? `
    <div class="d-sec"><div class="label">The record</div>
      <dl class="kv">
        <dt>Created</dt><dd>${when(it, 'created', 'created_at')} ago by ${who(it.created_by)}</dd>
        <dt>Attempts</dt><dd>${it.attempts}${it.stalls ? ` · ${plural(it.stalls, 'stall')}` : ''}${it.rejections ? ` · sent back ${it.rejections}×` : ''}</dd>
        <dt>Agents involved</dt><dd>${it.agents.map((a) => `${who(a.name, a.model)} <span class="age">${esc(a.model)}</span>`).join(', ') || '—'}</dd>
        ${it.parent ? `<dt>Part of</dt><dd>${refLink(it.parent.item)} ${esc(it.parent.title)}</dd>` : ''}
        ${it.children.length ? `<dt>Broken into</dt><dd>${it.children.map((c) => `${refLink(c.item)} ${esc(c.title)} ${stagePill(c.stage, courtOf(c.stage))}`).join('<br>')}</dd>` : ''}
        ${it.depends_on.length ? `<dt>Depends on</dt><dd>${it.depends_on.map((c) => `${refLink(c.item)} ${esc(c.title)} ${stagePill(c.stage, courtOf(c.stage))}`).join('<br>')}</dd>` : ''}
        ${it.fixes ? `<dt>Repairs</dt><dd>${refLink(it.fixes.item)} ${esc(it.fixes.title)} <span class="age">landed; counted as an escape</span></dd>` : ''}
        ${it.fixed_by?.length ? `<dt>Escaped</dt><dd>fixed later by ${it.fixed_by.map((f) => `${refLink(f.item)} ${esc(f.title)}`).join(', ')}</dd>` : ''}
      </dl></div>
    ${it.detail ? `<div class="d-sec"><div class="label">Detail</div>${md(it.detail)}</div>` : ''}
    ${it.usage ? usageTable(it.usage) : ''}
    <div class="d-sec"><div class="label">Timeline <span class="count">${plural(it.events.length, 'event')}</span></div><div class="timeline">
      ${it.events.map((e) => `<div class="tl t-${e.type} ${dotClass(e.type, courtOf)}">
        <div class="meta">${who(e.actor)}<span>${esc(e.type.replace('_', ' '))}</span><span>${when(e)} ago</span></div>
        <div class="h">${named(e.headline, e.actor, undefined, { beside: true })}</div>
        ${e.summary ? `<div class="sm">${md(e.summary)}</div>` : ''}
        ${e.data?.evidence?.length ? `<div class="evidence">${e.data.evidence.map((x) => `<span class="ev">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>` : esc(x.label)}</span>`).join('')}</div>` : ''}
        ${e.detail ? `<details><summary>Detail</summary><pre>${esc(e.detail)}</pre></details>` : ''}
      </div>`).join('')}
    </div></div>` : '';

  return `
    <div class="d-top">${refLink(it.item)} ${stagePill(it.stage, it.court)} <span class="tag ${it.priority}">${it.priority}</span>${it.effective_priority ? ` <span class="tag ${esc(it.effective_priority.split(' ')[0])}" title="Agents take it at this priority: its milestone, or work waiting on it, ranks higher">ranks ${esc(it.effective_priority)}</span>` : ''}${repoTag(it)}${it.size ? ` <span class="tag" title="Large work waits while small models have other work">${esc(it.size)}</span>` : ''}${(it.needs ?? []).map((n) => ` <span class="tag" title="Only agents that have this get it">needs ${esc(n)}</span>`).join('')}
      <button class="btn ghost small x" data-action="close" title="Close (Esc)">✕</button></div>
    <h2 class="title">${esc(it.title)}</h2>
    <div class="d-now">${holderLine}</div>
    ${it.model_why && z() >= 1 ? `<div class="d-model" data-new="model-why">Model: ${esc(it.model_why)}</div>` : ''}
    <div class="actions">${actions.join('')}</div>
    ${it.map ? `<div class="d-sec"><div class="label">Map</div>${prioritySeg(it.item, it.priority)}${groupMap(it.map)}</div>` : ''}
    ${edit}
    ${lifebar ? `<div class="d-sec"><div class="label">Lifecycle <span class="count">agents ${esc(it.court_totals.agents)} · queue ${esc(it.court_totals.queue)} · you ${esc(it.court_totals.you)}${it.court_ms.external ? ` · outside ${esc(it.court_totals.external)}` : ''}</span></div>
      <div class="lifebar">${lifebar}</div>
      <div class="life-steps">${life.map((l) => `<span><b>${esc(l.label)}</b> ${esc(l.time)}${l.court === 'agents' && l.actor ? ` (${esc(l.actor)})` : ''}</span>`).join('<span>→</span>')}</div></div>` : ''}
    ${it.summary ? `<div class="d-sec"><div class="label">Summary</div>${md(it.summary)}</div>` : ''}
    <div class="d-sec"><div class="label">Done means</div>${it.acceptance ? md(it.acceptance) : '<p class="faint">No acceptance criteria yet. Agents are asked to write them before submitting.</p>'}</div>
    ${it.breaking ? `<div class="d-sec"><div class="label"><span data-new="breaking">Breaking: who must act when it ships</span></div><div class="warn">${inline(it.breaking)}</div></div>` : ''}
    ${preconditionSection(it, { editing: S.editPre })}
    ${it.submissions?.length ? `<div class="d-sec"><div class="label">The race <span class="count">${it.submissions.length} submitted</span></div>${attemptsGrid(it.item, it.submissions, { keep: it.stage === 'verifying' })}</div>` : ''}
    ${it.submission && it.stage === 'verifying' && !it.submissions?.length ? `<div class="d-sec"><div class="label">What the agent says</div><p><b>${esc(it.submission.headline)}</b></p>${md(it.submission.summary)}
      ${it.evidence.length ? `<div class="evidence">${it.evidence.map((x) => `<span class="ev">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>` : esc(x.label)}</span>`).join('')}</div>` : '<div class="warn">⚠ No evidence attached</div>'}
      ${commits(it.git)}${it.git_warning ? `<div class="warn">⚠ ${esc(it.git_warning)}</div>` : ''}</div>` : ''}
    ${it.bounce ? `<div class="d-sec"><div class="label">Keeps bouncing</div><p>${esc(it.bounce)}</p></div>` : ''}
    ${handoff}
    ${it.prs?.length ? `<div class="d-sec"><div class="label">Pull requests</div>${it.prs.map((pr) => `<p><a href="${esc(pr.url)}" target="_blank" rel="noopener">${esc(pr.repo)}#${pr.number}</a> <b>${esc(pr.state)}</b> · ${esc(pr.title)}
      ${pr.ci ? ` · CI <b class="${pr.ci === 'fail' ? 'bad' : pr.ci === 'pass' ? 'ok' : ''}">${pr.ci === 'pass' ? '✓ passing' : pr.ci === 'fail' ? '✗ failing' : '… running'}</b>` : ''}</p>
      ${pr.checks.length ? `<div class="evidence">${pr.checks.map((c) => checkChip(c, esc)).join('')}</div>` : ''}`).join('')}</div>` : ''}
    ${questions}
    ${steers}
    ${told}
    <div class="d-sec"><div class="label">Say something about this item</div>
      <div class="inline-form"><input data-draft="ic:${it.item}" id="ic:${it.item}" placeholder="Steer whoever works on it next, or leave a note…">
      <button class="btn primary" data-action="item-steer" data-item="${it.item}" title="The agent on it must read and acknowledge">Steer</button>
      <button class="btn" data-action="item-note" data-item="${it.item}">Note</button></div></div>
    <div class="d-sec">${S.deep ? '' : `<button class="btn" data-action="deep">Deep dive (30m): the timeline, every event and its detail</button>`}</div>
    ${deep}`;
}
