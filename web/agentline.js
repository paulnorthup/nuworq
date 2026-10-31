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
