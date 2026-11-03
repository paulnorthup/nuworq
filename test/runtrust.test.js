import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { checkName, sq, redact, printable, lockDown, tokenFile, withoutTokens, chooseFolders, chosenFolders, inChosen, loopback } from '../src/runtrust.js';

// A runner trusts its own machine, not the hub (#477).
const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const mode = (p) => statSync(p).mode & 0o777;

describe('what the hub sends is checked before a shell sees it', () => {
  test('only plain names pass; every value in a shell string is quoted', () => {
    for (const ok of ['nuworq', 'claude-9feb', 'a.b_c-1']) assert.equal(checkName('project', ok), ok);
    for (const bad of ['a;touch x', '$(id)', '`id`', 'A', '../x', '..', '', 'a b', "a'b", 'a\nb']) {
      assert.throws(() => checkName('project', bad), /isn't a plain name/, JSON.stringify(bad));
    }
    const hostile = `x'; touch /tmp/never; echo '$(id) \`id\``;
    assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${sq(hostile)}`], { encoding: 'utf8' }), hostile);
  });

  test('tokens are redacted and control characters stripped', () => {
    assert.equal(redact('token nwq_abcdef123456 and ghs_ABCdef0123 and ghp_xyz12345, github_pat_11AA_bb'), 'token nwq_[redacted] and ghs_[redacted] and ghp_[redacted], github_pat_[redacted]');
    assert.equal(printable('Fix \u001b[31mred\u001b[0m\u0007 title\nnext\tline'), 'Fix [31mred[0m title\nnext\tline');
  });

  test('provider and llm-proxy keys are redacted too, by shape, in a header, or as a secret of the runner (#626)', () => {
    const env = { NUWORQ_LLM_PROXY_TOKEN: 'owner-token-shapeless-9f8e7d6c', NUWORQ_TOKEN_FILE: '/home/me/.nuworq/tokens/w.token', SHORT_KEY: 'abc', HOME: '/home/me' };
    assert.equal(redact('ant sk-ant-api03-Abc123def456 oai sk-proj-Zyx987wvu654 proxy sk-proxy-0a1b2c3d4e5f', env), 'ant sk-[redacted] oai sk-[redacted] proxy sk-[redacted]');
    assert.equal(redact('Authorization: Bearer tok_abc.def\nx-proxy-token: anything-at-all\nX-Api-Key: k123', env), 'Authorization: Bearer [redacted]\nx-proxy-token: [redacted]\nX-Api-Key: [redacted]');
    assert.equal(redact('owner was owner-token-shapeless-9f8e7d6c.', env), 'owner was [redacted].');
    assert.equal(redact('file /home/me/.nuworq/tokens/w.token, abc, task-list', env), 'file /home/me/.nuworq/tokens/w.token, abc, task-list', 'paths, short values and ordinary words stay');
    assert.equal(JSON.parse(redact(JSON.stringify({ h: 'Authorization: Bearer sk-ant-api03-Abc123def456' }), env)).h, 'Authorization: Bearer [redacted]', 'JSON stays JSON');
  });

  test("a worker's environment holds no token: the person's, an agent's, or a git helper that carries one", () => {
    const env = withoutTokens({
      PATH: '/bin', NUWORQ_TOKEN: 'nwq_human1234', NUWORQ_AGENT_TOKEN: 'nwq_agent1234',NUWORQ_URL: 'http://h',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '!NUWORQ_TOKEN=nwq_old12345 node x', OTHER: 'ghs_abcdef12',
    });
    assert.deepEqual(env, { PATH: '/bin', NUWORQ_URL: 'http://h' }, 'the git config set goes whole, or git would refuse it');
  });

  test('~/.nuworq, its logs and tokens are 0700 with 0600 files, set again on every start', () => {
    const dir = join(tmp('nuworq-lock-'), '.nuworq');
    mkdirSync(join(dir, 'logs'), { recursive: true, mode: 0o755 });
    writeFileSync(join(dir, 'connect.json'), '{}', { mode: 0o644 });
    writeFileSync(join(dir, 'logs', 'w.log'), 'x', { mode: 0o644 });
    lockDown(dir);
    assert.deepEqual([mode(dir), mode(join(dir, 'logs')), mode(join(dir, 'tokens')), mode(join(dir, 'connect.json')), mode(join(dir, 'logs', 'w.log'))], [0o700, 0o700, 0o700, 0o600, 0o600]);
    const f = tokenFile(dir, 'w-1', 'nwq_secret12');
    assert.equal(mode(f), 0o600);
    assert.equal(readFileSync(f, 'utf8').trim(), 'nwq_secret12');
    assert.throws(() => tokenFile(dir, '../evil', 'x'), /isn't a plain name/);
  });

  test('chosen folders: inside one counts, beside it does not; only a hub on this machine is local', () => {
    const root = tmp('nuworq-chosen-');
    const dir = join(root, '.nuworq');
    mkdirSync(join(root, 'repos', 'api'), { recursive: true });
    mkdirSync(join(root, 'repos-evil'));
    assert.deepEqual(chosenFolders(dir), []);
    const chosen = chooseFolders(dir, [join(root, 'repos')]);
    assert.deepEqual(chosenFolders(dir), chosen);
    assert.ok(inChosen(join(root, 'repos', 'api'), chosen));
    assert.ok(inChosen(join(root, 'repos'), chosen));
    assert.ok(!inChosen(join(root, 'repos-evil'), chosen));
    assert.ok(!inChosen(join(root, '.ssh'), chosen));
    assert.ok(loopback('http://127.0.0.1:4100') && loopback('http://localhost:1') && !loopback('https://app.nuworq.com'));
  });
});

// A hub that renames a project's slug in what it sends, as a hostile or impersonated hub could.
function hostileProxy(target, from, to) {
  return http.createServer((req, res) => {
    const up = http.request({ host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: req.headers }, (r) => {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { body += c; });
      r.on('end', () => {
        const out = body.split(JSON.stringify(from)).join(JSON.stringify(to));
        res.writeHead(r.statusCode, { 'content-type': r.headers['content-type'] ?? 'application/json' });
        res.end(out);
      });
    });
    req.pipe(up);
  });
}

describe('a runner facing a hostile hub', () => {
  test('a slug that would run a command: nothing runs, and the runner says why', async () => {
    const root = tmp('nuworq-hostile-');
    const work = join(root, 'work'), home = join(root, 'home'), bin = join(root, 'bin');
    for (const d of [work, home, bin]) mkdirSync(d);
    mkdirSync(join(home, '.nuworq'));
    writeFileSync(join(home, '.nuworq', 'folders.json'), JSON.stringify({ folders: [work] }));
    const started = join(root, 'agent-started'), pwned = join(root, 'pwned');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\ntouch ${sq(started)}\n`, { mode: 0o755 });
    const hub = new Hub();
    hub.tx(() => hub.project('good', { create: true }));
    hub.humanOp('good', 'settings', { path: work, runner: true });
    hub.humanOp('good', 'create', { title: 'Do it', acceptance: 'done' });
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const proxy = hostileProxy(server.address().port, 'good', `good$(touch ${pwned})`);
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${proxy.address().port}`;
    try {
      const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, NUWORQ_TOKEN: '', NUWORQ_AGENT_TOKEN: '', NUWORQ_REPOS: '' };
      const { stdout } = await promisify(execFile)(process.execPath, [BIN, 'run', '--url', url, '--agent', 'claude', '--max-runs', '1', '--until-idle', '--poll', '1'], { env, cwd: work });
      assert.match(stdout, /isn't a plain name/, stdout);
      assert.ok(!existsSync(pwned), 'the hub ran nothing here');
      assert.ok(!existsSync(started), 'no agent started');
    } finally {
      proxy.close();
      server.close();
    }
  });

  test("the hub's folder for a project isn't used unless the person chose it", async () => {
    const root = tmp('nuworq-folder-');
    const elsewhere = join(root, 'elsewhere'), home = join(root, 'home'), bin = join(root, 'bin');
    for (const d of [elsewhere, home, bin]) mkdirSync(d);
    const started = join(root, 'agent-started');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\ntouch ${sq(started)}\n`, { mode: 0o755 });
    const hub = new Hub();
    hub.tx(() => hub.project('good', { create: true }));
    hub.humanOp('good', 'settings', { path: elsewhere, runner: true });
    hub.humanOp('good', 'create', { title: 'Do it', acceptance: 'done' });
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, NUWORQ_TOKEN: '', NUWORQ_AGENT_TOKEN: '', NUWORQ_REPOS: '' };
      const run = (...a) => promisify(execFile)(process.execPath, [BIN, 'run', '--url', url, '--agent', 'claude', '--max-runs', '1', '--until-idle', '--poll', '1', ...a], { env, cwd: home });
      const first = (await run()).stdout;
      assert.match(first, /No folder is chosen for workers on this machine/);
      assert.match(first, /has no folder you chose for workers/);
      assert.ok(!existsSync(started), 'no agent in a folder only the hub named');
      // The person names it themselves: now it's theirs.
      const second = (await run('--folder', elsewhere)).stdout;
      assert.ok(existsSync(started), second);
      assert.deepEqual(chosenFolders(join(home, '.nuworq')), [elsewhere]);
    } finally {
      server.close();
    }
  });
});
