import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hub, DAY } from '../src/core.js';
import { view } from '../src/insight.js';
import { MODE_RULES } from '../src/protocol.js';
import { AREAS, SECURITY_EVERY, securityUp } from '../src/security.js';
import { drift } from '../src/tidy.js';
import { prMerged } from '../src/github.js';
import { tagsSettled } from '../src/releases.js';

// Security stays checked (#480): a review before each release that the release waits for, read by someone who built
// none of it, and one area each month.
function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-security-')));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }));
  g('add', '.');
  g('commit', '-qm', 'init');
  return dir;
}

function world({ security = true, releases = 'milestone' } = {}) {
  let t = Date.UTC(2026, 10, 1, 9);
  const hub = new Hub({ clock: () => (t += 1000) });
  hub.tx(() => hub.project('p', { create: true, name: 'App' }));
  hub.humanOp('p', 'settings', { path: repo(), releases, fresh: false, security });
  const p = () => hub.project('p');
  const add = (title, more = {}) => hub.humanOp('p', 'create', { title, acceptance: 'x', ...more }).item;
  const item = (ref) => hub.item(p(), ref);
  // A milestone whose parts were built by builders (one per part), then finished: the hub drafts a release.
  const ship = (builders) => {
    const m = add('Exports retry');
    for (const [i, b] of builders.entries()) {
      const k = add(`Part ${i + 1}`, { parent: m });
      hub.patch(item(k), { implementer: b });
      hub.humanOp('p', 'update', { item: k, stage: 'done' });
    }
    hub.humanOp('p', 'update', { item: m, stage: 'done' });
  };
  const release = () => hub.q('SELECT * FROM items WHERE release = 1 ORDER BY seq DESC').get();
  const reviews = (kind) => hub.q(`SELECT * FROM items WHERE security = ? ORDER BY seq`).all(kind);
  const next = (agent) => { hub.agentOp('p', 'checkin', agent, {}); return hub.agentOp('p', 'next', agent, {}); };
  return { hub, p, add, item, ship, release, reviews, next, later: (ms) => { t += ms; } };
}

describe('a review before each release (#480)', () => {
  test('a drafted release waits for a security review of what it ships', () => {
    const w = world();
    w.ship(['a1']);
    const rel = w.release();
    const [rev] = w.reviews('release');
    assert.ok(rel && rev, 'a release and its review');
    assert.match(rev.title, new RegExp(`Security audit before the next release \\(#${rel.seq}\\)`));
    assert.equal(rev.stage, 'ready');
    assert.equal(rev.priority, 'now');
    assert.deepEqual(w.hub.unmetDeps(rel).map((d) => d.seq), [rev.seq], 'the release depends on it');
    assert.throws(() => w.hub.agentOp('p', 'claim', 'a2', { item: `#${rel.seq}` }), /depends on unfinished work/);
    assert.doesNotMatch(rel.summary, /Security audit/, "the review isn't in the release's changelog");
  });

  test('an agent that built a change the release ships is never given the review, nor may claim it', () => {
    const w = world();
    w.ship(['a1', 'a3']);
    const [rev] = w.reviews('release');
    for (const builder of ['a1', 'a3']) {
      w.hub.agentOp('p', 'checkin', builder, {});
      assert.notEqual(w.hub.agentOp('p', 'next', builder, { claim: false }).item, `#${rev.seq}`, `${builder} isn't offered it`);
      assert.throws(() => w.hub.agentOp('p', 'claim', builder, { item: `#${rev.seq}` }), /audits changes you built/);
    }
    const r = w.next('a2');
    assert.equal(r.item, `#${rev.seq}`, 'someone who built none of it gets it');
    assert.ok(r.hint.includes(MODE_RULES.security), 'with the security rules in its hint');
  });

  test('submitting an attempt at a change counts as building it', () => {
    const w = world();
    w.ship(['a1']);
    const part = w.hub.q("SELECT * FROM items WHERE title = 'Part 1'").get();
    w.hub.q("INSERT INTO attempts (item_id, agent, stage, closed, at) VALUES (?, 'a4', 'submitted', 1, 0)").run(part.id);
    const [rev] = w.reviews('release');
    assert.throws(() => w.hub.agentOp('p', 'claim', 'a4', { item: `#${rev.seq}` }), /audits changes you built/);
  });

  test("a token can't take the review of a release it built under another name (#622)", async () => {
    const { Auth } = await import('../src/auth.js');
    const w = world();
    w.ship(['a1']);
    const [rev] = w.reviews('release');
    // One token acts as a1 (which built Part 1) and as a9; a runner's token is shared by its workers by design.
    const auth = new Auth(w.hub.db);
    auth.createToken('box', 'agent');
    auth.createToken('ci', 'agent', { runner: 'ci' });
    const id = (name) => w.hub.db.prepare('SELECT id FROM tokens WHERE name = ?').get(name).id;
    for (const a of ['a1', 'a9', 'r1']) w.hub.agentOp('p', 'checkin', a, {});
    const bind = (agent, token) => w.hub.db.prepare('UPDATE agents SET token_id = ? WHERE project_id = ? AND name = ?').run(id(token), w.hub.project('p').id, agent);
    bind('a1', 'box'); bind('a9', 'box');
    assert.throws(() => w.hub.agentOp('p', 'claim', 'a9', { item: `#${rev.seq}` }), /audits changes you built/);
    assert.notEqual(w.hub.agentOp('p', 'next', 'a9', { claim: false }).item, `#${rev.seq}`, "and isn't offered it");
    // Moved to the runner's token, a1's work no longer makes a runner sibling its builder.
    bind('a1', 'ci'); bind('r1', 'ci');
    assert.equal(w.next('r1').item, `#${rev.seq}`);
  });

  test('once the review is done the release is free to land', () => {
    const w = world();
    w.ship(['a1']);
    const [rev] = w.reviews('release');
    w.hub.humanOp('p', 'update', { item: `#${rev.seq}`, stage: 'done' });
    assert.deepEqual(w.hub.unmetDeps(w.release()), []);
  });

  test('a critical finding holds it: its fix added to depends_on keeps the release waiting until it is done', () => {
    const w = world();
    w.ship(['a1']);
    const rel = w.release();
    const [rev] = w.reviews('release');
    const fix = w.add('Exports keep their checks');
    // The reviewer (who built none of it) adds the fix to the release's dependencies.
    w.hub.agentOp('p', 'checkin', 'a2', {});
    w.hub.agentOp('p', 'refine', 'a2', { item: `#${rel.seq}`, depends_on: [`#${rev.seq}`, fix], reason: 'A high finding holds the release' });
    w.hub.humanOp('p', 'update', { item: `#${rev.seq}`, stage: 'done' });
    assert.deepEqual(w.hub.unmetDeps(w.release()).map((d) => `#${d.seq}`), [fix], 'held by the fix');
    assert.match(rev.acceptance, /critical or high finding holds the release/);
    assert.match(rev.acceptance, /"Fix it before the release" and "Accept it for this release"/);
  });

  test('off: a release waits for nothing', () => {
    const w = world({ security: false });
    w.ship(['a1']);
    assert.ok(w.release());
    assert.deepEqual(w.reviews('release'), []);
    assert.deepEqual(w.hub.unmetDeps(w.release()), []);
  });

  test('turned on with a release already drafted, that release waits for a review too', () => {
    const w = world({ security: false });
    w.ship(['a1']);
    w.hub.humanOp('p', 'settings', { security: true });
    const [rev] = w.reviews('release');
    assert.deepEqual(w.hub.unmetDeps(w.release()).map((d) => d.seq), [rev.seq]);
    const said = w.hub.q("SELECT headline FROM events WHERE type = 'settings' ORDER BY id DESC").get().headline;
    assert.match(said, /turned on security audits: one before each release, and one area each month/);
    assert.equal(view(w.hub, 'p').project.security, true);
  });

  test("the hub's own reviews are never drift: no milestone needed", () => {
    const w = world();
    w.ship(['a1']);
    securityUp(w.hub);
    assert.equal(w.reviews('area').length, 1);
    assert.deepEqual(drift(w.hub, w.p()).filter((d) => /Security audit/.test(d.text)), []);
  });
});

describe('one area a month (#480)', () => {
  test('the first opens at once, then one every 30 days, each the next area in turn', () => {
    const w = world();
    assert.equal(securityUp(w.hub).length, 1);
    let [first] = w.reviews('area');
    assert.match(first.summary, new RegExp(`area 1 of ${AREAS.length}`));
    assert.match(first.title, /^Security audit: sign-in, accounts and tenancy$/);
    assert.equal(securityUp(w.hub).length, 0, 'not again within the month');
    w.hub.humanOp('p', 'update', { item: `#${first.seq}`, stage: 'done' });
    w.later(SECURITY_EVERY);
    securityUp(w.hub);
    const second = w.reviews('area')[1];
    assert.match(second.summary, /area 2 of/);
    assert.match(second.title, /^Security audit: the web client and the HTTP edge$/);
  });

  test("while last month's is open, this month's is skipped; parked or off, none opens", () => {
    const w = world();
    securityUp(w.hub);
    w.later(SECURITY_EVERY);
    assert.equal(securityUp(w.hub).length, 0);
    assert.equal(w.reviews('area').length, 1);
    const off = world({ security: false });
    assert.equal(securityUp(off.hub).length, 0);
    const parked = world();
    parked.hub.humanOp('p', 'settings', { parked: true });
    assert.equal(securityUp(parked.hub).length, 0);
  });

  test('after the fifth area it starts again at the first', () => {
    const w = world();
    for (let i = 0; i < AREAS.length + 1; i++) {
      securityUp(w.hub);
      const open = w.reviews('area').at(-1);
      w.hub.humanOp('p', 'update', { item: `#${open.seq}`, stage: 'done' });
      w.later(SECURITY_EVERY + DAY);
    }
    assert.match(w.reviews('area').at(-1).summary, /area 1 of/);
  });
});

describe('a release ships only what its review read (#936)', () => {
  const git = (dir, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', dir, ...a], { encoding: 'utf8' }).trim();
  // A release with its review read and done; then, optionally, a change lands on main.
  const reviewed = ({ late = true } = {}) => {
    const w = world();
    w.ship(['a1']);
    const dir = w.p().path, rel = w.release(), [rev] = w.reviews('release');
    const job = w.next('a2');
    assert.equal(job.item, `#${rev.seq}`);
    const read = git(dir, 'rev-parse', 'main');
    assert.equal(w.item(job.item).security_sha, read, 'the review records the main commit it read');
    assert.ok(job.hint.includes(`main up to ${read.slice(0, 7)}`), 'and its hint names it');
    w.hub.humanOp('p', 'update', { item: `#${rev.seq}`, stage: 'done' });
    assert.equal(w.item(`#${rev.seq}`).security_sha, read, 'done, it still names what it read');
    let lateItem = null;
    if (late) {
      writeFileSync(join(dir, 'exports.js'), 'export const retries = 3;\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'Exports retry three times');
      lateItem = w.add('Exports retry three times');
      w.hub.humanOp('p', 'update', { item: lateItem, stage: 'done' });
    }
    // The release, built on main as it is now: its version and CHANGELOG.md.
    const version = /v(\S+)$/.exec(rel.title)[1], branch = `nuworq/${rel.seq}-release`;
    git(dir, 'switch', '-q', '-c', branch);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version }));
    writeFileSync(join(dir, 'CHANGELOG.md'), `## ${version}\n\n${rel.summary}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', `Release v${version}`);
    git(dir, 'switch', '-q', 'main');
    w.hub.agentOp('p', 'checkin', 'a3', {});
    w.hub.patch(w.item(`#${rel.seq}`), { stage: 'landing', branch, holder: 'a3', lease_until: w.hub.now() + 600_000, reviewed_sha: git(dir, 'rev-parse', branch) });
    const land = () => w.hub.agentOp('p', 'submit', 'a3', { item: `#${rel.seq}`, headline: 'Landed' });
    return { w, dir, rel, rev, read, lateItem, version, branch, land };
  };

  test('a change landed after the pre-release review holds the release until it is reviewed', () => {
    const { w, rel, rev, read, lateItem, land } = reviewed();
    const res = land();
    assert.match(res.hint, /holds changes that landed after/);
    const held = w.item(`#${rel.seq}`);
    assert.equal(held.stage, 'ready', 'not landed: back to be built again on main');
    const gap = w.reviews('release').at(-1);
    assert.notEqual(gap.seq, rev.seq);
    assert.match(gap.title, new RegExp(`Security audit of what landed after #${rev.seq} \\(#${rel.seq}\\)`));
    assert.equal(gap.security_from, read, 'it reads just the new range');
    assert.match(gap.summary, /Exports retry three times/, 'listing what landed');
    assert.deepEqual(w.hub.unmetDeps(held).map((d) => d.seq), [gap.seq], 'the release depends on it');
    assert.ok(held.summary.includes(`(${lateItem})`), "the release's summary lists the change");
    assert.ok(w.hub.q(`SELECT 1 FROM events WHERE item_id = ? AND type = 'release_held'`).get(rel.id));
    // Read by someone who built none of it, the range is reviewed; then the release lands as usual.
    const job = w.next('a4');
    assert.equal(job.item, `#${gap.seq}`);
    assert.ok(job.hint.includes(`git diff ${read.slice(0, 7)} `), 'its hint names the range');
    w.hub.humanOp('p', 'update', { item: `#${gap.seq}`, stage: 'done' });
    assert.deepEqual(w.hub.unmetDeps(w.item(`#${rel.seq}`)), []);
  });

  test("the release's own version and CHANGELOG.md edit doesn't hold it", () => {
    const { w, rel, land } = reviewed({ late: false });
    assert.throws(land, /doesn't contain/, 'only told to put it on main');
    assert.equal(w.item(`#${rel.seq}`).stage, 'landing');
    assert.equal(w.reviews('release').length, 1);
  });

  test('a release on main holding unreviewed changes is tagged only once a review reads them', () => {
    const { w, dir, rel, version, branch, land } = reviewed();
    git(dir, 'merge', '-q', '--ff-only', branch);
    const res = land();
    assert.match(res.hint, new RegExp(`v${version.replace(/\./g, '\\.')} isn't tagged yet`));
    assert.equal(w.item(`#${rel.seq}`).stage, 'done');
    assert.equal(git(dir, 'tag', '--list', `v${version}`), '', 'not tagged, so not signed');
    const gap = w.reviews('release').at(-1);
    assert.match(gap.title, /Security audit of what landed after/);
    assert.ok(w.hub.q(`SELECT 1 FROM events WHERE item_id = ? AND type = 'tag_held'`).get(rel.id));
    w.next('a4');
    w.hub.humanOp('p', 'update', { item: `#${gap.seq}`, stage: 'done' });
    assert.equal(git(dir, 'rev-parse', `v${version}^{commit}`), git(dir, 'rev-parse', branch), 'tagged once reviewed');
  });

  test("GitHub's merge of a release the mirror hasn't fetched yet is tagged, with no range review, when nothing landed late", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-security-gh-')));
    const origin = join(root, 'origin.git'), seed = join(root, 'seed');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, seed);
    writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }));
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'init');
    git(seed, 'push', '-q', 'origin', 'main');
    const read = git(seed, 'rev-parse', 'HEAD');

    const hub = new Hub({ repos: join(root, 'repos') });
    hub.tx(() => hub.project('g', { create: true }));
    hub.humanOp('g', 'remote', { add: origin });
    hub.humanOp('g', 'settings', { security: true });
    const tags = [];
    hub.github = { covers: () => true, async tag(a) { tags.push(a); return { sha: a.sha }; } };
    const p = hub.project('g');
    assert.ok(hub.repoFor(p)?.path, 'the mirror is cloned, as of the review');
    const rel = hub.item(p, hub.humanOp('g', 'create', { title: 'Release v0.2.0', acceptance: 'x' }).item);
    const rev = hub.item(p, hub.humanOp('g', 'create', { title: 'Security audit before the next release', acceptance: 'x' }).item);
    hub.patch(rev, { security: 'release', security_sha: read, stage: 'done' });
    hub.patch(rel, { release: 1, stage: 'landing', branch: 'nuworq/9-release-v0-2-0' });
    hub.q('INSERT INTO deps (item_id, depends_on) VALUES (?, ?)').run(rel.id, rev.id);
    hub.q(`INSERT INTO prs (project_id, repo, number, item_id, url, title, state, head_ref, head_sha, updated_at) VALUES (?, ?, 9, ?, '', 'Release v0.2.0', 'open', ?, '', 0)`)
      .run(p.id, origin, rel.id, rel.branch);

    // GitHub merges the release: its version and CHANGELOG.md only. The mirror hasn't fetched it.
    writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'x', version: '0.2.0' }));
    writeFileSync(join(seed, 'CHANGELOG.md'), '## 0.2.0\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'Release v0.2.0');
    git(seed, 'push', '-q', 'origin', 'main');
    const sha = git(seed, 'rev-parse', 'HEAD');
    assert.throws(() => git(hub.repoFor(p).path, 'cat-file', '-e', `${sha}^{commit}`), 'the mirror lacks the merge');
    hub.tx(() => prMerged(hub, p, hub.q('SELECT * FROM prs WHERE number = 9').get(), { sha }));
    await tagsSettled(hub);

    assert.equal(hub.item(p, `#${rel.seq}`).stage, 'done');
    assert.deepEqual(tags, [{ repo: hub.repoOf(p), tag: 'v0.2.0', sha }], 'tagged once the mirror has it');
    assert.equal(hub.q(`SELECT COUNT(*) AS n FROM items WHERE security = 'release'`).get().n, 1, 'no range review opened');
    assert.equal(hub.q(`SELECT 1 FROM events WHERE item_id = ? AND type = 'tag_held'`).get(rel.id), undefined);
  });
});

describe('the threat model (#480)', () => {
  const model = readFileSync(new URL('../docs/SECURITY-MODEL.md', import.meta.url), 'utf8');
  test('names the attackers, the trust boundaries, the areas and the maintainer\'s three calls; SECURITY.md links it', () => {
    for (const who of ['anonymous internet', 'Another workspace', 'A member, by role', 'An agent token', "A stranger's issue", 'A hostile or impersonated hub', 'A compromised hub VM']) assert.ok(model.includes(who), who);
    assert.match(model, /## Trust boundaries/);
    for (const n of [1, 2, 3]) assert.match(model, new RegExp(`the maintainer's call ${n}`));
    for (const a of AREAS) assert.ok(model.includes(a.split(':')[0].replace(/^./, (c) => c.toUpperCase())), a);
    assert.match(readFileSync(new URL('../SECURITY.md', import.meta.url), 'utf8'), /\(docs\/SECURITY-MODEL\.md\)/);
  });
});
