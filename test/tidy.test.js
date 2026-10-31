import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Hub } from '../src/core.js';
import { itemView, view } from '../src/insight.js';
import { receive, prsOf } from '../src/github.js';
import { guide, skill } from '../src/protocol.js';
import { drift } from '../src/tidy.js';

// A project that steers by groups: #1 "Workers" with its part #2.
function setup() {
  const hub = new Hub({ clock: () => Date.UTC(2026, 9, 30, 9) });
  hub.tx(() => hub.project('p', { create: true, name: 'App' }));
  const human = (op, args) => hub.humanOp('p', op, args);
  const agent = (op, name, args = {}) => hub.agentOp('p', op, name, args);
  human('create', { title: 'Workers', acceptance: 'x' });
  human('create', { title: 'Start workers', acceptance: 'x', parent: '#1' });
  agent('checkin', 'w1');
  const tidies = () => hub.q("SELECT * FROM items WHERE tidy != '' ORDER BY seq").all();
  return { hub, human, agent, tidies };
}
describe('agents keep the groups true (#202)', () => {
  test('no drift: no tidy job', () => {
    const { agent, tidies } = setup();
    assert.equal(agent('next', 'w1').mode, 'work');
    assert.equal(tidies().length, 0);
  });

  test('work in no group: next offers a tidy job naming it, and none other while it is held', () => {
    const { human, agent, tidies } = setup();
    human('create', { title: 'Loose end', acceptance: 'x' }); // #3
    agent('checkin', 'w2');
    const r = agent('next', 'w1');
    assert.equal(r.mode, 'tidy');
    assert.equal(r.priority, 'soon');
    assert.match(r.summary, /#3 "Loose end" \(ready\) is in no milestone/);
    assert.match(r.hint, /Never change a priority a person set/);
    human('create', { title: 'Another loose end', acceptance: 'x' });
    assert.notEqual(agent('next', 'w2').mode, 'tidy', 'one tidy job at a time');
    assert.equal(tidies().length, 1);
  });

  test('a release spans every milestone: at the top level it is no drift, but loose work still is (#425)', () => {
    const { hub, human, agent, tidies } = setup();
    human('create', { title: 'Quick fix', acceptance: 'x' }); // #3
    human('update', { item: '#3', stage: 'done' });
    human('release'); // #4 "Release v0.0.1", drafted by the hub
    const rel = hub.q('SELECT * FROM items WHERE release = 1').get();
    assert.equal(rel.seq, 4);
    assert.equal(rel.stage, 'ready');
    assert.equal(rel.parent_id, null);
    assert.deepEqual(drift(hub, hub.project('p')), []);
    assert.notEqual(agent('next', 'w1', { claim: false }).mode, 'tidy');
    assert.equal(tidies().length, 0);
    human('create', { title: 'Loose end', acceptance: 'x' }); // #5
    const r = agent('next', 'w1');
    assert.equal(r.mode, 'tidy');
    assert.match(r.summary, /#5 "Loose end" \(ready\) is in no milestone/);
    assert.doesNotMatch(r.summary, /#4/);
  });

  test('a group whose parts are all done, while it is still open', () => {
    const { human, agent } = setup();
    human('update', { item: '#2', stage: 'done' });
    const r = agent('next', 'w1');
    assert.equal(r.mode, 'tidy');
    assert.match(r.summary, /#1 "Workers" is still ready, but all its parts are done or dropped/);
  });

  test('two groups whose open parts touch the same files', () => {
    const { human, agent } = setup();
    human('create', { title: 'Runners', acceptance: 'x' }); // #3
    human('create', { title: 'Report state', acceptance: 'x', parent: '#3' }); // #4
    agent('claim', 'w1', { item: '#2', touching: ['src/runner.js', 'src/a.js', 'src/b.js'] });
    agent('checkin', 'w2');
    agent('claim', 'w2', { item: '#4', touching: ['src/runner.js', 'src/b.js (its state)'] });
    agent('checkin', 'w3');
    const r = agent('next', 'w3');
    assert.equal(r.mode, 'tidy');
    assert.match(r.summary, /#1 "Workers" and #3 "Runners" both change src\/b\.js, src\/runner\.js/);
  });

  test('docs every group adds to, or one source file in common, are no overlap (#243)', () => {
    const { human, agent } = setup();
    human('create', { title: 'Runners', acceptance: 'x' }); // #3
    human('create', { title: 'Report state', acceptance: 'x', parent: '#3' }); // #4
    agent('claim', 'w1', { item: '#2', touching: ['docs/DEPLOY.md', 'README.md', 'CHANGELOG', 'src/server.js', 'src/a.js'] });
    agent('checkin', 'w2');
    agent('claim', 'w2', { item: '#4', touching: ['docs/DEPLOY.md', 'README.md', 'CHANGELOG', 'src/server.js (billing routes)', 'src/b.js'] });
    agent('checkin', 'w3');
    assert.notEqual(agent('next', 'w3').mode, 'tidy');
  });

  test('a finished group waiting on others is no drift: submitted (verifying), or parked on a question (#243)', () => {
    const { hub, human, agent, tidies } = setup();
    human('update', { item: '#2', stage: 'done' });
    const finished = () => drift(hub, hub.project('p')).filter((d) => d.kind === 'finished').length;
    const stage = (s) => hub.q('UPDATE items SET stage = ? WHERE seq = 1').run(s); // as if submitted, then sent back
    stage('verifying');
    assert.equal(finished(), 0, 'already submitted');
    stage('ready');
    assert.equal(finished(), 1, 'ready, nothing in the way: drift');
    hub.agentOp('p', 'ask', 'w1', { item: '#1', question: 'How should this be proven?', blocking: true });
    stage('ready'); // even if it were offered again, the open blocking question still holds it
    assert.equal(finished(), 0, 'parked on a person');
    assert.notEqual(agent('next', 'w1').mode, 'tidy');
    assert.equal(tidies().length, 0);
  });

  test('what a finished tidy job left alone is not listed again beside new drift, until it changes (#243)', () => {
    const { human, agent, tidies } = setup();
    human('update', { item: '#2', stage: 'done' }); // #1 is finished
    const first = agent('next', 'w1');
    assert.equal(first.mode, 'tidy');
    agent('submit', 'w1', { item: first.item, headline: '#1 waits on its live check, left alone' });
    human('create', { title: 'Loose end', acceptance: 'x' }); // new drift
    const second = agent('next', 'w1');
    assert.equal(second.mode, 'tidy');
    assert.match(second.summary, /"Loose end"/);
    assert.doesNotMatch(second.summary, /#1 "Workers"/, 'already looked at');
    agent('submit', 'w1', { item: second.item, headline: 'Left the loose end alone' });
    // #1 changes (a new part, done too): it is a different picture, so it is listed again.
    human('create', { title: 'Check it live', acceptance: 'x', parent: '#1' });
    human('update', { item: `#${tidies().at(-1).seq + 1}`, stage: 'done' });
    const third = agent('next', 'w1');
    assert.equal(third.mode, 'tidy');
    assert.match(third.summary, /#1 "Workers" is still ready/);
  });

  test('a pull request no item tracks is on record, shows in the tidy job, and attaching it links it to the item', () => {
    const { hub, human, agent } = setup();
    human('settings', { github_secret: 's3cret' });
    const deliver = (body) => {
      const raw = JSON.stringify(body);
      return receive(hub, 'p', { event: 'pull_request', raw, signature: 'sha256=' + createHmac('sha256', 's3cret').update(raw).digest('hex') });
    };
    const pr = (state = 'open', merged = false) => ({
      action: state === 'open' ? 'opened' : 'closed', repository: { full_name: 'acme/app' },
      pull_request: { number: 9, state, merged, title: 'Bump deps', body: '', html_url: 'https://github.com/acme/app/pull/9', head: { ref: 'bump', sha: 'b'.repeat(40) }, base: { ref: 'main' } },
    });
    assert.equal(deliver(pr()).untracked, true);
    const r = agent('next', 'w1');
    assert.equal(r.mode, 'tidy');
    assert.match(r.summary, /PR acme\/app#9 "Bump deps" \(branch bump\) belongs to no item/);

    agent('refine', 'w1', { item: '#2', pr: 'acme/app#9', reason: 'It is the dependency bump #2 needs' });
    assert.deepEqual(prsOf(hub, hub.project('p'), hub.item(hub.project('p'), '#2')).map((x) => [x.number, x.state]), [[9, 'open']]);
    assert.equal(hub.q('SELECT COUNT(*) AS n FROM untracked_prs').get().n, 0);
    assert.throws(() => agent('refine', 'w1', { item: '#1', pr: 'acme/app#9' }), (e) => e.status === 404 && /No untracked pull request acme\/app#9/.test(e.message) && /as the tidy job lists it/.test(e.hint));
    // From here GitHub's events reach #2, as for any pull request the hub knows.
    assert.equal(deliver(pr('closed', true)).item, '#2');
    assert.ok(itemView(hub, 'p', '#2').events.some((e) => e.type === 'pr' && /PR #9 merged/.test(e.headline)));
  });

  test("a tidy agent can't change a priority a person set; its moves show in both groups' history with the reason", () => {
    const { hub, human, agent } = setup();
    human('create', { title: 'Loose end', acceptance: 'x', priority: 'later' }); // #3
    human('create', { title: 'Runners', acceptance: 'x' }); // #4
    human('create', { title: 'Report state', acceptance: 'x', parent: '#4' }); // #5
    const r = agent('next', 'w1');
    assert.equal(r.mode, 'tidy');
    assert.throws(() => agent('refine', 'w1', { item: '#3', priority: 'now' }), (e) => e.status === 403 && /set by a person/.test(e.message) && /Leave priorities/.test(e.hint));
    agent('refine', 'w1', { item: '#2', priority: 'later' }); // nobody chose #2's: fine
    agent('refine', 'w1', { item: '#5', parent: '#1', reason: 'Reporting state is how workers get started' });
    const why = (n) => itemView(hub, 'p', n).events.filter((e) => e.type === 'regrouped').map((e) => [e.headline, e.summary]);
    assert.deepEqual(why(4), [['w1 moved #5 out of #4 into #1: Report state', 'Why: Reporting state is how workers get started']]);
    assert.deepEqual(why(1), [['w1 moved #5 into #1 from #4: Report state', 'Why: Reporting state is how workers get started']]);
    agent('refine', 'w1', { item: '#4', parent: '#1', reason: 'Runners are part of getting workers going' }); // emptied by the move
    const done = agent('submit', 'w1', { item: r.item, headline: 'Moved #4 and #5 under #1; #3 stays loose on purpose' });
    assert.match(done.hint, /is done/);
    assert.deepEqual(view(hub, 'p').attention.filter((a) => a.kind === 'tidied').map((a) => [a.level, a.headline]),
      [['know', 'w1 tidied the milestones: Moved #4 and #5 under #1; #3 stays loose on purpose']], 'worth knowing sums it up in one line');
    assert.notEqual(agent('next', 'w1').mode, 'tidy', 'what it listed and left alone is not raised again');
  });

  test('the guide describes the tidy job, and the skill includes it', () => {
    const g = guide();
    assert.match(g, /## Tidy jobs/);
    assert.match(g, /\*\*Look for:\*\* open work in no milestone; two milestones changing the same files/);
    assert.match(g, /\*\*Never touch:\*\* a priority a person set/);
    assert.match(g, /- \*\*tidy\*\*: the milestones drifted/);
    assert.match(skill(), /A tidy job/);
  });
});
