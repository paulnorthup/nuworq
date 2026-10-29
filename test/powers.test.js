import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { view } from '../src/insight.js';
import { createServer } from '../src/server.js';

const BIN = fileURLToPath(new URL('../bin/trellis.js', import.meta.url));

function request(port, method, path, { headers = {}, body } = {}) {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('agent token powers and provenance', () => {
  let ctx;
  before(async () => {
    const hub = new Hub();
    const auth = new Auth(hub.db);
    auth.addPerson('olivia', 'owner');
    auth.addPerson('dev', 'steward');
    const tok = {
      builder: auth.createToken('builder', 'agent', { powers: 'build', mintedBy: 'dev' }),
      reviewer: auth.createToken('reviewer', 'agent', { powers: ['review'], mintedBy: 'dev' }),
      full: auth.createToken('full', 'agent'),
      ci: auth.createToken('ci', 'agent', { runner: 'github-actions' }),
      shaper: auth.createToken('shaper', 'agent', { powers: 'shape', mintedBy: 'olivia' }),
    };
    hub.tx(() => hub.project('demo', { create: true }));
    hub.humanOp('demo', 'settings', { autonomy: 'full' });
    const server = createServer(hub, { auth: 'required' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    ctx = { hub, auth, tok, server, port: server.address().port };
  });
  after(() => { ctx.server.close(); ctx.server.closeAllConnections(); });

  const op = (token, agent, name, body = {}) => request(ctx.port, 'POST', `/api/p/demo/agent/${name}`, { headers: { authorization: `Bearer ${ctx.tok[token]}`, 'x-trellis-agent': agent }, body });

  test('a build-only token gets work from next but never a review, and its review call is refused with a hint', async () => {
    const { hub } = ctx;
    hub.humanOp('demo', 'create', { title: 'Done already', acceptance: 'x' });
    hub.humanOp('demo', 'create', { title: 'To build', acceptance: 'x' });
    await op('full', 'f', 'claim', { item: '#1' });
    await op('full', 'f', 'submit', { item: '#1', headline: 'Done' }); // #1 now waits for review
    const next = await op('builder', 'b', 'next');
    assert.equal(next.json.mode, 'work');
    assert.equal(next.json.item, '#2');
    const rev = await op('builder', 'b', 'review', { item: '#1', verdict: 'accept', headline: 'ok' });
    assert.equal(rev.status, 403);
    assert.match(rev.json.error, /can't review \(its powers: build\)/);
    assert.match(rev.json.hint, /--powers review/);
    assert.equal((await op('builder', 'b', 'claim', { item: '#1' })).status, 403, 'claiming a review needs review too');
    // A review-only token gets the review and nothing else.
    const r = await op('reviewer', 'r', 'next');
    assert.equal(r.json.mode, 'review');
    assert.equal((await op('reviewer', 'r', 'review', { item: '#1', verdict: 'accept', headline: 'Good' })).status, 200);
    assert.equal((await op('reviewer', 'r', 'next')).json.mode, 'idle', 'nothing else it may do');
  });

  test('a token without shape is never handed a proposal, and its refine is refused', async () => {
    const { hub } = ctx;
    const idea = hub.humanOp('demo', 'create', { title: 'An idea', stage: 'proposed' }).item;
    await op('builder', 'b', 'handoff', { item: '#2', headline: 'pause' });
    hub.humanOp('demo', 'update', { item: '#2', stage: 'dropped' });
    const next = await op('builder', 'b', 'next');
    assert.equal(next.json.mode, 'idle', 'the only open work is a proposal');
    const ref = await op('builder', 'b', 'refine', { item: idea, acceptance: 'x' });
    assert.equal(ref.status, 403);
    assert.match(ref.json.error, /can't shape/);
    assert.equal((await op('shaper', 's', 'next')).json.mode, 'shape');
  });

  test('every agent op that needs no power is still allowed', async () => {
    for (const [name, body] of [['checkin', {}], ['look', {}], ['comment', { headline: 'hi' }], ['propose', { title: 'Another idea' }], ['learn', { note: 'npm test runs everything' }], ['ask', { question: 'Q?', assumption: 'A' }]]) {
      assert.equal((await op('reviewer', 'r', name, body)).status, 200, name);
    }
  });

  test('the agent card says who answers for the agent', async () => {
    await op('ci', 'gha-1', 'checkin');
    const agents = view(ctx.hub, 'demo').agents;
    assert.equal(agents.find((a) => a.name === 'b').via, 'via @dev');
    assert.equal(agents.find((a) => a.name === 'gha-1').via, 'runner github-actions');
    assert.equal(agents.find((a) => a.name === 'f').via, null, 'an old-style token answers to nobody in particular');
  });

  test('removing a person revokes every token they minted; runner tokens survive', async () => {
    const r = ctx.auth.removePerson('dev');
    assert.equal(r.revoked, 2);
    assert.equal((await op('builder', 'b', 'checkin')).status, 401);
    assert.equal((await op('reviewer', 'r', 'checkin')).status, 401);
    assert.equal((await op('ci', 'gha-1', 'checkin')).status, 200);
    assert.equal((await op('shaper', 's', 'checkin')).status, 200, "another person's tokens are untouched");
  });

  test('tokens from before powers existed keep every power', () => {
    const t = ctx.auth.listTokens().find((x) => x.name === 'full');
    assert.deepEqual(t.powers, ['shape', 'build', 'review']);
    assert.throws(() => ctx.auth.createToken('bad', 'agent', { powers: 'deploy' }), /powers: one or more of shape, build, review/);
    assert.throws(() => ctx.auth.createToken('both', 'agent', { mintedBy: 'olivia', runner: 'x' }), /not both/);
  });
});

describe('the token CLI shows who and what', () => {
  test('token create --powers/--minted-by/--runner and token list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trellis-powers-'));
    const db = join(dir, 't.db');
    const run = (...a) => promisify(execFile)(process.execPath, [BIN, ...a, '--db', db], { env: { ...process.env, HOME: dir, NO_COLOR: '1' } });
    await run('person', 'add', 'dev', '--role', 'steward');
    await run('token', 'create', 'b1', '--role', 'agent', '--powers', 'build,review', '--minted-by', 'dev');
    await run('token', 'create', 'ci', '--role', 'agent', '--runner', 'github-actions');
    const list = (await run('token', 'list')).stdout;
    assert.match(list, /b1 .*minted by @dev · build,review/);
    assert.match(list, /ci .*runner github-actions · shape,build,review/);
    assert.match((await run('person', 'remove', 'dev')).stdout, /1 token\(s\) they held or minted are revoked/);
  });
});
