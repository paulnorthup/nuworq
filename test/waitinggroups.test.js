import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, HOUR, MIN } from '../src/core.js';
import { view } from '../src/insight.js';
import { runChecks, FIRST_RETRY, STUCK_ERRORS } from '../src/precondition.js';
import { milestonesSection, whenText } from '../web/milestones.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// The board as it stood on 2026-11-02 (#746), cut down to a part or two per milestone; the comments name the
// items each stands in for.
function world() {
  let t = Date.UTC(2026, 10, 2, 9);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('p', { create: true }));
  const create = (args) => hub.humanOp('p', 'create', { acceptance: 'x', ...args }).item;
  const line = (ref) => {
    const v = view(hub, 'p');
    const shown = v.groups.find((g) => g.item === ref), waiting = v.groups_waiting.find((g) => g.item === ref);
    return shown ? { ...shown, shown: true } : waiting && { ...waiting, shown: false };
  };
  return { hub, create, line, tick: (ms) => (t += ms), item: (ref) => hub.item(hub.project('p'), ref) };
}

describe('milestones that only wait step out of sight; Stuck means something must change (#746)', () => {
  test("#344's date: Waiting until Nov 15, out of the list, back once the day comes", () => {
    const { hub, create, line, tick } = world();
    create({ title: 'Audit the first week' }); // #1
    create({ title: 'Measure a week of runs', parent: '#1', precondition: { kind: 'date', after: '2026-11-15' } }); // #2
    const g = line('#1');
    assert.deepEqual([g.state, g.shown, g.reason], ['waiting', false, '#2 waits until Nov 15']);
    assert.deepEqual(g.until, { item: '#2', at: Date.UTC(2026, 10, 15), text: 'Nov 15' });
    assert.equal(view(hub, 'p').groups.length, 0, 'not in the list, nor its count');

    tick(13 * 24 * HOUR); // the day has come, before the sweep moves it
    assert.deepEqual([line('#1').state, line('#1').shown], ['queued', true]);
  });

  test("#514: its #522 waits on #575, a measurement dated 20:50 today: Waiting, with #575's time", () => {
    const { create, line } = world();
    create({ title: 'Costs per item' }); // #1, like #514
    create({ title: 'Take the measurement', precondition: { kind: 'date', after: '2026-11-02T20:50:00Z' } }); // #2, like #575
    create({ title: 'Report the measurement', parent: '#1', depends_on: ['#2'] }); // #3, like #522
    const g = line('#1');
    assert.deepEqual([g.state, g.shown], ['waiting', false]);
    assert.equal(g.reason, '#3 waits on #2, which waits until Nov 2, 20:50 UTC');
    assert.deepEqual(g.until, { item: '#2', at: Date.UTC(2026, 10, 2, 20, 50), text: 'Nov 2, 20:50 UTC', time: true });
  });

  test("#548: a GitHub Releases check that keeps failing is Stuck and shown, saying what must change", async () => {
    const { hub, create, line, tick } = world();
    create({ title: 'Release notes' }); // #1
    create({ title: 'Link the release', parent: '#1', precondition: { kind: 'release', repo: 'acme/nuworq', min: '1.0.0' } }); // #2
    assert.equal(line('#1').state, 'waiting', 'not checked yet: waiting');
    assert.equal(line('#1').reason, '#2 waits until the latest release of acme/nuworq is 1.0.0 or later');
    const fetch = async () => new Response('{"message":"Not Found"}', { status: 404 });
    for (let n = 1; n <= STUCK_ERRORS; n++) {
      await runChecks(hub, { fetch });
      assert.equal(JSON.parse(hub.item(hub.project('p'), '#2').last_check).errors, n);
      assert.equal(line('#1').state, n < STUCK_ERRORS ? 'waiting' : 'stuck', `after ${n} failing checks`);
      tick(FIRST_RETRY * 2 ** n);
    }
    const g = line('#1');
    assert.equal(g.shown, true);
    assert.equal(g.reason, `#2 can't be checked (acme/nuworq has no releases yet, or GitHub can't see it): fix or clear its precondition, "the latest release of acme/nuworq is 1.0.0 or later"`);
    assert.doesNotMatch(JSON.stringify(view(hub, 'p')), /outside fact/);

    // A check that runs but isn't met yet is "not yet", and clears the count.
    await runChecks(hub, { fetch: async () => Response.json({ tag_name: 'v0.9.0' }) });
    assert.equal(JSON.parse(hub.item(hub.project('p'), '#2').last_check).errors, undefined);
    assert.equal(line('#1').state, 'waiting');
  });

  test('a part needing github-admin that nobody has: Stuck, and Needs you', () => {
    const { hub, create, line, tick } = world();
    create({ title: 'Rotate keys', priority: 'now' }); // #1, like #476
    create({ title: 'Rotate the app key', parent: '#1', needs: ['github-admin'] }); // #2
    hub.agentOp('p', 'checkin', 'w1', { has: ['macos'] });
    tick(4 * HOUR + MIN);
    hub.agentOp('p', 'checkin', 'w1', { has: ['macos'] });
    const g = line('#1');
    assert.deepEqual([g.state, g.shown], ['stuck', true]);
    assert.match(g.reason, /#2 needs an operator \(github-admin\)/);
    assert.ok(view(hub, 'p').attention.some((a) => a.kind === 'group-stalled' && a.group === '#1'));
  });

  test('a dependency on stuck work is Stuck; on an operator who holds the question, Waiting for them', () => {
    const { hub, create, line } = world();
    create({ title: 'Ship it' }); // #1
    create({ title: 'Needs a GPU', needs: ['gpu'] }); // #2
    create({ title: 'After the GPU work', parent: '#1', depends_on: ['#2'] }); // #3
    assert.deepEqual([line('#1').state, line('#1').reason], ['stuck', '#3 waits on #2, which needs gpu; no agent connected in the last day has it']);

    create({ title: 'Deploy' }); // #4
    create({ title: 'Run the migration', parent: '#4' }); // #5
    hub.agentOp('p', 'claim', 'w1', { item: '#5' });
    hub.agentOp('p', 'ask', 'w1', { item: '#5', question: 'Can someone run the migration?', to: 'operator', blocking: true });
    assert.deepEqual([line('#4').state, line('#4').reason], ['waiting', '#5 waits for an operator']);
    hub.tx(() => hub.q('UPDATE questions SET held_by = ?, held_until = ? WHERE item_id = ?').run('op-1', hub.now() + HOUR, hub.item(hub.project('p'), '#5').id));
    assert.deepEqual([line('#4').state, line('#4').reason], ['waiting', '#5 waits for the operator (op-1 has it)']);
  });

  test('the page: the count leaves out waiting milestones; one quiet line opens them, naming the next', () => {
    const { hub, create } = world();
    create({ title: 'Audit the first week' }); // #1
    create({ title: 'Measure', parent: '#1', precondition: { kind: 'date', after: '2026-11-15' } }); // #2
    create({ title: 'Costs per item' }); // #3
    create({ title: 'Take the measurement', parent: '#3', precondition: { kind: 'date', after: '2026-11-02T20:50:00Z' } }); // #4
    create({ title: 'Moving one' }); // #5
    create({ title: 'Its part', parent: '#5' }); // #6
    const v = view(hub, 'p');
    const now = Date.UTC(2026, 10, 2, 9);
    const html = milestonesSection(v, { esc, now });
    assert.match(html, /<span class="count">1<\/span>/);
    const at = whenText(v.groups_waiting[0].until, now);
    assert.match(html, new RegExp(`<details class="groups-waiting"><summary data-new="milestones-waiting">2 waiting · next: #4 at ${at}</summary>`));
    assert.ok(html.indexOf('#3') < html.indexOf('#1"'), 'soonest first');
    assert.ok(html.includes(`#4 waits until ${at}`), "the line's time in the device's zone");
    assert.match(whenText({ at: now + 30 * MIN, time: true }, now), / today$/);
    assert.equal(whenText({ at: 0, text: 'Nov 15' }, now), 'Nov 15', 'a day stays as written');
    assert.equal(milestonesSection({ groups: [], groups_waiting: [], ungrouped: 0 }, { esc }), '');
  });
});
