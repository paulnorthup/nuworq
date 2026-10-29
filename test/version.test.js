import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

const root = new URL('..', import.meta.url).pathname;
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

describe('/api/info says which version is live', () => {
  let server, base;
  before(async () => {
    server = createServer(new Hub());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => { server.close(); server.closeAllConnections(); });

  test('version from package.json, commit from the running code', async () => {
    const info = await (await fetch(`${base}/api/info`)).json();
    assert.equal(info.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    const sha = git('rev-parse', 'HEAD');
    assert.equal(info.commit, sha.slice(0, 7));
    let remote = '';
    try { remote = git('remote', 'get-url', 'origin'); } catch {}
    if (/github\.com/i.test(remote)) assert.match(info.commit_url, new RegExp(`^https://github\\.com/[^/]+/[^/]+/commit/${sha}$`));
    else assert.equal(info.commit_url, null);
  });
});
