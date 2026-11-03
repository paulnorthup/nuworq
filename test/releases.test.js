import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hub, PERSON_CAN } from '../src/core.js';
import { view } from '../src/insight.js';
import { OPS, MODE_RULES, guide } from '../src/protocol.js';
import { bump, changeOf, nextVersion, releaseVersion, tagRelease, tagsSettled } from '../src/releases.js';
import { prMerged } from '../src/github.js';
import { appSource } from './appsource.js';

// When a milestone finishes, the hub drafts the next release (#399).
const T0 = Date.UTC(2026, 9, 1);
const iso = (t) => new Date(t).toISOString();

// A repository whose main has package.json at pkg (none when null), and tags: [[tag, at]].
function repo({ pkg = null, tags = [] } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-release-')));
  const g = (at, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: iso(at), GIT_AUTHOR_DATE: iso(at) },
  }).trim();
  g(T0, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'package.json'), pkg ? JSON.stringify({ name: 'x', version: pkg }) : '{}');
  g(T0, 'add', '.');
  g(T0, 'commit', '-qm', 'init');
  for (const [tag, at] of tags) {
    writeFileSync(join(dir, 'f'), tag);
    g(at, 'add', '.');
    g(at, 'commit', '-qm', tag);
    g(at, 'tag', tag);
  }
  return dir;
}

function world({ releases = 'milestone', ...r } = {}) {
  let t = T0 + 1000;
  const hub = new Hub({ clock: () => (t += 1000) });
  hub.tx(() => hub.project('p', { create: true }));
  hub.humanOp('p', 'settings', { path: repo(r), releases, fresh: false });
  const add = (title, more = {}) => hub.humanOp('p', 'create', { title, acceptance: 'x', ...more }).item;
  const done = (item) => hub.humanOp('p', 'update', { item, stage: 'done' });
  // A milestone with parts; each part done, then the milestone.
  const milestone = (title, parts) => {
    const m = add(title);
    const kids = parts.map((pt) => (typeof pt === 'string' ? add(pt, { parent: m }) : add(pt.title, { parent: m, ...pt })));
    for (const k of kids) done(k);
    done(m);
    return { m, kids };
  };
  const releases_ = () => hub.q('SELECT * FROM items WHERE release = 1 ORDER BY seq').all();
  return { hub, add, done, milestone, releases: releases_, at: (ms) => (t = ms) };
}

describe('the version (#399)', () => {
  test('0.x: breaking or a milestone is minor; anything else a patch', () => {
    assert.equal(nextVersion('0.2.0', { breaking: true }), '0.3.0');
    assert.equal(nextVersion('0.2.5', { milestone: true }), '0.3.0');
    assert.equal(nextVersion('0.2.5', { feature: true }), '0.2.6', 'on 0.x a feature alone stays a patch');
    assert.equal(nextVersion('0.0.0', { milestone: true }), '0.1.0');
  });

  test('from 1.0.0, semver (#863): breaking is major, a feature minor, fixes and internal work a patch', () => {
    assert.equal(nextVersion('1.4.2', { breaking: true, feature: true }), '2.0.0');
    assert.equal(nextVersion('1.4.2', { feature: true }), '1.5.0');
    assert.equal(nextVersion('1.4.2', { milestone: true }), '1.4.3', 'a finished milestone alone no longer bumps the minor');
    assert.equal(nextVersion('1.4.2'), '1.4.3');
  });

  test('bump reads each item\'s kind, and says why (#863)', () => {
    const it = (seq, more = {}) => ({ id: seq, seq, change: '', fixes: null, breaking: '', ...more });
    assert.deepEqual(bump('1.2.3', [it(1, { change: 'fix' }), it(2, { breaking: 'Move to /v2', change: 'internal' })]),
      { version: '2.0.0', why: '2.0.0: major, for 1 breaking change (#2)' });
    assert.deepEqual(bump('1.2.3', [it(1, { change: 'feature' }), it(2, { change: 'fix' }), it(3, { change: 'feature' })]),
      { version: '1.3.0', why: '1.3.0: minor, for 2 features (#1, #3); no breaking change' });
    assert.deepEqual(bump('1.2.3', [it(1, { change: 'fix' }), it(2, { change: 'internal' }), it(3, { fixes: 9 })]),
      { version: '1.2.4', why: '1.2.4: patch, for 2 fixes, 1 internal change (#1, #2, #3); no breaking change or feature' });
    assert.equal(bump('1.2.3', [it(1)]).version, '1.3.0', 'an item with no kind counts as a feature');
    assert.equal(changeOf(it(1)), 'feature');
    assert.equal(changeOf(it(1, { fixes: 4 })), 'fix', 'an item that repairs landed work is a fix');
    assert.equal(changeOf(it(1, { fixes: 4, change: 'internal' })), 'internal', 'what it says wins');
    // 0.x keeps the old rule, and says so.
    assert.equal(bump('0.11.0', [it(1, { change: 'feature' })]).version, '0.11.1');
    assert.equal(bump('0.11.0', [it(1, { breaking: 'x' })]).why, '0.12.0: minor while on 0.x, for 1 breaking change (#1)');
    assert.equal(bump('0.11.0', [it(1), it(2)], [it(2)]).why, '0.12.0: minor, for 1 finished milestone (#2); no breaking change');
    // A milestone counts by its parts, unless it says its own kind.
    assert.equal(bump('1.2.3', [it(1, { change: 'fix' }), it(2)], [it(2)]).version, '1.2.4');
    assert.equal(bump('1.2.3', [it(1, { change: 'fix' }), it(2, { change: 'feature' })], [it(2)]).version, '1.3.0');
    const many = Array.from({ length: 12 }, (_, k) => it(k + 1));
    assert.match(bump('1.0.0', many).why, /^1\.1\.0: minor, for 12 features \(#1, .*#10, 2 more\); no breaking change$/);
  });
});

describe('each item says its kind of change (#863)', () => {
  test('propose and refine set change; a wrong kind is refused with a hint; "" leaves it unsaid', () => {
    const w = world({ tags: [['v1.0.0', T0]] });
    w.hub.agentOp('p', 'checkin', 'a1', {});
    w.hub.agentOp('p', 'propose', 'a1', { title: 'Add export', acceptance: 'x', change: 'feature' });
    assert.equal(w.hub.q('SELECT change FROM items WHERE title = ?').get('Add export').change, 'feature');
    const id = w.add('Fix the crash');
    const change = () => w.hub.q('SELECT change FROM items WHERE title = ?').get('Fix the crash').change;
    w.hub.agentOp('p', 'refine', 'a1', { item: id, change: 'fix' });
    assert.equal(change(), 'fix');
    assert.throws(() => w.hub.humanOp('p', 'update', { item: id, change: 'chore' }), (e) => /isn't a kind of change/.test(e.message) && /internal/.test(e.hint));
    w.hub.humanOp('p', 'update', { item: id, change: '' });
    assert.equal(change(), '');
    assert.deepEqual(OPS.find((o) => o.name === 'propose').params.change.enum, ['feature', 'fix', 'internal']);
    assert.ok(OPS.find((o) => o.name === 'refine').params.change, 'refine takes it too, "" included');
    assert.match(MODE_RULES.shape, /Set change to its kind/);
    assert.match(guide({ project: 'p' }), /Never create, move or push tags/);
    assert.match(MODE_RULES.release, /Never create, move or push a tag yourself/);
  });

  test('after 1.0.0: features make the draft minor, fixes and internal work a patch, and the summary says why', () => {
    const w = world({ tags: [['v1.2.3', T0]] });
    w.milestone('Polish', [{ title: 'Fix the crash', change: 'fix' }, { title: 'Tidy tests', change: 'internal' }]);
    const [r] = w.releases();
    assert.equal(r.title, 'Release v1.2.4', 'a milestone of fixes and internal work is a patch');
    assert.match(r.summary, /^What landed since v1\.2\.3\.\n\n1\.2\.4: patch, for 1 fix, 1 internal change \(#\d+, #\d+\); no breaking change or feature\.\n\n/);
    w.done(w.add('Add export')); // no kind: a feature
    w.hub.humanOp('p', 'release');
    assert.equal(w.releases().length, 1);
    assert.equal(w.releases()[0].title, 'Release v1.3.0');
    assert.match(w.releases()[0].summary, /\n\n1\.3\.0: minor, for 1 feature \(#\d+\); no breaking change\.\n\n/);
  });

  test('a person edited the draft: on redraft the hub\'s "why" line follows the version, their words stay (#868)', () => {
    const w = world({ tags: [['v1.2.3', T0]] });
    w.milestone('Polish', [{ title: 'Fix the crash', change: 'fix' }]);
    const [r] = w.releases();
    w.hub.humanOp('p', 'update', { item: r.id, summary: r.summary.replace('- Fix the crash', '- Fixed the crash on start') });
    const feature = w.add('Add export');
    w.done(feature);
    w.hub.humanOp('p', 'release');
    const s = w.releases()[0];
    assert.equal(s.title, 'Release v1.3.0');
    assert.match(s.summary, new RegExp(`\\n\\n1\\.3\\.0: minor, for 1 feature \\(#${feature.slice(1)}\\); no breaking change\\.\\n\\n`));
    assert.doesNotMatch(s.summary, /1\.2\.4: patch/);
    assert.match(s.summary, /- Fixed the crash on start/, 'the person\'s edit is kept');
    assert.match(s.summary, /Landed since this was edited:\n\n\*\*In this release\*\*\n\n- Add export/, 'the feature is still added');
    // A person's own rewrite of the line is left alone.
    w.hub.humanOp('p', 'update', { item: r.id, summary: s.summary.replace(/\n\n1\.3\.0: minor[^\n]*\n\n/, '\n\nA minor release: export is new.\n\n') });
    w.done(w.add('Add import'));
    w.hub.humanOp('p', 'release');
    const t = w.releases()[0].summary;
    assert.match(t, /A minor release: export is new\./);
    assert.doesNotMatch(t, /1\.3\.0: minor, for 2 features/);
  });

  test('a person edited a draft from before #863: its first section header stays on redraft (#868)', () => {
    const w = world({ tags: [['v1.2.3', T0]] });
    const { m, kids: [fix] } = w.milestone('Polish', [{ title: 'Fix the crash', change: 'fix' }]);
    const [r] = w.releases();
    const old = `What landed since v1.2.3.\n\n**Polish (${m})**\n\n- Fix the crash (${fix})`;
    w.hub.q('UPDATE items SET summary = ?, release_draft = ? WHERE id = ?').run(old, old, r.id);
    w.hub.humanOp('p', 'update', { item: r.id, summary: old.replace('- Fix the crash', '- Fixed the crash on start') });
    w.done(w.add('Add export'));
    w.hub.humanOp('p', 'release');
    const s = w.releases()[0];
    assert.equal(s.title, 'Release v1.3.0');
    assert.match(s.summary, new RegExp(`^What landed since v1\\.2\\.3\\.\\n\\n\\*\\*Polish \\(${m}\\)\\*\\*\\n\\n- Fixed the crash on start`), 'the header and the edit stay');
    assert.match(s.summary, /Landed since this was edited:\n\n\*\*In this release\*\*\n\n- Add export/);
  });

  test('a person\'s higher version is kept through redrafts, and the summary says so (#679)', () => {
    const w = world({ pkg: '0.11.0' });
    w.milestone('Push', [{ title: 'Add export', change: 'feature' }]);
    const [r] = w.releases();
    assert.equal(r.title, 'Release v0.12.0', 'on 0.x a finished milestone is minor');
    w.hub.humanOp('p', 'update', { item: r.id, title: 'Release v1.0.0' });
    w.milestone('More', [{ title: 'Fix the crash', change: 'fix' }]);
    assert.equal(w.releases().length, 1);
    assert.equal(w.releases()[0].title, 'Release v1.0.0', 'a redraft keeps the version a person set');
    assert.match(w.releases()[0].summary, /\n\n1\.0\.0: set by a person; by what landed it would be 0\.12\.0: minor, for 2 finished milestones/);
  });
});

describe('a finished milestone drafts the release (#399)', () => {
  test('minor: one "Release" item, the milestone with its parts under it', () => {
    const w = world({ pkg: '9.9.9', tags: [['v1.4.2', T0]] });
    w.add('Not done yet');
    const { m } = w.milestone('Faster search', ['Index titles', 'Rank by recency']);
    const [r] = w.releases();
    assert.equal(r.title, 'Release v1.5.0', 'the newest tag wins over the version file');
    assert.equal(r.stage, 'ready');
    assert.match(r.summary, /^What landed since v1\.4\.2\./);
    assert.match(r.summary, new RegExp(`\\*\\*Faster search \\(#${m.slice(1)}\\)\\*\\*\\n\\n- Index titles \\(#\\d+\\)\\n- Rank by recency \\(#\\d+\\)`));
    assert.doesNotMatch(r.summary, /Not done yet|Upgrade notes/);
    assert.match(r.acceptance, /CHANGELOG\.md/);
  });

  test('major: a breaking item makes it major, with its upgrade note', () => {
    const w = world({ tags: [['v1.4.2', T0]] });
    w.milestone('New API', [{ title: 'Drop /v1', breaking: 'Clients calling /v1 must move to /v2' }, 'Add /v2']);
    const [r] = w.releases();
    assert.equal(r.title, 'Release v2.0.0');
    assert.match(r.summary, /\*\*Upgrade notes\*\*\n\n- Clients calling \/v1 must move to \/v2 \(#\d+\)/);
  });

  test('0.x: breaking stays minor; with no tag, the version file is the last release', () => {
    const w = world({ pkg: '0.2.0' });
    w.milestone('New API', [{ title: 'Drop /v1', breaking: 'Move to /v2' }]);
    assert.equal(w.releases()[0].title, 'Release v0.3.0');
    assert.match(w.releases()[0].summary, /^What landed since v0\.2\.0\./);
  });

  test('a person sets the draft to 1.0.0, and it stays that through a redraft (#679)', () => {
    const w = world({ pkg: '0.9.0' });
    w.milestone('Push', [{ title: 'Drop /v1', breaking: 'Move to /v2' }]);
    const [r] = w.releases();
    assert.equal(r.title, 'Release v0.10.0', 'on 0.x a breaking item bumps only the minor');
    w.hub.humanOp('p', 'update', { item: r.id, title: 'Release v1.0.0' });
    assert.equal(w.hub.itemById(r.id).title, 'Release v1.0.0');
    w.milestone('More', ['B']);
    assert.equal(w.releases().length, 1);
    assert.equal(w.releases()[0].title, 'Release v1.0.0', 'a redraft keeps the version a person set');
    assert.equal(releaseVersion(w.releases()[0]), '1.0.0');
    assert.equal(nextVersion('1.0.0', { breaking: true }), '2.0.0');
    assert.equal(nextVersion('1.0.0', { feature: true }), '1.1.0');
  });

  test('no tag and no version file: the first release is 0.1.0, of everything done', () => {
    const w = world();
    w.done(w.add('Early fix'));
    w.milestone('First things', ['A']);
    const [r] = w.releases();
    assert.equal(r.title, 'Release v0.1.0');
    assert.match(r.summary, /^What landed since the start\./);
    assert.match(r.summary, /\*\*Also in this release\*\*\n\n- Early fix/);
  });

  test('work done before the last tag is not in it', () => {
    const w = world({ tags: [['v1.0.0', T0 + 3_600_000]] });
    w.done(w.add('Shipped in 1.0.0'));
    w.at(T0 + 7_200_000);
    w.milestone('After', ['B']);
    const [r] = w.releases();
    assert.doesNotMatch(r.summary, /Shipped in 1\.0\.0/);
    assert.match(r.summary, /\*\*After/);
  });

  test('two milestones before the first is released: one release item with both', () => {
    const w = world({ tags: [['v1.0.0', T0]] });
    w.milestone('One', ['a']);
    w.milestone('Two', ['b']);
    const rs = w.releases();
    assert.equal(rs.length, 1);
    assert.equal(rs[0].title, 'Release v1.1.0');
    assert.match(rs[0].summary, /\*\*One[\s\S]*\*\*Two/);
    // A breaking part in a third makes the same item major.
    w.milestone('Three', [{ title: 'c', breaking: 'Run the migration' }]);
    assert.equal(w.releases().length, 1);
    assert.equal(w.releases()[0].title, 'Release v2.0.0');
  });

  test('a person edits the draft: a redraft keeps their words and adds only what is new', () => {
    const w = world({ tags: [['v1.0.0', T0]] });
    w.milestone('One', ['a']);
    const r = w.releases()[0];
    w.hub.humanOp('p', 'update', { item: `#${r.seq}`, summary: `${r.summary}\n\nThanks to everyone.` });
    w.milestone('Two', ['b']);
    const s = w.releases()[0].summary;
    assert.match(s, /\*\*One[\s\S]*Thanks to everyone\.\n\nLanded since this was edited:\n\n\*\*Two \(#\d+\)\*\*\n\n- b/);
    assert.equal(s.match(/\*\*One/g).length, 1, 'not repeated');
    // Still edited at the next redraft: their words stay, and only Three is added (#737).
    w.milestone('Three', ['c']);
    const t = w.releases()[0].summary;
    assert.match(t, /Thanks to everyone\./);
    assert.equal(t.match(/\*\*Two/g).length, 1, 'Two not repeated');
    assert.equal(t.match(/\*\*Three/g).length, 1, 'Three added once');
  });

  test('once the release is under way, later work goes in the next one', () => {
    const w = world({ tags: [['v1.0.0', T0]] });
    w.milestone('One', ['a']);
    const r = w.releases()[0];
    w.hub.agentOp('p', 'checkin', 'a1', {});
    w.hub.agentOp('p', 'claim', 'a1', { item: `#${r.seq}` });
    w.milestone('Two', ['b']);
    assert.equal(w.releases().length, 1, 'the started one is kept as it was');
    assert.doesNotMatch(w.releases()[0].summary, /\*\*Two/);
    w.done(`#${r.seq}`); // it lands, and Two finished meanwhile: the next is drafted at once
    const next = w.releases()[1];
    assert.equal(next.title, 'Release v1.2.0', 'the tag is still v1.0.0 here, but v1.1.0 landed: it is the floor (#735)');
    assert.match(next.summary, /\*\*Two/);
    assert.doesNotMatch(next.summary, /\*\*One/);
    assert.match(next.summary, /^What landed since v1\.1\.0\./);
  });

  test('work done while a release is under way is in exactly one changelog, however late the tag shows (#735)', () => {
    const w = world({ tags: [['v1.0.0', T0]] });
    w.milestone('One', ['a']);
    const r = w.releases()[0];
    w.hub.agentOp('p', 'checkin', 'a1', {});
    w.hub.agentOp('p', 'claim', 'a1', { item: `#${r.seq}` });
    w.milestone('Two', ['b']); // finished while One's release is under way
    w.done(`#${r.seq}`);
    const next = w.releases()[1];
    const before = { title: next.title, summary: next.summary };
    // Now the tag shows, dated after Two finished; a redraft keeps the same version and contents.
    const dir = w.hub.project('p').path;
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', dir, 'commit', '-q', '--allow-empty', '-m', 'Release v1.1.0'], {
      env: { ...process.env, GIT_COMMITTER_DATE: iso(T0 + 1e9), GIT_AUTHOR_DATE: iso(T0 + 1e9) },
    });
    execFileSync('git', ['-C', dir, 'tag', 'v1.1.0']);
    w.hub.humanOp('p', 'release');
    const again = w.hub.q('SELECT * FROM items WHERE id = ?').get(next.id);
    assert.deepEqual({ title: again.title, summary: again.summary }, before);
    assert.equal(w.releases().length, 2);
    // More lands after the tag: the redraft still holds Two, and keeps the version.
    w.at(T0 + 2e9);
    w.done(w.add('c'));
    w.hub.humanOp('p', 'release');
    const later = w.hub.q('SELECT * FROM items WHERE id = ?').get(next.id);
    assert.equal(later.title, 'Release v1.2.0');
    assert.match(later.summary, /\*\*Two/);
    assert.match(later.summary, /- c \(#/);
    assert.equal(w.releases().length, 2);
  });

  test('releases off: a finished milestone drafts nothing', () => {
    const w = world({ releases: 'off', tags: [['v1.0.0', T0]] });
    w.milestone('One', ['a']);
    assert.equal(w.releases().length, 0);
  });
});

describe('asking for a release (#399)', () => {
  test('a person asks for one at any time: a patch for a fix, the same way', () => {
    const w = world({ releases: 'off', tags: [['v1.0.0', T0]] });
    assert.throws(() => w.hub.humanOp('p', 'release'), /Nothing has landed since v1\.0\.0/);
    w.done(w.add('Fix the crash', { change: 'fix' }));
    const r = w.hub.humanOp('p', 'release');
    assert.equal(r.title, 'Release v1.0.1');
    assert.match(w.releases()[0].summary, /\*\*In this release\*\*\n\n- Fix the crash/);
    assert.ok(PERSON_CAN.steward.includes('release'));
    assert.ok(!PERSON_CAN.member.includes('release'));
  });

  test('an agent asks through propose with release', () => {
    const w = world({ tags: [['v1.0.0', T0]] });
    w.hub.agentOp('p', 'checkin', 'a1', {});
    w.done(w.add('Fix the crash', { change: 'fix' }));
    const r = w.hub.agentOp('p', 'propose', 'a1', { title: 'Release', release: true });
    assert.equal(r.title, 'Release v1.0.1');
    assert.equal(w.hub.agentOp('p', 'propose', 'a1', { title: 'Release', release: true }).item, r.item, 'asked again: the same item');
    assert.ok(OPS.find((o) => o.name === 'propose').params.release);
  });
});

describe('a release that lands is tagged with its version (#400)', () => {
  const git = (dir, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', dir, ...a], { encoding: 'utf8' }).trim();

  test('in a checkout on the hub\'s machine: the lander submits, the hub tags the commit vX.Y.Z', () => {
    const w = world({ tags: [['v1.4.2', T0]] });
    w.milestone('Faster search', ['Index titles']);
    const [r] = w.releases();
    w.hub.agentOp('p', 'checkin', 'a1', {});
    const job = w.hub.agentOp('p', 'next', 'a1', {});
    assert.equal(job.item, `#${r.seq}`);
    assert.match(job.hint, /This is a release: set the version file to 1\.5\.0 .* top of CHANGELOG\.md under "## 1\.5\.0 \(\d{4}-\d\d-\d\d\)"/);
    // Built, accepted and put on main by hand, as a land job does.
    const dir = w.hub.project('p').path;
    git(dir, 'switch', '-q', '-c', job.branch);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.5.0' }));
    writeFileSync(join(dir, 'CHANGELOG.md'), `## 1.5.0 (2026-10-31)\n\n${r.summary}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'Release v1.5.0');
    const sha = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'switch', '-q', 'main');
    git(dir, 'merge', '-q', '--ff-only', job.branch);
    w.hub.patch(w.hub.itemById(r.id), { stage: 'landing', holder: 'a1', lease_until: w.hub.now() + 600_000 });
    const res = w.hub.agentOp('p', 'submit', 'a1', { item: `#${r.seq}`, headline: 'Landed' });
    assert.doesNotMatch(res.hint, /Tag it/, 'the hub tagged it; nothing for the lander to do');
    assert.equal(git(dir, 'rev-parse', 'v1.5.0^{commit}'), sha);
    const ev = w.hub.q(`SELECT * FROM events WHERE item_id = ? AND type = 'tagged'`).get(r.id);
    assert.equal(ev.headline, `nuworq tagged ${sha.slice(0, 7)} v1.5.0`);
  });

  test('on GitHub: the merge of its pull request is tagged through the GitHub App; otherwise it says how by hand', async () => {
    const hub = new Hub();
    hub.tx(() => hub.project('g', { create: true }));
    hub.humanOp('g', 'remote', { add: 'github.com/acme/api' });
    const calls = [];
    hub.github = { covers: () => true, async tag(a) { calls.push(a); return { sha: a.sha }; } };
    const p = hub.project('g');
    const it = hub.humanOp('g', 'create', { title: 'Release v0.3.0', acceptance: 'x' }).item;
    const item = hub.item(p, it);
    hub.patch(item, { release: 1, stage: 'landing', branch: 'nuworq/9-release-v0-3-0' });
    hub.q(`INSERT INTO prs (project_id, repo, number, item_id, url, title, state, head_ref, head_sha, updated_at) VALUES (?, 'github.com/acme/api', 9, ?, '', 'Release v0.3.0', 'open', ?, '', 0)`)
      .run(p.id, item.id, item.branch);
    const sha = 'f'.repeat(40);
    hub.tx(() => prMerged(hub, p, hub.q('SELECT * FROM prs WHERE number = 9').get(), { sha }));
    await tagsSettled(hub);
    assert.equal(hub.item(p, it).stage, 'done');
    assert.deepEqual(calls, [{ repo: 'github.com/acme/api', tag: 'v0.3.0', sha }]);
    assert.equal(hub.q(`SELECT headline FROM events WHERE item_id = ? AND type = 'tagged'`).get(item.id).headline, 'nuworq tagged fffffff v0.3.0 on github.com/acme/api');

    // No GitHub App to write with: the record and the lander get the commands.
    hub.github = null;
    const hint = hub.tx(() => tagRelease(hub, p, hub.item(p, it), sha));
    assert.equal(hint, `Tag it: git fetch origin, then git tag v0.3.0 ${sha}, then git push origin v0.3.0.`);
    assert.match(hub.q(`SELECT summary FROM events WHERE item_id = ? AND type = 'tag_failed'`).get(item.id).summary, /can't write tags to github\.com\/acme\/api/);
    // Only release items are tagged.
    assert.equal(hub.tx(() => tagRelease(hub, p, { ...hub.item(p, it), release: 0 }, sha)), '');
  });

  test('a tag GitHub refuses reaches an operator as a question with the command, and closes itself once the tag shows (#760)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-tagq-')));
    const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();
    const origin = join(root, 'origin.git');
    g(root, 'init', '-q', '--bare', '-b', 'main', origin);
    g(root, 'clone', '-q', origin, join(root, 'seed'));
    const seed = join(root, 'seed');
    writeFileSync(join(seed, 'README'), 'hi\n');
    g(seed, 'add', '.');
    g(seed, 'commit', '-qm', 'init');
    g(seed, 'push', '-q', 'origin', 'main');
    const sha = g(seed, 'rev-parse', 'HEAD');

    const hub = new Hub({ repos: join(root, 'repos') });
    hub.tx(() => hub.project('g', { create: true }));
    hub.humanOp('g', 'remote', { add: origin });
    hub.github = { covers: () => true, async tag() { throw new Error('422: Reference update failed'); } };
    const p = hub.project('g');
    const it = hub.humanOp('g', 'create', { title: 'Release v0.7.0', acceptance: 'x' }).item;
    hub.patch(hub.item(p, it), { release: 1, stage: 'done' });
    assert.equal(hub.tx(() => tagRelease(hub, p, hub.item(p, it), sha)), '');
    await tagsSettled(hub);

    const q = hub.q(`SELECT * FROM questions WHERE item_id = ? AND audience = 'operator' AND status = 'open'`).all(hub.item(p, it).id);
    assert.equal(q.length, 1, 'one operator question on the release');
    assert.match(q[0].context, /GitHub refused the hub's tag: 422: Reference update failed/);
    assert.ok(q[0].context.includes(`git tag v0.7.0 ${sha} && git push origin refs/tags/v0.7.0`), 'it holds the exact command');
    // Failing again (a retry, a second lander) doesn't ask twice.
    hub.tx(() => tagRelease(hub, p, hub.item(p, it), sha));
    await tagsSettled(hub);
    assert.equal(hub.q(`SELECT COUNT(*) AS n FROM questions WHERE item_id = ? AND status = 'open'`).get(hub.item(p, it).id).n, 1);

    // next hands it to an operator.
    hub.agentOp('g', 'checkin', 'op', { has: ['operator'] });
    const job = hub.agentOp('g', 'next', 'op', {});
    assert.equal(job.mode, 'answer');
    assert.equal(job.question.id, q[0].id);
    assert.match(job.question.question, /^Tag the release v0\.7\.0/);

    // Someone tags it by hand; the hub's mirror sees the tag, and the question closes.
    g(seed, 'tag', 'v0.7.0', sha);
    g(seed, 'push', '-q', 'origin', 'refs/tags/v0.7.0');
    const after = hub.agentOp('g', 'next', 'op', {});
    assert.notEqual(after.mode, 'answer', 'nothing left to answer');
    const closed = hub.q('SELECT * FROM questions WHERE id = ?').get(q[0].id);
    assert.equal(closed.status, 'withdrawn');
    assert.equal(closed.closed_reason, `v0.7.0 is on ${origin.replace(/\.git$/, '')} at ${sha.slice(0, 7)}`);
  });
});

describe('the Releases setting (#399)', () => {
  test('off by default; per milestone or off; the view says which', () => {
    const hub = new Hub();
    hub.tx(() => hub.project('q', { create: true }));
    assert.equal(view(hub, 'q').project.releases, 'off');
    hub.humanOp('q', 'settings', { releases: 'milestone' });
    assert.equal(view(hub, 'q').project.releases, 'milestone');
    assert.throws(() => hub.humanOp('q', 'settings', { releases: 'weekly' }), /releases is "milestone" or "off"/);
  });

  test('Settings has a Releases switch and a button to release now', () => {
    const app = appSource();
    assert.match(app, /row\('releases', 'Release per milestone'/);
    assert.match(app, /data-action="release-now"/);
  });
});
