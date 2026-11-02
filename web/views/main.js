// The page (#602): the home, a project, analytics, as markup from the state. Pure: it reads the store (fields marked
// 'main' in web/store.js) and the window's width, and touches no page.
import { SETUP } from '../connect.js';
import { ago, dur } from '../ago.js';
import { getStartedCard } from '../getstarted.js';
import { proposeForm } from '../propose.js';
import { homePage, columns, stateDot, STATE_LABELS } from '../home.js';
import { credit } from '../credit.js';
import { checkChip } from '../checks.js';
import { missingProject } from '../missing.js';
import { boardWork } from '../oldwork.js';
import { milestonesSection } from '../milestones.js';
import { ackList } from '../acks.js';
import { analyticsPage } from '../analytics.js';
import { roleCounts } from '../agentline.js';
import { placeholder } from '../instant.js';
import { shell } from '../switching.js';
import { S } from '../store.js';
import { KEYBOARD, WIDE, Z, commits, esc, inline, md, plural, refLink, repoTag, stepWhere, when, zero } from './html.js';
import { attemptsGrid, courtOf, named, stagePill, who, z } from './parts.js';

// The agents here now as counts by role, each opening to its agents (#441, web/agentline.js). scope keeps each page's open counts apart.
const hereNow = (agents, scope) => roleCounts(agents, { scope, isOpen: (k) => S.open.has(k), esc,
  who: (a) => `${who(a.name, a.model, { job: true, presence: a })}${a.project ? ` <span class="age">${esc(a.project.name)}</span>` : ''}` });
export function mainHtml() {
  if (S.analytics) return analytics();
  // The project picked this frame (#637): only its shell is drawn until the frame has painted, held view or not.
  if (S.slug && S.view?.project.slug === S.slug && S.shellOnly !== S.slug) return project(S.view);
  if (S.missing) return missingProject(S.missing, { esc });
  // Picked a moment ago (#503): its header from what the app holds, at once; the view fills it in place.
  if (S.slug) return projectShell(S.slug);
  return overview();
}
const updating = (slug) => (S.loading === slug ? '<span class="updating" role="status">Updating</span>' : '');
function projectShell(slug) {
  const line = S.projects.find((p) => p.slug === slug);
  if (!line) return placeholder(6);
  return shell(line, { esc, stateDot, labels: STATE_LABELS, placeholder, depth: zoomControl(), updating: updating(slug),
    columns: WIDE.matches ? (a, b) => columns(a, b, `p:${slug}`) : null });
}

// ── overview: the 30-second view across every project ──
function zoomControl() {
  return `<div class="seg" title="How much do you want to see? (keys 1, 2, 3)">${Object.keys(Z).map((k) =>
    `<button class="${S.zoom === k ? 'on' : ''}" data-action="zoom" data-zoom="${k}">${k}</button>`).join('')}</div>`;
}

// Analytics (#239, web/analytics.js): the workspace's figures, for its owners, from the home.
const owner = () => S.person?.role === 'owner';
const analytics = () => analyticsPage(S.outcomes, { esc, dur, period: S.period, open: S.open.has('an-agents'), wide: WIDE.matches, columns });

// The home, across every project (web/home.js): the pulse, what needs you, a line per project.
const getStarted = () => getStartedCard(S.gs, { commands: Object.fromEntries(SETUP.map((s) => [s.key, s.how])) });
function overview() {
  if (!S.projects.length && S.me?.org) return firstProject();
  if (!S.projects.length || !S.home) {
    // One next step: Get started while it shows, the fallback only once it's finished or hidden (#149).
    const gs = getStarted();
    return `<div class="phead"><div class="titles"><h1>Welcome to nuworq</h1>
      <div class="mission">A hub where you facilitate and AI agents (Claude, OpenAI, open-weight) find, do and verify the work.</div></div></div>
      ${gs || `<div class="zero"><span class="check">→</span><div>No projects yet. Connect an agent and it will create one when it checks in, or <button class="link" data-action="new-project">create one now</button>.
      <button class="btn primary" data-action="connect">Connect an agent</button></div></div>`}`;
  }
  return `<div class="phead"><div class="titles"><h1>Home</h1></div>
      <div class="controls"><div class="ctl-row"><span class="seg-label">Depth</span>${zoomControl()}
      ${owner() ? '<a class="btn an-open" href="#/analytics" data-new="analytics">Analytics</a>' : ''}</div></div></div>
    ${homePage(S.home, { z: z(), pulse, card, esc, plural, who, wide: WIDE.matches, gs: getStarted() })}`;}

// ── project ──
function project(v) {
  const P = v.project;
  const zoomSeg = zoomControl();
  const autoSeg = `<div class="seg" role="group" aria-label="Autonomy" data-new="instant-actions">${Object.entries(P.autonomy_options).map(([k, o]) =>
    `<button class="${P.autonomy === k ? 'on' : ''}" aria-pressed="${P.autonomy === k}" data-action="autonomy" data-level="${k}" title="${esc(o.human)}">${esc(o.label)}</button>`).join('')}</div>`;
  const mission = S.editMission
    ? `<div class="inline-form"><input data-draft="mission" id="mission-in" placeholder="What is this project for? Agents read this first." value="${esc(P.mission)}"><button class="btn primary small" data-action="save-mission">Save</button><button class="btn ghost small" data-action="cancel-mission">Cancel</button></div>`
    : `<div class="mission ${P.mission ? '' : 'empty'}" data-action="edit-mission" title="Click to edit. Every agent reads the mission at checkin.">${esc(P.mission || 'Add a mission: the north star every agent reads at checkin')}</div>`;

  // The repositories this project is: any clone of one, on any machine, finds the project.
  const remotes = `<div class="where">${P.remotes.length ? `Repo ${P.remotes.map((r) => `<code>${esc(r)}</code><button class="link" data-action="remote-remove" data-remote="${esc(r)}" title="Unlink this repository">×</button>`).join(' ')}` : '<span class="faint">No repository linked yet: the first agent that checks in from a clone teaches the hub.</span>'}
    ${S.addRemote
      ? `<div class="inline-form"><input data-draft="remote" id="remote-in" placeholder="github.com/acme/api, or any git remote URL"><button class="btn primary small" data-action="remote-add">Link</button><button class="btn ghost small" data-action="remote-cancel">Cancel</button></div>`
      : `<button class="link" data-action="remote-new" title="Link a git remote: every clone of it, on any machine, reaches this project">+ repo</button>`}</div>`;
  const empty = !(v.counts?.items ?? v.all.length) && !(v.counts?.agents ?? v.agents.length);
  // The staffing banner only once a runner has reached this project (#643): before that a yes starts nothing, and
  // connect asks on the machine that would run the workers.
  return `
    <div class="phead">
      <div class="titles"><h1>${esc(P.name)}${updating(P.slug)}</h1>${mission}${z() >= 1 || S.addRemote ? remotes : ''}</div>
      <div class="controls">
        <div class="ctl-row"><span class="seg-label">Depth</span>${zoomSeg}</div>
        ${z() >= 1 ? `<div class="ctl-row"><span class="seg-label">Autonomy</span>${autoSeg}
        <button class="btn settings-btn" data-action="settings" data-new="project-settings" title="Staffing, freshness, GitHub, park or remove">Settings</button></div>` : ''}
      </div>
    </div>
    ${!P.runner && P.staffing && !P.staffing.asked && P.runners_here ? `<div class="staff-ask"><div><b>Let <code>nuworq run</code> staff this project?</b> It starts headless workers whenever work is waiting, and they can cost money. Off until you say.</div>
      <div class="actions"><button class="btn primary" data-action="runner-on">Let run staff it</button><button class="btn ghost" data-action="staff-not-now">Not now</button></div></div>` : ''}
    ${projectBody(v, empty)}`;
}

// The staffing in a few words (#174): paused, budget spent for today, or the limit and budget that apply.
function staffLine(s) {
  if (!s) return '';
  if (s.paused) return 'paused';
  if (s.stopped === 'budget') return `today's $${s.budget.toFixed(2)} spent`;
  return [s.workers ? `up to ${s.workers} at once` : 'runners decide how many', s.budget != null ? `$${s.budget.toFixed(2)}/day` : ''].filter(Boolean).join(' · ');
}
// The project's sections: one column on a phone; wide (#141), the work in the main column and the pulse,
// flow and agents beside it, the same sections either way. Each starts at its own depth; Flow at every depth (Paul's decision).
function projectBody(v, empty) {
  const more = z() < 2 && !empty ? `<div class="zoom-more">${z() === 0
    ? `That's the 30-second view. <button data-action="zoom" data-zoom="5m">Go to 5m</button> for what's worth knowing, what's next, what finished, and how agents are doing.`
    : `<button data-action="zoom" data-zoom="30m">Go to 30m</button> for the full activity record, every item and agent diagnostics.`}</div>` : '';
  const s = {
    pulse: pulse(v), composer: composer(v), empty: empty ? emptyProject() : '', needs: needsYou(v), groups: groups(v), motion: motion(v),
    worth: z() >= 1 ? worthKnowing(v) : '', flow: flow(v), next: z() >= 1 ? upNext(v) : '', finished: z() >= 1 ? finished(v) : '',
    steering: z() >= 1 ? steering(v) : '', agents: z() >= 1 ? agents(v) : '', runners: z() >= 1 ? runners(v) : '', activity: z() >= 2 ? activity(v) : '', all: z() >= 2 ? allWork(v) : '', more,
  };
  const order = (keys) => keys.map((k) => s[k]).join('');
  if (WIDE.matches && !empty) return columns(order(['composer', 'needs', 'groups', 'motion', 'worth', 'next', 'finished', 'steering', 'activity', 'all', 'more']), order(['pulse', 'flow', 'agents', 'runners']), `p:${S.slug}`);
  return order(['pulse', 'composer', 'empty', 'needs', 'groups', 'motion', 'worth', 'flow', 'next', 'finished', 'steering', 'agents', 'runners', 'activity', 'all', 'more']);
}

function emptyProject() {
  return `<section class="sec"><div class="zero"><span class="check">→</span><div>
    <b>No work yet.</b> Add some above, or connect an agent and let it propose what matters.
    <button class="btn primary small" data-action="connect">Connect an agent</button></div></div></section>`;
}

function pulse(v) {
  const label = STATE_LABELS[v.pulse.state];
  const c = v.since.counts;
  const bits = [
    c.finished && `<b>${c.finished}</b> finished`,
    c.submitted && `<b>${c.submitted}</b> submitted`,
    c.started && `<b>${c.started}</b> started`,
    c.proposed && `<b>${c.proposed}</b> proposed`,
    c.sent_back && `<b>${c.sent_back}</b> sent back`,
  ].filter(Boolean);
  const since = v.since.at
    ? bits.length ? `Since you last looked (${when(v.since)} ago): ${bits.join(' · ')}` : `No agent activity since you last looked (${when(v.since)} ago).`
    : v.home ? 'Everything here is new to you.' : 'Everything in this project is new to you.';
  // On the home, each finished item names its project, and its link opens it there.
  const list = z() >= 1 && v.since.finished.length
    ? `<div class="since-list">${v.since.finished.slice(0, 6).map((f) => `<div${f.project ? ` data-project="${esc(f.project.slug)}"` : ''}>✓ ${refLink(f.item)} ${esc(f.title)} <span class="age">${f.project ? `${esc(f.project.name)} · ` : ''}by ${esc(f.by === 'you' ? 'you' : f.by)}</span></div>`).join('')}</div>` : '';
  // Who is here now, as counts by role (#441): on the home at every depth, on a project at 30s (5m on has its Agents section).
  const here = v.home ? hereNow(v.agents ?? [], 'home') : z() === 0 ? hereNow(v.agents.filter((a) => a.present), S.slug) : '';
  return `<div class="pulse state-${v.pulse.state}">
      <div class="state-chip">${stateDot(v.pulse.state)}${label}</div>
      <div class="sentence">${esc(v.pulse.sentence)}</div>
      ${here}
      ${v.project.parked ? `<div class="actions"><button class="btn primary small" data-action="unpark-project">Unpark</button></div>` : ''}
      <div class="since"><span>${since}</span><span class="spacer"></span>
        ${c.updates || !v.since.at ? `<button class="btn small" data-action="seen" title="Count from now: what changes after this shows as new next time. Nothing that needs you goes away.">Mark all seen</button>` : ''}
        ${list}</div>
    </div>`;
}

function composer(v) {
  const hints = {
    steer: 'Every agent must read and acknowledge it. You\'ll see who did.',
    decision: 'A standing rule. Every agent gets it at every checkin.',
    note: 'For the record. Agents may see it; no acknowledgement needed.',
  };
  const kinds = { steer: 'Steer', decision: 'Decision', note: 'Note' };
  return `<div class="composer">
      <div class="box">
        <textarea id="compose" data-draft="compose" placeholder="Say something to your agents…${KEYBOARD.matches ? ' (⌘↵ to send)' : ''}"></textarea>
        <div class="row">
          <div class="seg">${Object.entries(kinds).map(([k, l]) => `<button class="${S.composeKind === k ? 'on' : ''}" data-action="compose-kind" data-kind="${k}">${l}</button>`).join('')}</div>
          <span class="hint">${hints[S.composeKind]}</span>
          <button class="btn primary small" data-action="compose-send">Send</button>
        </div>
      </div>
      <button class="btn" data-action="toggle-add"data-new="propose-work" aria-expanded="${!!S.addWork}">${S.addWork ? 'Close' : '+ Work'}</button>
    </div>
    ${S.addWork ? proposeForm({ more: S.addMore, priority: S.drafts['nw-priority'] ?? 'soon', autonomy: v?.project.autonomy }) : ''}`;
}

// ── 30s: what needs you ──
function needsYou(v) {
  const act = v.attention.filter((a) => a.level === 'act');
  const body = act.length
    ? `<div class="cards">${act.map(card).join('')}</div>`
    : `<div class="zero"><span class="check good">✓</span><div><b>Nothing needs you.</b> ${v.pulse.active ? 'Agents are working; you\'ll see things here when they need a decision, an answer or a verification.' : 'When agents need a decision, an answer or a verification, it shows up here.'}</div></div>`;
  return `<section class="sec"><header><h2>Needs you</h2>${act.length ? `<span class="count">${act.length}</span>` : ''}
    ${act.length ? '<span class="hint" data-new="needs-rank">most important first; each one moves work to its next stage</span>' : ''}</header>${body}</section>`;
}

// ── 30s: the milestones (web/milestones.js): one line each; a tap opens its map. ──
const groups = (v) => milestonesSection(v, { esc });
// What each Needs you card is, in plain words: one per kind the hub puts at level "act" (test/cardlabels.test.js).
const CARD_LABELS = {
  question: 'Question', review: 'Ready to verify', proposal: 'Shaped, needs your approval', struggling: 'Keeps bouncing', direction: 'Direction',
  'no-agents': 'Nobody is working', 'group-stalled': 'A "now" milestone is stalled', 'ci-failing': 'CI is failing', 'pr-review': 'Needs your approval on GitHub',
  'operator-missing': 'No operator connected', 'kept-parked': 'Kept parked', 'app-wiring': 'GitHub App setup', 'payment-failed': 'Payment failed',
  'plan-limit': 'Free plan limit',
};

// Why a card sits where it does (#506): the priority of the work it holds up, as the app's priority tag (by weight,
// never a state color), and "from #468" when it's the milestone's or a dependent's. The hub's reason is its title.
const cardPriority = (a) => (a.priority ? `<span class="card-prio" title="${esc(a.priority_why ?? '')}"><span class="tag ${esc(a.priority)}">${esc(a.priority)}</span>${a.priority_from ? ` from ${refLink(a.priority_from)}` : ''}</span>` : '');

function card(a) {
  const label = a.kind === 'question' && a.escalation ? 'Escalated by an operator' : CARD_LABELS[a.kind] ?? 'Needs you';
  const key = 'a:' + a.key;
  const open = S.open.has(key) || z() >= 2;
  const hasMore = a.why || a.detail || a.acceptance;
  const more = open && hasMore ? `<div class="more">
      ${a.why ? md(a.why) : ''}
      ${a.acceptance ? `<div class="label">Done means</div>${md(a.acceptance)}` : ''}
      ${a.detail ? `<div class="label">Detail</div>${md(a.detail)}` : ''}
    </div>` : '';
  return `<article class="card kind-${a.kind}">
    <div class="card-top"><span class="kind">${label}</span>${refLink(a.item)}<span class="sub">${named(a.sub, a.agent, a.presence)}</span>${cardPriority(a)}</div>
    <h3>${esc(a.headline)}</h3>
    ${a.attempts?.length > 1 ? attemptsGrid(a.item, a.attempts) : `${a.evidence?.length ? `<div class="evidence">${a.evidence.map((e) => `<span class="ev">${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.label)}</a>` : esc(e.label)}</span>`).join('')}</div>` : ''}
    ${commits(a.git)}`}
    ${a.warn ? `<div class="warn">⚠ ${esc(a.warn)}</div>` : ''}
    ${a.steps?.length ? stepList(a) : ''}
    ${a.how?.length ? howList(a.how) : ''}
    ${a.kind === 'proposal' && a.acceptance && !open ? `<div class="more"><div class="label" style="margin-top:0">Done means</div>${md(a.acceptance)}</div>` : ''}
    ${more}
    ${cardActions(a, hasMore, open, key)}
  </article>`;
}

// What the hub says to do about something it noticed (#173: why nobody is working), as numbered steps with the
// exact place and how to see it worked. Not a question, so nothing to tick.
function howList(how) {
  return `<div class="steps"><ol>${how.map((s, i) => `<li>
      <div class="step-tick" style="cursor:default"><span class="box" aria-hidden="true">${i + 1}</span><span class="do">${inline(s.do)}</span></div>
      ${s.where || s.check ? `<div class="step-more">${stepWhere(s.where)}${s.check ? `<div class="step-check">${inline(s.check)}</div>` : ''}</div>` : ''}
    </li>`).join('')}</ol></div>`;
}

// Steps an agent wrote say so above their Copy buttons: their commands are the agent's words, not the hub's.
// A person ('you', '@handle') or the hub itself ('nuworq') wrote the rest.
const stepsBy = (asker) => (!asker || asker === 'you' || asker === 'nuworq' || String(asker).startsWith('@') ? ''
  : `<div class="steps-by">Written by ${esc(asker)}, an agent, not by nuworq. Read each command before you run it.</div>`);

// A question's steps as a checklist the person ticks off (#162), shown at every depth. The row is the tick target;
// a URL opens in a new tab, each command gets a Copy button. Ticks are the viewer's own and survive a reload.
function stepList(a) {
  const done = new Set(a.ticked ?? []);
  const q = a.question.id;
  return `<div class="steps" data-new="step-checklist">
    <div class="steps-head"><span class="label">Steps</span><span class="steps-count">${[...done].filter((n) => n <= a.steps.length).length} of ${a.steps.length} done</span></div>
    ${stepsBy(a.question.asked_by)}
    <ol>${a.steps.map((s, i) => {
      const n = i + 1;
      const on = done.has(n);
      const where = stepWhere(s.where);
      return `<li class="${on ? 'on' : ''}">
        <button class="step-tick" data-action="step" data-q="${q}" data-step="${n}" data-done="${on ? '' : '1'}" aria-pressed="${on}">
          <span class="box" aria-hidden="true">${on ? '✓' : n}</span><span class="do">${inline(s.do)}</span></button>
        ${where || s.check ? `<div class="step-more">${where}${s.check ? `<div class="step-check">${inline(s.check)}</div>` : ''}</div>` : ''}
      </li>`;
    }).join('')}</ol>
  </div>`;
}

function cardActions(a, hasMore, open, key) {
  if (a.kind === 'direction') {
    return `<div class="answer">
      <div class="picks">${a.picks.map((p) => `<button class="pick" data-action="pick" data-item="${esc(p.item)}" title="${esc(p.summary || '')}"><span class="ref">${esc(p.item)}</span>${esc(p.title)}</button>`).join('')}</div>
      <div class="actions" style="margin-top:0"><button class="btn ghost small" data-action="park">Park this project instead</button><span style="flex:1"></span>${hasMore ? `<button class="link" data-action="toggle" data-key="${esc(key)}">${open ? 'Less' : 'How this works'}</button>` : ''}</div>
    </div>`;
  }
  if (a.kind === 'no-agents') {
    // The one fix first: let nuworq run staff it when that's all it takes; otherwise start an agent.
    return `<div class="actions">${a.staff
      ? '<button class="btn primary" data-action="runner-on">Let nuworq run staff this project</button><button class="btn" data-action="connect">Start an agent</button>'
      : '<button class="btn primary" data-action="connect">Start an agent</button>'}<button class="btn ghost" data-action="park">Park this project</button></div>`;
  }
  const moreBtn = hasMore ? `<button class="link" data-action="toggle" data-key="${esc(key)}">${open ? 'Less' : 'Why it needs you'}</button>` : '';
  if (a.kind === 'group-stalled') {
    return `<div class="actions"><button class="btn" data-action="open" data-item="${esc(a.item)}">Open ${esc(a.item)}</button><button class="btn ghost" data-action="dismiss" data-key="${esc(a.key)}">Not now</button>${moreBtn}</div>`;
  }
  if (a.kind === 'question') {
    const q = a.question;
    return `<div class="answer">
      ${q.options?.length ? `<div class="opts">${q.options.map((o) => `<button class="opt" data-action="answer" data-q="${q.id}" data-answer="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
      <div class="answer-row"><input data-draft="ans-${q.id}" id="ans-${q.id}" placeholder="${q.options?.length ? 'Or write your own answer…' : 'Your answer…'}"><button class="btn primary" data-action="answer-text" data-q="${q.id}">Answer</button></div>
      <div class="actions" style="margin-top:0"><label class="check-label"><input type="checkbox" data-draft="dec-${q.id}" id="dec-${q.id}"> Make this a standing decision for all agents</label>${a.parked ? `<label class="check-label" title="Record the answer, but don't hand the work back to agents yet"><input type="checkbox" data-draft="keep-${q.id}" id="keep-${q.id}"> Keep it parked</label>` : ''}<span style="flex:1"></span>${moreBtn}</div>
    </div>`;
  }
  if (a.kind === 'operator-missing') {
    return `<div class="actions"><a class="btn primary" href="${esc(a.guide)}" target="_blank" rel="noopener">How to start an operator</a><button class="btn ghost" data-action="dismiss" data-key="${esc(a.key)}">Not now</button>${moreBtn}</div>`;
  }
  if (a.kind === 'payment-failed') {
    return `<div class="actions"><button class="btn primary" data-action="billing-portal">Manage billing</button>${moreBtn}</div>`;
  }
  if (a.kind === 'plan-limit') {
    return `<div class="actions"><button class="btn primary" data-action="workspace-settings">Upgrade</button><button class="btn ghost" data-action="dismiss" data-key="${esc(a.key)}">Not now</button>${moreBtn}</div>`;
  }
  if (a.kind === 'kept-parked') {
    return `<div class="actions"><button class="btn primary" data-action="unpark" data-item="${esc(a.item)}">Unpark</button><button class="btn ghost" data-action="open" data-item="${esc(a.item)}">Open</button>${moreBtn}</div>`;
  }
  if (a.kind === 'review') {
    const r = `sb:${a.item}`;
    const race = a.attempts?.length > 1;
    return `<div class="actions">
      ${race ? '' : `<button class="btn primary" data-action="accept" data-item="${esc(a.item)}">Accept</button>`}
      ${S.reveal.has(r)
        ? `<div class="inline-form grow"><input data-draft="${r}" id="${r}" placeholder="What's missing? The next agent starts from this."><button class="btn primary" data-action="sendback" data-item="${esc(a.item)}">Send ${race ? 'all ' : ''}back</button></div>`
        : `<button class="btn" data-action="reveal" data-key="${r}">Send ${race ? 'all ' : ''}back…</button>`}
      <button class="btn ghost" data-action="open" data-item="${esc(a.item)}">Open</button>${moreBtn}
    </div>`;
  }
  if (a.kind === 'proposal') {
    return `<div class="actions">
      <button class="btn primary" data-action="approve" data-item="${esc(a.item)}">Approve</button>
      <button class="btn" data-action="drop" data-item="${esc(a.item)}">Drop</button>
      <button class="btn ghost" data-action="open" data-item="${esc(a.item)}">Open</button>${moreBtn}
    </div>`;
  }
  if (a.kind === 'pr-review') {
    return `<div class="actions">
      <a class="btn primary" href="${esc(a.pr.url)}" target="_blank" rel="noopener">Approve PR #${a.pr.number} on GitHub</a>
      <button class="btn ghost" data-action="open" data-item="${esc(a.item)}">Open</button>${moreBtn}
    </div>`;
  }
  if (a.kind === 'ci-failing') {
    const r = `sb:${a.item}`;
    return `<div class="evidence">${a.pr.checks.map((c) => checkChip(c, esc)).join('')}</div>
      <div class="actions">
      ${S.reveal.has(r)
        ? `<div class="inline-form grow"><input data-draft="${r}" id="${r}" placeholder="What failed? The next agent starts from this."><button class="btn primary" data-action="sendback" data-item="${esc(a.item)}">Send back</button></div>`
        : `<button class="btn primary" data-action="reveal" data-key="${r}">Send back…</button>`}
      ${a.pr.url ? `<a class="btn" href="${esc(a.pr.url)}" target="_blank" rel="noopener">PR #${a.pr.number}</a>` : ''}
      <button class="btn ghost" data-action="open" data-item="${esc(a.item)}">Open</button>
      <button class="btn ghost" data-action="dismiss" data-key="${esc(a.key)}">Not now</button>${moreBtn}
    </div>`;
  }
  // Keeps bouncing (#564): only the actions for its case. A question to you: answer it here. A missing capability:
  // the steps to start an agent that has it (the card's how list). A real bounce: clarify, split or drop.
  if (a.kind === 'struggling' && a.step === 'answer') {
    const q = a.question;
    return `<div class="answer"><div class="label" style="margin-top:0">Question ${q.id}: ${esc(q.question)}</div>
      ${q.options?.length ? `<div class="opts">${q.options.map((o) => `<button class="opt" data-action="answer" data-q="${q.id}" data-answer="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
      <div class="answer-row"><input data-draft="ans-${q.id}" id="ans-${q.id}" placeholder="${q.options?.length ? 'Or write your own answer…' : 'Your answer…'}"><button class="btn primary" data-action="answer-text" data-q="${q.id}">Answer</button></div>
      <div class="actions" style="margin-top:0"><button class="btn ghost" data-action="open" data-item="${esc(a.item)}">Open</button><span style="flex:1"></span>${moreBtn}</div>
    </div>`;
  }
  if (a.kind === 'struggling' && a.step === 'capability') {
    return `<div class="actions"><button class="btn" data-action="open" data-item="${esc(a.item)}">Open</button><button class="btn ghost" data-action="dismiss" data-key="${esc(a.key)}">Not now</button>${moreBtn}</div>`;
  }
  if (a.kind === 'struggling') {
    const r = `cl:${a.item}`;
    return `<div class="actions">
      ${S.reveal.has(r)
        ? `<div class="inline-form grow"><input data-draft="${r}" id="${r}" placeholder="Clarify the intent. Whoever picks it up next must read this."><button class="btn primary" data-action="clarify" data-item="${esc(a.item)}">Steer</button></div>`
        : `<button class="btn primary" data-action="reveal" data-key="${r}">Clarify…</button>`}
      <button class="btn" data-action="open" data-item="${esc(a.item)}">Open</button>
      <button class="btn ghost" data-action="drop" data-item="${esc(a.item)}">Drop</button>
      <button class="btn ghost" data-action="dismiss" data-key="${esc(a.key)}">Not now</button>${moreBtn}
    </div>`;
  }
  return '';
}

// ── 5m: worth knowing ──
// Only what a person might confirm, redirect or fix (#497): one line each, the rest behind Open, at most 5 before
// "N more", and one tap clears them all.
const WK_SHOWN = 5;
function worthKnowing(v) {
  const know = v.attention.filter((a) => a.level === 'know');
  if (!know.length) return '';
  const allKey = `wk:all:${S.slug}`;
  const shown = S.open.has(allKey) ? know : know.slice(0, WK_SHOWN);
  const rows = shown.map((a) => {
    const open = S.open.has(`wk:${a.key}`);
    const openBtn = `<button class="btn ghost small" data-action="toggle" data-key="wk:${esc(a.key)}" aria-expanded="${open}">${open ? 'Close' : 'Open'}</button>`;
    if (!open) {
      return `<div class="row-item wk-line"${a.key ? ` data-key="know:${esc(a.key)}"` : ''}><div class="body"><div class="h" title="${esc(a.headline)}">${a.item ? refLink(a.item) + ' ' : ''}${esc(a.headline)}</div></div>
        <div class="acts">${openBtn}<button class="btn ghost small wk-got" data-action="dismiss" data-key="${esc(a.key)}">Got it</button></div></div>`;
    }
    let acts = `<button class="btn ghost small" data-action="dismiss" data-key="${esc(a.key)}">Got it</button>`;
    if (a.kind === 'assumption') {
      const r = `ov:${a.question.id}`;
      acts = S.reveal.has(r)
        ? `<div class="inline-form" style="width:320px"><input data-draft="${r}" id="${r}" placeholder="Instead…"><button class="btn primary small" data-action="override" data-q="${a.question.id}">Override</button></div>`
        : `<button class="btn small" data-action="confirm" data-q="${a.question.id}">Confirm</button><button class="btn small" data-action="reveal" data-key="${r}">Override…</button>`;
    }
    if (a.kind === 'proposal') acts = `<button class="btn small" data-action="open" data-item="${esc(a.item)}">Look</button>` + acts;
    if (a.start) acts = `<button class="btn small" data-action="connect">Start an agent</button>` + acts;
    if (a.kind === 'notify-failing') acts = `<button class="btn small" data-action="notify">Check it</button>` + acts;
    if (a.kind === 'outside-overdue') acts = `<button class="btn small" data-action="check-now" data-item="${esc(a.item)}">Check now</button><button class="btn small" data-action="open" data-item="${esc(a.item)}">Edit it</button>` + acts;
    if (a.kind === 'peer-review-stuck') acts =`<button class="btn small" data-action="open" data-item="${esc(a.item)}">Review it</button>` + acts;
    // Stuck on a capability nobody has: the choices are to let any agent take it, or keep waiting for one that has it.
    // Infrastructure work can't go to just any agent: the steps start an operator session instead (#201).
    if (a.kind === 'unfit' && a.operator) acts = `<button class="btn ghost small" data-action="dismiss" data-key="${esc(a.key)}">Keep waiting</button>`;
    else if (a.kind === 'unfit') acts = `<button class="btn small" data-action="needs" data-item="${esc(a.item)}" data-needs="${esc(JSON.stringify(a.keep ?? []))}" title="Drop ${esc((a.missing ?? []).join(', '))} from what it needs">Let any agent take it</button><button class="btn ghost small" data-action="dismiss" data-key="${esc(a.key)}">Keep waiting</button>`;
    // "Got it" is for news; next to a real action, dismissing just hides it.
    else if (/data-action="(open|connect|notify)"/.test(acts)) acts = acts.replace('>Got it</button>', '>Hide</button>');
    return `<div class="row-item wk-open"${a.key ? ` data-key="know:${esc(a.key)}"` : ''}><div class="body"><div class="h">${esc(a.headline)}</div><div class="s">${a.item ? refLink(a.item) + ' ' : ''}${esc(a.sub)}</div>
      ${a.why ? `<div class="s" style="margin-top:var(--sp-1)">${esc(a.why)}</div>` : ''}${a.how?.length ? howList(a.how) : ''}<div class="acts" style="margin-top:var(--sp-2)">${acts}</div></div><div class="acts">${openBtn}</div></div>`;
  }).join('');
  const more = know.length > WK_SHOWN
    ? `<button class="link wk-more" data-action="toggle" data-key="${esc(allKey)}" aria-expanded="${S.open.has(allKey)}">${S.open.has(allKey) ? 'Show fewer' : `${know.length - WK_SHOWN} more`}</button>` : '';
  const all = `<button class="btn ghost small" data-action="dismiss-all" data-keys="${esc(JSON.stringify(know.map((a) => a.key)))}">Got it, all</button>`;
  return `<section class="sec" data-new="worth-knowing-lines"><header><h2>Worth knowing</h2><span class="count">${know.length}</span><span class="hint wk-hint">agents carried on without you; glance and confirm, or redirect</span><span style="flex:1"></span>${all}</header><div class="rows">${rows}</div>${more}</section>`;
}

// ── 30s → 5m: what's in motion ──
function motion(v) {
  if (!v.motion.length) return '';
  const rows = v.motion.map((m) => `
    <div class="row-item clickable" data-action="open" data-item="${esc(m.item)}">
      <div class="body">
        <div class="h">${who(m.agent, m.model)} ${refLink(m.item)} <span>${esc(m.title)}</span>${repoTag(m)}${m.shaping ? '<span class="tag shaping">shaping</span>' : ''}${m.landing ? '<span class="tag shaping">landing</span>' : ''}${m.priority === 'now' ? '<span class="tag now">now</span>' : ''}${m.race ? `<span class="tag soon">race of ${m.race}</span>` : m.attempt > 1 ? `<span class="tag soon">attempt ${m.attempt}</span>` : ''}</div>
        ${z() >= 1 && m.last ? `<div class="last ${m.quiet ? 'quiet' : ''}">${m.last.type === 'claimed' ? 'Just picked it up' : m.last.type === 'shaping' ? 'Started shaping it' : named(m.last.headline, m.agent, undefined, { beside: true })}</div>` : ''}
        ${z() >= 1 && m.touching?.length ? `<div class="touch">${m.touching.map((t) => `<code>${esc(t)}</code>`).join(' ')}</div>` : ''}
        ${z() >= 1 && m.heads_up ? `<div class="headsup">⚠ ${esc(m.heads_up.split('. ')[0])}</div>` : ''}
        ${z() >= 2 && m.last?.summary ? `<div class="s">${md(m.last.summary)}</div>` : ''}
      </div>
      <span class="age" title="Lease: ${esc(m.lease_left)} left">${m.last ? when(m.last) + ' ago' : ''}${z() >= 1 ? ` · on it ${when(m, 'for', 'since_at')}` : ''}</span>
    </div>`).join('');
  return `<section class="sec motion"><header><h2>In motion</h2><span class="count">${v.motion.length}</span></header><div class="rows">${rows}</div></section>`;
}

// ── 5m: flow ──
function flow(v) {
  const f = v.flow;
  // Dropped work isn't on the board (#442): All work's "Show dropped", at 30m, lists it.
  const stages = f.stages.filter((s) => s.stage !== 'dropped');
  const pills = stages.map((s) => `<button class="stage stage-${s.stage} court-${s.court ?? 'none'} ${S.stage === s.stage ? 'on' : ''} ${s.count ? '' : 'zero-count'}" data-action="stage" data-stage="${s.stage}" title="${esc(s.blurb)}"><span class="n">${s.count}</span><span class="l">${esc(s.label)}</span></button>`).join('<span class="arrow">→</span>');
  let detail = '';
  if (S.stage) {
    const st = f.stages.find((s) => s.stage === S.stage);
    const here = v.stage_items?.[S.stage] ?? boardWork(v.all).rows.filter((i) => i.stage === S.stage);
    // Approved feedback about nuworq (#295) is marked, and can be shown on its own.
    const fb = here.some((i) => i.feedback);
    const items = here.filter((i) => !S.onlyFeedback || !fb || i.feedback).slice(-25).reverse();
    detail = `<div class="stage-detail"><div class="blurb"><b>${esc(st.label)}.</b> ${esc(st.blurb)} ${st.court ? `<i>Whose move: ${st.court === 'you' ? 'yours' : st.court === 'agents' ? "the agents'" : st.court === 'external' ? 'someone outside this hub' : 'nobody yet (waiting for an agent)'}.</i>` : ''} ${st.ms ? `Work spent ${esc(st.time)} here in the last 14 days.` : ''}</div>
      ${fb ? `<button class="chip fb-only ${S.onlyFeedback ? 'on' : ''}" data-action="only-feedback" aria-pressed="${!!S.onlyFeedback}">Feedback only</button>` : ''}
      ${items.length ? items.map((i) => `<div>${refLink(i.item)} ${i.feedback ? '<span class="tag fb-tag">feedback</span> ' : ''}${esc(i.title)} <span class="age">${when(i)}</span></div>`).join('') : `<div class="age">${STAGE_EMPTY[S.stage] ?? 'Nothing here.'}</div>`}</div>`;
  }
  const c = f.court;
  const hasTime = c.agents + c.queue + c.you + (c.external ?? 0) > 0;
  const max = Math.max(1, ...f.throughput);
  return `<section class="sec"><header><h2>Flow</h2><span class="hint">the lifecycle, and whose move it is (last 14 days)</span></header>
    <div class="flow">
      <div class="stages">${pills}</div>
      ${detail}
      ${hasTime ? `<div class="courtbar">
          ${c.agents ? `<span class="seg-c agents" style="flex:${c.agents}">${c.agents >= 8 ? c.agents + '%' : ''}</span>` : ''}
          ${c.queue ? `<span class="seg-c queue" style="flex:${c.queue}">${c.queue >= 8 ? c.queue + '%' : ''}</span>` : ''}
          ${c.you ? `<span class="seg-c you" style="flex:${c.you}">${c.you >= 8 ? c.you + '%' : ''}</span>` : ''}
          ${c.external ? `<span class="seg-c external" style="flex:${c.external}">${c.external >= 8 ? c.external + '%' : ''}</span>` : ''}
        </div>
        <div class="legend"><span><i class="agents"></i>Agents working ${c.agents}%</span><span><i class="queue"></i>Waiting for an agent ${c.queue}%</span><span><i class="you"></i>Waiting on you ${c.you}%</span>${c.external ? `<span><i class="external"></i>Waiting outside ${c.external}%</span>` : ''}</div>` : ''}
      ${f.takeaway ? `<p class="takeaway">${esc(f.takeaway)}</p>` : ''}
      <div class="throughput">
        <div class="spark" title="Finished per day, last 14 days">${f.throughput.map((n) => `<span class="${n ? '' : 'z'}" style="height:${Math.max(2, Math.round((n / max) * 28))}px" title="${n}"></span>`).join('')}</div>
        <span>${plural(f.finished, 'item')} finished in 14 days${f.median_cycle ? ` · median ${esc(f.median_cycle)} from ready to done` : ''}</span>
      </div>
      ${flowYou(f.you)}
      ${flowHeld(f.verification)}
      ${f.cost ? flowCost(f.cost) : ''}
    </div></section>`;
}

// Whether verification held up (#176): landed work a later item fixes (an escape), per model as builder and as
// peer reviewer, and peer verdicts a person overturned. Silent until there's a peer verdict or an escape.
function flowHeld(v) {
  if (!v || (!v.escaped && !v.peer_accepted)) return '';
  const who = v.by_model.filter((m) => m.built_escaped || m.reviewed_escaped || m.overturned)
    .map((m) => `${esc(m.model ?? 'unknown model')}: ${[m.built_escaped && `built ${m.built_escaped}`, m.reviewed_escaped && `reviewed ${m.reviewed_escaped}`, m.overturned && `${m.overturned} verdict${m.overturned === 1 ? '' : 's'} overturned`].filter(Boolean).join(', ')}`);
  return `<p class="flow-held" title="An escape is landed work that a later item names in fixes">${plural(v.escaped, 'escape')} in ${v.landed} landed${v.peer_accepted ? ` · ${v.overturned} of ${plural(v.peer_accepted, 'peer verdict')} overturned` : ''}${who.length ? ` · ${who.join(' · ')}` : ''}</p>`;
}

// What the work cost you (#175): your actions (answers, verdicts, steers, decisions, comments) per landed item,
// and how long work you had to move waited for you. Nothing to say until you've acted or something landed.
function flowYou(y) {
  if (!y || (!y.actions && !y.landed && !y.waits)) return '';
  const per = y.per_landed != null ? `<b>${y.per_landed}</b> of your actions per landed item` : `${plural(y.actions, 'action')} of yours, nothing landed yet`;
  return `<p class="flow-you" title="Your answers, verdicts, steers, decisions, comments and confirmations over 14 days, against the items that landed">${per}${y.median_wait ? ` · work waited a median <b>${esc(y.median_wait)}</b> for you (${plural(y.waits, 'time')})` : ''}</p>`;
}

// Why a stage is empty, and the one thing to do about it where there is one.
const STAGE_EMPTY = {
  proposed: 'No ideas waiting to be shaped. <button class="link" data-action="toggle-add">+ Work</button>',
  ready: 'Nothing ready: every shaped item is taken or finished. <button class="link" data-action="toggle-add">+ Work</button>',
  outside: 'Nothing is waiting on a check outside this hub.',
  active: 'No agent is working right now. <button class="link" data-action="connect">Start an agent</button>',
  waiting: 'No agent is waiting on an answer from you.',
  verifying: 'Nothing to review: no submissions are waiting.',
  landing: 'Nothing accepted is waiting to land on main.',
  done: 'Nothing finished in the last 3 days. <button class="link" data-action="launcher">Search</button> finds older work.',
};

// What finished work cost per model; a local model shows tokens, having no price.
function flowCost(c) {
  const usd = (n) => `$${n.toFixed(2)}`;
  const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const row = (m) => `<dt>${esc(m.model || 'unknown model')} <span class="age">${plural(m.items, 'item')}</span></dt><dd>${m.median_usd != null
    ? `median ${usd(m.median_usd)} per item · ${usd(m.total_usd)} total`
    : `median ${tok(m.median_tokens)} tokens per item · ${tok(m.total_tokens)} total`}</dd>`;
  return `<div class="cost"><dl class="kv">${c.by_model.map(row).join('')}
    <dt><b>Spent</b></dt><dd><b>${c.spend_usd != null ? usd(c.spend_usd) : '—'}</b> in 14 days</dd></dl></div>`;
}

function itemRow(i, extra = '') {
  const notes = [
    i.blocked_by?.length && `after ${i.blocked_by.join(', ')}`,
    i.handoff?.kind === 'sent_back' && `sent back: "${i.handoff.headline}"`,
    i.handoff?.kind === 'handoff' && `${i.handoff.by} left a note`,
    i.attempts > 1 && `${i.attempts} attempts`,
  ].filter(Boolean).join(' · ');
  return `<div class="row-item clickable" data-action="open" data-item="${esc(i.item)}">
    <span class="tag ${i.priority}">${i.priority}</span>
    <div class="body"><div class="h">${refLink(i.item)} ${esc(i.title)}${repoTag(i)}</div>${notes || extra ? `<div class="s">${esc(notes)}${extra}</div>` : ''}</div>
    <span class="age">${when(i)}</span></div>`;
}

function upNext(v) {
  if (!v.queue.length) return (v.counts?.items ?? v.all.length) ? `<section class="sec"><header><h2>Up next</h2></header>
    ${zero('<b>Nothing ready for an agent to pick up.</b> Everything here is in progress, waiting, still being shaped or finished.', '<button class="link" data-action="toggle-add">+ Work</button>')}</section>` : '';
  const shown = z() >= 2 ? v.queue : v.queue.slice(0, 5);
  const all = v.counts?.queue ?? v.queue.length;
  return `<section class="sec"><header><h2>Up next</h2><span class="count">${all}</span><span class="hint">ready for any agent, in the order they'll be picked</span></header>
    <div class="rows">${shown.map((i) => itemRow(i)).join('')}</div>
    ${all > shown.length ? `<div class="zoom-more">+${all - shown.length} more at 30m</div>` : ''}</section>`;
}

function finished(v) {
  if (!v.done.length) return '';
  const shown = z() >= 2 ? v.done : v.done.slice(0, 5);
  return `<section class="sec"><header><h2>Recently finished</h2><span class="count">${v.counts?.done ?? v.done.length}</span><span class="hint">last 3 days</span></header>
    <div class="rows">${shown.map((i) => i.parts ? finishedMilestone(i) : `<div class="row-item clickable" data-action="open" data-item="${esc(i.item)}">
      <div class="body"><div class="h">✓ ${refLink(i.item)} ${esc(i.title)}</div>${credit(i, who) ? `<div class="s">${credit(i, who)}</div>` : ''}</div>
      <span class="age">${when(i)} ago</span></div>`).join('')}</div></section>`;
}
// A finished milestone is one line (#442): its title, how many parts, when it finished. Tapping the parts count
// opens them under it.
function finishedMilestone(i) {
  const key = `fin:${i.item}`, shown = S.open.has(key);
  return `<div class="row-item fin-ms" data-key="${esc(key)}" data-new="finished-milestones"><div class="body">
    <div class="h">✓ ${refLink(i.item)} ${esc(i.title)}</div>
    <button class="link fin-parts" data-action="toggle" data-key="${esc(key)}" aria-expanded="${shown}">${shown ? 'Hide parts' : `${plural(i.parts.length, 'part')}`}</button>
    ${shown ? `<ul class="fin-list">${i.parts.map((c) => `<li>${refLink(c.item)} ${esc(c.title)}${c.stage === 'done' ? '' : ` ${stagePill(c.stage, courtOf(c.stage))}`}</li>`).join('')}</ul>` : ''}</div>
    <span class="age">finished ${when(i)} ago</span></div>`;
}

function steering(v) {
  if (!v.steers.length && !v.decisions.length && !v.notes.length) return '';
  const steers = v.steers.map((s) => {
    const expected = v.agents.filter((a) => a.present).map((a) => a.name);
    const missing = s.item ? [] : expected.filter((n) => !s.acks.some((x) => x.agent === n));
    // A steer made from an agent's answer is the answerer's, not yours (#497).
    const from = s.by && s.by !== 'you' && !s.by.startsWith('@') ? `<div class="s">from ${who(s.by)}</div>` : '';
    return `<div class="row-item steer-item" data-key="note:${s.id}"><div class="body"><div class="h">${s.item ? refLink(s.item) + ' ' : ''}${inline(s.body)}</div>${from}
      <div class="acks">${ackList({ acks: s.acks, missing, key: `acks:${s.id}`, open: S.open.has(`acks:${s.id}`), responses: z() >= 2 }, { esc })}</div></div>
      <div class="acts"><span class="age">${ago(s.at)} ago</span><button class="btn ghost small" data-action="retire" data-note="${s.id}" title="Stop delivering it">Retire</button></div></div>`;
  }).join('');
  // Memory distilled for people (#552): a gist first, the full words one tap away; a review's recommendation decided
  // with one tap. Without a gist yet, the words themselves.
  const behind = (label, body) => `<details class="mem-full"><summary>${label}</summary><div class="mem-words">${inline(body)}</div></details>`;
  const decisions = v.decisions.map((d) => `<div class="row-item" data-key="note:${d.id}"><div class="body"><div class="h">${inline(d.gist ?? d.body)}</div>${d.gist ? behind('Full text', d.body) : ''}</div>
    <div class="acts"><span class="age">${when(d)} ago</span><button class="btn ghost small" data-action="retire" data-note="${d.id}">Retire</button></div></div>`).join('');
  const all = z() >= 2 || S.open.has(`memory:${S.slug}`);
  // A recommendation waiting for the person comes first, so it's among those shown before 30m.
  const pending = (n) => !!n.advice && !n.advice.by && n.advice.do !== 'keep';
  const ranked = [...v.notes.filter(pending), ...v.notes.filter((n) => !pending(n))];
  const shownNotes = all ? ranked : ranked.slice(0, 3);
  const advice = (n) => {
    const a = n.advice;
    if (!pending(n)) return a?.do === 'keep' && a.why && !a.by ? `<div class="s">Recommended: keep. ${esc(a.why)}</div>` : '';
    return a.do === 'retire'
      ? `<div class="mem-advice"><span>Recommended: retire. ${esc(a.why)}</span><span class="mem-acts"><button class="btn small" data-action="retire" data-note="${n.id}">Retire</button><button class="btn ghost small" data-action="keep" data-note="${n.id}">Keep</button></span></div>`
      : `<div class="mem-advice"><span>Recommended: make it a decision. ${esc(a.why)}</span><blockquote>${inline(a.draft)}</blockquote><span class="mem-acts"><button class="btn small" data-action="promote" data-note="${n.id}">Make it a decision</button><button class="btn ghost small" data-action="keep" data-note="${n.id}">Keep as a note</button></span></div>`;
  };
  // Agents get the ten notes that bear on their work (#443); a note marked always-show reaches every one of them.
  const notes = shownNotes.map((n, i) => `<div class="row-item note-item" data-key="note:${n.id}"><div class="body"><div class="h">${inline(n.gist ?? n.note ?? n.body)}</div>${n.gist ? behind('Agent\'s words', n.body) : ''}<div class="s">${who(n.by)}${n.item ? ` on ${refLink(n.item)}` : ''}</div>${advice(n)}</div>
    <div class="acts"><span class="age">${when(n)} ago</span><button class="btn ghost small${n.always ? ' on' : ''}" data-action="always" data-note="${n.id}" data-on="${n.always ? 0 : 1}" aria-pressed="${!!n.always}" title="${n.always ? 'Every agent gets it, whatever it works on. Tap to stop' : 'Give it to every agent, whatever it works on (at most 3)'}"${i === 0 ? ' data-new="always-show"' : ''}>${n.always ? 'Always shown' : 'Always show'}</button>${pending(n) && n.advice.do === 'retire' ? '' : `<button class="btn ghost small" data-action="retire" data-note="${n.id}" title="Outdated or wrong">Retire</button>`}</div></div>`).join('');
  const sub = (label, hint) => `<div class="sublabel">${label}<span>${hint}</span></div>`;
  // Direction today (#552): a few plain lines a person checks direction by, each naming where it comes from.
  const src = (s) => {
    const m = String(s ?? '').match(/^(decision|steer|note) (\d+)$/);
    if (!m) return /^#\d+$/.test(s) ? refLink(s) : '';
    return `<button class="link faint" data-action="memory-src" data-note="${m[2]}">${{ decision: 'a decision', steer: 'your steering', note: 'a field note' }[m[1]]}</button>`;
  };
  const direction = v.direction?.length ? `${sub('<span data-new="memory-distilled">Direction today</span>', 'distilled from your decisions, steering and the notes that matter')}
    <ol class="direction">${v.direction.map((d) => `<li><span>${inline(d.line)}</span> <span class="mem-src">${src(d.source)}</span></li>`).join('')}</ol>` : '';
  return `<section class="sec"><header><h2>Steering &amp; memory</h2><span class="hint">did your nudges land, and what every agent carries into every session</span></header>
    ${direction}
    ${steers ? `${sub('Steering', 'acknowledged by')}<div class="rows" style="margin-bottom:var(--sp-4)">${steers}</div>` : ''}
    ${decisions ? `${sub('Decisions', 'standing rules, from you')}<div class="rows" style="margin-bottom:var(--sp-4)">${decisions}</div>` : ''}
    ${notes ? `${sub('Field notes', 'what agents learned the hard way, left for the next one')}<div class="rows">${notes}</div>
      ${(v.counts?.notes ?? v.notes.length) > shownNotes.length ? `<div class="zoom-more">${v.counts?.notes ?? v.notes.length} field notes in all; every one at 30m</div>` : ''}` : ''}
  </section>`;
}
function agents(v) {
  if (!(v.counts?.agents ?? v.agents.length)) return (v.counts?.items ?? v.all.length) ? `<section class="sec"><header><h2>Agents</h2></header>
    ${zero('<b>No agent has checked in here yet.</b> The work waits until one does.', '<button class="btn primary small" data-action="connect">Connect an agent</button>')}</section>` : '';
  // Only the agents here now (#441): holding work, or seen in the last hour. The rest wait behind "Show earlier agents" at 30m.
  const live = v.agents.filter((a) => a.present);
  const nobody = `<span class="age">No agent has been here in the last hour, so nothing moves until one comes back. <button class="link" data-action="connect">Start an agent</button></span>`;
  if (z() < 2) {
    return `<section class="sec"><header><h2>Agents</h2><span class="count">${live.length} here</span></header>
      <div class="agent-strip">${live.map((a) => `<span class="a"${a.tokens.length ? ` title="token: ${esc(a.tokens.join(', '))}"` : ''}>${who(a.name, a.model, { job: true })}<span class="st ${a.status.split(' ')[0]}">${esc(a.status)}${a.holding.length && !a.job ? ` ${a.holding.join(', ')}` : ''}${a.tokens.length > 1 ? ` · <span class="warn">${a.tokens.length} tokens</span>` : ''}</span></span>`).join('') || nobody}</div></section>`;
  }
  // Earlier agents come a page at a time (#501): v.earlier names the ones sent for the list.
  const gone = v.earlier ? v.agents.filter((a) => v.earlier.includes(a.name)) : v.agents.filter((a) => !a.present);
  const goneAll = v.counts?.agents_gone ?? gone.length;
  const showGone = S.open.has(`earlier:${S.slug}`);
  const earlier = goneAll ? `<button class="link earlier" data-action="toggle" data-key="earlier:${esc(S.slug)}" aria-expanded="${showGone}" data-new="present-agents">${showGone ? 'Hide earlier agents' : `Show earlier agents (${goneAll})`}</button>` : '';
  const moreGone = showGone && goneAll > gone.length ? ` <button class="link" data-action="more" data-more="agents" data-new="show-more">Show more (${goneAll - gone.length} left)</button>` : '';
  const shown = showGone ? [...live, ...gone] : live;
  return `<section class="sec"><header><h2>Agents</h2><span class="count">${live.length} here</span><span class="hint">first-class participants, each with a track record</span></header>
    ${shown.length ? '' : `<div class="agent-strip">${nobody}</div>`}
    <div class="agent-grid">${shown.map((a) => `<div class="agent-card">
      <div class="top">${who(a.name, a.model, { job: true })}<span class="status ${a.status.split(' ')[0]}">${esc(a.status)}</span></div>
      <div class="model">${esc([a.model, a.client, a.provider].filter(Boolean).join(' · ') || 'model unknown')}${a.via ? ` · <span title="Who answers for this agent's token">${esc(a.via)}</span>` : ''}</div>
      ${a.tokens.length ? `<div class="model ${a.tokens.length > 1 ? 'warn' : ''}" title="${a.tokens.length > 1 ? 'More than one token has acted under this name' : 'The token this agent connects with'}">token: ${esc(a.tokens.join(', '))}</div>` : ''}
      ${a.has?.length ? `<div class="model" title="What this agent's machine can do (declared at checkin)">has: ${esc(a.has.join(', '))}</div>` : ''}
      <div class="line" title="${esc(a.line)}">${esc(a.line || '—')}</div>
      <div class="stats">
        <div><b>${a.record.landed}</b><span>landed</span></div>
        <div><b>${a.record.sent_back}</b><span>sent back</span></div>
        <div><b>${a.record.stalls}</b><span>stalls</span></div>
        <div><b>${a.record.handoffs}</b><span>handoffs</span></div>
      </div>
      <div class="model" style="margin-top:var(--sp-2)">${a.record.assumptions} assumptions · ${a.record.questions} blocking questions · ${a.record.proposed} proposed · ${a.record.learned} field notes${a.record.reviews ? ` · ${a.record.reviews} reviews` : ''}${a.record.races ? ` · won ${a.record.races_won} of ${a.record.races} races` : ''} · seen ${when(a, 'last_seen', 'seen_at')} ago</div>
    </div>`).join('')}</div>${earlier}${moreGone}</section>`;
}

// The machines running `nuworq run` for this project (#171), as each last said: up, paused, skipping this
// project, stopped, or down (silent for 3 polls). The state leads each row; one line says why.
function runners(v) {
  if (!v.project.runner) return '';
  const rs = v.runners ?? [];
  // The staffing in words beside the heading (#213), so it shows without opening Settings.
  const staff = `<span class="right">${esc(staffLine(v.project.staffing))} <button class="link" data-action="staffing">Staffing</button></span>`;
  if (!rs.length) return `<section class="sec"><header><h2>Runners</h2>${staff}</header>
    ${zero('<b>No runner has reported here.</b> Nothing starts workers until one does.', 'On a machine with a checkout: <code>nuworq run</code>')}</section>`;
  const why = (r) => r.state === 'down' ? `Silent since ${when(r, 'last_seen', 'seen_at')} ago${r.machine ? ` on ${esc(r.machine)}` : ''}.`
    : r.state === 'stopped' ? `Stopped ${when(r, 'last_seen', 'seen_at')} ago: ${esc(r.stopped)}.`
    : r.state === 'paused' ? `Paused for ${when(r.paused, 'for', 'until', true)}: ${esc(r.paused.reason)}.`
    : r.state === 'skipping' ? `Leaves this project alone${r.skipping.for ? ` for ${when(r.skipping, 'for', 'until', true)}` : ''}: ${esc(r.skipping.reason)}.`
    // --workers auto (#533): it adds workers while the machine has room, and says why when it holds.
    : r.auto ? `${r.running} of up to ${r.workers} running${r.holding ? `. Holding: ${esc(r.holding)}.` : ', as the machine has room.'}`
    : `${r.running} of ${r.workers} worker${r.workers === 1 ? '' : 's'} running.`;
  const up = rs.filter((r) => r.state === 'up').length;
  const st = v.project.staffing;
  const held = st?.stopped === 'paused' ? 'Staffing is paused: no new workers start here; running ones finish.'
    : st?.stopped === 'budget' ? `Today's budget is spent ($${st.spent_today.toFixed(2)} of $${st.budget.toFixed(2)}): new workers start here again tomorrow (UTC).` : '';
  return `<section class="sec"><header><h2>Runners</h2><span class="count">${up} up</span>${up < rs.length ? `<span class="hint">${rs.length - up} not starting work here</span>` : ''}${staff}</header>
    ${held ? `<p class="warn">${held}</p>` : ''}
    <div class="rows">${rs.map((r) => `<div class="row-item runner"><div class="body">
      <div class="h">${esc(r.name)}<span class="status runner-${r.state}">${esc(r.state)}</span></div>
      <div class="s">${why(r)}</div>
      <div class="s faint">${[r.machine && r.machine !== r.name ? `on ${esc(r.machine)}` : '', r.state !== 'down' ? `seen ${when(r, 'last_seen', 'seen_at')} ago` : '', r.spent ? `$${r.spent.toFixed(2)} spent` : '', r.skipping_others ? `skips ${r.skipping_others} other project${r.skipping_others === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}</div>
    </div></div>`).join('')}</div></section>`;
}

function activity(v) {
  const quiet = new Set(['progress', 'checkin', 'review_started']);
  const events = S.feedAll ? v.activity : v.activity.filter((e) => !quiet.has(e.type));
  return `<section class="sec feed"><header><h2>Everything that happened</h2><span class="count">${events.length}</span>
    <span class="right"><label class="check-label"><input type="checkbox" data-action="feed-all" ${S.feedAll ? 'checked' : ''}> include routine progress</label></span></header>
    ${events.length ? '' : v.activity.length
      ? zero('Only routine progress so far.', '<button class="link" data-action="feed-all">Include routine progress</button>')
      : zero('<b>Nothing has happened here yet.</b> Every claim, question, submission and review will show up here.')}
    <div class="rows">${events.map((e) => {
      const key = 'e:' + e.id;
      const open = S.open.has(key);
      const has = e.summary || e.detail || e.data?.evidence?.length;
      return `<div class="row-item ${has ? 'clickable' : ''}" ${has ? `data-action="toggle" data-key="${key}"` : ''}>
        <span class="type">${esc(e.type.replace('_', ' '))}</span>
        <div class="body"><div class="h">${e.item ? refLink(e.item) + ' ' : ''}${named(e.headline, e.actor, undefined, { beside: true })}</div>
          ${open ? `<div class="expand">${md(e.summary)}${e.data?.evidence?.length ? `<div class="evidence">${e.data.evidence.map((x) => `<span class="ev">${esc(x.label)}</span>`).join('')}</div>` : ''}${e.detail ? `<pre>${esc(e.detail)}</pre>` : ''}</div>` : ''}</div>
        <span class="age">${who(e.actor)} · ${when(e)}</span></div>`;
    }).join('')}</div></section>`;
}

// Every item on the board (#442): done work older than 3 days and dropped work aren't here; search (⌘K) and
// analytics find the old, and "Show dropped" brings the dropped back.
function allWork(v) {
  if (!(v.counts?.items ?? v.all.length)) return `<section class="sec"><header><h2>All work</h2></header>${zero('<b>No work yet.</b> Every item, in every stage, will be listed here.')}</section>`;
  // A view fetched by depth (#501) brings the board newest first, a page at a time, and the dropped beside it.
  const { rows, dropped, old } = v.counts ? { rows: v.all, dropped: v.dropped ?? [], old: v.counts.old } : boardWork(v.all);
  const board = v.counts?.board ?? rows.length;
  const showDropped = S.open.has('all:dropped');
  const floor = rows.length < board ? Number(rows.at(-1)?.item.slice(1) ?? 0) : 0; // dropped work within the page shown
  const shown = [...rows, ...(showDropped ? dropped.filter((i) => Number(i.item.slice(1)) > floor) : [])].sort((a, b) => b.item.slice(1) - a.item.slice(1));
  const foot = [
    old ? `${plural(old, 'item')} finished more than 3 days ago: <button class="link" data-action="launcher">Search</button> finds them.` : '',
    dropped.length ? `<button class="link" data-action="toggle" data-key="all:dropped" aria-expanded="${showDropped}" data-new="show-dropped">${showDropped ? 'Hide dropped' : `Show dropped (${dropped.length})`}</button>` : '',
  ].filter(Boolean).join(' · ');
  const more = board > rows.length ? `<div class="zoom-more"><button class="link" data-action="more" data-more="all" data-new="show-more">Show more (${board - rows.length} older)</button></div>` : '';
  return `<section class="sec"><header><h2>All work</h2><span class="count">${board + (showDropped ? dropped.length : 0)}</span></header>
    ${shown.length ? `<div class="work-scroll"><table class="work"><thead><tr><th>#</th><th>Title</th><th>Stage</th><th>Priority</th><th>Worked on by</th><th>In stage</th></tr></thead><tbody>
    ${shown.map((i) => `<tr data-action="open" data-item="${esc(i.item)}"><td>${esc(i.item)}</td><td>${esc(i.title)}${repoTag(i)}</td><td>${stagePill(i.stage, courtOf(i.stage))}</td><td>${esc(i.priority)}</td><td>${i.last_worker ? who(i.last_worker) : '<span class="age" title="No agent has worked on it yet">—</span>'}</td><td class="age">${when(i)}</td></tr>`).join('')}
    </tbody></table></div>` : zero('<b>Nothing open or recently finished.</b>')}
    ${more}${foot ? `<div class="zoom-more">${foot}</div>` : ''}</section>`;
}

// ── a new workspace: step 2 (its first project, with its repositories) and step 3 (connect a machine) ──
// Step 1, naming the workspace, is on the hub's own address (web/join.js).
function firstProject() {
  return `<div class="phead"><div class="titles"><h1>${esc(S.me.org)}</h1></div></div>
    <div class="setup">
      <p class="faint">Step 2 of 3 · your first project</p>
      <p class="lead">A project is what agents work on: a mission, and the repositories their work lands in.</p>
      <div class="form"><label>Name<input id="fp-name" data-draft="fp-name" placeholder="e.g. api"></label>
      <label>Mission (optional): the north star every agent reads<textarea id="fp-mission" data-draft="fp-mission" placeholder="What is this for? What matters most?"></textarea></label>
      <label>Repositories (optional): one per line<textarea id="fp-remotes" data-draft="fp-remotes" placeholder="github.com/acme/api&#10;github.com/acme/web"></textarea></label></div>
      <div class="foot"><button class="btn primary" data-action="first-project">Create project</button></div>
    </div>`;
}
