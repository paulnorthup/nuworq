import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OPS, tools } from '../src/protocol.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A hub as far as the MCP server asks it: its tools and its guide, which a test can change. state.tools null: the
// real tools for the role asked. checkin answers with state.role.
function fakeHub(port = 0) {
  const state = { tools: [{ name: 'checkin', description: 'Hub checkin', inputSchema: { type: 'object' } }, { name: 'brand_new', description: 'Only the hub knows this one', inputSchema: { type: 'object' } }], guide: '# The hub\'s own guide\n', roles: [], role: 'session' };
  const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://hub');
    if (url.pathname === '/api/tools' && url.searchParams.get('format') === 'mcp') {
      state.roles.push(url.searchParams.get('role'));
      return json(res, state.tools ?? tools('mcp', '', { role: url.searchParams.get('role') }));
    }
    if (url.pathname.endsWith('/agent/checkin')) { req.resume(); return req.on('end', () => json(res, { ok: true, project: 'demo', role: state.role })); }
    if (req.url.startsWith('/api/guide')) { res.writeHead(200, { 'content-type': 'text/markdown' }); return res.end(state.guide); }
    res.writeHead(404); res.end('{}');
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, state, port: server.address().port })));
}

// `nuworq mcp` over stdio: send requests, collect every message it writes.
function mcp(port) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NUWORQ|TRELLIS)_/.test(k))), NUWORQ_URL: `http://127.0.0.1:${port}`, NUWORQ_MCP_POLL_MS: '100' };
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
  test('tools and instructions come from the hub; a change reaches the open session as list_changed', async () => {
    const hub = await fakeHub();
    const s = mcp(hub.port);
    try {
      const init = await s.ask('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } });
      assert.equal(init.instructions, '# The hub\'s own guide\n');
      assert.deepEqual(init.capabilities.tools, { listChanged: true });
      assert.deepEqual((await s.ask('tools/list')).tools.map((t) => t.name), ['checkin', 'brand_new'], "exactly the hub's tools");

      hub.state.tools = [...hub.state.tools, { name: 'newer_still', description: 'x', inputSchema: { type: 'object' } }];
      await s.until((m) => m.method === 'notifications/tools/list_changed');
      assert.deepEqual((await s.ask('tools/list')).tools.map((t) => t.name), ['checkin', 'brand_new', 'newer_still']);
      await sleep(300);
      assert.equal(s.seen.filter((m) => m.method === 'notifications/tools/list_changed').length, 1, 'once per change');
    } finally { s.close(); hub.server.close(); }
  });

  test('hub unreachable: built-in tools and a stale warning; when it comes back, list_changed', async () => {
    const probe = await fakeHub();
    const port = probe.port;
    await new Promise((r) => probe.server.close(r));
    const s = mcp(port);
    let hub;
    try {
      const init = await s.ask('initialize', { protocolVersion: '2025-06-18' });
      assert.match(init.instructions, /may be stale/);
      assert.deepEqual((await s.ask('tools/list')).tools.map((t) => t.name), OPS.filter((o) => !o.roles).map((o) => o.name), "a session's built-in tools");
      hub = await fakeHub(port);
      await s.until((m) => m.method === 'notifications/tools/list_changed');
      assert.ok((await s.ask('tools/list')).tools.some((t) => t.name === 'brand_new'));
    } finally { s.close(); hub?.server.close(); }
  });

  // #529: a session sees only the tools its role can use; operators learn theirs at checkin.
  test('a session asks for its role\'s tools, and an operator checkin brings the operator\'s', async () => {
    const hub = await fakeHub();
    hub.state.tools = null;
    hub.state.role = 'operator';
    const s = mcp(hub.port);
    try {
      await s.ask('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } });
      let list = (await s.ask('tools/list')).tools;
      assert.equal(hub.state.roles[0], 'session');
      assert.ok(!list.some((t) => t.name === 'answer'), 'no answer before it is an operator');
      assert.ok(!('escalates' in list.find((t) => t.name === 'ask').inputSchema.properties));
      await s.ask('tools/call', { name: 'checkin', arguments: { has: ['operator'] } });
      await s.until((m) => m.method === 'notifications/tools/list_changed');
      list = (await s.ask('tools/list')).tools;
      assert.equal(hub.state.roles.at(-1), 'operator');
      assert.ok(list.some((t) => t.name === 'answer'));
      assert.ok('escalates' in list.find((t) => t.name === 'ask').inputSchema.properties);
    } finally { s.close(); hub.server.close(); }
  });
});
