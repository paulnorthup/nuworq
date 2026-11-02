// Agent operations are for agents, and each agent acts only as itself (#469): a person on the agent
// routes may do only what their role allows, and an agent name belongs to the token that first used it.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { Hub, AGENT_OP_NAMES } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';

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

describe('agent operations are for agents, and each agent acts only as itself', () => {
  let hub, auth, tok, sid, server, gh, url;
  before(async () => {
    gh = github();
    const api = `http://127.0.0.1:${await listen(gh)}`;
    hub = new Hub();
    auth = new Auth(hub.db);
    tok = {};
    for (const [handle, role] of [['olivia', 'owner'], ['mo', 'member'], ['vic', 'viewer']]) {
      auth.addPerson(handle, role);
      tok[handle] = auth.createToken(`${handle}-laptop`, 'human', { person: handle });
    }
    tok.box = auth.createToken('box', 'agent');
    tok.other = auth.createToken('other-box', 'agent');
    tok.runner = auth.createToken('ci-runner', 'agent', { runner: 'ci' });
    sid = auth.createSession(hub.db.prepare("SELECT id FROM tokens WHERE name = 'olivia-laptop'").get().id);
    hub.tx(() => hub.project('api', { create: true }));
    hub.addRemote(hub.project('api'), 'github.com/acme/api', 'you');
    for (const t of ['Seed work', 'More work', 'Third work', 'Fourth work']) hub.humanOp('api', 'create', { title: t, acceptance: 'x' });
    server = createServer(hub, { auth: 'required', githubApp: { id: 1, key: PEM, slug: 'nuworq-test', api } });
    url = `http://127.0.0.1:${await listen(server)}`;
  });
  after(() => { for (const s of [server, gh]) { s.close(); s.closeAllConnections(); } });

  const call = async (path, { token, cookie, agent, body = {} } = {}) => {
    const headers = { 'content-type': 'application/json', ...(agent ? { 'x-nuworq-agent': agent } : {}) };
    if (token) headers.authorization = `Bearer ${token}`;
    if (cookie) Object.assign(headers, { cookie: `nuworq_session=${cookie}`, origin: url });
    const r = await fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  const op = (name, opts) => call(`/api/p/api/agent/${name}`, opts);

  test('a viewer can use no agent operation, on any agent route', async () => {
    for (const name of [...AGENT_OP_NAMES, 'feedback']) {
      for (const path of [`/api/p/api/agent/${name}`, `/api/agent/${name}`]) {
        const r = await call(path, { token: tok.vic, agent: 'vic-bot', body: { item: '#1', verdict: 'accept', headline: 'x' } });
        assert.equal(r.status, 403, `${path}: ${JSON.stringify(r.json)}`);
        assert.match(r.json.error, new RegExp(`a viewer can't ${name} here`));
        assert.match(r.json.hint, /A viewer only reads/);
      }
    }
    const c = await call('/api/agent/credential', { token: tok.vic, agent: 'vic-bot' });
    assert.equal(c.status, 403);
    assert.match(c.json.error, /a viewer can't get a push token/);
    assert.equal(hub.q("SELECT COUNT(*) AS n FROM agents WHERE name = 'vic-bot'").get().n, 0, 'nothing happened under its name');
  });

  test('a viewer reviewing a submission is refused, and the item stays in verifying', async () => {
    hub.agentOp('api', 'claim', 'builder', { item: '#4' });
    hub.agentOp('api', 'submit', 'builder', { item: '#4', headline: 'done', evidence: [{ label: 'tests pass' }] });
    const r = await op('review', { token: tok.vic, agent: 'vic-bot', body: { item: '#4', verdict: 'accept', headline: 'ok' } });
    assert.equal(r.status, 403);
    assert.equal(hub.item(hub.project('api'), '#4').stage, 'verifying');
  });

  test('a member may check in, look, propose and comment, but not claim, shape, review or push', async () => {
    for (const [name, body] of [['checkin', {}], ['look', {}], ['propose', { title: 'Members propose' }], ['comment', { headline: 'a note' }], ['signoff', { headline: 'bye' }]]) {
      const r = await op(name, { token: tok.mo, agent: 'mo-bot', body });
      assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.json)}`);
    }
    for (const name of ['next', 'claim', 'refine', 'review', 'submit', 'answer', 'retire']) {
      const r = await op(name, { token: tok.mo, agent: 'mo-bot', body: { item: '#2' } });
      assert.equal(r.status, 403, name);
      assert.match(r.json.error, new RegExp(`a member can't ${name} here`));
      assert.match(r.json.hint, /steward role/);
    }
    assert.equal(hub.item(hub.project('api'), '#2').stage, 'ready', 'nothing was claimed');
    assert.equal((await call('/api/agent/credential', { token: tok.mo, agent: 'mo-bot' })).status, 403);
  });

  test("an owner's own agent flow works as before: claim, progress, push token, submit", async () => {
    const n = await op('next', { token: tok.olivia, agent: 'olivia-bot' });
    assert.equal(n.status, 200, JSON.stringify(n.json));
    assert.equal(n.json.mode, 'work');
    assert.equal((await op('progress', { token: tok.olivia, agent: 'olivia-bot', body: { item: n.json.item, headline: 'halfway' } })).status, 200);
    const c = await call('/api/agent/credential', { token: tok.olivia, agent: 'olivia-bot' });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.match(c.json.password, /^ghs_push/);
    const s = await op('submit', { token: tok.olivia, agent: 'olivia-bot', body: { item: n.json.item, headline: 'done', evidence: [{ label: 'ok' }] } });
    assert.equal(s.status, 200, JSON.stringify(s.json));
  });

  test('an agent name belongs to the token that first used it; a push token goes only to that token', async () => {
    const claim = await op('claim', { token: tok.box, agent: 'a1', body: { item: '#2' } });
    assert.equal(claim.status, 200, JSON.stringify(claim.json));
    // Another agent token, a person's token and a person's browser session, all naming a1:
    for (const who of [{ token: tok.other }, { token: tok.olivia }, { cookie: sid }]) {
      const r = await op('progress', { ...who, agent: 'a1', body: { item: '#2', headline: 'mine now' } });
      assert.equal(r.status, 403, JSON.stringify(who));
      assert.match(r.json.error, /"a1" is another agent's name here/);
      const c = await call('/api/agent/credential', { ...who, agent: 'a1' });
      assert.equal(c.status, 403, JSON.stringify(c.json));
      assert.doesNotMatch(JSON.stringify(c.json), /ghs_/);
    }
    assert.match((await call('/api/agent/credential', { cookie: sid, agent: 'a1' })).json.error, /a person's browser session gets no push token/);
    const mine = await call('/api/agent/credential', { token: tok.box, agent: 'a1' });
    assert.equal(mine.status, 200, JSON.stringify(mine.json));
    assert.equal(hub.item(hub.project('api'), '#2').holder, 'a1');
  });

  test('workers sharing one runner token each keep working; a revoked token frees its names', async () => {
    for (const w of ['w1', 'w2']) assert.equal((await op('checkin', { token: tok.runner, agent: w })).status, 200, w);
    assert.equal((await op('look', { token: tok.runner, agent: 'w1' })).status, 200, 'the same token acts as either of its workers');
    assert.equal((await op('look', { token: tok.other, agent: 'w1' })).status, 403);
    auth.revoke('ci-runner');
    assert.equal((await op('look', { token: tok.other, agent: 'w1' })).status, 200, 'its token is gone, so the name is free');
    assert.equal((await op('look', { token: tok.box, agent: 'w1' })).status, 403, 'and now it is the new token\'s');
  });

  test("a person's browser session may act under a name no token holds, without taking it", async () => {
    assert.equal((await op('look', { cookie: sid, agent: 'olivia-ui' })).status, 200);
    assert.equal(hub.q("SELECT token_id FROM agents WHERE name = 'olivia-ui'").get().token_id, null);
    assert.equal((await op('look', { token: tok.box, agent: 'olivia-ui' })).status, 200);
  });

  test('operator role needs a token a steward or owner minted', async () => {
    auth.addPerson('sam', 'steward');
    const minted = (name, by, powers) => auth.createToken(name, 'agent', { mintedBy: by, ...(powers ? { powers } : {}) });
    const t = { mo: minted('mo-device', 'mo'), sam: minted('sam-device', 'sam'), olivia: minted('olivia-device', 'olivia'), named: minted('mo-operate', 'mo', 'shape,build,review,operate') };
    const as = (token, agent) => op('checkin', { token, agent, body: { has: ['operator', 'macos'] } });

    // A member's device login: refused as an operator, with a hint; fine as an agent.
    const refused = await as(t.mo, 'mo-op');
    assert.equal(refused.status, 403);
    assert.match(refused.json.error, /can't act as an operator/);
    assert.match(refused.json.hint, /steward or owner minted[^]*--powers shape,build,review,operate/);
    assert.equal((await op('checkin', { token: t.mo, agent: 'mo-op', body: { has: ['macos'] } })).status, 200);
    assert.equal(hub.roleOf(hub.project('api'), 'mo-op'), 'session');

    // A steward's, an owner's, one with the operate power by name, and one made on the hub host (no person minted it).
    for (const [token, agent] of [[t.sam, 'sam-op'], [t.olivia, 'olivia-op'], [t.named, 'mo-named-op'], [tok.box, 'box-op']]) {
      assert.equal((await as(token, agent)).status, 200, agent);
      assert.equal(hub.roleOf(hub.project('api'), agent), 'operator', agent);
    }

    // A member signed in in the browser checks in, but not as an operator.
    const moSid = auth.createSession(hub.db.prepare("SELECT id FROM tokens WHERE name = 'mo-laptop'").get().id);
    assert.equal((await op('checkin', { cookie: moSid, agent: 'mo-ui', body: { has: ['operator'] } })).status, 403);

    // answer and escalate check the same, even for a session that became an operator before this was checked.
    hub.humanOp('api', 'create', { title: 'Needs an operator', acceptance: 'x' });
    const ask = () => hub.agentOp('api', 'ask', 'asker', { question: 'Restart the VM?', assumption: 'yes', to: 'operator' }).question;
    hub.agentOp('api', 'checkin', 'asker', {});
    hub.db.prepare("UPDATE agents SET role = 'operator' WHERE name = 'mo-op'").run();
    const q1 = ask();
    assert.equal((await op('answer', { token: t.mo, agent: 'mo-op', body: { question: q1, answer: 'done' } })).status, 403);
    assert.equal((await op('ask', { token: t.mo, agent: 'mo-op', body: { question: 'Paul?', escalates: q1 } })).status, 403);
    assert.equal((await op('answer', { token: t.sam, agent: 'sam-op', body: { question: q1, answer: 'Restarted it.' } })).status, 200);
  });

  test("a token can't review work it built under another name (#622)", async () => {
    const build = async (token, agent, title) => {
      const { item } = hub.humanOp('api', 'create', { title, acceptance: 'x' });
      assert.equal((await op('claim', { token, agent, body: { item } })).status, 200, `${agent} claims ${item}`);
      assert.equal((await op('submit', { token, agent, body: { item, headline: 'done', evidence: [{ label: 'tests pass' }] } })).status, 200);
      return item;
    };
    const review = (token, agent, item) => op('review', { token, agent, body: { item, verdict: 'accept', headline: 'looks right' } });
    hub.humanOp('api', 'settings', { autonomy: 'full' }); // agents peer-review
    // One token, two names: the second name can't review what the first built.
    const mine = await build(tok.box, 'box-builder', 'Built by one name');
    const r = await review(tok.box, 'box-reviewer', mine);
    assert.notEqual(r.status, 200);
    assert.match(r.json.error, /can't review your own work/);
    assert.equal(hub.item(hub.project('api'), mine).stage, 'verifying', 'still waiting for someone else');
    // Another token reviews it.
    assert.equal((await review(tok.other, 'other-reviewer', mine)).status, 200);
    // A runner's workers share its token by design: one may review another's work.
    const runner = auth.createToken('ci-runner-2', 'agent', { runner: 'ci2' });
    const theirs = await build(runner, 'ci-builder', 'Built by a runner worker');
    assert.equal((await review(runner, 'ci-reviewer', theirs)).status, 200);
  });
});
