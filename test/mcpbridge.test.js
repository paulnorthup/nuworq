import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OPS, tools, protocolVersion } from '../src/protocol.js';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A hub as far as the MCP server asks it: its tools and its guide, which a test can change, the protocol it
// names on every answer (#541), and agent calls. state.tools null: the real tools for the role asked; state.roles
// records each tools request (so its length counts them). checkin answers with state.role.
function fakeHub(port = 0) {
  const state = { protocol: 'p1', tools: [{ name: 'checkin', description: 'Hub checkin', inputSchema: { type: 'object' } }, { name: 'brand_new', description: 'Only the hub knows this one', inputSchema: { type: 'object' } }], guide: '# The hub\'s own guide\n', roles: [], role: 'session', calls: [], hang: false };
  const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    res.setHeader('x-nuworq-protocol', state.protocol);
    const url = new URL(req.url, 'http://hub');
    if (url.pathname === '/api/tools' && url.searchParams.get('format') === 'mcp') {
      state.roles.push(url.searchParams.get('role'));
      return json(res, state.tools ?? tools('mcp', '', { role: url.searchParams.get('role') }));
    }
    // Every agent call, by op and agent; state.hang: a sign-off that never gets an answer.
    const op = url.pathname.match(/\/agent\/([a-z]+)$/)?.[1];
    if (op) state.calls.push({ op, agent: req.headers['x-nuworq-agent'], project: url.pathname.match(/\/api\/p\/([^/]+)\//)?.[1] ?? null });
    if (op === 'signoff' && state.hang) return;
    if (url.pathname.endsWith('/agent/checkin')) { req.resume(); return req.on('end', () => json(res, { ok: true, project: 'demo', role: state.role })); }
    if (op) { req.resume(); return req.on('end', () => json(res, { ok: true })); }
    if (req.url.startsWith('/api/guide')) { res.writeHead(200, { 'content-type': 'text/markdown' }); return res.end(state.guide); }
    res.writeHead(404); res.end('{}');
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, state, port: server.address().port })));
}

// `nuworq mcp` over stdio: send requests, collect every message it writes.
function mcp(port) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NUWORQ_/.test(k))), NUWORQ_URL: `http://127.0.0.1:${port}` };
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
  const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
  return { ask, until, seen, child, exited, close: () => child.kill() };
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

      assert.equal(hub.state.roles.length, 1, 'fetched once, at startup');

      // Calls while the protocol is the same: nothing is refetched, however long the session runs.
      for (let i = 0; i < 3; i++) await s.ask('tools/call', { name: 'checkin', arguments: {} });
      await sleep(200);
      assert.equal(hub.state.roles.length, 1, 'no refetch while the protocol is the same');
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
      assert.equal(hub.state.roles.length, 2, 'one refetch after it changed');
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
      assert.deepEqual((await s.ask('tools/list')).tools.map((t) => t.name), OPS.filter((o) => !o.roles).map((o) => o.name), "a session's built-in tools");
      hub = await fakeHub(port);
      await s.ask('tools/call', { name: 'checkin', arguments: {} });
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

// #558: a session that ends signs its agent off, so the hub stops listing it and what it held goes back at once.
describe('the MCP server signs its agent off when the session ends', () => {
  const signoffs = (hub) => hub.state.calls.filter((c) => c.op === 'signoff');
  for (const [how, stop] of [['stdin ends', (s) => s.child.stdin.end()], ['SIGTERM', (s) => s.child.kill('SIGTERM')], ['SIGHUP', (s) => s.child.kill('SIGHUP')]]) {
    test(`${how}: it signs off "Session ended" as the agent that checked in, then exits`, async () => {
      const hub = await fakeHub();
      const s = mcp(hub.port);
      try {
        await s.ask('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });
        await s.ask('tools/call', { name: 'checkin', arguments: {} });
        const agent = hub.state.calls.find((c) => c.op === 'checkin').agent;
        assert.match(agent, /^claude-code-[0-9a-f]{4}$/);
        stop(s);
        assert.deepEqual(await s.exited, { code: 0, sig: null });
        assert.deepEqual(signoffs(hub), [{ op: 'signoff', agent, project: 'demo' }], 'once, in the project the hub sent it to');
      } finally { s.close(); hub.server.close(); }
    });
  }

  test('a session that never checked in, or already signed off, signs off nothing', async () => {
    const hub = await fakeHub();
    const never = mcp(hub.port);
    const done = mcp(hub.port);
    try {
      await never.ask('initialize', { protocolVersion: '2025-06-18' });
      await never.ask('tools/call', { name: 'next', arguments: {} }); // a call, but no checkin
      never.child.stdin.end();
      assert.equal((await never.exited).code, 0);
      await done.ask('initialize', { protocolVersion: '2025-06-18' });
      await done.ask('tools/call', { name: 'checkin', arguments: {} });
      await done.ask('tools/call', { name: 'signoff', arguments: { headline: 'Done for today' } });
      done.child.kill('SIGTERM');
      assert.equal((await done.exited).code, 0);
      assert.equal(signoffs(hub).length, 1, 'only the one it made itself');
    } finally { never.close(); done.close(); hub.server.close(); }
  });

  test("a hub that doesn't answer holds the exit about 2 s, no longer", async () => {
    const hub = await fakeHub();
    hub.state.hang = true;
    const s = mcp(hub.port);
    try {
      await s.ask('initialize', { protocolVersion: '2025-06-18' });
      await s.ask('tools/call', { name: 'checkin', arguments: {} });
      const t = Date.now();
      s.child.stdin.end();
      assert.equal((await s.exited).code, 0);
      const ms = Date.now() - t;
      assert.ok(ms >= 1500 && ms < 4000, `${ms}ms`);
      assert.equal(signoffs(hub).length, 1, 'it tried');
    } finally { s.close(); hub.server.closeAllConnections(); hub.server.close(); }
  });
});
