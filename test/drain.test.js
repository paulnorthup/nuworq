import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

// The hub drains on shutdown (#545): what's in flight finishes, waits answer, streams are told to reconnect.
async function hub() {
  const h = new Hub();
  h.tx(() => h.project('o', { create: true }));
  h.agentOp('o', 'checkin', 'op', { has: ['operator'] });
  const server = createServer(h, {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { h, server, port: server.address().port };
}

// A request, written by hand: start() sends its headers and keeps the body open until finish().
function request(port, method, path, headers = {}) {
  let resolve, reject;
  const answered = new Promise((a, b) => { resolve = a; reject = b; });
  const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; seen?.(body); });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  let seen;
  return { req, answered, when: (fn) => { seen = fn; } };
}
const until = (ms) => new Promise((r) => setTimeout(r, ms));

describe('the hub drains on shutdown (#545)', () => {
  test('a request in flight finishes, on a connection that then closes', async () => {
    const { server, port } = await hub();
    const r = request(port, 'POST', '/api/p/o/agent/checkin', { 'content-type': 'application/json', 'x-nuworq-agent': 'w1' });
    r.req.write('{"has":');
    await until(50); // the hub has the request, not yet its body
    const drained = server.drain();
    r.req.end('["macos"]}');
    const res = await r.answered;
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).you, 'w1');
    assert.equal(res.headers.connection, 'close');
    await drained;
    assert.equal(server.listening, false);
  });

  test('a pending wait answers at once, empty', async () => {
    const { server, port } = await hub();
    const r = request(port, 'GET', '/api/wait?for=operator&project=o', { 'x-nuworq-agent': 'op' });
    r.req.end();
    await until(50);
    const t = Date.now();
    const drained = server.drain();
    const res = await r.answered;
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body).events, []);
    await drained;
    assert.ok(Date.now() - t < 2000, `drained in ${Date.now() - t} ms`);
  });

  test('a live stream is told to reconnect, then ended', async () => {
    const { server, port } = await hub();
    const r = request(port, 'GET', '/api/stream');
    const hello = new Promise((ok) => r.when((b) => b.includes(': hello') && ok()));
    r.req.end();
    await hello;
    const drained = server.drain();
    const res = await r.answered;
    assert.match(res.body, /\nretry: \d+\n\n$/);
    await drained;
  });

  test('new connections are refused while it drains', async () => {
    const { server, port } = await hub();
    const r = request(port, 'POST', '/api/p/o/agent/checkin', { 'content-type': 'application/json', 'x-nuworq-agent': 'w1' });
    r.req.write('{');
    await until(50);
    const drained = server.drain();
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`), 'refused');
    r.req.end('}');
    await r.answered;
    await drained;
  });

  test('a request that never finishes is cut once the time is up', async () => {
    const { server, port } = await hub();
    const r = request(port, 'POST', '/api/p/o/agent/checkin', { 'content-type': 'application/json', 'x-nuworq-agent': 'w1' });
    r.req.write('{');
    r.answered.catch(() => {}); // cut: the client sees the connection reset
    await until(50);
    const t = Date.now();
    await server.drain(300);
    assert.ok(Date.now() - t < 2000, `cut after ${Date.now() - t} ms`);
    r.req.destroy();
  });
});
