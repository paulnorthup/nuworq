import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';

test('the checkin that creates a project says so and names the closest slug; later checkins and existing projects say nothing', () => {
  const h = new Hub();
  const first = h.agentOp('nuworq', 'checkin', 'a1');
  assert.match(first.next, /^nuworq is a new project here, made by this checkin\. /, 'the first project: nothing to have meant');
  h.agentOp('llm-proxy', 'checkin', 'a1');

  const typo = h.agentOp('nope', 'checkin', 'a2');
  assert.match(typo.next, /^nope is a new project here; did you mean nuworq\? If so, check in to nuworq instead/);
  assert.match(typo.next, /If not: Nothing is ready\./, 'the usual next follows');
  assert.ok(h.projects().some((p) => p.slug === 'nope'), 'still created');

  assert.doesNotMatch(h.agentOp('nope', 'checkin', 'a2').next, /new project/, 'said once');
  assert.doesNotMatch(h.agentOp('nope', 'checkin', 'a3').next, /new project/, 'not to the next agent either');
  assert.doesNotMatch(h.agentOp('nuworq', 'checkin', 'a2').next, /new project/);
  assert.doesNotMatch(h.agentOp('nope', 'next', 'a2').next ?? '', /new project/, 'only a checkin creates, so only it says');
});

test("the suggestion stays within the agent's scope", () => {
  const h = new Hub();
  h.agentOp('nuworq', 'checkin', 'a1');
  h.agentOp('other', 'checkin', 'a1');
  const r = h.agentOp('nuwork', 'checkin', 'a2', {}, { scope: ['other', 'nuwork'] });
  assert.match(r.next, /did you mean other\?/);
});
