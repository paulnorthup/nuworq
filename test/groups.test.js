import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hub, MIN } from '../src/core.js';
import { view, itemView } from '../src/insight.js';

// The project page shows its groups at a glance, and each opens as a map (#200).
function world() {
  let t = Date.UTC(2026, 9, 30, 9);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('p', { create: true }));
  const create = (args) => { const r = hub.humanOp('p', 'create', { acceptance: 'x', ...args }).item; t += MIN; return r; };
  const op = (agent, name, args = {}) => hub.agentOp('p', name, agent, args);
  const done = (ref) => hub.tx(() => hub.move(hub.item(hub.project('p'), ref), 'done', 'you'));
  return { hub, create, op, done };
}

describe('groups at a glance (#200)', () => {
  test('one line per group with open work: progress, effective priority, and moving, waiting on you or stuck with the reason', () => {
    const { hub, create, op, done } = world();
    create({ title: 'Operator lane', priority: 'now' }); // #1
    create({ title: 'Rotate the app key', needs: ['github-admin'], parent: '#1' }); // #2
    create({ title: 'Docs', parent: '#1' }); // #3
    done('#3');
    create({ title: 'Admin dashboard', priority: 'soon' }); // #4
    create({ title: 'List workspaces', parent: '#4' }); // #5
    create({ title: 'Switch plans', parent: '#4' }); // #6
    create({ title: 'Help pages', priority: 'later' }); // #7
    create({ title: 'Write the FAQ', parent: '#7' }); // #8
    create({ title: 'On its own' }); // #9
    create({ title: 'Finished group' }); // #10
    create({ title: 'Its part', parent: '#10' }); // #11
    done('#11'); done('#10');
    op('a1', 'checkin', { has: [] });
    op('a1', 'claim', { item: '#5' });
    op('a2', 'claim', { item: '#8' });
    op('a2', 'ask', { item: '#8', question: 'Which questions go in?', blocking: true });

    const v = view(hub, 'p');
    assert.deepEqual(v.groups.map((g) => [g.item, g.effective, g.state, g.done, g.total]), [
      ['#1', 'now', 'stuck', 1, 2],
      ['#4', 'soon', 'moving', 0, 2],
      ['#7', 'later', 'you', 0, 1],
    ], 'the finished group is gone; sorted by priority');
    const [lane, admin, help] = v.groups;
    assert.equal(lane.title, 'Operator lane');
    assert.equal(lane.reason, '#2 needs an operator (github-admin); none has checked in today');
    assert.equal(admin.reason, 'a1 on #5');
    assert.equal(help.reason, '#8 waits on you');
    assert.equal(v.ungrouped, 1, '#9 alone');

    // A tap on a priority is an ordinary update; the lines re-sort at once.
    hub.humanOp('p', 'update', { item: '#7', priority: 'now' });
    assert.deepEqual(view(hub, 'p').groups.map((g) => g.item), ['#7', '#1', '#4'], 'now: waiting on you before stuck');

    // A stuck group that needs a plain capability says which.
    hub.humanOp('p', 'update', { item: '#2', needs: ['gpu'] });
    assert.equal(view(hub, 'p').groups.find((g) => g.item === '#1').reason, '#2 needs gpu; no agent connected in the last day has it');
    op('box', 'checkin', { has: ['gpu'] });
    assert.deepEqual(view(hub, 'p').groups.find((g) => g.item === '#1').state, 'queued');
  });

  test("work parked on an operator's question doesn't wait on you: the group reads stuck on the operator", () => {
    const { hub, create, op } = world();
    create({ title: 'Deploy', priority: 'now' }); // #1
    create({ title: 'Run the migration', parent: '#1' }); // #2
    op('w1', 'claim', { item: '#2' });
    op('w1', 'ask', { item: '#2', question: 'Can someone run the migration on prod?', to: 'operator', blocking: true });
    assert.equal(hub.item(hub.project('p'), '#2').stage, 'waiting');
    const [g] = view(hub, 'p').groups;
    assert.deepEqual([g.state, g.reason], ['stuck', '#2 waits on an operator']);
    // Answered and back in the queue: still not waiting on you.
    hub.agentOp('p', 'checkin', 'op', { has: ['operator'] });
    hub.agentOp('p', 'answer', 'op', { question: 1, answer: 'Ran it' });
    hub.humanOp('p', 'update', { item: '#2', stage: 'ready' });
    assert.notEqual(view(hub, 'p').groups[0].state, 'you');
  });

  test("a group's map is its whole tree, any depth, with stage, holder, what it waits on, PRs and open questions", () => {
    const { hub, create, op } = world();
    create({ title: 'Admin dashboard', priority: 'now' }); // #1
    create({ title: 'List workspaces', parent: '#1' }); // #2
    create({ title: 'Switch plans', parent: '#1' }); // #3
    create({ title: 'The confirm dialog', parent: '#3', depends_on: ['#2'] }); // #4
    op('a1', 'claim', { item: '#2' });
    op('a1', 'ask', { item: '#2', question: 'Sort by name or activity?', assumption: 'activity' });
    const p = hub.project('p');
    hub.q(`INSERT INTO prs (project_id, repo, number, item_id, url, title, state, head_ref, head_sha, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', 'b', 'abc1234def', ?)`)
      .run(p.id, 'github.com/acme/api', 42, hub.item(p, '#2').id, 'https://github.com/acme/api/pull/42', 'List workspaces', hub.now());

    const map = itemView(hub, 'p', '#1').map;
    assert.equal(map.item, '#1');
    const [list, plans] = map.children;
    assert.deepEqual({ ...list, questions: undefined, prs: undefined }, {
      item: '#2', title: 'List workspaces', stage: 'active', priority: 'soon', holder: 'a1', depends_on: [], needs_you: false, children: [], questions: undefined, prs: undefined,
    });
    assert.deepEqual(list.prs, [{ url: 'https://github.com/acme/api/pull/42', number: 42, repo: 'github.com/acme/api', state: 'open', ci: null }]);
    assert.deepEqual(list.questions.map((q) => [q.question, q.blocking, q.to]), [['Sort by name or activity?', false, 'human']]);
    assert.equal(plans.children[0].item, '#4', 'two levels down');
    assert.deepEqual(plans.children[0].depends_on, ['#2']);
    assert.equal(itemView(hub, 'p', '#4').map, null, 'no children: no map');
  });

  test('the page: groups right below Needs you; one tap sets priority; the map opens in the drawer', () => {
    const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    assert.match(app, /'needs', 'groups'/, 'right below Needs you, phone and wide');
    assert.match(readFileSync(new URL('../web/milestones.js', import.meta.url), 'utf8'), /data-action="group-priority"/);
    assert.doesNotMatch(app.match(/'group-priority': [^\n]*/)[0], /confirm\(/, 'no dialog: it is reversible');
    assert.match(app, /function groupMap\(/);
  });
});
