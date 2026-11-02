import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { liveGate } from '../web/pace.js';
import { appSource } from './appsource.js';

// A fake clock: the gate's timers and its now() both run on it.
function clock() {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  return { tick: (ms) => mock.timers.tick(ms), done: () => mock.timers.reset() };
}

describe('live updates at a calm pace (#392)', () => {
  test('a burst of hub changes becomes at most one update a second', () => {
    const c = clock();
    try {
      const runs = [];
      const gate = liveGate({ run: () => runs.push(Date.now()) });
      // Twenty changes in two seconds, one every 100ms.
      for (let i = 0; i < 20; i++) { gate.poke(); c.tick(100); }
      c.tick(2000);
      assert.ok(runs.length >= 2 && runs.length <= 3, `${runs.length} updates`);
      for (let i = 1; i < runs.length; i++) assert.ok(runs[i] - runs[i - 1] >= 1000, 'a second apart at least');
    } finally { c.done(); }
  });

  test('a lone change shows promptly, not a second later', () => {
    const c = clock();
    try {
      let runs = 0;
      const gate = liveGate({ run: () => runs++ });
      gate.poke();
      c.tick(200);
      assert.equal(runs, 1);
    } finally { c.done(); }
  });

  test('while a pointer is held down, updates wait; letting go applies them', () => {
    const c = clock();
    try {
      let runs = 0, idles = 0;
      const gate = liveGate({ run: () => runs++, idle: () => idles++ });
      gate.press();
      assert.equal(gate.busy(), true);
      gate.poke();
      c.tick(5000);
      assert.equal(runs, 0, 'nothing under their finger');
      gate.release();
      assert.equal(idles, 1, 'a redraw that waited can apply now');
      c.tick(200);
      assert.equal(runs, 1);
    } finally { c.done(); }
  });

  test('while they scroll, updates wait until it has been still a moment', () => {
    const c = clock();
    try {
      let runs = 0, idles = 0;
      const gate = liveGate({ run: () => runs++, idle: () => idles++ });
      gate.poke();
      for (let i = 0; i < 20; i++) { gate.scrolled(); c.tick(50); }
      assert.equal(runs, 0, 'not during the scroll');
      c.tick(300);
      assert.equal(idles, 1, 'still now');
      c.tick(200);
      assert.equal(runs, 1);
    } finally { c.done(); }
  });
});

describe('no refresh piles up (#517)', () => {
  test('none starts while the last is on its way; changes meanwhile make one more, after it lands', async () => {
    const c = clock();
    try {
      let runs = 0, land;
      const gate = liveGate({ run: () => { runs++; return new Promise((r) => { land = r; }); } });
      gate.poke();
      c.tick(200);
      assert.equal(runs, 1);
      for (let i = 0; i < 5; i++) { gate.poke(); c.tick(1500); }
      assert.equal(runs, 1, 'not while the first is in flight');
      land();
      await new Promise((r) => setImmediate(r));
      c.tick(1500);
      assert.equal(runs, 2, 'one more for everything that came meanwhile');
      land();
      await new Promise((r) => setImmediate(r));
      c.tick(5000);
      assert.equal(runs, 2, 'and nothing after that');
    } finally { c.done(); }
  });

  test('none while the tab is hidden; shown again, one', () => {
    const c = clock();
    try {
      let runs = 0, hidden = true;
      const gate = liveGate({ run: () => runs++, hidden: () => hidden });
      for (let i = 0; i < 5; i++) { gate.poke(); c.tick(1500); }
      assert.equal(runs, 0);
      gate.shown(); // still hidden: a visibilitychange to hidden changes nothing
      c.tick(1500);
      assert.equal(runs, 0);
      hidden = false;
      gate.shown();
      c.tick(1500);
      assert.equal(runs, 1);
      gate.shown();
      c.tick(1500);
      assert.equal(runs, 1, 'shown with nothing waiting: no refresh');
    } finally { c.done(); }
  });
});

describe('the page', () => {
  const app = appSource();
  test('the stream goes through the gate, and a live redraw waits while the person is busy', () => {
    assert.match(app, /const scheduleRefresh = \(\) => live\.poke\(\);/);
    assert.doesNotMatch(app, /setInterval\(\(\) => refresh\(\)/);
    // No timer refetches (#530): relative times tick in the page (web/ago.js), and only a change on the hub pokes.
    assert.doesNotMatch(app, /setInterval\([^)]*\)\s*=>\s*live\.poke\(\)/);
    assert.doesNotMatch(app, /setInterval\(\(\) => live\.poke/);
    assert.match(app, /startTicking\(\);/);
    assert.match(app, /if \(!force && \(typing\(\) \|\| live\.busy\(\)\)\) \{ setState\(\{ pending: true \}\); return; \}/);
    for (const ev of ['pointerdown', 'pointerup', 'scroll']) assert.ok(app.includes(`'${ev}'`), ev);
  });
});
