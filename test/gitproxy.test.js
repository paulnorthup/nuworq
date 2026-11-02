import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readCommands, refusedRef, refusal, proxyPush } from '../src/gitproxy.js';

// The ref updates at the head of a push (#472), as git sends them: pkt-lines, capabilities after a NUL on the first.
const pkt = (s) => `${(Buffer.byteLength(s) + 4).toString(16).padStart(4, '0')}${s}`;
const A = 'a'.repeat(40), B = 'b'.repeat(40), Z = '0'.repeat(40);

describe('the hub reads a push before passing it on', () => {
  test('commands and capabilities, only once they are all there', () => {
    const head = pkt(`${A} ${B} refs/heads/nuworq/1-x\0report-status side-band-64k agent=git/2\n`) + pkt(`${Z} ${B} refs/heads/main\n`) + '0000';
    const buf = Buffer.concat([Buffer.from(head), Buffer.from('PACK...')]);
    for (let n = 0; n < head.length; n++) assert.equal(readCommands(buf.subarray(0, n)), null, `${n} bytes are not enough`);
    const r = readCommands(buf);
    assert.deepEqual(r.cmds, [{ old: A, new: B, ref: 'refs/heads/nuworq/1-x' }, { old: Z, new: B, ref: 'refs/heads/main' }]);
    assert.deepEqual(r.caps, ['report-status', 'side-band-64k', 'agent=git/2']);
    assert.equal(r.end, head.length, 'the pack starts after the flush');
    assert.deepEqual(readCommands(Buffer.from('0000')).cmds, [], "git's empty probe before a large push");
    assert.throws(() => readCommands(Buffer.from(pkt('push-cert\0report-status\n'))), /signed pushes/);
    assert.throws(() => readCommands(Buffer.from(pkt('hello\n'))), /not a git push/);
  });

  test('only the held item\'s nuworq/ branch, and no deletions (#605)', () => {
    const own = 'nuworq/12-fix';
    assert.equal(refusedRef({ new: B, ref: 'refs/heads/nuworq/12-fix' }, own), '');
    assert.match(refusedRef({ new: B, ref: 'refs/heads/nuworq/7-accepted-elsewhere' }, own), /only the branch of the item they hold: nuworq\/12-fix/);
    assert.match(refusedRef({ new: B, ref: 'refs/heads/nuworq/12-fix-2' }, own), /only the branch of the item they hold/);
    assert.match(refusedRef({ new: B, ref: 'refs/heads/nuworq/12-fix' }), /has no branch yet/, 'no held branch: nothing passes');
    assert.match(refusedRef({ new: B, ref: 'refs/heads/main' }, own), /never push main/);
    assert.match(refusedRef({ new: B, ref: 'refs/tags/v1.0.0' }, own), /only refs\/heads\/nuworq\/\*/);
    assert.match(refusedRef({ new: B, ref: 'refs/heads/nuworqx' }, own), /only refs\/heads\/nuworq\/\*/);
    assert.match(refusedRef({ new: Z, ref: 'refs/heads/nuworq/12-fix' }, own), /never delete/);
    assert.match(refusedRef({ new: B, ref: 'refs/heads/nuworq/12-fix' }, own, '#7'), /nuworq\/12-fix is #7's branch/, 'another live item holds it (#759)');
  });

  test('a refusal git understands: each ref rejected with its reason, in the side band when asked', () => {
    const cmds = [{ ref: 'refs/heads/main' }, { ref: 'refs/heads/nuworq/1-x' }];
    const plain = refusal(cmds, ['no main', ''], ['report-status'], 'nuworq: no main.').toString();
    assert.equal(plain, `${pkt('unpack ok\n')}${pkt('ng refs/heads/main no main\n')}${pkt('ng refs/heads/nuworq/1-x refused with the others in this push\n')}0000`);
    const banded = refusal(cmds, ['no main', ''], ['report-status', 'side-band-64k'], 'nuworq: no main.').toString('latin1');
    assert.ok(banded.startsWith(pkt('\x02nuworq: no main.\n')), 'the reason as a remote: line');
    assert.ok(banded.endsWith('0000'));
    assert.ok(banded.includes(`\x01${pkt('unpack ok\n')}`));
  });
});

// #738: GitHub hanging, or cut off, never hangs the worker's push with it. A local server plays GitHub; the hub's
// side is proxyPush behind a plain http server, as src/server.js mounts it.
describe('the push proxy when GitHub hangs or goes', () => {
  const BRANCH = 'nuworq/1-x';
  const PUSH = Buffer.concat([Buffer.from(pkt(`${A} ${B} refs/heads/${BRANCH}\0report-status\n`) + '0000'), Buffer.from('PACK')]);
  const listen = async (handler) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1');
    await once(s, 'listening');
    s.open = 0; // sockets open right now
    s.on('connection', (c) => { s.open++; c.on('close', () => s.open--); });
    return s;
  };
  const url = (s) => `http://127.0.0.1:${s.address().port}`;
  // The hub: every request a push through proxyPush to the fake GitHub.
  const hubFor = (github, timeoutMs) => listen((req, res) => {
    const service = req.url.startsWith('/info/refs') ? 'info/refs' : 'git-receive-pack';
    proxyPush(req, res, { git: `${url(github)}/o/r.git`, service, token: 't', branch: BRANCH, timeoutMs });
  });
  // One request to the hub, as git sends it: its status, its body, and how long it took.
  const ask = (hub, service) => new Promise((resolve, reject) => {
    const t = Date.now();
    const post = service === 'git-receive-pack';
    const r = http.request(`${url(hub)}/${post ? 'git-receive-pack' : 'info/refs?service=git-receive-pack'}`, { method: post ? 'POST' : 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('error', () => {});
      res.on('close', () => resolve({ status: res.statusCode, body, ms: Date.now() - t, cut: !res.complete }));
    });
    r.on('error', (e) => resolve({ error: e.code, ms: Date.now() - t }));
    r.end(post ? PUSH : undefined);
    setTimeout(() => reject(new Error('the hub never answered')), 10_000).unref();
  });
  const until = async (ok, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (ok()) return true;
    return false;
  };
  const close = (...servers) => { for (const s of servers) { s.closeAllConnections(); s.close(); } };

  test('GitHub accepting and never answering: info/refs and receive-pack both end with "GitHub didn\'t answer"', async () => {
    const github = await listen(() => {}); // takes the request, says nothing
    const hub = await hubFor(github, 300);
    for (const service of ['info/refs', 'git-receive-pack']) {
      const r = await ask(hub, service);
      assert.equal(r.status, 502, service);
      assert.ok(!r.cut, `${service}: a whole answer`);
      assert.equal(r.body, "nuworq: GitHub didn't answer in 0.3s. Try the push again in a minute.\n", `${service}: git shows it as remote: nuworq: …`);
      assert.ok(r.ms < 3000, `${service} ended in ${r.ms}ms, not when git gives up`);
    }
    assert.ok(await until(() => github.open === 0), 'the hub hangs up on GitHub too');
    close(hub, github);
  });

  test('GitHub unreachable says so, in the same line git shows', async () => {
    const gone = await listen(() => {});
    const port = gone.address().port;
    close(gone);
    await once(gone, 'close');
    const hub = await listen((req, res) => proxyPush(req, res, { git: `http://127.0.0.1:${port}/o/r.git`, service: 'info/refs', token: 't', branch: BRANCH }));
    const r = await ask(hub, 'info/refs');
    assert.equal(r.status, 502);
    assert.match(r.body, /^nuworq: couldn't reach GitHub \(ECONNREFUSED\)\. Try the push again in a minute\.\n$/);
    close(hub);
  });

  test('a worker that hangs up mid-push: the hub hangs up on GitHub', async () => {
    const github = await listen(() => {});
    const hub = await hubFor(github, 60_000);
    const r = http.request(`${url(hub)}/git-receive-pack`, { method: 'POST' });
    r.on('error', () => {});
    r.write(PUSH); // the commands and the start of the pack; the rest never comes
    assert.ok(await until(() => github.open === 1), 'the push reached GitHub');
    r.destroy();
    assert.ok(await until(() => github.open === 0), 'and its request to GitHub is cut, not left open for a minute');
    close(hub, github);
  });

  test('GitHub cut off mid-answer: the worker is cut off too, and the hub carries on', async () => {
    const github = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement' });
      res.write('001f# service=git-receive-pack\n');
      setTimeout(() => res.socket.destroy(), 50);
    });
    const hub = await hubFor(github, 60_000);
    const r = await ask(hub, 'info/refs');
    assert.ok(r.cut || r.error, 'the worker sees the answer end early');
    // Still serving: a process-level error would have ended the test run here.
    const again = await ask(hub, 'info/refs');
    assert.ok(again.cut || again.error);
    close(hub, github);
  });
});
