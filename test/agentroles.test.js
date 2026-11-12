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
    assert.equal((await op('ask', { token: t.mo, agent: 'mo-op', body: { question: 'Remy?', escalates: q1 } })).status, 403);
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
    // Nor does next offer it to that name (#660, #654): it offers other work, so the agent isn't stuck on a refusal.
    hub.humanOp('api', 'create', { title: 'Work for anyone', acceptance: 'x' });
    const offered = await op('next', { token: tok.box, agent: 'box-reviewer', body: { claim: false } });
    assert.equal(offered.status, 200);
    assert.ok(offered.json.item, 'it gets a job');
    assert.notEqual(offered.json.item, mine, "next doesn't offer the review it would refuse");
    assert.ok(!hub.claimable(hub.project('api'), 'box-reviewer').some((o) => o.mode === 'review' && `#${o.item.seq}` === mine));
    assert.ok(hub.claimable(hub.project('api'), 'other-reviewer').some((o) => o.mode === 'review' && `#${o.item.seq}` === mine), 'another token is offered it');
    // Another token reviews it.
    assert.equal((await review(tok.other, 'other-reviewer', mine)).status, 200);
    // A runner's workers each carry a token of their own from it (#941): one may review another's work.
    const runner = auth.verifyToken(auth.createToken('ci-runner-2', 'agent', { runner: 'ci2' })).id;
    const theirs = await build(auth.workerToken(runner, 'ci-builder').token, 'ci-builder', 'Built by a runner worker');
    assert.equal((await review(auth.workerToken(runner, 'ci-reviewer').token, 'ci-reviewer', theirs)).status, 200);
  });

  test("a machine's workers review each other's work with the runner token its device login mints (#656)", async () => {
    hub.humanOp('api', 'settings', { autonomy: 'full' });
    // A token does no more than its minter may (#629), so a steward connects the machine.
    auth.addPerson('rita', 'steward');
    const device = auth.createToken('rita@laptop', 'agent', { mintedBy: 'rita' }); // what nuworq connect gets
    const mint = (token) => call('/api/me/runner-token', { token });
    const me = async (token) => (await fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${token}` } })).json();
    const r = await mint(device);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.name, r.json.runner], ['rita@laptop.runner', 'rita@laptop']);
    const runner = r.json.token;
    assert.deepEqual([(await me(runner)).role, (await me(runner)).runner], ['agent', 'rita@laptop'], 'it says which runner it is');
    assert.equal((await mint(runner)).status, 400, "a runner token can't mint another");
    assert.equal((await mint(tok.olivia)).status, 400, "nor can a person's token");
    const row = auth.listTokens().find((t) => t.name === 'rita@laptop.runner');
    assert.equal(row.minted_by, 'rita', 'the person who connected the machine answers for it');
    // A member's machine gets a runner token too, but can't build with it (#629).
    const members = await mint(auth.createToken('mo@laptop', 'agent', { mintedBy: 'mo' }));
    assert.equal(members.status, 200, JSON.stringify(members.json));
    const { item: theirs } = hub.humanOp('api', 'create', { title: 'Not for a member', acceptance: 'x' });
    assert.match((await op('claim', { token: members.json.token, agent: 'mo-worker', body: { item: theirs } })).json.error, /minted by a member/);

    // Worker A builds, worker B's next offers the review, and B's review is accepted, each on a token of its own the
    // device login mints from the runner token (#941). Earlier tests' reviews go first.
    const clearer = auth.createToken('clearer', 'agent');
    for (const { id } of hub.q("SELECT id FROM items WHERE stage = 'verifying'").all()) {
      assert.equal((await op('review', { token: clearer, agent: 'clearer', body: { item: `#${id}`, verdict: 'accept', headline: 'ok' } })).status, 200);
    }
    const ownToken = async (name) => (await call('/api/me/worker-token', { token: device, body: { name, from: runner } })).json.token;
    const [a, b] = [await ownToken('worker-a'), await ownToken('worker-b')];
    const { item } = hub.humanOp('api', 'create', { title: 'Built by worker A', acceptance: 'x', priority: 'now' });
    assert.equal((await op('claim', { token: a, agent: 'worker-a', body: { item } })).status, 200);
    assert.equal((await op('submit', { token: a, agent: 'worker-a', body: { item, headline: 'done', evidence: [{ label: 'tests pass' }] } })).status, 200);
    // The runner token, which code worker A runs can reach, can't review it under another name (#937).
    assert.match((await op('review', { token: runner, agent: 'worker-a-alias', body: { item, verdict: 'accept', headline: 'x' } })).json.error, /can't review your own work/);
    const next = await op('next', { token: b, agent: 'worker-b', body: { claim: false } });
    assert.deepEqual([next.json.mode, next.json.item], ['review', item], JSON.stringify(next.json));
    assert.equal((await op('review', { token: b, agent: 'worker-b', body: { item, verdict: 'accept', headline: 'looks right' } })).status, 200);

    // The person's own token still can't review what it built under another name.
    const { item: own } = hub.humanOp('api', 'create', { title: 'Built on the connect token', acceptance: 'x' });
    assert.equal((await op('claim', { token: device, agent: 'rita-laptop-a', body: { item: own } })).status, 200);
    assert.equal((await op('submit', { token: device, agent: 'rita-laptop-a', body: { item: own, headline: 'done', evidence: [{ label: 'tests pass' }] } })).status, 200);
    assert.match((await op('review', { token: device, agent: 'rita-laptop-b', body: { item: own, verdict: 'accept', headline: 'x' } })).json.error, /can't review your own work/);

    // The machine's workers share the runner token, so one of them can't revoke it (#913).
    assert.equal((await call('/api/me/revoke', { token: runner })).status, 400);
    assert.equal((await me(runner)).role, 'agent');

    // Minting again replaces it; disconnecting the machine revokes its runner token too.
    const again = (await mint(device)).json.token;
    assert.equal((await me(runner)).role, null, 'the old runner token is revoked');
    assert.equal((await me(again)).runner, 'rita@laptop');
    assert.equal((await call('/api/me/revoke', { token: device })).status, 200);
    assert.equal((await me(again)).role, null, "the device login's runner token went with it");
  });

  test("only owners see people's emails (#631)", async () => {
    const people = async (token) => { const r = await fetch(`${url}/api/people`, { headers: { authorization: `Bearer ${token}` } }); return { status: r.status, json: await r.json() }; };
    hub.db.prepare("UPDATE people SET email = handle || '@acme.test'").run();
    for (const who of ['mo', 'vic']) {
      const r = await people(tok[who]);
      assert.equal(r.status, 200, `${who} still lists people`);
      assert.ok(r.json.length >= 3);
      for (const p of r.json) assert.deepEqual(Object.keys(p).sort(), ['created_at', 'handle', 'name', 'role'], `${who} sees no email`);
    }
    const owner = await people(tok.olivia);
    assert.equal(owner.json.find((p) => p.handle === 'mo').email, 'mo@acme.test', 'an owner does');
  });

  test("workers of one runner on a person's device token review each other's work (#658)", async () => {
    hub.humanOp('api', 'settings', { autonomy: 'full' }); // agents peer-review
    // A person's machine: one device token, no runner tag, running nuworq run's workers and an interactive session.
    const device = auth.createToken('olivia-mbp', 'agent', { mintedBy: 'olivia' });
    for (const w of ['mbp-w1', 'mbp-w2']) {
      assert.equal((await op('checkin', { token: device, agent: w, body: { role: 'worker', runner: 'olivia-mbp' } })).status, 200, w);
    }
    const build = async (agent, title) => {
      const { item } = hub.humanOp('api', 'create', { title, acceptance: 'x' });
      assert.equal((await op('claim', { token: device, agent, body: { item } })).status, 200);
      assert.equal((await op('submit', { token: device, agent, body: { item, headline: 'done', evidence: [{ label: 'tests pass' }] } })).status, 200);
      return item;
    };
    const review = (agent, item) => op('review', { token: device, agent, body: { item, verdict: 'accept', headline: 'looks right' } });
    const built = await build('mbp-w1', 'Built by one worker of the runner');
    // Feedback #7 (#661): the sibling's next offers that review, and its review is accepted, never refused.
    const offered = (await op('next', { token: device, agent: 'mbp-w2', body: { claim: false } })).json;
    assert.ok(offered.item && !/own work/.test(JSON.stringify(offered)), JSON.stringify(offered));
    assert.ok(hub.claimable(hub.project('api'), 'mbp-w2').some((o) => o.mode === 'review' && `#${o.item.seq}` === built), JSON.stringify(offered));
    assert.equal((await review('mbp-w2', built)).status, 200, "a sibling worker reviews it, as before #622");
    // #622's case stands: two plain sessions on one token are one builder.
    const own = await build('mbp-session', 'Built by a session on the device token');
    // ...and next offers the other session a different job, never that review or the refusal (#654/#660).
    const other = (await op('next', { token: device, agent: 'mbp-other-session', body: { claim: false } })).json;
    assert.ok(other.item !== own && !/own work/.test(JSON.stringify(other)), JSON.stringify(other));
    const r =await review('mbp-other-session', own);
    assert.notEqual(r.status, 200);
    assert.match(r.json.error, /can't review your own work/);
  });

  test('next, peeking or claiming, never offers a review that review refuses (#665)', async () => {
    hub.humanOp('api', 'settings', { autonomy: 'full' }); // agents peer-review
    const clearer = auth.createToken('clearer-665', 'agent');
    const clear = async () => { // earlier tests' reviews go first
      for (const { id } of hub.q("SELECT id FROM items WHERE stage = 'verifying'").all()) {
        assert.equal((await op('review', { token: clearer, agent: 'clearer-665', body: { item: `#${id}`, verdict: 'accept', headline: 'ok' } })).status, 200);
      }
    };
    const build = async (token, agent, title) => {
      const { item } = hub.humanOp('api', 'create', { title, acceptance: 'x', priority: 'now' });
      assert.equal((await op('claim', { token, agent, body: { item } })).status, 200, `${agent} claims ${item}`);
      assert.equal((await op('submit', { token, agent, body: { item, headline: 'done', evidence: [{ label: 'tests pass' }] } })).status, 200);
      return item;
    };
    await clear();

    // claude-d25d's loop (feedback #8): two names on one non-runner token; one builds, the other asks for work.
    const device = auth.createToken('loop-device', 'agent');
    const mine = await build(device, 'loop-builder', 'Built by one name of the device');
    const never = (r, how) => {
      assert.equal(r.status, 200, `${how}: ${JSON.stringify(r.json)}`);
      assert.doesNotMatch(JSON.stringify(r.json), /can't review your own work/, how);
      assert.ok(!(r.json.mode === 'review' && r.json.item === mine), `${how} doesn't offer the review it would refuse`);
    };
    // It is offered other ready work instead, peeking and claiming alike.
    hub.humanOp('api', 'create', { title: 'Work for anyone', acceptance: 'x' });
    const peek = await op('next', { token: device, agent: 'loop-reviewer', body: { claim: false } });
    never(peek, 'peek');
    assert.equal(peek.json.mode, 'work', 'it peeks at other work');
    const claimed = await op('next', { token: device, agent: 'loop-reviewer' });
    never(claimed, 'claim');
    assert.deepEqual([claimed.json.mode, claimed.json.item], ['work', peek.json.item], 'it claims the work it peeked at');
    assert.equal(hub.item(hub.project('api'), mine).stage, 'verifying', 'the review waits for someone else');
    await clear();

    // #658's rule: two workers of one runner, each on its own token from it (#941), can each be offered the other's review.
    const runner = auth.verifyToken(auth.createToken('loop-runner', 'agent', { runner: 'loop-box' })).id;
    const own = { 'loop-worker-a': auth.workerToken(runner, 'loop-worker-a').token, 'loop-worker-b': auth.workerToken(runner, 'loop-worker-b').token };
    const a = await build(own['loop-worker-a'], 'loop-worker-a', 'Built by runner worker A');
    const b = await build(own['loop-worker-b'], 'loop-worker-b', 'Built by runner worker B');
    for (const [agent, theirs] of [['loop-worker-a', b], ['loop-worker-b', a]]) {
      const r = await op('next', { token: own[agent], agent, body: { claim: false } });
      assert.deepEqual([r.json.mode, r.json.item], ['review', theirs], `${agent}: ${JSON.stringify(r.json)}`);
    }
  });

  test("an operator on a person's device token reviews that machine's runner workers, and next never offers what review refuses (#663)", async () => {
    hub.humanOp('api', 'settings', { autonomy: 'full' }); // agents peer-review
    // Feedback #2: the operator and the runner's workers all used the maintainer's device login, and every next answered
    // "You can't review your own work" for an item a worker built.
    const device = auth.createToken('olivia-studio', 'agent', { mintedBy: 'olivia' });
    assert.equal((await op('checkin', { token: device, agent: 'studio-op', body: { has: ['operator', 'macos'] } })).status, 200);
    assert.equal(hub.roleOf(hub.project('api'), 'studio-op'), 'operator');
    assert.equal((await op('checkin', { token: device, agent: 'studio-w1', body: { role: 'worker', runner: 'olivia-studio' } })).status, 200);
    // Earlier tests' reviews go first, so the worker's is the one waiting.
    const clearer = auth.createToken('clearer-663', 'agent');
    for (const { id } of hub.q("SELECT id FROM items WHERE stage = 'verifying'").all()) {
      assert.equal((await op('review', { token: clearer, agent: 'clearer-663', body: { item: `#${id}`, verdict: 'accept', headline: 'ok' } })).status, 200);
    }
    const build = async (agent, title) => {
      const { item } = hub.humanOp('api', 'create', { title, acceptance: 'x', priority: 'now' });
      assert.equal((await op('claim', { token: device, agent, body: { item } })).status, 200, `${agent} claims ${item}`);
      assert.equal((await op('submit', { token: device, agent, body: { item, headline: 'done', evidence: [{ label: 'tests pass' }] } })).status, 200);
      return item;
    };
    const next = () => op('next', { token: device, agent: 'studio-op', body: { claim: false } });

    // The runner's worker builds: the operator's next offers the review, and the review is accepted.
    const theirs = await build('studio-w1', "Built by the machine's runner worker");
    const offered = await next();
    assert.equal(offered.status, 200, JSON.stringify(offered.json));
    assert.deepEqual([offered.json.mode, offered.json.item], ['review', theirs], JSON.stringify(offered.json));
    assert.equal((await op('review', { token: device, agent: 'studio-op', body: { item: theirs, verdict: 'accept', headline: 'looks right' } })).status, 200);

    // A plain session on the same token builds: that is the operator's own token's work, so next doesn't offer it,
    // and answers with other work or none, never an error.
    const own = await build('studio-session', 'Built by a session on the device token');
    const after = await next();
    assert.equal(after.status, 200, JSON.stringify(after.json));
    assert.ok(!after.json.error, JSON.stringify(after.json));
    assert.notEqual(after.json.item, own, "next doesn't offer the review it would refuse");
    assert.doesNotMatch(JSON.stringify(after.json), /can't review your own work/);
    assert.ok(!hub.claimable(hub.project('api'), 'studio-op').some((o) => o.mode === 'review' && `#${o.item.seq}` === own));
  });
});
