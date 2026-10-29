import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { createClient } from '../src/client.js';

// A port nothing listens on (for now).
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
const client = (port, extra = {}) => createClient({ url: `http://127.0.0.1:${port}`, token: '', cwd: tmpdir(), ...extra });

describe('the client rides out a hub restart', () => {
  test('a call made while the hub is down waits for it to come back', async () => {
    const port = await freePort();
    const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true,"name":"nuworq"}'); });
    const late = setTimeout(() => server.listen(port, '127.0.0.1'), 1000);
    const t0 = Date.now();
    try {
      assert.deepEqual(await client(port).get('/api/health'), { ok: true, name: 'nuworq' });
      assert.ok(Date.now() - t0 >= 900, 'it waited for the hub to listen');
    } finally {
      clearTimeout(late);
      server.close();
    }
  });

  test('an HTTP error is an answer: thrown at once, not retried', async () => {
    let hits = 0;
    const server = createServer((req, res) => { hits++; res.statusCode = 503; res.setHeader('content-type', 'application/json'); res.end('{"error":"busy"}'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      await assert.rejects(client(server.address().port).get('/api/projects'), (e) => e.status === 503 && e.message === 'busy');
      assert.equal(hits, 1);
    } finally {
      server.close();
    }
  });

  test('a hub that stays down is reported as not reachable once the retries run out', async () => {
    const port = await freePort();
    const t0 = Date.now();
    await assert.rejects(client(port, { retryMs: 400 }).get('/api/health'), /hub not reachable/);
    const took = Date.now() - t0;
    assert.ok(took >= 250 && took < 3000, `retried for a while, then gave up (${took}ms)`);
  });
});
