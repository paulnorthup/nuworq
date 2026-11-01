import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

// One kept-alive connection, read one response at a time, the way a proxy reuses its connections to the origin.
function conn(port) {
  const s = connect(port, '127.0.0.1');
  let buf = '', waiting = null, closed = false;
  const settle = () => {
    if (!waiting) return;
    const head = buf.indexOf('\r\n\r\n');
    const last = head >= 0 ? buf.indexOf('\r\n0\r\n\r\n', head) : -1; // the hub's JSON comes chunked
    if (last >= 0) {
      const r = buf.slice(0, head);
      buf = buf.slice(last + 7);
      const w = waiting; waiting = null; return w(r);
    }
    if (closed) { const w = waiting; waiting = null; w(null); }
  };
  s.setEncoding('utf8');
  s.on('data', (d) => { buf += d; settle(); });
  s.on('error', () => {});
  s.on('close', () => { closed = true; settle(); });
  return {
    ready: new Promise((r) => s.once('connect', r)),
    send: () => s.write('GET /api/info HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n'),
    response: () => new Promise((r) => { waiting = r; settle(); }), // the head, or null when the hub dropped it
    end: () => s.destroy(),
  };
}

// #515: cloudflared keeps idle origin connections 90 s and doesn't retry a POST on a reset one,
// so the hub must keep them longer, while clients still hear a short timeout.
describe('kept-alive connections', () => {
  test('the hub keeps idle connections longer than a proxy does, and advertises 5 s', async () => {
    const server = createServer(new Hub());
    assert.ok(server.keepAliveTimeout > 90_000, 'longer than cloudflared keeps them');
    assert.ok(server.headersTimeout > server.keepAliveTimeout);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/info`);
      await res.text();
      assert.equal(res.headers.get('keep-alive'), 'timeout=5', 'one hint, the short one');
    } finally { server.close(); server.closeAllConnections(); }
  });

  test('a request blocking the loop resets no reused connection', async () => {
    const server = createServer(new Hub());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const cs = Array.from({ length: 20 }, () => conn(server.address().port));
    try {
      await Promise.all(cs.map((c) => c.ready));
      for (const c of cs) c.send();
      for (const c of cs) assert.match(await c.response(), /^HTTP\/1\.1 200/);
      // Each connection's next request arrives while something slow holds the loop past Node's
      // 5 s + 1 s default; with that default the idle timer fired first and reset them all.
      for (const c of cs) c.send();
      const until = Date.now() + 6_500;
      while (Date.now() < until);
      const second = await Promise.all(cs.map((c) => c.response()));
      assert.equal(second.filter((r) => !r?.startsWith('HTTP/1.1 200')).length, 0, 'no connection reset');
    } finally { for (const c of cs) c.end(); server.close(); }
  });
});
