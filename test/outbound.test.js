import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { blockedAddress, outbound, privateLiteral, allowedHosts } from '../src/outbound.js';
import { addChannel, deliver, listChannels } from '../src/notify.js';
import { check, normPrecondition } from '../src/precondition.js';
import { Hub } from '../src/core.js';

// A local server that counts what reaches it; /redirect sends the caller on to `to`.
async function sink() {
  const state = { hits: 0, to: '', bodies: [] };
  const server = http.createServer((req, res) => {
    state.hits++;
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      state.bodies.push(b);
      if (req.url.startsWith('/redirect')) { res.writeHead(Number(req.url.split('/')[2] ?? 302), { location: state.to }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { state, url: `http://127.0.0.1:${server.address().port}`, port: server.address().port, close: () => { server.closeAllConnections(); server.close(); } };
}

describe('the hub reaches only the public internet on people\'s behalf (#474)', () => {
  let a, b;
  before(async () => { a = await sink(); b = await sink(); });
  after(() => { a.close(); b.close(); });

  test('every range that is not public unicast is refused', () => {
    const refused = [
      '127.0.0.1', '127.255.0.9', '0.0.0.0', '0.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '100.100.100.100', '100.127.255.255', '192.0.0.1', '198.18.0.1', '198.19.255.255',
      '224.0.0.1', '239.255.255.250', '255.255.255.255',
      '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:100.64.0.1', '::ffff:192.168.0.1', '::127.0.0.1',
      '64:ff9b::a00:1', '2002:7f00:1::', '[::1]', 'localhost', 'not-an-ip', '',
    ];
    for (const ip of refused) assert.ok(blockedAddress(ip), `refuses ${ip}`);
    const allowed = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '198.20.0.1', '223.255.255.255',
      '2606:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'];
    for (const ip of allowed) assert.ok(!blockedAddress(ip), `allows ${ip}`);
  });

  test('a guarded request resolves once and connects to the address it checked', async () => {
    // A resolver that answers differently on its second lookup (DNS rebinding): only the first is ever asked.
    let lookups = 0;
    const resolve = async () => (++lookups === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.9.9.9', family: 4 }]);
    const res = await outbound(`http://sink.test:${a.port}/x`, { guard: true, resolve, allow: ['sink.test'] });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'hello');
    assert.equal(lookups, 1, 'no second lookup');

    // Public first, private second: it connects to the public answer, never asking again.
    lookups = 0;
    const flip = async () => (++lookups === 1 ? [{ address: '192.0.2.1', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
    const hits = a.state.hits;
    await assert.rejects(outbound(`http://rebind.test:${a.port}/x`, { guard: true, resolve: flip, allow: [], timeoutMs: 300 }));
    assert.equal(lookups, 1);
    assert.equal(a.state.hits, hits, 'the private address never saw it');
  });

  test('a guarded request refuses private answers before connecting, and any answer among several', async () => {
    const hits = a.state.hits;
    await assert.rejects(outbound(`${a.url}/x`, { guard: true, allow: [] }), { code: 'EBLOCKED' });
    await assert.rejects(outbound(`http://localhost:${a.port}/x`, { guard: true, allow: [] }), { code: 'EBLOCKED' });
    await assert.rejects(outbound(`http://two.test:${a.port}/x`, { guard: true, allow: [], resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), { code: 'EBLOCKED' });
    assert.equal(a.state.hits, hits);
  });

  test('a guarded request never follows a redirect, 302 or 307, into a private address', async () => {
    a.state.to = `http://localhost:${b.port}/steal`;
    for (const code of [302, 307]) {
      const res = await outbound(`${a.url}/redirect/${code}`, { guard: true, allow: ['127.0.0.1'], method: 'POST', body: '{"secret":1}' });
      assert.equal(res.status, code);
    }
    assert.equal(b.state.hits, 0, 'the redirect target never saw a request');
  });

  test('private hosts the hub host names are allowed; nothing else is', () => {
    assert.deepEqual(allowedHosts({ NUWORQ_ALLOW_PRIVATE_HOSTS: ' ntfy.lan , 192.168.1.5 ' }), ['ntfy.lan', '192.168.1.5']);
    assert.deepEqual(allowedHosts({}), []);
    assert.equal(privateLiteral('http://192.168.1.5/t', { allow: ['192.168.1.5'] }), false);
    assert.equal(privateLiteral('http://192.168.1.5/t', { allow: [] }), true);
    assert.equal(privateLiteral('http://[::1]:80/t', { allow: [] }), true);
    assert.equal(privateLiteral('http://app.localhost/t', { allow: [] }), true);
    assert.equal(privateLiteral('https://ntfy.sh/t', { allow: [] }), false, 'a name is checked when it is sent');
  });

  test('a shared hub refuses a private channel at once, and says only "couldn\'t deliver" when one fails', async () => {
    const hub = new Hub();
    const db = hub.db;
    assert.throws(() => addChannel(db, 'webhook', 'http://169.254.169.254/latest', Date.now(), { guard: true }), /a shared hub sends only to public addresses/);
    assert.throws(() => addChannel(db, 'webhook', `http://localhost:${a.port}/`, Date.now(), { guard: true }), /public addresses/);
    // A name that resolves privately is refused when it is sent, with the reason only in the log.
    const { id } = addChannel(db, 'webhook', `http://hooks.test:${a.port}/x`, Date.now(), { guard: true });
    const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
    const hits = a.state.hits;
    const logged = [], error = console.error;
    console.error = (...m) => logged.push(m.join(' '));
    let r;
    try { r = await deliver(db, c, { title: 't', text: 't', entries: [] }, { guard: true, retryDelay: 0, allow: [], resolve: async () => [{ address: '127.0.0.1', family: 4 }] }); }
    finally { console.error = error; }
    assert.deepEqual(r, { id, kind: 'webhook', ok: false, error: "couldn't deliver" });
    assert.equal(listChannels(db)[0].last_error, "couldn't deliver");
    assert.match(logged.join('\n'), /hooks\.test is not a public address/);
    assert.equal(a.state.hits, hits);
    // A hub of one's own still sends to its own network, with the real reason.
    const own = addChannel(db, 'webhook', `${a.url}/mine`, Date.now());
    assert.equal((await deliver(db, db.prepare('SELECT * FROM channels WHERE id = ?').get(own.id), { title: 't', text: 't', entries: [] })).ok, true);
    hub.close?.();
  });

  test('a shared hub\'s precondition check is generic, and its oracle never reaches the private network', async () => {
    const hits = a.state.hits;
    const error = console.error;
    console.error = () => {};
    try {
      for (const pre of [normPrecondition({ url: `${a.url}/x`, contains: 'hello' }), normPrecondition({ url: `http://meta.test/x`, json_path: 'a', equals: 1 })]) {
        const r = await check(pre, { shared: true, resolve: async () => [{ address: '169.254.169.254', family: 4 }] });
        assert.equal(r.ok, false);
        assert.match(r.detail, /^couldn't check .*: a shared hub reaches only public addresses that answer$/);
      }
    } finally { console.error = error; }
    assert.equal(a.state.hits, hits);
    // The host's own allow list lets a named private host through.
    assert.equal((await check(normPrecondition({ url: `${a.url}/x`, contains: 'hello' }), { shared: true, allow: ['127.0.0.1'] })).ok, true);
  });
});
