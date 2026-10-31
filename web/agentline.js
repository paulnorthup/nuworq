// How an agent reads on every screen (#240): what it is, where it runs and what it is doing, e.g. "Worker ·
// mac-mini runner — building #170", from the role, place and job the hub reports (#238), instead of claude-<hex>.
// Its id is for the deep look (30m) and the tooltip. Pure: the page and the tests share it.
export const ROLES = { operator: 'Operator', shaper: 'Shaper', worker: 'Worker', session: 'Agent' };

// presence: { role, where, job } (core.js presenceOf), or nothing when the hub didn't say, and then the name is
// all there is. job: say what it is doing now (where that isn't already the line's subject). id: add its name.
export function agentLine(presence, { name = '', job = true, id = false } = {}) {
  if (!presence) return name;
  const what = [ROLES[presence.role] ?? ROLES.session, presence.where].filter(Boolean).join(' · ');
  return `${what}${job && presence.job ? ` — ${presence.job}` : ''}${id && name ? ` · ${name}` : ''}`;
}

// The agents here now as counts by role (#441), for where space is tight (a project's 30s, the home):
// "2 workers · 1 operator", each count a button that opens to its agents. agents: [{ name, role, ... }];
// isOpen(key) says which counts are open; who(agent) renders one agent.
const MANY = { operator: 'operators', shaper: 'shapers', worker: 'workers', session: 'agents' };
const ORDER = ['worker', 'operator', 'shaper', 'session'];
export function byRole(agents) {
  const groups = new Map();
  for (const a of agents) {
    const role = MANY[a.role] ? a.role : 'session';
    groups.set(role, [...(groups.get(role) ?? []), a]);
  }
  return ORDER.filter((r) => groups.has(r)).map((role) => {
    const list = groups.get(role);
    return { role, agents: list, label: `${list.length} ${list.length === 1 ? (role === 'session' ? 'agent' : role) : MANY[role]}` };
  });
}
export function roleCounts(agents, { scope = '', isOpen = () => false, who, esc }) {
  const groups = byRole(agents);
  if (!groups.length) return '';
  const key = (role) => `roles:${scope}:${role}`;
  const counts = groups.map((g) => `<button class="link role-count" data-action="toggle" data-key="${esc(key(g.role))}" aria-expanded="${isOpen(key(g.role))}">${esc(g.label)}</button>`).join(' · ');
  const open = groups.filter((g) => isOpen(key(g.role)))
    .map((g) => `<div class="role-names">${g.agents.map((a) => `<span class="a">${who(a)}</span>`).join('')}</div>`).join('');
  return `<div class="role-counts" data-new="present-agents"><span class="role-label">Here now</span> ${counts}${open}</div>`;
}
