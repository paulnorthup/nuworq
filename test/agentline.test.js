import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentLine } from '../web/agentline.js';
import { Hub } from '../src/core.js';
import { view, homeView } from '../src/insight.js';
import { appSource } from './appsource.js';

// #240: an agent reads as role, where it runs and its job, from what the hub reports (#238), not as claude-<hex>.
describe('agentLine', () => {
  test('each role, with a job and without', () => {
    const cases = [
      [{ role: 'operator', where: "Paul's Mac", job: 'landing #120' }, "Operator · Paul's Mac — landing #120", "Operator · Paul's Mac"],
      [{ role: 'worker', where: 'mac-mini runner', job: 'building #170' }, 'Worker · mac-mini runner — building #170', 'Worker · mac-mini runner'],
      [{ role: 'shaper', where: "Paul's Mac", job: 'shaping #219' }, "Shaper · Paul's Mac — shaping #219", "Shaper · Paul's Mac"],
      [{ role: 'session', where: 'devbox', job: 'reviewing #12' }, 'Agent · devbox — reviewing #12', 'Agent · devbox'],
    ];
    for (const [p, withJob, without] of cases) {
      assert.equal(agentLine(p, { name: 'claude-4e0a' }), withJob);
      assert.equal(agentLine(p, { name: 'claude-4e0a', job: false }), without);
      assert.equal(agentLine({ ...p, job: null }, { name: 'claude-4e0a' }), without, 'holding nothing: no job');
    }
  });

  test('its id only when asked (30m); a place the hub doesn\'t know is left out; no presence is just the name', () => {
    assert.equal(agentLine({ role: 'worker', where: 'mac-mini runner', job: 'building #1' }, { name: 'claude-80e7', id: true }), 'Worker · mac-mini runner — building #1 · claude-80e7');
    assert.equal(agentLine({ role: 'worker', where: null, job: null }, { name: 'claude-80e7' }), 'Worker');
    assert.equal(agentLine({ role: 'something-new', where: 'x' }, { name: 'a' }), 'Agent · x');
    assert.equal(agentLine(null, { name: 'claude-80e7' }), 'claude-80e7');
  });
});

describe('the hub says who an agent named in an entry is', () => {
  // A worker on the mac-mini runner asks; a session on devbox submits; the owner hasn't verified.
  const setup = () => {
    const hub = new Hub();
    hub.tx(() => hub.project('web', { create: true }));
    hub.q("UPDATE projects SET autonomy = 'ask' WHERE slug = 'web'").run();
    for (const t of ['One', 'Two']) hub.humanOp('web', 'create', { title: t, acceptance: 'x' });
    hub.agentOp('web', 'checkin', 'claude-80e7', { role: 'worker', runner: 'mac-mini' });
    hub.agentOp('web', 'claim', 'claude-80e7', { item: '#1' });
    hub.agentOp('web', 'ask', 'claude-80e7', { item: '#1', question: 'Which?', options: ['a', 'b'], blocking: true });
    hub.agentOp('web', 'checkin', 'codex-91de', { machine: 'devbox' });
    hub.agentOp('web', 'claim', 'codex-91de', { item: '#2' });
    hub.agentOp('web', 'submit', 'codex-91de', { item: '#2', headline: 'Done', evidence: [{ label: 'npm test' }] });
    return hub;
  };

  test('a question and a submission in Needs you carry the agent and its presence', () => {
    const v = view(setup(), 'web');
    const q = v.attention.find((a) => a.kind === 'question'), r = v.attention.find((a) => a.kind === 'review');
    assert.equal(q.agent, 'claude-80e7');
    assert.deepEqual({ role: q.presence.role, where: q.presence.where }, { role: 'worker', where: 'mac-mini runner' });
    assert.ok(q.sub.includes('claude-80e7 asked'), 'the name the page swaps for the line');
    assert.equal(r.agent, 'codex-91de');
    assert.deepEqual({ role: r.presence.role, where: r.presence.where }, { role: 'session', where: 'devbox' });
  });

  test("the home's In motion carries each holder's presence", () => {
    const hub = setup();
    hub.humanOp('web', 'create', { title: 'Three', acceptance: 'x' });
    hub.agentOp('web', 'claim', 'codex-91de', { item: '#3' });
    const [row] = homeView(hub).motion;
    assert.equal(row.agent, 'codex-91de');
    assert.deepEqual(row.presence, { role: 'session', where: 'devbox', job: 'building #3' });
  });
});

describe('the page uses one function for every agent', () => {
  const app = appSource();
  test('who() builds every agent label with agentLine, its id at 30m', () => {
    assert.match(app, /import \{ agentLine(, \w+)* \} from '\.\/agentline\.js';/);
    assert.match(app, /esc\(agentLine\(presence, \{ name, job, id: z\(\) >= 2 \}\)\)/);
    assert.match(app, /title="\$\{esc\(\[name, model, prov\]\.filter\(Boolean\)\.join\(' · '\)\)\}"/, 'its id in the tooltip at every depth');
  });
  test('the agent strip and the Agents cards say the job; cards, the feed and timelines name agents through it; the home too', () => {
    assert.match(app, /\$\{who\(a\.name, a\.model, \{ job: true \}\)\}<span class="st /);
    assert.match(app, /<div class="top">\$\{who\(a\.name, a\.model, \{ job: true \}\)\}/);
    assert.match(app, /<span class="sub">\$\{named\(a\.sub, a\.agent, a\.presence\)\}<\/span>/);
    assert.equal(app.match(/named\(e\.headline, e\.actor, undefined, \{ beside: true \}\)/g).length, 2);
    // In motion's last step sits beside the agent's line: no "claude-80e7 is shaping #9" under it.
    assert.match(app, /m\.last\.type === 'shaping' \? 'Started shaping it' : named\(m\.last\.headline, m\.agent, undefined, \{ beside: true \}\)/);
    assert.doesNotMatch(app, /esc\(m\.last\.headline\)/);
    assert.match(app, /homePage\(S\.home, \{ z: z\(\), pulse, card, esc, plural, who,/);
    const home = readFileSync(new URL('../web/home.js', import.meta.url), 'utf8');
    assert.match(home, /<b>\$\{who\(m\.agent, null, \{ presence: m\.presence \}\)\}<\/b>/);
  });
});
