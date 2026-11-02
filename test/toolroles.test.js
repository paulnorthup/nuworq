// Agents get only the tools their role can use, kept short (#529).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tools } from '../src/protocol.js';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

const list = (role) => tools('mcp', '', { role });
const props = (role, name) => list(role).find((t) => t.name === name)?.inputSchema.properties;

describe('tools by role', () => {
  test('only an operator gets answer, and ask\'s escalates and evidence', () => {
    assert.ok(list('operator').some((t) => t.name === 'answer'));
    assert.ok(props('operator', 'ask').escalates && props('operator', 'ask').evidence);
    for (const role of ['worker', 'shaper', 'session']) {
      assert.ok(!list(role).some((t) => t.name === 'answer'), role);
      assert.ok(!props(role, 'ask').escalates && !props(role, 'ask').evidence, role);
      assert.ok(props(role, 'ask').to, `${role} still asks an operator`);
    }
  });

  test('a runner records its workers\' usage, so a worker isn\'t offered it; the others are', () => {
    for (const name of ['progress', 'submit', 'handoff']) {
      assert.ok(!props('worker', name).usage, name);
      for (const role of ['operator', 'shaper', 'session']) assert.ok(props(role, name).usage, `${role} ${name}`);
    }
  });

  test('without a role, every tool and parameter (the CLI and the docs); no role markers leak into a schema', () => {
    assert.ok(tools().some((t) => t.name === 'answer') && tools().find((t) => t.name === 'ask').inputSchema.properties.escalates);
    for (const role of [null, 'operator', 'worker']) assert.ok(!JSON.stringify(list(role)).includes('"roles"'), String(role));
  });

  // 16,000 since distill (#552): workers take field-notes reviews, so they need it; main had 124 characters to spare.
  test('a worker\'s list is at most 16,000 characters, and the precondition schema is sent once', () => {
    const worker = JSON.stringify(list('worker'));
    assert.ok(worker.length <= 16_000, `${worker.length} characters`);
    assert.equal(worker.split('NUWORQ_CRED').length - 1, 1, 'propose carries it; refine refers to it');
    assert.ok(props('worker', 'propose').precondition.properties.kind);
    assert.match(props('worker', 'refine').precondition.description, /propose/);
  });

  test('the hub serves the tools for the role asked', async () => {
    const server = createServer(new Hub());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const get = async (q) => (await (await fetch(`http://127.0.0.1:${server.address().port}/api/tools?format=mcp${q}`)).json()).map((t) => t.name);
      assert.ok(!(await get('&role=worker')).includes('answer'));
      assert.ok((await get('&role=operator')).includes('answer'));
      assert.ok((await get('')).includes('answer'), 'no role: everything, as older MCP servers ask');
    } finally { server.close(); server.closeAllConnections(); }
  });

  test('the hub still refuses operator-only calls from other roles', () => {
    const hub = new Hub();
    hub.tx(() => hub.project('p', { create: true }));
    hub.agentOp('p', 'checkin', 'w', {});
    assert.throws(() => hub.agentOp('p', 'answer', 'w', { question: 1, answer: 'x' }), /Only an operator/);
    assert.throws(() => hub.agentOp('p', 'ask', 'w', { question: 'Ship?', escalates: 1, evidence: [{ label: 'ran it' }] }), /Only an operator/);
  });
});
