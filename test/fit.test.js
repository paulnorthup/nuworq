import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Hub, smallModel, normTags, MIN, HOUR } from '../src/core.js';
import { view, itemView } from '../src/insight.js';
import { createServer } from '../src/server.js';
import { runMcp } from '../src/mcp.js';
import { tools, guide } from '../src/protocol.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));

function world() {
  const clock = { t: Date.UTC(2026, 9, 1, 9) };
  const hub = new Hub({ clock: () => clock.t });
  hub.tx(() => hub.project('p', { create: true }));
  const op = (agent, name, args = {}) => hub.agentOp('p', name, agent, args);
  const create = (args) => hub.humanOp('p', 'create', { acceptance: 'x', ...args }).item;
  return { hub, clock, op, create };
}

describe('fit hints: what items need and what agents have', () => {
  test('items take needs and size from propose, refine and the human; the item view shows them', () => {
    const { hub, op, create } = world();
    const a = create({ title: 'Container test', needs: ['Docker', 'docker', 'linux vm'], size: 'large' });
    let v = itemView(hub, 'p', a);
    assert.deepEqual(v.needs, ['docker', 'linux-vm']);
    assert.equal(v.size, 'large');
    assert.deepEqual(normTags('docker, linux-vm'), ['docker', 'linux-vm']);

    const b = op('w', 'propose', { title: 'Browser check', acceptance: 'x', needs: ['browser'], size: 'small' }).item;
    assert.deepEqual(itemView(hub, 'p', b).needs, ['browser']);
    const r = op('w', 'refine', { item: b, needs: [], size: 'large' });
    assert.ok(r.changed.includes('needs → nothing') && r.changed.includes('size → large'));
    hub.humanOp('p', 'update', { item: a, needs: ['gpu'], size: 'small' });
    v = itemView(hub, 'p', a);
    assert.deepEqual([v.needs, v.size], [['gpu'], 'small']);
    assert.deepEqual(op('w', 'look', { item: a }).needs, ['gpu']);
    hub.humanOp('p', 'update', { item: a, size: 'huge' });
    assert.equal(itemView(hub, 'p', a).size, 'small', 'unknown sizes are ignored');
  });

  test('next never offers work whose needs the agent lacks; another agent that has them gets it', () => {
    const { op, create } = world();
    create({ title: 'Needs Docker', needs: ['docker'], priority: 'now' });
    create({ title: 'Plain work' });
    op('mac', 'checkin', { has: ['macos'] });
    op('box', 'checkin', { has: ['linux', 'docker'] });
    assert.equal(op('mac', 'next').item, '#2', 'skips what it cannot do');
    const idle = op('mac2', 'next');
    assert.equal(idle.mode, 'idle');
    assert.match(idle.hint, /#1 needs docker/);
    assert.equal(op('box', 'next').item, '#1');
  });

  test('reviews and shaping respect needs too', () => {
    const { hub, op, create } = world();
    hub.humanOp('p', 'settings', { autonomy: 'full' });
    const it = create({ title: 'Needs Docker', needs: ['docker'] });
    op('box', 'checkin', { has: ['docker'] });
    op('box', 'claim', { item: it });
    op('box', 'submit', { item: it, headline: 'done', evidence: [{ label: 'tests pass' }] });
    assert.equal(op('mac', 'next').mode, 'idle', 'a reviewer without docker is not handed the review');
    op('box2', 'checkin', { has: ['docker'] });
    assert.equal(op('box2', 'next').mode, 'review');
    const idea = op('box', 'propose', { title: 'GPU idea', needs: ['gpu'] }).item;
    assert.equal(op('mac', 'next').mode, 'idle');
    op('gpu', 'checkin', { has: 'gpu' });
    assert.equal(op('gpu', 'next').item, idea);
  });

  test('the human hears when no agent seen in the last day has what an item needs', () => {
    const { hub, clock, op, create } = world();
    const it = create({ title: 'Needs a VM', needs: ['linux-vm'] });
    op('mac', 'checkin', { has: ['macos'] });
    const entry = () => view(hub, 'p').attention.find((a) => a.kind === 'unfit');
    assert.match(entry().headline, new RegExp(`${it} needs linux-vm`));
    assert.equal(entry().level, 'know');
    op('vm', 'checkin', { has: ['linux-vm'] });
    assert.equal(entry(), undefined);
    clock.t += 25 * HOUR;
    op('mac', 'checkin', {});
    assert.ok(entry(), 'an agent last seen over a day ago no longer counts');
  });

  test('operator work: offered only to an operator with that capability; nobody fitting says to start an operator session', () => {
    const { hub, op, create } = world();
    const it = create({ title: 'Rotate the app key', needs: ['github-admin'] });
    op('plain', 'checkin', { has: [] });
    op('op', 'checkin', { has: ['operator'] });
    const entry = () => view(hub, 'p').attention.find((a) => a.kind === 'unfit');
    assert.match(entry().why, /Start an operator session \(see Operators in the guide/);
    assert.equal(op('plain', 'next').mode, 'idle');
    assert.equal(op('op', 'next').mode, 'idle', 'operator alone is not enough');
    op('admin', 'checkin', { has: ['operator', 'github-admin'] });
    assert.equal(entry(), undefined);
    assert.equal(op('admin', 'next').item, it);

    create({ title: 'Needs a VM', needs: ['linux-vm'] });
    assert.match(entry().why, /Start one on a machine that has it/, 'other tags keep the plain wording');
  });

  test('large work waits for small models, but they still get it when nothing else fits', () => {
    const { op, create } = world();
    create({ title: 'Big', size: 'large', priority: 'now' });
    create({ title: 'Small', size: 'small', priority: 'later' });
    op('tiny', 'checkin', { model: 'qwen3:8b' });
    assert.equal(op('tiny', 'next').item, '#2');
    op('big', 'checkin', { model: 'qwen3.8:27b-mtp-q4_K_M' });
    op('tiny', 'handoff', { item: '#2', headline: 'back' });
    assert.equal(op('big', 'next').item, '#1', 'a capable model takes priority order');
    op('big', 'handoff', { item: '#1', headline: 'back' });
    op('big', 'claim', { item: '#2' });
    assert.equal(op('tiny', 'next').item, '#1', 'nothing else fits: still offered');
  });

  test('a poor record on large items (≥2 stalls or send-backs, none landed) counts as a weak fit', () => {
    const { hub, clock, op, create } = world();
    create({ title: 'Big', size: 'large', priority: 'now' });
    create({ title: 'Small', priority: 'later' });
    op('w', 'checkin', { model: 'claude-opus-5-5' });
    assert.equal(op('w', 'next').item, '#1');
    clock.t += 21 * MIN; // stall 1
    assert.equal(op('w', 'next').item, '#1');
    op('w', 'submit', { item: '#1', headline: 'done' });
    hub.humanOp('p', 'sendback', { item: '#1', note: 'wrong' }); // send-back 2
    assert.equal(op('w', 'next').item, '#2', 'large work now waits for this agent');
  });

  test('model size recognition', () => {
    for (const m of ['qwen3:8b', 'ollama/qwen3:0.6b', 'Llama-3.1-8B-Instruct', 'gemma3n:e2b']) assert.ok(smallModel(m), m);
    for (const m of ['qwen3.8:27b-mtp-q4_K_M', 'claude-opus-5-5', 'gpt-5', '', undefined, 'llama3.3:70b']) assert.ok(!smallModel(m), String(m));
  });

  test('work needing what an agent has comes first for it, before generic work of the same priority; others see no change', () => {
    const { hub, op, create } = world();
    create({ title: 'Plain' });
    create({ title: 'UI check', needs: ['browser'] });
    create({ title: 'Later UI check', needs: ['browser'], priority: 'later' });
    create({ title: 'Urgent plain', priority: 'now' });
    op('ui', 'checkin', { has: ['macos', 'browser'] });
    op('mac', 'checkin', { has: ['macos'] });
    const order = (agent) => hub.claimable(hub.project('p'), agent).map((o) => o.item.title);
    assert.deepEqual(order('ui'), ['Urgent plain', 'UI check', 'Plain', 'Later UI check'], 'priority still comes first');
    assert.deepEqual(order('mac'), ['Urgent plain', 'Plain']);
    assert.deepEqual(order(''), ['Urgent plain', 'Plain', 'UI check', 'Later UI check'], 'nobody in particular: as before');
    assert.equal(op('ui', 'next').item, '#4');
    op('ui', 'claim', { item: '#4' });
    op('ui', 'submit', { item: '#4', headline: 'done' });
    assert.equal(op('ui', 'next').item, '#2', 'not #1, which anyone can take');
    assert.equal(op('mac', 'next').item, '#1');
  });

  test('items without needs and agents without has behave as before', () => {
    const { op, create } = world();
    create({ title: 'A' });
    create({ title: 'B', priority: 'now' });
    assert.equal(op('anyone', 'next').item, '#2');
  });

  test('has is in the protocol and the guide; the agent card shows it', () => {
    assert.ok(tools().find((t) => t.name === 'checkin').inputSchema.properties.has);
    assert.ok(tools().find((t) => t.name === 'propose').inputSchema.properties.needs);
    assert.ok(tools().find((t) => t.name === 'refine').inputSchema.properties.size);
    assert.match(guide(), /`has`/);
    const ops = guide({ project: 'acme' });
    assert.match(ops, /## Operators/);
    for (const tag of ['operator', 'claude-cli', 'nuworq-infra', 'homelab-vm', 'github-admin', 'browser']) {
      assert.ok(ops.split('## Operators')[1].includes(`\`${tag}\``), tag);
      assert.match(tools().find((t) => t.name === 'checkin').inputSchema.properties.has.description, new RegExp(tag));
    }
    assert.match(ops, /to: "operator"/);
    assert.match(ops, /\/loop Work on acme as its operator using nuworq/);
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    assert.match(readme, /### Operators/);
    assert.match(readme, /\/loop Work on <project> as its operator/);
    for (const tag of ['claude-cli', 'nuworq-infra', 'homelab-vm', 'github-admin']) assert.ok(readme.includes(`\`${tag}\``), tag);
    const { hub, op } = world();
    op('box', 'checkin', { has: 'Docker, linux' });
    assert.deepEqual(view(hub, 'p').agents.find((a) => a.name === 'box').has, ['docker', 'linux']);
  });
});

describe('workers report what their machine has', () => {
  test('the MCP server adds NUWORQ_HAS to checkin', async () => {
    const hub = new Hub();
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { PassThrough } = await import('node:stream');
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = [];
    output.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean).map((l) => JSON.parse(l))));
    try {
      runMcp({ input, output, env: { NUWORQ_AGENT: 'w', NUWORQ_HAS: 'docker,macos' }, clientOpts: { url: `http://127.0.0.1:${server.address().port}`, project: 'fitp', token: '' } });
      input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'checkin', arguments: {} } }) + '\n');
      for (let i = 0; i < 100 && !lines.length; i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(!lines[0].result.isError, lines[0].result.content[0].text);
      assert.deepEqual(view(hub, 'fitp').agents[0].has, ['docker', 'macos']);
    } finally {
      server.close();
    }
  });

  test('nuworq worker detects tags, puts them in NUWORQ_HAS, and routes with them', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-fit-')));
    const bin = join(dir, 'bin');
    (await import('node:fs')).mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\n', { mode: 0o755 });
    const hub = new Hub();
    for (const slug of ['needy', 'plain']) {
      hub.tx(() => hub.project(slug, { create: true }));
      hub.humanOp(slug, 'settings', { path: dir });
    }
    hub.humanOp('needy', 'create', { title: 'GPU job', acceptance: 'x', needs: ['gpu'], priority: 'now' });
    hub.humanOp('plain', 'create', { title: 'Plain', acceptance: 'x', priority: 'later' });
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const cli = (...a) => promisify(execFile)(process.execPath, [BIN, 'worker', '--url', url, '--here', '--as', 'w', ...a],
      { cwd: tmpdir(), env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, NUWORQ_TOKEN: '', NUWORQ_PROJECT: '' } });
    try {
      const plain = (await cli()).stdout;
      const has = JSON.parse(plain.match(/--mcp-config '([^']*)'/)[1]).mcpServers.nuworq.env.NUWORQ_HAS.split(',');
      assert.ok(has.includes('docker'));
      assert.ok(has.includes({ darwin: 'macos', linux: 'linux' }[process.platform] ?? has[0]));
      assert.match(plain, /w → plain/, 'the GPU job is not routed to a machine without a GPU');
      const gpu = (await cli('--has', 'gpu')).stdout;
      assert.match(gpu, /w → needy/);
    } finally {
      server.close();
    }
  });
});
