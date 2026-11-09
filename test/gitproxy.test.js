import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
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

  test('a shallow clone\'s push: leading shallow lines are skipped (#886)', () => {
    // As git sends it from a clone made with --depth, and as #878's worker push was captured: the shallow
    // line is the first pkt (0035 = "shallow " + a 40-hex sha + a newline), the commands after it.
    const S = '27a7511244b3f5c3ab98e7ea5a7b6f8d3b2a1c0d';
    const head = pkt(`shallow ${S}\n`) + pkt(`${A} ${B} refs/heads/nuworq/1-x\0report-status side-band-64k agent=git/2\n`) + '0000';
    const buf = Buffer.concat([Buffer.from(head), Buffer.from('PACK...')]);
    for (let n = 0; n < head.length; n++) assert.equal(readCommands(buf.subarray(0, n)), null, `${n} bytes are not enough`);
    const r = readCommands(buf);
    assert.deepEqual(r.cmds, [{ old: A, new: B, ref: 'refs/heads/nuworq/1-x' }]);
    assert.deepEqual(r.caps, ['report-status', 'side-band-64k', 'agent=git/2'], 'caps still ride the first command');
    assert.equal(r.end, head.length, 'the flush, not a shallow line, ends the commands');
    const two = readCommands(Buffer.from(pkt(`shallow ${S}\n`) + pkt(`shallow ${B}\n`) + pkt(`${A} ${B} refs/heads/nuworq/1-x\n`) + '0000'));
    assert.deepEqual(two.cmds, [{ old: A, new: B, ref: 'refs/heads/nuworq/1-x' }], 'a clone may be shallow at more than one commit');
    const stranger = readCommands(Buffer.from(pkt(`shallow ${'f'.repeat(64)}\n`) + pkt(`${A} ${B} refs/heads/nuworq/1-x\n`) + '0000'));
    assert.deepEqual(stranger.cmds, [{ old: A, new: B, ref: 'refs/heads/nuworq/1-x' }], 'a shallow line naming a sha the hub has never heard of is skipped just the same');
    assert.throws(() => readCommands(Buffer.from(pkt(`shallow ${S.slice(0, 20)}\n`) + pkt(`${A} ${B} refs/heads/nuworq/1-x\n`) + '0000')), /not a git push/, 'a short shallow line is no push');
    assert.throws(() => readCommands(Buffer.from(pkt(`shallow ${S}\n`) + pkt('push-cert\0report-status\n') + '0000')), /signed pushes/, 'a cert after shallow lines is still refused');
    assert.throws(() => readCommands(Buffer.from(pkt(`shallow ${S}\n`) + pkt('hello\n') + '0000')), /not a git push/, 'garbage after shallow lines is still no push');
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

  test('a body the hub can\'t read answers 400 with the line git shows, not a 500 (#895)', async () => {
    const github = await listen(() => {});
    const hub = await hubFor(github, 60_000);
    const post = (body) => new Promise((resolve, reject) => {
      const r = http.request(`${url(hub)}/git-receive-pack`, { method: 'POST' }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('close', () => resolve({ status: res.statusCode, body: out }));
      });
      r.on('error', reject);
      r.end(body);
    });
    const garbage = await post('this is not a push at all\n');
    assert.equal(garbage.status, 400, 'not a 500: the worker hears why, no operator needed');
    assert.equal(garbage.body, "nuworq: the hub couldn't read this push (unusual client or a broken request): report it as feedback\n");
    const truncated = await post(pkt(`${A} ${B} refs/heads/${BRANCH}\n`)); // commands without their flush: the body ended first
    assert.equal(truncated.status, 400);
    assert.equal(truncated.body, garbage.body, 'the same line: git shows it as remote: nuworq: …');
    const signed = await post(Buffer.from(pkt('push-cert\0report-status\n') + '0000'));
    assert.equal(signed.status, 400);
    assert.match(signed.body, /signed pushes go to GitHub directly/);
    assert.ok(await until(() => github.open === 0), 'none of the three reached GitHub');
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

// #886: a worker whose clone is shallow (it fetched with --depth, as #878's did) still pushes through the hub:
// its git opens the receive-pack body with shallow lines, and the hub reads the commands after them. The fake
// GitHub here is real git (http-backend), as the package and flow tests use.
describe('a push from a shallow clone goes through the hub', () => {
  const BRANCH = 'nuworq/1-x';
  const run = promisify(execFile);
  const git = (cwd, args, env) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, timeout: 30_000 });
  let root, bare, clone, hub, github;

  const listen = (handler) => new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = (s) => `http://127.0.0.1:${s.address().port}`;
  // GitHub's smart HTTP for the bare repository under root, tokens it takes on trust (the hub's own side).
  const gitHttp = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://x');
      const cgi = spawn('git', ['http-backend'], { env: {
        ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'x-access-token',
        REQUEST_METHOD: req.method, PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '', CONTENT_LENGTH: String(raw.length),
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '', HTTP_GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
      } });
      const out = [];
      cgi.stdout.on('data', (c) => out.push(c));
      cgi.on('close', () => {
        const buf = Buffer.concat(out);
        const split = buf.indexOf('\r\n\r\n');
        const head = buf.subarray(0, split).toString();
        const status = Number((head.match(/^Status: (\d+)/m) ?? [])[1] ?? 200);
        const headers = Object.fromEntries(head.split('\r\n').slice(1).map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()]; }).filter(([k]) => k));
        res.writeHead(status, headers);
        res.end(buf.subarray(split + 4));
      });
      cgi.stdin.end(raw);
    });
  };

  before(async () => {
    root = join(realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-shallow-'))));
    bare = join(root, 'o', 'r.git');
    mkdirSync(bare, { recursive: true });
    await git(bare, ['init', '-q', '--bare', '-b', 'main']);
    await git(bare, ['config', 'http.receivepack', 'true']);
    await git(bare, ['config', 'receive.shallowUpdate', 'true']);
    // A commit on main, so the server has the history the shallow clone will push against.
    const seed = join(root, 'seed');
    await run('git', ['clone', '-q', bare, seed], {});
    writeFileSync(join(seed, 'f.txt'), 'one\n');
    await git(seed, ['add', 'f.txt']);
    await git(seed, ['commit', '-qm', 'one']);
    await git(seed, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    // The worker's clone, one commit deep: shallow, as a depth-1 fetch makes it.
    clone = join(root, 'work');
    await run('git', ['clone', '-q', '--depth', '1', `file://${bare}`, clone], {});
    assert.ok(existsSync(join(clone, '.git', 'shallow')), 'the clone is shallow');
    // The hub in front of it, as pushInsteadOf wires a worker's pushes for github.com to it (#472).
    github = await listen(gitHttp);
    hub = await listen((req, res) => proxyPush(req, res, { git: `${url(github)}/o/r.git`, service: req.url.includes('info/refs') ? 'info/refs' : 'git-receive-pack', token: 't', branch: BRANCH }));
    // The worker's wiring (#472): its pushes for the repository go through the hub.
    const through = `${url(hub)}/api/git/github.com/o/r.git`;
    await git(clone, ['config', `url.${through}.pushInsteadOf`, `file://${bare}`]);
    await git(clone, ['switch', '-qc', BRANCH]);
    writeFileSync(join(clone, 'f.txt'), 'two\n');
    await git(clone, ['commit', '-qam', 'two']);
  });
  after(() => {
    for (const s of [hub, github]) { if (s) { s.closeAllConnections(); s.close(); } }
    rmSync(root, { recursive: true, force: true });
  });

  test('the push lands on its branch, and main is untouched', async () => {
    await git(clone, ['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`]);
    const rev = (repo, ref) => git(repo, ['rev-parse', ref]).then((r) => r.stdout.trim());
    const pushed = await rev(bare, `refs/heads/${BRANCH}`);
    assert.equal(pushed, await rev(clone, 'HEAD'), 'GitHub took the shallow clone\'s push');
    assert.notEqual(await rev(bare, 'refs/heads/main'), pushed, 'main never moved');
  });
});

// #916: on a hub without logins nothing ties a name to a token, so a name alone would pass as the anonymous public
// of this machine and get the hub to mint its write token for an item another agent holds. The fake GitHub here
// records every request the hub makes, its token mints among them.
describe('the git proxy on a hub without logins', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let github, hub, server, base, runner;
  const personKey = 'the-persons-key-for-this-test';
  const seen = [];
  const listen = (s) => new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(s.address().port)));
  const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const credentials = () => hub.q(`SELECT COUNT(*) AS n FROM events WHERE type IN ('credential', 'credential_refused')`).get().n;
  const advert = (authorization) => fetch(`${base}/api/git/github.com/acme/api.git/info/refs?service=git-receive-pack`, { headers: authorization ? { authorization } : {} });

  before(async () => {
    github = http.createServer((req, res) => {
      if (req.url !== '/app') seen.push(`${req.method} ${req.url}`); // GET /app: the hub reading its own app as it starts
      req.resume();
      const json = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.url === '/repos/acme/api/installation') return json(200, { id: 42, account: { login: 'acme' } });
      if (req.url === '/app/installations/42/access_tokens') return json(201, { token: 'ghs_write', expires_at: new Date(Date.now() + 3600_000).toISOString(), repository_selection: 'selected' });
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement' });
      res.end('001f# service=git-receive-pack\n0000');
    });
    const stub = `http://127.0.0.1:${await listen(github)}`;
    hub = new Hub();
    hub.tx(() => hub.project('api', { create: true }));
    hub.addRemote(hub.project('api'), 'git@github.com:acme/api.git', 'you');
    hub.humanOp('api', 'create', { title: 'api work', acceptance: 'done' });
    hub.agentOp('api', 'claim', 'a1', { item: '#1' });
    server = createServer(hub, { personKey, githubApp: { id: 1, key: privateKey.export({ type: 'pkcs8', format: 'pem' }), slug: 'nuworq-test' }, github: { api: stub, web: stub }, sweepMs: 3600_000 });
    base = `http://127.0.0.1:${await listen(server)}`;
    runner = server.auth.localRunnerToken('box');
  });
  after(() => { for (const s of [server, github]) { s.close(); s.closeAllConnections(); } });

  test('a caller with no token gets nothing from the git proxy', async () => {
    const asked = {
      'no credential at all': '',
      'the holder\'s name, an empty password': basic('a1', ''),
      'the holder\'s name, a blank password': basic('a1', '   '),
      'the holder\'s name, no colon': `Basic ${Buffer.from('a1').toString('base64')}`,
    };
    for (const [what, authorization] of Object.entries(asked)) {
      const r = await advert(authorization);
      assert.equal(r.status, 401, what);
      assert.match(r.headers.get('www-authenticate'), /^Basic/, `${what}: git asks its helper`);
      assert.match(await r.text(), /need the worker's name and agent token/, what);
    }
    const post = await fetch(`${base}/api/git/github.com/acme/api.git/git-receive-pack`, { method: 'POST', headers: { authorization: basic('a1', '') }, body: '0000' });
    assert.equal(post.status, 401, 'the push itself too');
    await post.text();
    const none = await advert(basic('a1', 'none')); // what nuworq git-credential sends when it has no token
    assert.equal(none.status, 401, 'a token that doesn\'t verify');
    await none.text();
    assert.deepEqual(seen, [], 'GitHub heard of none of them');
    assert.equal(credentials(), 0, 'and no credential event names a1');
  });

  // #919: a machine's workers share its runner token, so a valid token isn't enough: it has to speak for that name.
  test("a worker's token can't act under another agent's name at the git proxy", async () => {
    const other = server.auth.workerToken(server.auth.verifyToken(runner.token).id, 'a2');
    const minted = await (await fetch(`${base}/api/me/runner-token`, { method: 'POST' })).json(); // any code on this machine can get one
    const asked = { 'the machine\'s runner token': runner.token, 'a fresh tokenless mint': minted.token, 'another worker\'s own token': other.token };
    for (const [what, token] of Object.entries(asked)) {
      const r = await advert(basic('a1', token));
      assert.equal(r.status, 403, what);
      assert.match(await r.text(), /a1 is another agent's name here/, what);
      const push = await fetch(`${base}/api/git/github.com/acme/api.git/git-receive-pack`, { method: 'POST', headers: { authorization: basic('a1', token) }, body: '0000' });
      assert.equal(push.status, 403, `${what}: the push itself too`);
      await push.text();
      const read = await fetch(`${base}/api/agent/credential`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'a1' }) });
      assert.equal(read.status, 403, `${what}: and the read-only token`);
      await read.text();
    }
    assert.deepEqual(seen, [], 'GitHub heard of none of them');
    assert.equal(credentials(), 0, 'and no credential event names a1');
    server.auth.dropWorkerToken('a2');
  });

  test("only the person's key makes a worker's token", async () => {
    const mint = (authorization) => fetch(`${base}/api/me/worker-token`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify({ name: 'a1', from: runner.token }) });
    for (const [what, authorization] of Object.entries({ 'no token': '', 'the runner token': `Bearer ${runner.token}` })) {
      const r = await mint(authorization);
      assert.equal(r.status, 403, what);
      await r.text();
    }
    const mine = await mint(`Bearer ${personKey}`);
    assert.equal(mine.status, 200);
    const made = await mine.json();
    assert.equal(server.auth.verifyToken(made.token).worker, 'a1');
    assert.equal(server.auth.verifyToken(made.token).runner, 'box', 'still its machine\'s worker');
    const refused = await fetch(`${base}/api/me/worker-token`, { method: 'POST', headers: { authorization: `Bearer ${made.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'a2', from: made.token }) });
    assert.equal(refused.status, 403, 'a worker\'s token can\'t make another');
    await refused.text();
    server.auth.revoke(server.auth.verifyToken(runner.token).id);
    assert.equal(server.auth.verifyToken(made.token), null, 'it goes with the runner token it came from');
    runner = server.auth.localRunnerToken('box');
    assert.equal(server.auth.workerToken(server.auth.verifyToken(runner.token).id, 'a3').name, 'a3.worker');
    assert.equal(server.auth.dropWorkerToken('a3'), 1);
  });

  test('each worker on a machine pushes with its own token', async () => {
    hub.humanOp('api', 'create', { title: 'more api work', acceptance: 'done' });
    hub.agentOp('api', 'claim', 'a2', { item: '#2' });
    const parent = server.auth.verifyToken(runner.token).id;
    for (const name of ['a1', 'a2']) {
      const r = await advert(basic(name, server.auth.workerToken(parent, name).token));
      assert.equal(r.status, 200, name);
      await r.text();
    }
    assert.ok(seen.includes('GET /acme/api.git/info/refs?service=git-receive-pack'), `reached GitHub: ${seen.join(', ')}`);
    assert.deepEqual(hub.q(`SELECT actor FROM events WHERE type = 'credential' ORDER BY id`).all().map((e) => e.actor), ['a1', 'a2']);
  });
});
