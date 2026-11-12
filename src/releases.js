// Releases (#399): in a project set to release per milestone, a finished milestone makes the hub draft the
// next release as one "Release vX.Y.Z" item, from what landed since the last one. A person can ask for one at
// any time too (a patch for an urgent fix). From 1.0.0 the version bumps by semver (#863): any breaking item
// makes it major, otherwise any feature minor, otherwise (only fixes and internal work) a patch. On 0.x a
// breaking item or a finished milestone makes it minor, anything else a patch, until a person sets 1.0.0. The
// draft changelog is the item's summary, which a person may edit before signing: a redraft then only adds what
// it doesn't mention, and keeps a higher version a person set.
import { SYSTEM, UserError } from './core.js';
import { lastRelease, shaOf, tagAt } from './git.js';
import { holdTag, reviewRelease, unreviewed } from './security.js';

export const RELEASES = { milestone: 'per milestone', off: 'off' };

const ACCEPTANCE = [
  '- The version file says the version in the title, and CHANGELOG.md starts with its entry: the summary above, as a person left it.',
  '- It lands on main, tagged with the version in the title.',
].join('\n');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

// The next version after last, by what's in it: semver from 1.0.0; on 0.x, breaking or a milestone is minor.
export function nextVersion(last, { breaking = false, feature = false, milestone = false } = {}) {
  const [, a, b, c] = (SEMVER.exec(last ?? '') ?? [0, 0, 0, 0]).map(Number);
  if (breaking) return a ? `${a + 1}.0.0` : `0.${b + 1}.0`;
  if (a ? feature : milestone) return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
}

// An item's kind of change (#863): what it says, else a fix when it repairs landed work, else a feature, so an
// unsaid kind never makes the bump too small.
export const changeOf = (it) => it.change || (it.fixes ? 'fix' : 'feature');

// The version items bring after last, and one line saying why, e.g. "1.1.0: minor, for 3 features (#870, #871,
// #874); no breaking change".
// A finished milestone counts by its parts, unless it says its own kind.
export function bump(last, items, milestones = []) {
  const parts = items.filter((it) => it.change || !milestones.some((m) => m.id === it.id));
  const counted = parts.length ? parts : items;
  const breaking = items.filter((it) => it.breaking), features = counted.filter((it) => changeOf(it) === 'feature');
  const version = nextVersion(last, { breaking: breaking.length > 0, feature: features.length > 0, milestone: milestones.length > 0 });
  const zero = !Number((SEMVER.exec(last ?? '') ?? [0, 0])[1]);
  const n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const refs = (its) => { const s = its.slice(0, 10).map((it) => `#${it.seq}`); if (its.length > 10) s.push(`${its.length - 10} more`); return `(${s.join(', ')})`; };
  let why;
  if (breaking.length) why = `${zero ? 'minor while on 0.x' : 'major'}, for ${n(breaking.length, 'breaking change')} ${refs(breaking)}`;
  else if (!zero && features.length) why = `minor, for ${n(features.length, 'feature')} ${refs(features)}; no breaking change`;
  else if (zero && milestones.length) why = `minor, for ${n(milestones.length, 'finished milestone')} ${refs(milestones)}; no breaking change`;
  else {
    const fixes = counted.filter((it) => changeOf(it) === 'fix').length, internal = counted.length - fixes - features.length;
    const what = [fixes && n(fixes, 'fix', 'fixes'), internal && n(internal, 'internal change'), zero && features.length && n(features.length, 'feature')].filter(Boolean).join(', ');
    why = `patch, for ${what} ${refs(counted)}; ${zero ? 'no breaking change or finished milestone' : 'no breaking change or feature'}`;
  }
  return { version, why: `${version}: ${why}` };
}

// The project's open release, if any.
export const openRelease = (hub, p) => hub.q(`SELECT * FROM items WHERE project_id = ? AND release = 1 AND stage NOT IN ('done', 'dropped') ORDER BY seq LIMIT 1`).get(p.id);

// A milestone: a top-level item with parts.
const isMilestone = (hub, it) => !it.parent_id && !!hub.q('SELECT 1 FROM items WHERE parent_id = ? LIMIT 1').get(it.id);

// a < b, b = a, a > b as -1, 0, 1.
const compare = (a, b) => {
  const [x, y] = [a, b].map((v) => (SEMVER.exec(v ?? '') ?? [0, 0, 0, 0]).slice(1).map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  return 0;
};

// What the next release holds: the work done since the last one, with the version it comes to. The last one
// is the release item that landed, until a tag newer than it shows (#735): its tag can lag its landing, so its
// version is the floor and its draft's cut-off the start, or work done while it was under way goes missing.
function contents(hub, p) {
  const tagged = lastRelease(hub.repoFor(p)?.path) ?? { version: '0.0.0', tag: null, at: 0 };
  const prev = hub.q(`SELECT MAX(release_through) AS t FROM items WHERE project_id = ? AND release = 1 AND stage = 'done'`).get(p.id).t ?? 0;
  const shipped = hub.q(`SELECT * FROM items WHERE project_id = ? AND release = 1 AND stage = 'done' ORDER BY release_through DESC, seq DESC LIMIT 1`).get(p.id);
  const shippedVersion = releaseVersion(shipped);
  const ours = shippedVersion && compare(shippedVersion, tagged.version) >= 0;
  const last = ours ? { version: shippedVersion, tag: shippedVersion === tagged.version ? tagged.tag : null, at: prev } : tagged;
  const since = ours ? prev : Math.max(prev, tagged.at);
  const items = hub.q(`SELECT * FROM items WHERE project_id = ? AND stage = 'done' AND stage_since > ? AND release = 0 AND sweep = 0 AND tidy = '' AND security = '' ORDER BY seq`).all(p.id, since);
  const milestones = items.filter((it) => isMilestone(hub, it));
  const { version, why } = bump(last.version, items, milestones);
  return { last, items, milestones, version, why };
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
  const { last, items, milestones, version, why } = contents(hub, p);
  if (!items.length) return open ?? null;
  const since = last.tag ? `since ${last.tag}` : `since ${last.version === '0.0.0' ? 'the start' : `v${last.version}`}`;
  // A person may raise the version (to 1.0.0 on 0.x, say): a redraft never lowers it (#679).
  const raised = open && compare(releaseVersion(open), version) > 0 ? releaseVersion(open) : null;
  const reason = raised ? `${raised}: set by a person; by what landed it would be ${why}` : why;
  const draft = `What landed ${since}.\n\n${reason}.\n\n${changelog(hub, items, milestones)}`;
  const title = `Release v${raised ?? version}`;
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
    // The hub's own "why" line, still there word for word as a paragraph, follows the version; a person's
    // rewrite of it stays, and a draft from before #863 has no such line, so its first header stays (#868).
    const was = open.release_draft?.split('\n\n')[1];
    if (/^\d+\.\d+\.\d+: .*\.$/.test(was ?? '') && summary.includes(`\n\n${was}\n\n`)) summary = summary.replace(`\n\n${was}\n\n`, () => `\n\n${reason}.\n\n`);
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
// fetched: the mirror was fetched for it already.
export function tagRelease(hub, p, item, sha, { fetched = false } = {}) {
  const version = releaseVersion(item);
  if (!item.release || !version) return '';
  const tag = `v${version}`, short = String(sha ?? '').slice(0, 7);
  // Not a commit holding changes its security review didn't read (#936): it is tagged once they are reviewed.
  // A commit the mirror hasn't fetched yet (GitHub's merge) is judged once it has.
  const gap = unreviewed(hub, p, item, sha);
  if (gap?.unseen && !fetched) {
    track(hub, hub.fetchRepo(p, item)
      .then(() => hub.tx(() => tagRelease(hub, p, hub.itemById(item.id), sha, { fetched: true })))
      .then(() => hub.changed(p), (e) => console.error('tagging a release failed', e)));
    return '';
  }
  if (gap) return holdTag(hub, p, item, gap, { tag, sha });
  const byHand = `Tag it: git fetch origin, then git tag ${tag} ${sha || 'origin/main'}, then git push origin ${tag}.`;
  // tagged, or tag_failed: someone tags it by hand, and an operator is asked to (#760).
  const record = (headline, summary = '', type = 'tagged') => hub.event(p, { item, actor: SYSTEM, type, headline, summary, data: { tag, sha } });
  const failed = (headline, why, where) => { record(headline, byHand, 'tag_failed'); askToTag(hub, p, item, { tag, sha, why, where }); };
  if (sha && hub.localFor(p, item)) {
    if (tagAt(p.path, tag, sha)) { record(`nuworq tagged ${short} ${tag}`); return ''; }
    failed(`The hub couldn't tag ${short} ${tag} in ${p.path}`, `git tag ${tag} ${sha} failed in ${p.path}.`, p.path);
    return byHand;
  }
  const repo = hub.repoOf(p, item);
  if (!sha || !hub.github?.tag || !hub.github.covers(repo)) {
    record(`#${item.seq} landed; ${tag} needs tagging by hand`, `The hub can't write tags to ${repo || 'its repository'}. ${byHand}`, 'tag_failed');
    askToTag(hub, p, item, { tag, sha, why: `The hub can't write tags to ${repo || 'its repository'}${sha ? '' : `, and doesn't know which commit main got`}.`, where: repo });
    return byHand;
  }
  const run = hub.github.tag({ repo, tag, sha }).then(
    () => hub.tx(() => record(`nuworq tagged ${short} ${tag} on ${repo}`)),
    (e) => hub.tx(() => failed(`The hub couldn't tag ${short} ${tag} on ${repo}: ${e.message}`, `GitHub refused the hub's tag: ${e.message}`, repo)),
  ).then(() => hub.changed(p), (e) => console.error('tagging a release failed', e));
  track(hub, run);
  return '';
}

// A tag being made (or judged) in the background, so tagsSettled waits for it.
function track(hub, run) {
  const all = tagging.get(hub) ?? new Set();
  tagging.set(hub, all.add(run));
  run.finally(() => all.delete(run));
}

// A release tag the hub couldn't make (#760) is an operator question on the release item, so next hands it to an
// operator instead of it sitting unseen as a tag_failed event. One per release; settleTags closes it once the tag
// shows. where: the repository (or the checkout) to tag in.
const TAG_QUESTION = 'Tag the release';
function askToTag(hub, p, item, { tag, sha, why, where }) {
  const open = hub.q(`SELECT 1 FROM questions WHERE item_id = ? AND asked_by = ? AND audience = 'operator' AND status = 'open' AND question LIKE ?`)
    .get(item.id, SYSTEM, `${TAG_QUESTION} %`);
  if (open) return;
  const at = sha || 'origin/main';
  const command = `git tag ${tag} ${at} && git push origin refs/tags/${tag}`;
  const question = `${TAG_QUESTION} ${tag}: the hub couldn't tag #${item.seq} on ${where || 'its repository'}`;
  const context = `${why}\n\nIn a checkout of ${where || 'the repository'} that may push tags, run git fetch origin, then:\n\n${command}\n\n`
    + `Releases are signed from their tags, so until it exists the release sits untagged on main. This question closes itself once the hub's copy of the repository has ${tag}.`;
  const steps = [{ do: `git fetch origin, then ${command}`, where: `a checkout of ${where || 'the repository'} that may push tags`, check: `git ls-remote origin refs/tags/${tag} prints ${sha || 'the commit main got'}` }];
  const id = Number(hub.q(`INSERT INTO questions (project_id, item_id, asked_by, question, context, options, blocking, assumption, at, audience, steps)
    VALUES (?, ?, ?, ?, ?, '[]', 1, '', ?, 'operator', ?)`).run(p.id, item.id, SYSTEM, question, context, hub.now(), JSON.stringify(steps)).lastInsertRowid);
  hub.event(p, { item, actor: SYSTEM, type: 'question', headline: `nuworq asks an operator: ${question}`, summary: context, data: { question: id, tag, sha } });
}

// Close the tagging questions whose tag now shows in the project's repository (its checkout, or the hub's mirror
// of it). fresh: a mirror on this machine is fetched first. In a transaction.
export function settleTags(hub, p, { fresh = false } = {}) {
  const open = hub.q(`SELECT q.id, q.item_id FROM questions q WHERE q.project_id = ? AND q.asked_by = ? AND q.audience = 'operator' AND q.status = 'open' AND q.question LIKE ?`)
    .all(p.id, SYSTEM, `${TAG_QUESTION} %`);
  for (const q of open) {
    const item = hub.itemById(q.item_id), version = releaseVersion(item);
    const path = version && hub.repoFor(p, item, { fresh })?.path;
    const at = path && shaOf(path, `refs/tags/v${version}`);
    if (!at) continue;
    const reason = `v${version} is on ${hub.repoOf(p, item) || p.path} at ${at.slice(0, 7)}`;
    hub.q(`UPDATE questions SET status = 'withdrawn', closed_reason = ?, held_by = '', held_until = 0 WHERE id = ?`).run(reason, q.id);
    hub.event(p, { item, actor: SYSTEM, type: 'question_withdrawn', headline: `nuworq withdrew its question: ${reason}`, summary: `Why: ${reason}`, data: { question: q.id } });
  }
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
