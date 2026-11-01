import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OPS, protocolVersion } from '../src/protocol.js';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A hub as far as the MCP server asks it: its tools and its guide, which a test can change, the protocol it
// names on every answer (#541), and an agent call. fetches counts the requests for its tools.
function fakeHub(port = 0) {
  const state = { protocol: 'p1', fetches: 0, tools: [{ name: 'checkin', description: 'Hub checkin', inputSchema: { type: 'object' } }, { name: 'brand_new', description: 'Only the hub knows this one', inputSchema: { type: 'object' } }], guide: '# The hub\'s own guide\n' };
  const server = http.createServer((req, res) => {
    res.setHeader('x-nuworq-protocol', state.protocol);
    if (req.url.startsWith('/api/agent/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
    if (req.url === '/api/tools?format=mcp') { state.fetches++; res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(state.tools)); }
    if (req.url.startsWith('/api/guide')) { res.writeHead(200, { 'content-type': 'text/markdown' }); return res.end(state.guide); }
    res.writeHead(404); res.end('{}');
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, state, port: server.address().port })));
}

// `nuworq mcp` over stdio: send requests, collect every message it writes.
function mcp(port) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NUWORQ|TRELLIS)_/.test(k))), NUWORQ_URL: `http://127.0.0.1:${port}` };
  const child = spawn(process.execPath, [BIN, 'mcp'], { env });
  const seen = [];
  let buf = '';
  child.stdout.on('data', (c) => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { seen.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); } });
  let id = 0;
  const until = async (pred, ms = 4000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) { const m = seen.find(pred); if (m) return m; }
    throw new Error(`nothing matched in ${ms}ms: ${JSON.stringify(seen)}`);
  };
  const ask = async (method, params = {}) => {
    const n = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    return (await until((m) => m.id === n)).result;
  };
  return { ask, until, seen, close: () => child.kill() };
}

describe('the MCP server bridges to the hub\'s current protocol', () => {
  test('tools and instructions come from the hub; only a new protocol refetches them, and reaches the open session as list_changed', async () => {
    const hub = await fakeHub();
    const s = mcp(hub.port);
    try {
      const init = await s.ask('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } });
      assert.equal(init.instructions, '# The hub\'s own guide\n');
      assert.deepEqual(init.capabilities.tools, { listChanged: true });
      assert.deepEqual((await s.ask('tools/list')).tools.map((t) => t.name), ['checkin', 'brand_new'], "exactly the hub's tools");

      assert.equal(hub.state.fetches, 1, 'fetched once, at startup');

      // Calls while the protocol is the same: nothing is refetched, however long the session runs.
      for (let i = 0; i < 3; i++) await s.ask('tools/call', { name: 'checkin', arguments: {} });
      await sleep(200);
      assert.equal(hub.state.fetches, 1, 'no refetch while the protocol is the same');
      assert.equal(s.seen.filter((m) => m.method === 'notifications/tools/list_changed').length, 0);

      // The hub serves a new protocol: the next answer names it, and the tools are fetched again, once.
      hub.state.tools = [...hub.state.tools, { name: 'newer_still', description: 'x', inputSchema: { type: 'object' } }];
      hub.state.protocol = 'p2';
      await s.ask('tools/call', { name: 'checkin', arguments: {} });
      await s.until((m) => m.method === 'notifications/tools/list_changed');
      for (let i = 0; i < 2; i++) await s.ask('tools/call', { name: 'checkin', arguments: {} });
      assert.deepEqual((await s.ask('tools/list')).tools.map((t) => t.name), ['checkin', 'brand_new', 'newer_still']);
      await sleep(300);
      assert.equal(s.seen.filter((m) => m.method === 'notifications/tools/list_changed').length, 1, 'once per change');
      assert.equal(hub.state.fetches, 2, 'one refetch after it changed');
    } finally { s.close(); hub.server.close(); }
  });

  test('hub unreachable: built-in tools and a stale warning; the first answer once it is back brings list_changed', async () => {
    const probe = await fakeHub();
    const port = probe.port;
    await new Promise((r) => probe.server.close(r));
    const s = mcp(port);
    let hub;
    try {
      const init = await s.ask('initialize', { protocolVersion: '2025-06-18' });
      assert.match(init.instructions, /may be stale/);
      assert.deepEqual((await s.ask('tools/list')).tools.map((t) => t.name), OPS.map((o) => o.name));
      hub = await fakeHub(port);
      await s.ask('tools/call', { name: 'checkin', arguments: {} });
      await s.until((m) => m.method === 'notifications/tools/list_changed');
      assert.ok((await s.ask('tools/list')).tools.some((t) => t.name === 'brand_new'));
    } finally { s.close(); hub?.server.close(); }
  });
});

describe('the hub names its protocol on every answer (#541)', () => {
  test('x-nuworq-protocol: the hash of its tools and guide, on API answers, errors and pages alike', async () => {
    const server = createServer(new Hub(), {});
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const at = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.match(protocolVersion(), /^[0-9a-f]{16}$/);
      for (const path of ['/api/tools?format=mcp', '/api/guide', '/agents.md', '/api/health', '/api/nothing-here']) {
        const res = await fetch(at + path);
        await res.text();
        assert.equal(res.headers.get('x-nuworq-protocol'), protocolVersion(), path);
      }
    } finally { server.close(); server.closeAllConnections(); }
  });
});
