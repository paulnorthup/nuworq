import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { view, itemView } from '../src/insight.js';
import { tools, guide } from '../src/protocol.js';
import { needsSteps } from '../src/audience.js';

// #161: when a person has to act, the question says exactly how, as numbered steps; the hub refuses one without them.
function setup() {
  const hub = new Hub({ clock: () => Date.UTC(2026, 9, 30, 9) });
  hub.tx(() => hub.project('o', { create: true }));
  hub.humanOp('o', 'create', { title: 'Publish to npm', acceptance: 'x' });
  hub.agentOp('o', 'checkin', 'w1', { has: ['macos'] });
  hub.agentOp('o', 'claim', 'w1', { item: '#1' });
  const ask = (args) => hub.agentOp('o', 'ask', 'w1', { item: '#1', blocking: true, ...args });
  return { hub, ask, attention: () => view(hub, 'o').attention.filter((a) => a.kind === 'question') };
}

const STEPS = [
  { do: "Open the repository's Actions secrets", where: 'https://github.com/acme/api/settings/secrets/actions' },
  { do: 'Click New repository secret, name it NPM_TOKEN, paste the token', check: 'NPM_TOKEN is listed' },
  'Tell me when it is there',
];
const ACT = 'Can you add the NPM_TOKEN secret in GitHub?';

describe('steps on a question', () => {
  test('a question asking a person to act is refused without steps, with a hint showing the shape', () => {
    const { ask } = setup();
    assert.throws(() => ask({ question: ACT, to: 'human' }), (e) => {
      assert.match(e.message, /needs steps/);
      assert.match(e.hint, /"do": "Open the repository's Actions secrets", "where": "https:\/\/github\.com/);
      assert.match(e.hint, /"check":/);
      return true;
    });
  });

  test('with steps it is stored, in order, and Needs you and the item page carry them', () => {
    const { hub, ask, attention } = setup();
    const r = ask({ question: ACT, to: 'human', steps: STEPS });
    assert.equal(r.ok, true);
    const want = [STEPS[0], STEPS[1], { do: 'Tell me when it is there' }];
    assert.deepEqual(attention()[0].steps, want);
    assert.deepEqual(itemView(hub, 'o', '#1').questions[0].steps, want);
  });

  test('a decision, and questions to an operator or a reporter, need no steps', () => {
    const { ask, attention } = setup();
    assert.equal(ask({ question: 'Should the export be CSV or JSON?', to: 'human' }).ok, true);
    assert.equal(ask({ question: 'Can you run `npm publish` with the real token?', to: 'operator' }).ok, true);
    assert.deepEqual(attention()[0].steps, []);
  });

  test('left out, `to` still checks a question that goes to the human', () => {
    const { ask } = setup();
    assert.throws(() => ask({ question: 'Please invite agent-bot to the workspace' }), /needs steps/);
  });

  test('malformed steps are refused with a hint', () => {
    const { ask } = setup();
    assert.throws(() => ask({ question: ACT, steps: 'do it' }), (e) => /must be a list/.test(e.message) && /Pass steps/.test(e.hint));
    assert.throws(() => ask({ question: ACT, steps: [{ where: 'https://x' }] }), (e) => /Step 1 says nothing to do/.test(e.message) && /do:/.test(e.hint));
    assert.throws(() => ask({ question: ACT, steps: Array.from({ length: 13 }, (_, i) => `step ${i}`) }), /At most 12 steps/);
  });

  test("an operator's escalation that asks the human to act needs steps too", () => {
    const { hub, ask, attention } = setup();
    const q = ask({ question: 'Can the npm token be created?', to: 'operator' }).question;
    hub.agentOp('o', 'checkin', 'op', { has: ['operator'] });
    const escalate = (args) => hub.agentOp('o', 'ask', 'op', { escalates: q, question: 'Could you create an npm automation token?', evidence: ['no token in the keychain'], ...args });
    assert.throws(() => escalate(), /needs steps/);
    assert.equal(escalate({ steps: [{ do: 'Create an Automation token', where: 'https://www.npmjs.com/settings/~/tokens' }] }).ok, true);
    assert.deepEqual(attention().find((a) => a.escalation).steps, [{ do: 'Create an Automation token', where: 'https://www.npmjs.com/settings/~/tokens' }]);
  });
});

describe('needsSteps', () => {
  for (const q of [ACT, 'Could you set up the GitHub App on the org?', 'Please sign in to fly.io and rotate the deploy token', 'Install the plugin on your laptop?', 'Would you click Approve on the PR?', 'Can you confirm the plan, and please add the NPM_TOKEN secret?'])
    test(`acts: ${q}`, () => assert.equal(needsSteps({ question: q }), true));
  for (const q of ['Should the export be CSV or JSON?', 'Is it OK to drop the legacy table?', 'Which name do you prefer, Flow or Lifecycle?',
    'Could you decide whether to add a CSV export?', 'Please choose: should we merge #12 or #13?', 'Can you confirm we should create a new repo?',
    'Would you approve adding the GitHub App?', 'Is it okay if I run the migration?'])
    test(`decides: ${q}`, () => assert.equal(needsSteps({ question: q }), false));
  test('the context counts too', () => assert.equal(needsSteps({ question: 'Ready to publish?', context: "You'll need to add the NPM_TOKEN secret first." }), true));
});

test('the guide and the ask tool require steps when a person must act, with an example', () => {
  const steps = tools().find((t) => t.name === 'ask').inputSchema.properties.steps;
  assert.match(steps.description, /Required when a person must do something/);
  assert.match(steps.description, /"do":/);
  assert.deepEqual(steps.items.required, ['do']);
  assert.match(guide(), /Does a person have to do something\? Give `steps` \(`do`, `where`, `check`\); the hub refuses/);
});
