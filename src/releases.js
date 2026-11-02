// Releases (#399): in a project set to release per milestone, a finished milestone makes the hub draft the
// next release as one "Release vX.Y.Z" item, from what landed since the last one. A person can ask for one at
// any time too (a patch for an urgent fix). The version bumps by who must act: any breaking item makes it
// major (minor while on 0.x), any finished milestone minor, anything else a patch. The draft changelog is the
// item's summary, which a person may edit before signing: a redraft then only adds what it doesn't mention.
import { SYSTEM, UserError } from './core.js';
import { lastRelease, tagAt } from './git.js';
import { reviewRelease } from './security.js';

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
  const items = hub.q(`SELECT * FROM items WHERE project_id = ? AND stage = 'done' AND stage_since > ? AND release = 0 AND sweep = 0 AND tidy = '' AND security = '' ORDER BY seq`).all(p.id, since);
  const milestones = items.filter((it) => isMilestone(hub, it));
  const version = nextVersion(last.version, { breaking: items.some((it) => it.breaking), milestone: milestones.length > 0 });
  return { last, items, milestones, version };
}

// The changelog for items: each finished milestone with its parts under it, then the rest, then upgrade notes.
function changelog(hub, items, milestones) {
  const top = (it) => { let a = it; while (a.parent_id) a = hub.itemById(a.parent_id); return a; };
  const line = (it) => `- ${it.title} (#${it.seq})`;
  // Each section a bold line, a blank line, then its list: what the drawer and a CHANGELOG both render.
  const out = [];
  const section = (head, lines) => out.push(`**${head}**\n\n${lines.join('\n')}`.trim());
  for (const m of milestones) section(`${m.title} (#${m.seq})`, items.filter((it) => it.id !== m.id && top(it).id === m.id).map(line));
  const rest = items.filter((it) => !milestones.some((m) => m.id === it.id || top(it).id === m.id));
  if (rest.length) section(milestones.length ? 'Also in this release' : 'In this release', rest.map(line));
  const breaking = items.filter((it) => it.breaking);
  if (breaking.length) section('Upgrade notes', breaking.map((it) => `- ${it.breaking} (#${it.seq})`));
  return out.join('\n\n');
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
    reviewRelease(hub, p, it, by); // security reviews on (#480): it waits for a review of what it ships
    return it;
  }
  // Untouched, the summary is redrafted whole; edited by a person, only what it doesn't mention is added.
  // release_draft keeps the hub's own draft, never the merged summary, so an edit stays an edit (#737).
  let summary = draft;
  if (open.summary !== open.release_draft) {
    const fresh = items.filter((it) => !open.summary.includes(`(#${it.seq})`));
    summary = fresh.length ? `${open.summary}\n\nLanded since this was edited:\n\n${changelog(hub, fresh, milestones.filter((m) => fresh.includes(m)))}` : open.summary;
  }
  if (summary === open.summary && title === open.title) { hub.patch(open, { release_through: through }); return open; }
  hub.patch(open, { title, summary, release_draft: draft, release_through: through });
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

// The version a release item's title names ("Release v1.5.0"), or null.
export const releaseVersion = (item) => /^Release v(\d+\.\d+\.\d+)$/.exec(String(item?.title ?? '').trim())?.[1] ?? null;

const tagging = new WeakMap(); // hub → its tags being made on GitHub

// A release item landed (#400): the hub tags the commit main got as vX.Y.Z. In a checkout on this machine, there;
// on GitHub, as the hub's GitHub App. Otherwise the hub can't write to the repository, and says how to tag it by
// hand. sha: the commit main got (its pull request's merge, or its branch's head). In a transaction; returns a
// sentence for whoever landed it ('' when there is nothing for them to do).
export function tagRelease(hub, p, item, sha) {
  const version = releaseVersion(item);
  if (!item.release || !version) return '';
  const tag = `v${version}`, short = String(sha ?? '').slice(0, 7);
  const byHand = `Tag it: git fetch origin, then git tag ${tag} ${sha || 'origin/main'}, then git push origin ${tag}.`;
  // tagged, or tag_failed: someone tags it by hand.
  const record = (headline, summary = '', type = 'tagged') => hub.event(p, { item, actor: SYSTEM, type, headline, summary, data: { tag, sha } });
  if (sha && hub.localFor(p, item)) {
    if (tagAt(p.path, tag, sha)) { record(`nuworq tagged ${short} ${tag}`); return ''; }
    record(`The hub couldn't tag ${short} ${tag} in ${p.path}`, byHand, 'tag_failed');
    return byHand;
  }
  const repo = hub.repoOf(p, item);
  if (!sha || !hub.github?.tag || !hub.github.covers(repo)) {
    record(`#${item.seq} landed; ${tag} needs tagging by hand`, `The hub can't write tags to ${repo || 'its repository'}. ${byHand}`, 'tag_failed');
    return byHand;
  }
  const run = hub.github.tag({ repo, tag, sha }).then(
    () => hub.tx(() => record(`nuworq tagged ${short} ${tag} on ${repo}`)),
    (e) => hub.tx(() => record(`The hub couldn't tag ${short} ${tag} on ${repo}: ${e.message}`, byHand, 'tag_failed')),
  ).then(() => hub.changed(p), (e) => console.error('tagging a release failed', e));
  const all = tagging.get(hub) ?? new Set();
  tagging.set(hub, all.add(run));
  run.finally(() => all.delete(run));
  return '';
}

// Resolves once every tag being made is made (or has failed). For tests.
export const tagsSettled = async (hub) => { while (tagging.get(hub)?.size) await Promise.all(tagging.get(hub)); };

// A person (or an agent for them) asks for a release now, whatever the setting.
export function askRelease(hub, p, by) {
  const it = draftRelease(hub, p, by);
  if (!it) {
    const { last } = contents(hub, p);
    throw new UserError(`Nothing has landed since ${last.tag ?? (last.version === '0.0.0' ? 'the start' : `v${last.version}`)}`, { status: 409, hint: 'A release ships work that landed. Ask again once something is done.' });
  }
  return it;
}
