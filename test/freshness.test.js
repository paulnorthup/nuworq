import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hub, DAY, HOUR } from '../src/core.js';
import { view } from '../src/insight.js';
import { freshen, FRESH_EVERY } from '../src/freshness.js';
import { MODE_RULES, skill } from '../src/protocol.js';
import { appSource } from './appsource.js';

function setup() {
  let t = Date.UTC(2026, 9, 1, 9);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('app', { create: true, name: 'App' }));
  const human = (op, args) => hub.humanOp('app', op, args);
  const agent = (op, name = 'w1', args = {}) => hub.agentOp('app', op, name, args);
  const sweeps = () => hub.q('SELECT * FROM items WHERE sweep = 1 ORDER BY seq').all();
  return { hub, human, agent, sweeps, tick: (ms) => (t += ms) };
}

describe('the weekly freshness sweep (#181)', () => {
  test('a newer Claude model than the default tiers, seen on the hub, makes the sweep propose an update (#723)', () => {
    const { hub, agent, sweeps, tick } = setup();
    agent('checkin', 'w1', { model: 'claude-opus-5-5' });
    tick(7 * DAY);
    freshen(hub);
    assert.doesNotMatch(sweeps()[0].acceptance, /Newer Claude models/, 'the defaults are the newest seen');
    hub.q('UPDATE items SET stage = ? WHERE sweep = 1').run('done');
    agent('checkin', 'w2', { model: 'claude-opus-6-0' });
    tick(7 * DAY);
    freshen(hub);
    assert.match(sweeps()[1].acceptance, /Newer Claude models than nuworq's default tiers \(claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5\) are in use on this hub: claude-opus-6-0 \(newer than claude-opus-5-5\)\. Propose an update: in nuworq's own repository, DEFAULT_TIERS in src\/models\.js/);
  });

  test('one "keep <project> fresh" item every 7 days, never two open at once', () => {
    const { hub, human, sweeps, tick } = setup();
    assert.equal(FRESH_EVERY, 7 * DAY);
    freshen(hub);
    assert.equal(sweeps().length, 0, 'a new project gets its first sweep a week in');
    tick(7 * DAY - HOUR);
    freshen(hub);
    assert.equal(sweeps().length, 0);
    tick(HOUR);
    assert.equal(freshen(hub).length, 1);
    const [s] = sweeps();
    assert.equal(s.title, 'Keep App fresh');
    assert.equal(s.stage, 'ready');
    assert.equal(s.priority, 'later');
    assert.equal(s.created_by, 'nuworq');
    for (const part of [/one batch/, /tests passing/, /its own proposal, saying what breaks and how to migrate/, /standing decision/, /fresh: nothing to update/]) {
      assert.match(s.acceptance, part);
    }
    freshen(hub);
    assert.equal(sweeps().length, 1, 'once a week, not every tick');

    tick(7 * DAY);
    freshen(hub);
    assert.equal(sweeps().length, 1, "last week's is still open: this week's is skipped");
    human('update', { item: `#${s.seq}`, stage: 'dropped' });
    tick(DAY);
    freshen(hub);
    assert.equal(sweeps().length, 1, 'the skipped week still counts: the next opens 7 days after it');
    tick(6 * DAY);
    freshen(hub);
    assert.equal(sweeps().length, 2);
  });

  test('a project from before the sweep existed gets its first one at the next tick', () => {
    const { hub, sweeps } = setup();
    hub.q('UPDATE projects SET fresh_at = 0').run();
    freshen(hub);
    assert.equal(sweeps().length, 1);
  });

  test('next offers the sweep only when no now or soon work is ready', () => {
    const { hub, human, agent, tick } = setup();
    tick(FRESH_EVERY);
    freshen(hub); // #1
    human('create', { title: 'Someday', acceptance: 'x', priority: 'later' }); // #2
    human('create', { title: 'Export to CSV', acceptance: 'x' }); // #3, soon
    human('create', { title: 'Needs a GPU', acceptance: 'x', needs: ['gpu'], priority: 'now' }); // #4
    agent('checkin', 'w1', { has: ['macos'] });
    assert.equal(agent('next', 'w1').item, '#3', 'soon work first');
    agent('checkin', 'w2', { has: ['macos'] });
    assert.equal(agent('next', 'w2').item, '#2', "ready now work this agent can't take still holds the sweep back");
    human('update', { item: '#4', stage: 'dropped' });
    agent('checkin', 'w3', { has: ['macos'] });
    assert.equal(agent('next', 'w3').item, '#1', 'nothing urgent ready: the sweep comes before other later work');
  });

  test('on for a new project; turning it off stops new sweeps and turning it on resumes them', () => {
    const { hub, human, sweeps, tick } = setup();
    assert.equal(hub.project('app').fresh, 1);
    assert.equal(view(hub, 'app').project.fresh, true);
    human('settings', { fresh: false });
    assert.equal(view(hub, 'app').project.fresh, false);
    assert.match(hub.q("SELECT headline FROM events WHERE type = 'settings' ORDER BY id DESC").get().headline, /no longer kept current/);
    tick(3 * FRESH_EVERY);
    freshen(hub);
    assert.equal(sweeps().length, 0);
    human('settings', { fresh: true });
    freshen(hub);
    assert.equal(sweeps().length, 1, 'back on: overdue, so it opens at the next tick');
  });

  test('a parked project gets no sweep', () => {
    const { hub, human, sweeps, tick } = setup();
    human('settings', { parked: true });
    tick(FRESH_EVERY);
    freshen(hub);
    assert.equal(sweeps().length, 0);
  });

  test('a sweep puts nothing in Needs you', () => {
    const { hub, sweeps, tick } = setup();
    hub.humanOp('app', 'settings', { autonomy: 'ask' });
    tick(FRESH_EVERY);
    freshen(hub);
    assert.equal(sweeps()[0].stage, 'ready', "the hub's own work needs no approval, even under 'ask'");
    const v = view(hub, 'app');
    assert.deepEqual(v.attention.filter((a) => a.item === `#${sweeps()[0].seq}`), []);
  });

  test('the settings control confirms before turning it off', () => {
    const app = appSource();
    // The switch lives in the Settings dialog (#213), and is wired to the same two actions.
    const dialog = app.slice(app.indexOf('function settingsModal('), app.indexOf('\n}\n', app.indexOf('function settingsModal(')));
    assert.match(dialog, /sw\('fresh', !!P\.fresh, P\.fresh \? 'fresh-off' : 'fresh-on'\)/);
    assert.match(app, /'fresh-off': \(\) => \{ if \(confirm\('Turn off the weekly freshness sweep\? This project will stop being kept current/);
    assert.match(app, /'fresh-on': \(\) => setting\(\{ fresh: true \}/);
  });

  test('the sweep\'s hint says how, and the skill points to it (#527)', () => {
    const g = MODE_RULES.fresh;
    for (const cmd of ['npm outdated', 'pip-audit', 'cargo audit', 'go list -m -u all', 'osv-scanner']) assert.ok(g.includes(cmd), cmd);
    assert.match(g, /Propose each breaking upgrade/);
    assert.match(g, /fresh: nothing to update/);
    assert.match(skill(), /freshness sweep[^\n]*The hint `next` gives with it says how/);
  });
});
