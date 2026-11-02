// Replies kept for retried writes (#524) never hold a credential (#623): the hub keeps hashes, never the secret, and
// the replies table is in every backup. A retry of a call that returned one asks again instead.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { Hub } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { createServer, holdsSecret } from '../src/server.js';

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

// GitHub, as far as minting a push token goes: the app is installed on acme/api.
function github() {
  let n = 0;
  return http.createServer((req, res) => {
    const json = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.method === 'GET' && req.url === '/repos/acme/api/installation') return json(200, { id: 42 });
    if (req.method === 'POST' && req.url === '/app/installations/42/access_tokens') return json(201, { token: `ghs_push${++n}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    json(404, { message: 'Not Found' });
  });
}

describe('a kept reply never holds a credential', () => {
  let hub, auth, tok, server, gh, url;
  before(async () => {
    gh = github();
    hub = new Hub();
    auth = new Auth(hub.db);
    auth.addPerson('olivia', 'owner');
    tok = { olivia: auth.createToken('olivia-laptop', 'human', { person: 'olivia' }), box: auth.createToken('box', 'agent') };
    hub.tx(() => hub.project('api', { create: true }));
    hub.addRemote(hub.project('api'), 'github.com/acme/api', 'you');
    hub.humanOp('api', 'create', { title: 'Seed work', acceptance: 'x' });
    server = createServer(hub, { auth: 'required', githubApp: { id: 1, key: PEM, slug: 'nuworq-test', api: `http://127.0.0.1:${await listen(gh)}` } });
    url = `http://127.0.0.1:${await listen(server)}`;
  });
  after(() => { for (const s of [server, gh]) { s.close(); s.closeAllConnections(); } });

  const call = async (path, { token, agent, key, body = {} }) => {
    const r = await fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body), headers: {
      'content-type': 'application/json', authorization: `Bearer ${token}`, ...(agent ? { 'x-nuworq-agent': agent } : {}), ...(key ? { 'idempotency-key': key } : {}) } });
    return { status: r.status, json: await r.json() };
  };
  const kept = () => hub.q('SELECT body FROM replies').all().map((r) => r.body);

  test('a kept reply never holds a credential', async () => {
    // A write's reply is kept, so its retry is answered without applying it again (#524)...
    const claim = await call('/api/p/api/agent/claim', { token: tok.box, agent: 'a1', key: 'k-claim', body: { item: '#1' } });
    assert.equal(claim.status, 200, JSON.stringify(claim.json));
    assert.equal(kept().length, 1, 'an ordinary reply is kept');

    // ...but a push token's isn't: the retry asks again (the hub's own cache of GitHub's token answers it).
    const first = await call('/api/agent/credential', { token: tok.box, agent: 'a1', key: 'k-cred' });
    assert.match(first.json.password, /^ghs_push/);
    assert.equal(kept().length, 1, 'not kept');
    const again = await call('/api/agent/credential', { token: tok.box, agent: 'a1', key: 'k-cred' });
    assert.equal(again.status, 200);
    assert.match(again.json.password, /^ghs_push/);

    // Nor an invite's link, which carries the invite's token.
    const inv = await call('/api/invites', { token: tok.olivia, key: 'k-invite', body: { role: 'member' } });
    assert.equal(inv.status, 200, JSON.stringify(inv.json));
    assert.match(inv.json.link, /#nwi_/);

    assert.equal(kept().length, 1, 'only the claim is kept');
    for (const b of kept()) assert.ok(!/ghs_|nwi_|nwq_/.test(b), b);
  });

  test('the check behind it: secret-named fields and token-shaped values, at any depth', () => {
    for (const b of [{ password: 'x' }, { a: { device_code: 'abc' } }, { link: 'https://h/invite.html#nwi_abcd1234' }, [{ note: 'ghs_abcdef' }], { client_secret: 's' }]) assert.ok(holdsSecret(b), JSON.stringify(b));
    for (const b of [{ ok: true }, { token: 'box' }, { data: { token: 'ci-runner' } }, { password: '' }, null, 'plain words']) assert.ok(!holdsSecret(b), JSON.stringify(b));
  });
});
