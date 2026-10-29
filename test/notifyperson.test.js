import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Hub } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { Notifier, addChannel, listChannels } from '../src/notify.js';
import { createServer } from '../src/server.js';

// A receiver per channel: what each one was sent.
async function receivers(names) {
  const got = Object.fromEntries(names.map((n) => [n, []]));
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    got[req.url.slice(1)]?.push(JSON.parse(raw));
    res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { got, url: (n) => `http://127.0.0.1:${server.address().port}/${n}`, close: () => server.close() };
}

// Two projects: ann looks after "a", ben after "b". Each has a blocking question, so each needs someone.
function people() {
  const hub = new Hub();
  const auth = new Auth(hub.db);
  auth.addPerson('ann', 'steward');
  auth.addPerson('ben', 'steward');
  for (const [slug, who] of [['a', '@ann'], ['b', '@ben']]) {
    hub.tx(() => hub.project(slug, { create: true }));
    hub.humanOp(slug, 'stewards', { set: [who] });
    hub.agentOp(slug, 'ask', 'bot', { question: `Which way for ${slug}?` });
  }
  return { hub, auth };
}

describe('push channels go to the person who owns the entry', () => {
  test("a question owned by @ann reaches ann's channel and not ben's; a hub-wide channel gets both", async () => {
    const { hub } = people();
    const r = await receivers(['ann', 'ben', 'all']);
    try {
      addChannel(hub.db, 'webhook', r.url('ann'), Date.now(), { person: 'ann' });
      addChannel(hub.db, 'webhook', r.url('ben'), Date.now(), { person: '@Ben' });
      addChannel(hub.db, 'webhook', r.url('all'));
      assert.deepEqual(listChannels(hub.db).map((c) => c.person), ['@ann', '@ben', null]);
      const n = new Notifier(hub, { baseUrl: 'http://hub.test', windowMs: 10, debounce: 1, retryDelay: 0 });
      n.scan();
      await n.flush();
      const projects = (msgs) => msgs.flatMap((m) => m.entries.map((e) => e.project)).sort();
      assert.deepEqual(projects(r.got.ann), ['a']);
      assert.deepEqual(projects(r.got.ben), ['b']);
      assert.deepEqual(projects(r.got.all), ['a', 'b']);
      n.scan();
      await n.flush();
      assert.equal(r.got.ann.length + r.got.ben.length + r.got.all.length, 3, 'once only, as before');
    } finally { r.close(); }
  });

  test('without people (local mode) nothing changes: a hub-wide channel gets everything', async () => {
    const hub = new Hub();
    hub.tx(() => hub.project('solo', { create: true }));
    hub.agentOp('solo', 'ask', 'bot', { question: 'Which way?' });
    const r = await receivers(['all']);
    try {
      addChannel(hub.db, 'webhook', r.url('all'));
      const n = new Notifier(hub, { windowMs: 10, debounce: 1, retryDelay: 0 });
      n.scan();
      await n.flush();
      assert.equal(r.got.all.length, 1);
      assert.throws(() => addChannel(hub.db, 'webhook', r.url('x'), Date.now(), { person: 'nobody' }), /no person @nobody/);
    } finally { r.close(); }
  });

  test('a person adds and removes only their own channel; an owner manages all', async () => {
    const { hub, auth } = people();
    auth.addPerson('own', 'owner');
    const tok = { ann: auth.createToken('ann-l', 'human', { person: 'ann' }), own: auth.createToken('own-l', 'human', { person: 'own' }) };
    const server = createServer(hub, { auth: 'required' });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const call = async (who, method, path, body) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { authorization: `Bearer ${tok[who]}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };
    try {
      const mine = await call('ann', 'POST', '/api/notify', { kind: 'ntfy', url: 'ann-topic', person: '@ben' });
      assert.equal(mine.json.person, '@ann', "a person's channel is always their own");
      const wide = await call('own', 'POST', '/api/notify', { kind: 'ntfy', url: 'everyone-topic' });
      assert.equal(wide.json.person, null);
      assert.deepEqual((await call('ann', 'GET', '/api/notify')).json.channels.map((c) => c.id), [mine.json.id], 'ann sees only hers');
      assert.equal((await call('own', 'GET', '/api/notify')).json.channels.length, 2);
      assert.equal((await call('ann', 'POST', '/api/notify/remove', { id: wide.json.id })).status, 403);
      assert.equal((await call('ann', 'POST', '/api/notify/test')).status, 403, 'testing every channel stays with owners');
      assert.equal((await call('ann', 'POST', '/api/notify/remove', { id: mine.json.id })).status, 200);
    } finally { server.close(); }
  });
});
