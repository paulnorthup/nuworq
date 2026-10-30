import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';

const OAUTH = { github: { id: 'gh', secret: 's', authorize: 'http://127.0.0.1:9/a', token: 'http://127.0.0.1:9/t', api: 'http://127.0.0.1:9' } };
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));

// #155: a workspace's sign-in pages name it, lead with sign-in, and say "workspace", never "organization" (#159).
describe('signing in to a workspace', () => {
  test('the login page learns the workspace it belongs to; a single hub has none', async () => {
    const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-signin-')) });
    spaces.create('acme');
    const server = createServer(spaces, { oauth: OAUTH });
    const base = await listen(server);
    try {
      const o = await (await fetch(`${base}/w/acme/api/oauth`)).json();
      assert.equal(o.workspace, 'acme');
      assert.equal(o.providers[0].name, 'github');
      const bad = await post(`${base}/w/acme/api/invite/peek`, { token: 'nwi_nonsense' });
      assert.equal(bad.status, 410);
      assert.equal(bad.json.hint, 'Ask whoever invited you for a new link to the workspace.');
      assert.doesNotMatch(JSON.stringify(bad.json), /organi[sz]ation/i);
    } finally { server.close(); spaces.close(); }
  });

  test('the page leads with sign-in for a workspace and tucks the host-only token path away', () => {
    const js = readFileSync(new URL('../web/login.js', import.meta.url), 'utf8');
    assert.match(js, /Sign in to \$\{workspace\}\./);
    assert.match(js, /Have a token\? Paste it/);
    assert.match(js, /workspace \? 'btn primary' : 'btn'/);
    assert.doesNotMatch(js, /^input\.focus\(\);$/m, 'nothing grabs focus before the hub says which kind of page this is');
  });
});
