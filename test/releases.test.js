import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hub, PERSON_CAN } from '../src/core.js';
import { view } from '../src/insight.js';
import { OPS } from '../src/protocol.js';
import { nextVersion } from '../src/releases.js';

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
  test('breaking is major, or minor on 0.x; a milestone is minor; anything else a patch', () => {
    assert.equal(nextVersion('1.4.2', { breaking: true, milestone: true }), '2.0.0');
    assert.equal(nextVersion('0.2.0', { breaking: true }), '0.3.0');
    assert.equal(nextVersion('1.4.2', { milestone: true }), '1.5.0');
    assert.equal(nextVersion('0.2.5', { milestone: true }), '0.3.0');
    assert.equal(nextVersion('1.4.2'), '1.4.3');
    assert.equal(nextVersion('0.0.0', { milestone: true }), '0.1.0');
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
    assert.equal(next.title, 'Release v1.1.0', 'the tag is still v1.0.0 here; landing tags it (#400)');
    assert.match(next.summary, /\*\*Two/);
    assert.doesNotMatch(next.summary, /\*\*One/);
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
    w.done(w.add('Fix the crash'));
    const r = w.hub.humanOp('p', 'release');
    assert.equal(r.title, 'Release v1.0.1');
    assert.match(w.releases()[0].summary, /\*\*In this release\*\*\n\n- Fix the crash/);
    assert.ok(PERSON_CAN.steward.includes('release'));
    assert.ok(!PERSON_CAN.member.includes('release'));
  });

  test('an agent asks through propose with release', () => {
    const w = world({ tags: [['v1.0.0', T0]] });
    w.hub.agentOp('p', 'checkin', 'a1', {});
    w.done(w.add('Fix the crash'));
    const r = w.hub.agentOp('p', 'propose', 'a1', { title: 'Release', release: true });
    assert.equal(r.title, 'Release v1.0.1');
    assert.equal(w.hub.agentOp('p', 'propose', 'a1', { title: 'Release', release: true }).item, r.item, 'asked again: the same item');
    assert.ok(OPS.find((o) => o.name === 'propose').params.release);
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
    const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    assert.match(app, /row\('releases', 'Release per milestone'/);
    assert.match(app, /data-action="release-now"/);
  });
});
