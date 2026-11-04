import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { createServer, encode } from '../src/server.js';
import { runMcp } from '../src/mcp.js';

// Agents pay for every byte they read (#528): compact JSON, gzipped when they take it, and a look that summarizes.

// A raw agent call, so the test decides the headers (fetch always asks for gzip and unpacks it).
const look = (port, args, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ port, method: 'POST', path: '/api/p/acme/agent/look', headers: { 'x-nuworq-agent': 'claude-a', 'content-type': 'application/json', ...headers } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  req.end(JSON.stringify(args));
});

describe('compact JSON, gzipped when the client takes it (#528)', () => {
  let hub, server, port, runner;
  before(async () => {
    hub = new Hub();
    hub.agentOp('acme', 'checkin', 'claude-a');
    for (let n = 1; n <= 30; n++) hub.agentOp('acme', 'propose', 'claude-a', { title: `Item number ${n} with a title long enough to matter`, acceptance: 'It works.' });
    server = createServer(hub, {});
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    runner = server.auth.localRunnerToken('box');
  });
  after(() => { server.close(); hub.close?.(); });

  test('without Accept-Encoding: plain, compact JSON, and Vary says it could differ', async () => {
    const r = await look(port, { stage: 'ready' }, { authorization: `Bearer ${runner.token}` });
    assert.equal(r.headers['content-encoding'], undefined);
    assert.equal(r.headers.vary, 'Accept-Encoding');
    const text = r.body.toString('utf8');
    assert.doesNotMatch(text, /\n/, 'no indentation');
    assert.equal(JSON.parse(text).board.ready.length, 30);
  });

  test('with Accept-Encoding: gzip, the same body gzipped', async () => {
    const plain = (await look(port, { stage: 'ready' }, { authorization: `Bearer ${runner.token}` })).body;
    const r = await look(port, { stage: 'ready' }, { 'accept-encoding': 'gzip, deflate, br', authorization: `Bearer ${runner.token}` });
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.ok(r.body.length < plain.length / 2, `${r.body.length} vs ${plain.length}`);
    assert.deepEqual(JSON.parse(gunzipSync(r.body)).board, JSON.parse(plain).board);
  });

  test('gzip refused (q=0), a small body, or a stream: sent as is', () => {
    const req = (ae) => ({ headers: { 'accept-encoding': ae } });
    const big = 'x'.repeat(5000);
    assert.equal(encode(req('gzip;q=0'), big, 'application/json').headers['content-encoding'], undefined);
    assert.equal(encode(req('deflate, gzip;q=0.5'), big, 'text/html').headers['content-encoding'], 'gzip');
    assert.equal(encode(req('br'), big, 'application/json').headers['content-encoding'], undefined);
    assert.equal(encode(req('gzip'), '{"ok":true}', 'application/json').headers['content-encoding'], undefined, 'too small to pay');
    assert.deepEqual(encode(req('gzip'), big, 'application/gzip').headers, {}, 'not JSON or text: untouched');
  });

  test('the MCP tool output is compact too', async () => {
    const input = new PassThrough(), output = new PassThrough(), lines = [];
    output.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean).map((l) => JSON.parse(l))));
    runMcp({ input, output, updateDir: mkdtempSync(join(tmpdir(), 'nuworq-compact-')), env: { NUWORQ_AGENT: 'claude-a' }, clientOpts: { url: `http://127.0.0.1:${port}`, project: 'acme', token: runner.token } });
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'look', arguments: { stage: 'ready' } } }) + '\n');
    for (let i = 0; i < 100 && !lines.some((l) => l.id === 1); i++) await new Promise((r) => setTimeout(r, 20));
    const text = lines.find((l) => l.id === 1).result.content[0].text;
    assert.doesNotMatch(text, /\n/);
    assert.equal(JSON.parse(text).board.ready.length, 30); // input stays open: its end exits the process
  });
});

describe('look without an item: counts and the top of each stage (#528)', () => {
  test('counts, the top 5 in the order next offers them, and how to see the rest; with stage, all of it', () => {
    const hub = new Hub();
    hub.agentOp('acme', 'checkin', 'claude-a');
    for (let n = 1; n <= 8; n++) hub.agentOp('acme', 'propose', 'claude-a', { title: `Item ${n}`, acceptance: 'It works.', priority: n === 7 ? 'now' : 'soon' });
    const r = hub.agentOp('acme', 'look', 'claude-a');
    assert.equal(r.counts.ready, 8);
    assert.equal(r.board.ready.length, 5);
    assert.match(r.board.ready[0], /^#7 \[now\]/, 'the most urgent first');
    assert.deepEqual(r.board.ready.slice(1).map((l) => l.split(' ')[0]), ['#1', '#2', '#3', '#4'], 'then the oldest');
    assert.match(r.more, /look with stage, e\.g\. stage: "ready" \(8 items\)/);
    const all = hub.agentOp('acme', 'look', 'claude-a', { stage: 'ready' });
    assert.equal(all.board.ready.length, 8);
    assert.equal(all.more, undefined);
    assert.equal(all.counts, undefined);
  });

  test('a small board: everything, and nothing said about more', () => {
    const hub = new Hub();
    hub.agentOp('acme', 'checkin', 'claude-a');
    hub.agentOp('acme', 'propose', 'claude-a', { title: 'Only one', acceptance: 'It works.' });
    const r = hub.agentOp('acme', 'look', 'claude-a');
    assert.deepEqual(r.counts, { ready: 1 });
    assert.equal(r.more, undefined);
  });
});
