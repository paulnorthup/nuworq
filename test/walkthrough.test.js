import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hub, DAY, HOUR } from '../src/core.js';
import { walkthrough, WALK_EVERY, COVERED, GUIDE } from '../src/walkthrough.js';

// A real repo with main and the guide in it, and a hub whose project lives there.
function setup({ guide = true } = {}) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-walk-')));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const land = (file, subject) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    appendFileSync(join(repo, file), `${subject}\n`);
    git('add', '.');
    git('commit', '-q', '-m', subject);
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README'), 'hi\n');
  if (guide) land(GUIDE, 'The guide (#383)');
  else land('src/app.js', 'An app');
  let t = Date.UTC(2026, 9, 1, 9);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('app', { create: true, name: 'App' }));
  hub.humanOp('app', 'settings', { path: repo });
  const walks = () => hub.q('SELECT * FROM items WHERE walk = 1 ORDER BY seq').all();
  return { hub, git, land, walks, tick: (ms) => (t += ms) };
}

describe('the weekly guide walk-through (#386)', () => {
  test('a week after a change to a covered area, one walk-through item opens', () => {
    const { hub, land, walks, tick } = setup();
    assert.equal(WALK_EVERY, 7 * DAY);
    assert.equal(walkthrough(hub).length, 0, 'the first look only notes where main is');
    land('src/connect.js', 'Connect asks which workspace (#400)');
    land('README', 'Docs tweak (#401)');
    tick(WALK_EVERY - HOUR);
    walkthrough(hub);
    assert.equal(walks().length, 0, 'at most once a week');
    tick(HOUR);
    const [it] = walkthrough(hub);
    assert.ok(it);
    const [w] = walks();
    assert.equal(w.title, 'Walk through the getting-started guide on a fresh workspace');
    assert.equal(w.stage, 'ready');
    assert.equal(w.priority, 'later');
    assert.equal(w.created_by, 'nuworq');
    assert.deepEqual(JSON.parse(w.needs), ['browser']);
    assert.match(w.summary, /Connect asks which workspace \(#400\)/);
    assert.match(w.summary, /src\/connect\.js/);
    assert.doesNotMatch(w.summary, /#401|README/, 'only what touched a covered area');
    for (const part of [/Follow \/guide/, /fresh workspace/, /375px/, /fixed on this branch/, /npm test passes/, /its own proposal/, /guide matches/]) assert.match(w.acceptance, part);
    walkthrough(hub);
    assert.equal(walks().length, 1, 'once a week, not every tick');
  });

  test('a quiet week opens nothing: no landing, or landings outside the covered areas', () => {
    const { hub, land, walks, tick } = setup();
    walkthrough(hub);
    tick(WALK_EVERY);
    walkthrough(hub);
    assert.equal(walks().length, 0, 'nothing landed');
    land('README', 'Docs (#402)');
    land('src/insight.js', 'Analytics (#403)');
    tick(WALK_EVERY);
    walkthrough(hub);
    assert.equal(walks().length, 0, 'nothing the guide covers changed');
  });

  test('while one is open no second opens; what changed meanwhile opens the next once it closes', () => {
    const { hub, land, walks, tick } = setup();
    walkthrough(hub);
    land('src/runner.js', 'Runner flag (#404)');
    tick(WALK_EVERY);
    walkthrough(hub);
    assert.equal(walks().length, 1);
    land('web/getstarted.js', 'Get started step (#405)');
    tick(WALK_EVERY);
    walkthrough(hub);
    assert.equal(walks().length, 1, "last week's is still open");
    hub.humanOp('app', 'update', { item: `#${walks()[0].seq}`, stage: 'dropped' });
    tick(WALK_EVERY);
    walkthrough(hub);
    const all = walks();
    assert.equal(all.length, 2);
    assert.match(all[1].summary, /Get started step \(#405\)/);
    assert.doesNotMatch(all[1].summary, /#404/, 'the first walk-through covered that');
  });

  test('a project whose repository has no guide never gets one', () => {
    const { hub, land, walks, tick } = setup({ guide: false });
    walkthrough(hub);
    land('src/connect.js', 'Connect (#406)');
    tick(WALK_EVERY);
    walkthrough(hub);
    assert.equal(walks().length, 0);
  });

  test("when the last walk's commit is gone (a force-push), it counts again from main", () => {
    const { hub, land, walks, tick } = setup();
    walkthrough(hub);
    hub.q("UPDATE projects SET walk_sha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'").run();
    land('src/ghapp.js', 'App wiring (#407)');
    tick(WALK_EVERY);
    walkthrough(hub);
    assert.equal(walks().length, 0, 'no guessing at what changed');
    land('src/ghapp.js', 'More wiring (#408)');
    tick(WALK_EVERY);
    walkthrough(hub);
    assert.equal(walks().length, 1);
    assert.match(walks()[0].summary, /#408/);
  });

  test('the covered areas are listed once, beside the guide, and every one exists; the hub runs it on its timer', () => {
    const root = new URL('../', import.meta.url);
    assert.ok(COVERED.includes(GUIDE));
    for (const f of COVERED) assert.ok(readFileSync(new URL(f, root)), f);
    assert.match(readFileSync(new URL('src/server.js', root), 'utf8'), /walkthrough\(hub\)/);
  });
});
