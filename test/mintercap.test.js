// An agent token never does more than its minter may do now (#629): #469 keeps claiming, building, reviewing and push
// tokens from members on the agent routes, so a machine a member approves can't do them either, and demoting a
// minter narrows every token they minted at once.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

// GitHub, as far as minting a push token goes: the app is installed on acme/api.
function github() {
  return http.createServer((req, res) => {
    const json = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.method === 'GET' && req.url === '/repos/acme/api/installation') return json(200, { id: 42 });
    if (req.method === 'POST' && req.url === '/app/installations/42/access_tokens') return json(201, { token: 'ghs_push1', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    json(404, { message: 'Not Found' });
  });
}

describe('an agent token never does more than its minter\'s current role', () => {
  let hub, auth, server, gh, url, tok;
  before(async () => {
    gh = github();
    hub = new Hub();
    server = createServer(hub, { auth: 'required', githubApp: { id: 1, key: PEM, slug: 'nuworq-test', api: `http://127.0.0.1:${await listen(gh)}` } });
    auth = server.auth;
    auth.addPerson('mo', 'member');
    auth.addPerson('stu', 'steward');
    tok = { mo: auth.createToken('mo-laptop', 'human', { person: 'mo' }), stu: auth.createToken('stu-laptop', 'human', { person: 'stu' }), runner: auth.createToken('ci', 'agent', { runner: 'ci' }) };
    hub.tx(() => hub.project('api', { create: true }));
    hub.addRemote(hub.project('api'), 'github.com/acme/api', 'you');
    for (const t of ['One', 'Two', 'Three', 'Four', 'Five']) hub.humanOp('api', 'create', { title: t, acceptance: 'x' });
    url = `http://127.0.0.1:${await listen(server)}`;
  });
  after(() => { for (const s of [server, gh]) { s.close(); s.closeAllConnections(); } });

  const call = async (path, { token, agent, body = {} }) => {
    const r = await fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(agent ? { 'x-nuworq-agent': agent } : {}) } });
    return { status: r.status, json: await r.json() };
  };
  const op = (name, token, agent, body) => call(`/api/p/api/agent/${name}`, { token, agent, body });
  // A machine connected by device login, approved in the browser by `by`.
  const device = async (by, machine) => {
    const d = (await call('/api/device/start', { token: '', body: { machine } })).json;
    const peek = await call('/api/device/peek', { token: tok[by], body: { user_code: d.user_code } });
    assert.equal((await call('/api/device/approve', { token: tok[by], body: { user_code: d.user_code, approve: true } })).status, 200);
    return { token: (await call('/api/device/poll', { token: '', body: { device_code: d.device_code } })).json.token, role: peek.json.role };
  };

  test("an agent token never does more than its minter's current role", async () => {
    // A member's machine: checks in, looks, proposes and comments; never claims, reviews or gets a push token.
    const mine = await device('mo', 'mo-box');
    assert.equal(mine.role, 'member', 'the device page is told whose role it is, to say what the machine can do');
    for (const [name, body] of [['checkin', {}], ['look', {}], ['propose', { title: 'An idea' }], ['comment', { item: '#1', headline: 'noted' }]]) {
      assert.equal((await op(name, mine.token, 'mo-1', body)).status, 200, name);
    }
    for (const [name, body] of [['claim', { item: '#1' }], ['next', {}], ['review', { item: '#1', verdict: 'accept', headline: 'x' }]]) {
      const r = await op(name, mine.token, 'mo-1', body);
      assert.equal(r.status, 403, `${name}: ${JSON.stringify(r.json)}`);
      assert.match(r.json.error, new RegExp(`this token can't ${name} here: it was minted by a member`));
    }
    const push = await call('/api/agent/credential', { token: mine.token, agent: 'mo-1' });
    assert.equal(push.status, 403);
    assert.match(push.json.error, /can't get a push token here: it was minted by a member/);
    assert.doesNotMatch(JSON.stringify(push.json), /ghs_/);

    // A steward's machine works in full; demoted to viewer, every token they minted is refused at once; back, it works.
    const stus = await device('stu', 'stu-box');
    assert.equal((await op('claim', stus.token, 'stu-1', { item: '#2' })).status, 200);
    assert.equal((await call('/api/agent/credential', { token: stus.token, agent: 'stu-1' })).status, 200);
    auth.setRole('stu', 'viewer');
    for (const name of ['checkin', 'look', 'progress']) {
      const r = await op(name, stus.token, 'stu-1', { item: '#2', headline: 'x' });
      assert.equal(r.status, 403, name);
      assert.match(r.json.error, /minted by a viewer/);
    }
    assert.equal((await call('/api/agent/credential', { token: stus.token, agent: 'stu-1' })).status, 403);
    auth.setRole('stu', 'steward');
    assert.equal((await op('progress', stus.token, 'stu-1', { item: '#2', headline: 'back' })).status, 200, 'restoring the role restores the token');

    // A runner's token has no minter: unaffected. Powers named on the hub host for a member's token are the host's
    // grant (#609's operate by name): they stand while the minter is a member, and go when they're a viewer.
    assert.equal((await op('claim', tok.runner, 'w1', { item: '#3' })).status, 200);
    const granted = auth.createToken('mo-granted', 'agent', { mintedBy: 'mo', powers: 'build' });
    assert.equal((await op('claim', granted, 'mo-2', { item: '#4' })).status, 200);
    auth.setRole('mo', 'viewer');
    assert.equal((await op('look', granted, 'mo-2')).status, 403);
    auth.setRole('mo', 'member');
  });
});
