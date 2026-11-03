// Every tool definition is in an agent's context before its first call (#678): each stays at most its size here.
// A definition that has to grow raises its number in the same change, so the growth is a choice someone reviewed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tools } from '../src/protocol.js';
import { LIMITS } from '../src/core.js';

const size = (t) => JSON.stringify(t).length;
// Characters of JSON, with every parameter (no role): what an operator gets, the most anyone does.
const MAX = {
  checkin: 758, next: 265, claim: 328, progress: 630, ask: 1708, answer: 569, withdraw: 247, submit: 1274, handoff: 735,
  propose: 1571, refine: 1614, review: 503, comment: 327, ack: 218, learn: 403, retire: 417, distill: 526, feedback: 308,
  look: 415, signoff: 240,
};
// Before #678, on main at 8bdc154 (#765's limits in), a worker's 19 definitions came to 16,354 characters: now at
// least a third fewer.
const WORKER_BEFORE = 16_354;

describe('tool definitions stay small', () => {
  test('each tool is at most its size', () => {
    const all = tools('mcp');
    assert.deepEqual(all.map((t) => t.name).sort(), Object.keys(MAX).sort(), 'a new tool gets its size here');
    for (const t of all) assert.ok(size(t) <= MAX[t.name], `${t.name} is ${size(t)} characters, over its ${MAX[t.name]}`);
  });

  test('a worker\'s list is at least a third smaller than before #678', () => {
    const worker = JSON.stringify(tools('mcp', '', { role: 'worker' })).length;
    assert.ok(worker <= WORKER_BEFORE * 2 / 3, `${worker} characters`);
  });

  test('a worker isn\'t offered what its MCP server fills in, or a release only a person asks for', () => {
    const props = (role, name) => tools('mcp', '', { role }).find((t) => t.name === name).inputSchema.properties;
    for (const p of ['project', 'client', 'machine', 'role', 'has']) {
      assert.ok(!props('worker', 'checkin')[p], p);
      assert.ok(props('session', 'checkin')[p], `a session still sends ${p}`);
    }
    assert.ok(!props('worker', 'propose').release && props('session', 'propose').release);
  });

  // The limits the hub refuses past (#765) are each field's maxLength, so an agent sees them without the words.
  test('each limited field carries the hub\'s limit', () => {
    const props = (name) => tools('mcp').find((t) => t.name === name).inputSchema.properties;
    for (const name of ['progress', 'submit', 'handoff', 'propose', 'refine', 'review', 'comment']) {
      assert.equal(props(name).summary.maxLength, LIMITS.summary, `${name} summary`);
      assert.equal(props(name).detail.maxLength, LIMITS.detail, `${name} detail`);
    }
    for (const name of ['propose', 'refine']) assert.equal(props(name).acceptance.maxLength, LIMITS.acceptance, name);
    const ask = props('ask');
    for (const k of ['question', 'context', 'assumption']) assert.equal(ask[k].maxLength, LIMITS[k], k);
    assert.equal(ask.options.items.maxLength, LIMITS.option);
    for (const k of ['do', 'where', 'check']) assert.equal(ask.steps.items.properties[k].maxLength, LIMITS.step, k);
    const evidence = props('submit').evidence;
    assert.equal(evidence.maxItems, LIMITS.evidence);
    assert.equal(evidence.items.properties.label.maxLength, LIMITS.evidence_label);
    assert.equal(props('propose').depends_on.maxItems, LIMITS.depends_on);
  });
});
