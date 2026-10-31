// Releases (#399): in a project set to release per milestone, a finished milestone makes the hub draft the
// next release as one "Release vX.Y.Z" item, from what landed since the last one. A person can ask for one at
// any time too (a patch for an urgent fix). The version bumps by who must act: any breaking item makes it
// major (minor while on 0.x), any finished milestone minor, anything else a patch. The draft changelog is the
// item's summary, which a person may edit before signing: a redraft then only adds what it doesn't mention.
import { SYSTEM, UserError } from './core.js';
import { lastRelease } from './git.js';

export const RELEASES = { milestone: 'per milestone', off: 'off' };

const ACCEPTANCE = [
  '- The version file says the version in the title, and CHANGELOG.md starts with its entry: the summary above, as a person left it.',
  '- It lands on main, tagged with the version in the title.',
].join('\n');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

// The next version after last, by what's in it.
export function nextVersion(last, { breaking = false, milestone = false } = {}) {
  const [, a, b, c] = (SEMVER.exec(last ?? '') ?? [0, 0, 0, 0]).map(Number);
  if (breaking) return a ? `${a + 1}.0.0` : `0.${b + 1}.0`;
  if (milestone) return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
}

// The project's open release, if any.
export const openRelease = (hub, p) => hub.q(`SELECT * FROM items WHERE project_id = ? AND release = 1 AND stage NOT IN ('done', 'dropped') ORDER BY seq LIMIT 1`).get(p.id);

// A milestone: a top-level item with parts.
const isMilestone = (hub, it) => !it.parent_id && !!hub.q('SELECT 1 FROM items WHERE parent_id = ? LIMIT 1').get(it.id);

// What the next release holds: the work done since the last one (the last release item's draft, or the
// last tag's commit, whichever is later), with the version it comes to.
function contents(hub, p) {
  const last = lastRelease(hub.repoFor(p)?.path) ?? { version: '0.0.0', tag: null, at: 0 };
  const prev = hub.q(`SELECT MAX(release_through) AS t FROM items WHERE project_id = ? AND release = 1 AND stage = 'done'`).get(p.id).t ?? 0;
  const since = Math.max(prev, last.at);
  const items = hub.q(`SELECT * FROM items WHERE project_id = ? AND stage = 'done' AND stage_since > ? AND release = 0 AND sweep = 0 AND tidy = '' ORDER BY seq`).all(p.id, since);
  const milestones = items.filter((it) => isMilestone(hub, it));
  const version = nextVersion(last.version, { breaking: items.some((it) => it.breaking), milestone: milestones.length > 0 });
  return { last, items, milestones, version };
}

// The changelog for items: each finished milestone with its parts under it, then the rest, then upgrade notes.
function changelog(hub, items, milestones) {
  const top = (it) => { let a = it; while (a.parent_id) a = hub.itemById(a.parent_id); return a; };
  const line = (it) => `- ${it.title} (#${it.seq})`;
  const out = [];
  for (const m of milestones) {
    out.push(`### ${m.title} (#${m.seq})`, ...items.filter((it) => it.id !== m.id && top(it).id === m.id).map(line), '');
  }
  const rest = items.filter((it) => !milestones.some((m) => m.id === it.id || top(it).id === m.id));
  if (rest.length) out.push(milestones.length ? '### Also in this release' : '### In this release', ...rest.map(line), '');
  const breaking = items.filter((it) => it.breaking);
  if (breaking.length) out.push('### Upgrade notes', ...breaking.map((it) => `- ${it.breaking} (#${it.seq})`), '');
  return out.join('\n').trim();
}

// Draft the project's next release, or redraft the open one. An open release a worker has started is kept
// as it is: what lands after it goes in the one after. Returns the release item, or null when nothing landed.
export function draftRelease(hub, p, by = SYSTEM) {
  const open = openRelease(hub, p);
  if (open && !['proposed', 'ready', 'outside', 'waiting'].includes(open.stage)) return open;
  const { last, items, milestones, version } = contents(hub, p);
  if (!items.length) return open ?? null;
  const since = last.tag ? `since ${last.tag}` : `since ${last.version === '0.0.0' ? 'the start' : `v${last.version}`}`;
  const draft = `What landed ${since}.\n\n${changelog(hub, items, milestones)}`;
  const title = `Release v${version}`;
  const through = hub.now();
  if (!open) {
    const it = hub.createItem(p, by, { title, summary: draft, acceptance: ACCEPTANCE, priority: 'soon' });
    hub.patch(it, { release: 1, release_draft: draft, release_through: through });
    if (it.stage !== 'ready') hub.move(it, 'ready', by); // drafted from what landed: nothing to shape
    hub.event(p, { item: it, actor: by, type: 'release', headline: `${by === SYSTEM ? 'nuworq' : by} drafted ${title}: ${items.length} item${items.length === 1 ? '' : 's'} landed ${since}` });
    return it;
  }
  // Untouched, the summary is redrafted whole; edited by a person, only what it doesn't mention is added.
  let summary = draft;
  if (open.summary !== open.release_draft) {
    const fresh = items.filter((it) => !open.summary.includes(`(#${it.seq})`));
    summary = fresh.length ? `${open.summary}\n\n#### Landed since this was edited\n\n${changelog(hub, fresh, milestones.filter((m) => fresh.includes(m)))}` : open.summary;
  }
  if (summary === open.summary && title === open.title) { hub.patch(open, { release_through: through }); return open; }
  hub.patch(open, { title, summary, release_draft: summary, release_through: through });
  hub.event(p, { item: open, actor: by, type: 'release', headline: `${by === SYSTEM ? 'nuworq' : by} redrafted #${open.seq} as ${title}` });
  return open;
}

// An item is done. In a project that releases per milestone: a finished milestone drafts the release, and a
// release that lands drafts the next at once when a milestone finished while it was under way.
export function landed(hub, item) {
  if (!item.release && !isMilestone(hub, item)) return;
  const p = hub.q('SELECT * FROM projects WHERE id = ?').get(item.project_id);
  if (p.releases !== 'milestone') return;
  if (item.release && !contents(hub, p).milestones.length) return;
  draftRelease(hub, p);
}

// A person (or an agent for them) asks for a release now, whatever the setting.
export function askRelease(hub, p, by) {
  const it = draftRelease(hub, p, by);
  if (!it) {
    const { last } = contents(hub, p);
    throw new UserError(`Nothing has landed since ${last.tag ?? (last.version === '0.0.0' ? 'the start' : `v${last.version}`)}`, { status: 409, hint: 'A release ships work that landed. Ask again once something is done.' });
  }
  return it;
}
