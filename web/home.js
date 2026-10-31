// The signed-in home (#124): does anything need you, anywhere? One request (GET /api/home) at every depth.
// 30s: the pulse across projects, then everything that needs you (absent, not empty, when nothing does),
// then one line per project with parked ones folded into one line. 5m adds worth knowing per project and
// what's in motion; 30m adds each project's mission, repositories and whether nuworq run staffs it.
// Pure: the page hands in its own renderers (the project page's pulse() and card()), so both pages share
// one of each. Every card sits inside data-project, so its actions reach its own project.

// A project's sentence without its "needs you" part: the badge says that.
const short = (s) => String(s ?? '').replace(/^(Nothing needs you\.|\d+ things? needs? you\.)\s*/, '');

// wide: lay it out in two columns; gs: the Get started card, if any.
export function homePage(h, { z, pulse, card, esc, plural, who = (name) => esc(name), wide = false, gs = '' }) {
  const tag = (p) => `<a class="proj-tag" href="#/p/${encodeURIComponent(p.slug)}">${esc(p.name)}</a>`;
  const needs = h.needs.length ? `<section class="sec home-needs"><header><h2>Needs you</h2><span class="count">${h.needs.length}</span>
      <span class="hint">oldest first, across projects</span></header>
      <div class="cards">${h.needs.map((a) => (a.project
        ? `<div class="home-card" data-project="${esc(a.project.slug)}">${tag(a.project)}${card(a)}</div>`
        : `<div class="home-card">${card(a)}</div>`)).join('')}</div></section>` : ''; // project null: the workspace's own (#231)

  const live = h.projects.filter((p) => !p.parked), parked = h.projects.filter((p) => p.parked);
  const line = (p) => `<div class="ov-line state-${p.pulse.state} ${p.parked ? 'parked' : ''}" data-action="goto" data-slug="${esc(p.slug)}">
      ${stateDot(p.pulse.state)}
      <div class="body"><b>${esc(p.name)}</b> <span class="s">${esc(short(p.pulse.sentence) || p.pulse.state)}</span>
        ${z >= 2 && p.mission ? `<div class="m">${esc(p.mission)}</div>` : ''}
        ${z >= 2 ? `<div class="m">${[p.remotes?.length ? esc(p.remotes.join(', ')) : 'No repo linked', p.runner ? 'nuworq run staffs it' : 'nuworq run leaves it alone'].join(' · ')}</div>` : ''}</div>
      ${p.needs ? `<span class="badge" title="${plural(p.needs, 'thing')} ${p.needs === 1 ? 'needs' : 'need'} you">${p.needs}</span>` : ''}
    </div>`;
  const projects = `<section class="sec home-projects"><header><h2>Projects</h2></header><div class="ov-lines">
      ${(z >= 1 ? [...live, ...parked] : live).map(line).join('')}
      ${z < 1 && parked.length ? `<button class="ov-line folded" data-action="zoom" data-zoom="5m">${plural(parked.length, 'parked project')}</button>` : ''}
    </div></section>`;

  const worth = z >= 1 && h.worth_knowing.length ? `<section class="sec"><header><h2>Worth knowing</h2></header><div class="ov-lines">
      ${h.worth_knowing.map((w) => `<div class="ov-line" data-action="goto" data-slug="${esc(w.slug)}"><div class="body"><b>${esc(w.name)}</b> <span class="s">${plural(w.count, 'thing')} worth knowing</span></div></div>`).join('')}
    </div></section>` : '';
  const motion = z >= 1 && h.motion.length ? `<section class="sec"><header><h2>In motion</h2><span class="count">${h.motion.length}</span></header><div class="ov-lines">
      ${h.motion.map((m) => `<div class="ov-line" data-project="${esc(m.project.slug)}" data-action="open" data-item="${esc(m.item)}"><div class="body"><b>${who(m.agent, null, { presence: m.presence })}</b> <span class="s">${esc(m.item)} ${esc(m.title)}</span></div>${tag(m.project)}</div>`).join('')}
    </div></section>` : '';

  const head = pulse({ pulse: h.pulse, since: h.pulse.since, project: { parked: false }, home: true, agents: h.agents });
  // Wide (#141): the work in the main column, the 30-second answer (pulse, Get started, projects) beside it.
  // The same sections either way; with nothing to act on, one column, so no empty band.
  if (wide && (needs || worth || motion)) return columns(`${needs}${worth}${motion}`, `${head}${gs}${projects}`);
  return `${gs}${head}${needs}${projects}${worth}${motion}`;
}

// A project's state dot (#195): its color never speaks alone, so it carries the state as its name and title.
export const STATE_LABELS = { 'needs-you': 'Needs you', flowing: 'Flowing', stalled: 'Stalled', idle: 'Idle', parked: 'Parked' };
export const stateDot = (state) => {
  const label = STATE_LABELS[state] ?? state;
  return `<span class="dot ${state}" role="img" aria-label="${label}" title="${label}"></span>`;
};

// Two columns: the work, and beside it what stays in view while you act on it. The side column scrolls on its own,
// so it carries a key a redraw finds it by (#376): one per page, so moving to another page starts it at the top.
export const columns = (main, side, page = 'home') => `<div class="cols"><div class="col-main">${main}</div><aside class="col-side" data-scroll="side:${page}">${side}</aside></div>`;
