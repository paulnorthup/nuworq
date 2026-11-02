import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { run, staffCheck, unstaffedLine } from '../src/runner.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));

// Staffing is never off without saying so (#491).
describe('nuworq run says when no project is staffed, and offers to staff one', () => {
  const projects = () => [{ slug: 'demo', name: 'Demo', runner: false }, { slug: 'api', name: 'API', runner: false }, { slug: 'old', name: 'Old', parked: true }];
  const world = (answers = []) => {
    const lines = [], asked = [], opted = [];
    return { lines, asked, opted, log: (l) => lines.push(l), ask: async (q) => { asked.push(q); return answers.shift() ?? ''; }, optIn: async (p) => { opted.push(p.slug); } };
  };

  test('none opted in, no terminal: it names them and says how, asking nothing', async () => {
    const w = world();
    await staffCheck({ projects: projects(), log: w.log, optIn: w.optIn });
    assert.match(w.lines[0], /^No project is staffed by nuworq run: Demo, API\. Workers start only in projects whose "Staff it with nuworq run" switch is on\.$/);
    assert.match(w.lines[1], /turn on "Staff it with nuworq run" in its Settings on the hub, or run nuworq run --staff <project>/);
    assert.deepEqual(w.opted, []);
  });

  test('at a terminal, in a clone of one: offers that one, and a yes opts it in', async () => {
    const ps = projects();
    const w = world(['y']);
    await staffCheck({ projects: ps, here: ps[1], ask: w.ask, log: w.log, optIn: w.optIn });
    assert.match(w.asked[0], /^Staff API, the project of this clone, with nuworq run\? Its workers can cost money\. \[y\/N\] $/);
    assert.deepEqual(w.opted, ['api']);
    assert.equal(ps[1].runner, true);
    assert.match(w.lines.at(-1), /nuworq run now staffs API/);

    const no = world(['']);
    await staffCheck({ projects: projects(), here: projects()[1], ask: no.ask, log: no.log, optIn: no.optIn });
    assert.deepEqual(no.opted, [], 'the default is no');
    assert.match(no.lines.at(-1), /None staffed, so no worker starts\. Later, turn on/);
  });

  test("at a terminal, outside any of them: asks which, by slug or name", async () => {
    const w = world(['demo']);
    await staffCheck({ projects: projects(), ask: w.ask, log: w.log, optIn: w.optIn });
    assert.match(w.asked[0], /Which project should nuworq run staff\? Its workers can cost money\. \(demo, api; Enter for none\)/);
    assert.deepEqual(w.opted, ['demo']);
    const typo = world(['nope']);
    await staffCheck({ projects: projects(), ask: typo.ask, log: typo.log, optIn: typo.optIn });
    assert.deepEqual(typo.opted, []);
    assert.ok(typo.lines.includes('No project "nope".'));
  });

  test('--staff opts the project in first; then nothing more is said or asked', async () => {
    const w = world();
    await staffCheck({ projects: projects(), staff: 'Demo', ask: w.ask, log: w.log, optIn: w.optIn });
    assert.deepEqual(w.opted, ['demo']);
    assert.deepEqual(w.asked, []);
    assert.equal(w.lines.length, 1);
    await assert.rejects(staffCheck({ projects: projects(), staff: 'nope', log: w.log, optIn: w.optIn }), (e) => /No project "nope"/.test(e.message) && /Demo, API/.test(e.hint));
  });

  test('with one opted in, it says nothing', async () => {
    const w = world();
    const ps = projects();
    ps[0].runner = true;
    await staffCheck({ projects: ps, ask: w.ask, log: w.log, optIn: w.optIn });
    assert.deepEqual([w.lines, w.asked], [[], []]);
  });
});

describe('the waiting line says how much waits where nuworq run does not staff, once per run', () => {
  test('unstaffedLine counts claimable work in projects not opted in', () => {
    const ps = [{ slug: 'a', name: 'A', runner: true }, { slug: 'b', name: 'B', runner: false }, { slug: 'c', name: 'C', runner: false }];
    assert.equal(unstaffedLine([{ project: 'a', claimable: 4 }], ps), null);
    assert.equal(unstaffedLine([{ project: 'a', claimable: 4 }, { project: 'b', claimable: 2 }, { project: 'c', claimable: 1 }], ps),
      `3 items wait in projects nuworq run doesn't staff: B (2), C (1). To staff one, turn on "Staff it with nuworq run" in its Settings on the hub, or run nuworq run --staff <project>.`);
    assert.match(unstaffedLine([{ project: 'c', claimable: 1 }], ps), /^1 item waits in/);
  });

  test('run says it before the waiting line, the first time only', async () => {
    const lines = [];
    let asked = 0, polls = 0, t = 0;
    const res = await run({
      routes: async () => { polls++; return []; },
      launch: async () => assert.fail('nothing to launch'),
      unstaffed: async () => { asked++; return '2 items wait in projects nuworq run doesn\'t staff: B (2).'; },
      log: (l) => lines.push(l), now: () => t, sleep: async (ms) => { t += ms; if (polls >= 3) stopper(); }, pollSeconds: 1,
      onInterrupt: (fn) => { stopper = fn; },
    });
    assert.equal(asked, 1);
    assert.equal(lines.filter((l) => /wait in projects/.test(l)).length, 1);
    assert.ok(lines.indexOf(lines.find((l) => /wait in projects/.test(l))) < lines.findIndex((l) => /Nothing is waiting/.test(l)), lines.join('\n'));
    assert.equal(res.why, 'interrupted');
  });
  let stopper = () => {};
});

describe('nuworq run against a hub where no project is staffed', () => {
  test('without a terminal it names them and says how; --staff opts one in, and the work elsewhere is counted', async () => {
    const hub = new Hub();
    hub.tx(() => { hub.project('demo', { create: true }); hub.project('api', { create: true }); });
    hub.humanOp('api', 'create', { title: 'Do it', acceptance: 'done' });
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const home = mkdtempSync(join(tmpdir(), 'nuworq-unstaffed-'));
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NUWORQ|TRELLIS)_/.test(k))), HOME: home };
    const cli = (...a) => promisify(execFile)(process.execPath, [BIN, 'run', '--url', `http://127.0.0.1:${server.address().port}`, '--agent', 'claude', '--until-idle', '--poll', '1', ...a], { env, cwd: home });
    try {
      const none = (await cli()).stdout;
      assert.match(none, /No project is staffed by nuworq run: (demo, api|api, demo)\./, none);
      assert.match(none, /or run nuworq run --staff <project>/);
      assert.match(none, /1 item waits in projects nuworq run doesn't staff: api \(1\)/);

      const staffed = (await cli('--staff', 'demo')).stdout;
      assert.match(staffed, /nuworq run now staffs demo/, staffed);
      assert.equal(!!hub.project('demo').runner, true, 'the same switch as Settings');
      assert.equal(!!hub.project('demo').staff_asked, true, "the project page doesn't ask again");
      assert.doesNotMatch(staffed, /No project is staffed/);
      assert.equal(staffed.match(/1 item waits in projects nuworq run doesn't staff: api \(1\)/g)?.length, 1, staffed);
      assert.match(staffed, /Done: no work is waiting in opted-in projects/);
    } finally { server.close(); }
  });
});
