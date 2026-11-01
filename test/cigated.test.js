import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, DAY } from '../src/core.js';
import { guide } from '../src/protocol.js';
import { view } from '../src/insight.js';

// Where CI checks every pull request, workers run only the tests near their change and leave the whole suite to
// CI (#532); elsewhere they run it once before submitting.
function world({ github = true } = {}) {
  let t = Date.UTC(2026, 10, 1, 9);
  const hub = new Hub({ clock: () => t });
  if (github) hub.github = { covers: () => true };
  hub.tx(() => hub.project('demo', { create: true }));
  hub.humanOp('demo', 'remote', { add: 'github.com/acme/api' });
  const p = () => hub.project('demo');
  const check = (at = t) => hub.q('INSERT INTO checks (project_id, sha, name, conclusion, at) VALUES (?, ?, ?, ?, ?)').run(p().id, `sha${at}`, 'test', 'success', at);
  let n = 0;
  const workHint = () => {
    const agent = `w${++n}`; // a fresh agent each time: one holding work is told to finish it first
    hub.humanOp('demo', 'create', { title: `Exports retry ${n}`, acceptance: '- retries 3 times', stage: 'ready' });
    hub.agentOp('demo', 'checkin', agent, {});
    return hub.agentOp('demo', 'next', agent, {}).hint;
  };
  return { hub, p, check, workHint, later: (ms) => { t += ms; } };
}

describe('the whole suite is CI\'s where CI checks the pull request (#532)', () => {
  test('recorded checks on a project that lands through pull requests: run the tests near your change', () => {
    const w = world();
    w.check();
    const hint = w.workHint();
    assert.match(hint, /Tests: run the ones near your change\. Not the whole suite: CI runs it on the pull request, and a failing check sends the work back naming it\./);
    assert.doesNotMatch(hint, /whole suite once/);
  });

  test('no checks recorded: the builder runs the whole suite once before submitting', () => {
    const w = world();
    assert.match(w.workHint(), /Tests: run the ones near your change as you work, and the whole suite once, just before you submit\./);
  });

  test('checks older than 30 days no longer count', () => {
    const w = world();
    w.check();
    w.later(31 * DAY);
    assert.match(w.workHint(), /whole suite once, just before you submit/);
  });

  test('without pull requests (no GitHub App), work lands by hand and the builder runs the suite', () => {
    const w = world({ github: false });
    w.check();
    assert.match(w.workHint(), /whole suite once, just before you submit/);
  });

  test('a person can say so either way, and auto goes back to telling from the checks', () => {
    const w = world();
    w.hub.humanOp('demo', 'settings', { ci: 'on' });
    assert.equal(w.p().ci, 'on');
    assert.match(w.workHint(), /CI runs it on the pull request/, 'on, with no checks recorded yet');
    w.check();
    w.hub.humanOp('demo', 'settings', { ci: 'off' });
    assert.match(w.workHint(), /whole suite once/, 'off, though checks were recorded');
    w.hub.humanOp('demo', 'settings', { ci: 'auto' });
    assert.equal(w.p().ci, '');
    assert.match(w.workHint(), /CI runs it on the pull request/, 'auto: the recorded check counts again');
    const said = w.hub.q(`SELECT headline FROM events WHERE type = 'settings' ORDER BY id`).all().map((e) => e.headline);
    assert.equal(said.length, 3);
    assert.match(said[0], /CI checks demo's pull requests/);
    assert.throws(() => w.hub.humanOp('demo', 'settings', { ci: 'sometimes' }), /ci must be auto, on or off/);
  });

  test('the project view says which it is', () => {
    const w = world();
    assert.equal(view(w.hub, 'demo').project.ci, 'auto');
    w.hub.humanOp('demo', 'settings', { ci: 'off' });
    assert.equal(view(w.hub, 'demo').project.ci, 'off');
  });

  test('the guide says the whole suite is run only where CI doesn\'t check the pull request, and still fits', () => {
    for (const via of ['tools', 'cli']) {
      const g = guide({ via });
      assert.match(g, /Run the tests near your change; the whole suite only where the hint says CI doesn't check the pull request\./);
      assert.ok(g.length <= 3500, `${via}: ${g.length}`);
    }
  });
});
