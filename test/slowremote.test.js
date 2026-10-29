import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

// The hub never blocks on the network (#58): GitHub that takes 3 seconds to answer (an ssh that sleeps,
// then refuses) holds up only the op that waits on it, never the rest of the hub.
describe('a slow remote never blocks the hub', () => {
  let dir, hub, server, url, saved;
  const SLUG = 'slow';

  before(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-slow-')));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'ssh'), '#!/bin/sh\nsleep 3\necho "ssh: connect to host github.com: Operation timed out" >&2\nexit 255\n', { mode: 0o755 });
    saved = { GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND, GIT_SSH: process.env.GIT_SSH };
    process.env.GIT_SSH_COMMAND = join(dir, 'bin', 'ssh');
    delete process.env.GIT_SSH;
    hub = new Hub({ repos: join(dir, 'repos') });
    hub.tx(() => hub.project(SLUG, { create: true }));
    hub.addRemote(hub.project(SLUG), 'github.com/acme/slow', 'you');
    server = createServer(hub, { sweepMs: 60_000 });
    url = `http://127.0.0.1:${await listen(server)}`;
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    server.close();
    server.closeAllConnections();
  });

  test('while an accept waits on a 3s fetch, the same hub answers a read in under 300ms; the accept then lands as today', async () => {
    hub.humanOp(SLUG, 'create', { title: 'Slow work', acceptance: 'x' });
    hub.agentOp(SLUG, 'checkin', 'a1');
    const job = hub.agentOp(SLUG, 'next', 'a1');
    hub.agentOp(SLUG, 'submit', 'a1', { item: job.item, headline: 'Built' });

    const t0 = Date.now();
    const accept = fetch(`${url}/api/p/${SLUG}/human/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item: job.item }) });
    await new Promise((r) => setTimeout(r, 200)); // the fetch is under way
    const r0 = Date.now();
    const read = await fetch(`${url}/api/p/${SLUG}/view`);
    const took = Date.now() - r0;
    assert.equal(read.status, 200);
    assert.ok(took < 300, `the read took ${took}ms`);

    const done = await accept;
    assert.equal(done.status, 200, await done.clone().text());
    assert.ok(Date.now() - t0 >= 2500, 'the accept waited for the fetch');
    // Unreachable: as today, accepted remote work waits in landing, and its land job says push first.
    assert.equal(hub.item(hub.project(SLUG), job.item).stage, 'landing');
    hub.agentOp(SLUG, 'checkin', 'a2');
    const land = hub.agentOp(SLUG, 'next', 'a1');
    assert.equal(land.mode, 'land');
    assert.match(land.hint, new RegExp(`git push origin ${job.branch}`));
  });

  test('ordinary reads never wait: a stale mirror starts a background fetch, and the project hears when it finished', async () => {
    hub.tx(() => hub.project('other', { create: true }));
    const p = hub.project('other');
    hub.addRemote(p, 'github.com/acme/other', 'you');
    const t0 = Date.now();
    hub.agentOp('other', 'checkin', 'a3');
    hub.agentOp('other', 'next', 'a3', { claim: false });
    // The ops' own change events are behind us; the next one is the fetch finishing.
    const heard = new Promise((r) => hub.on('change', (e) => { if (e.project === 'other') r(e); }));
    assert.equal(hub.repoFor(p), null, 'nothing yet: the first clone is under way');
    assert.ok(Date.now() - t0 < 300, `reads took ${Date.now() - t0}ms`);
    await heard;
    assert.ok(Date.now() - t0 >= 2500, 'the change came when the fetch finished');
  });

  test('no network git runs synchronously in src/git.js', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'git.js'), 'utf8');
    const net = src.slice(src.indexOf('const netGit'), src.indexOf('// A repository on this machine'));
    assert.match(net, /execFile\(/);
    assert.doesNotMatch(net, /execFileSync|spawnSync/);
    // execFileSync runs only local reads (git()) and fetches from a path on this machine (diskGit).
    const sync = [...src.matchAll(/execFileSync\(/g)].length;
    assert.equal(sync, 2, 'git() and diskGit() only');
    assert.match(src, /plan\.disk \? diskGit\(/);
    assert.match(src, /const disk = !https && source\.startsWith\('\/'\)/);
  });
});
