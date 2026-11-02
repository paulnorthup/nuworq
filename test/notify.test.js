import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Hub, MIN, HOUR, DAY } from '../src/core.js';
import { view, byNeed } from '../src/insight.js';
import { Notifier, addChannel, listChannels, mask, testChannels } from '../src/notify.js';
import { createServer } from '../src/server.js';

// A local HTTP server stands in for ntfy, Slack and webhooks: it records every request.
let sink, sinkUrl;
const got = [];
let reply = 200; // status to answer with, or 'hang'
before(async () => {
  sink = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ path: req.url, headers: req.headers, body });
      if (reply === 'hang') return;
      res.writeHead(reply).end();
    });
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  sinkUrl = `http://127.0.0.1:${sink.address().port}`;
});
after(() => { sink.closeAllConnections(); sink.close(); });

function setup({ kind = 'webhook', path = '/hook', timeout = 5000 } = {}) {
  got.length = 0;
  reply = 200;
  let t = Date.UTC(2026, 9, 1, 9);
  const hub = new Hub({ clock: () => t });
  const op = (o, agent, args = {}) => hub.agentOp('app', o, agent, args);
  op('checkin', 'a'); // an agent is around, so "no agent is working" stays quiet
  hub.humanOp('app', 'create', { title: 'Build the thing', acceptance: 'it works' });
  hub.humanOp('app', 'create', { title: 'Build another thing', acceptance: 'it works' });
  op('next', 'a');
  addChannel(hub.db, kind, sinkUrl + path, t);
  const n = new Notifier(hub, { baseUrl: 'http://hub.test', windowMs: 60, debounce: 5, retryDelay: 0, timeout });
  return { hub, op, n, advance: (ms) => (t += ms) };
}
const blockingAsk = (op, agent, item, question) => op('ask', agent, { item, question, blocking: true });

describe('push notifications', () => {
  test('new act-level entries in a burst go out as one message per channel, with a line each and a link', async () => {
    const { hub, op, n } = setup();
    addChannel(hub.db, 'slack', sinkUrl + '/slack');
    // Wait on the batch the window timer sends, not on the wall clock: a loaded test run can make it late.
    const flushed = new Promise((resolve) => { const flush = n.flush.bind(n); n.flush = () => { const p = flush(); resolve(p); return p; }; });
    n.start();
    blockingAsk(op, 'a', '#1', 'Postgres or SQLite?');
    op('checkin', 'b');
    op('next', 'b');
    blockingAsk(op, 'b', '#2', 'Which region should it deploy to?');
    await flushed;
    n.stop();
    assert.equal(got.length, 2, 'one message per channel');
    const hook = JSON.parse(got.find((g) => g.path === '/hook').body);
    assert.equal(hook.title, 'nuworq: 2 soon');
    assert.equal(hook.url, 'http://hub.test/#/p/app');
    assert.equal(hook.entries.length, 2);
    assert.match(hook.text, /#1 question: Postgres or SQLite\?/);
    assert.match(hook.text, /#2 question: Which region/);
    const slack = JSON.parse(got.find((g) => g.path === '/slack').body);
    assert.deepEqual(Object.keys(slack), ['text']);
    assert.match(slack.text, /→ http:\/\/hub\.test\/#\/p\/app$/);
  });

  test('a batch lists the most important first, in Needs you\'s order, and its title counts what is now (#507)', async () => {
    const { hub, op, n } = setup();
    hub.humanOp('app', 'update', { item: '#2', priority: 'now' });
    hub.humanOp('app', 'create', { title: 'Polish the thing', acceptance: 'it shines', priority: 'later' });
    blockingAsk(op, 'a', '#1', 'Postgres or SQLite?'); // asked first, but soon
    for (const [agent, item, q] of [['b', '#2', 'Which region?'], ['c', '#3', 'Which shade?']]) {
      op('checkin', agent);
      op('claim', agent, { item });
      blockingAsk(op, agent, item, q);
    }
    const order = view(hub, 'app').attention.filter((a) => a.level === 'act').sort(byNeed).map((a) => a.item);
    n.scan();
    await n.flush();
    const hook = JSON.parse(got[0].body);
    assert.deepEqual(hook.entries.map((e) => e.item), order, 'the same order as Needs you');
    assert.deepEqual(hook.entries.map((e) => [e.item, e.priority]), [['#2', 'now'], ['#1', 'soon'], ['#3', 'later']]);
    assert.equal(hook.title, 'nuworq: 1 now, 1 soon, 1 later');
    assert.match(hook.text, /^nuworq: 1 now, 1 soon, 1 later\n• #2 question: Which region\?\n• #1 question: Postgres or SQLite\?\n• #3 question: Which shade\?\n/);
  });

  test('the same entry is never pushed twice; a new one is', async () => {
    const { op, n } = setup();
    blockingAsk(op, 'a', '#1', 'Postgres or SQLite?');
    n.scan();
    await n.flush();
    assert.equal(got.length, 1);
    n.scan();
    assert.equal(n.pending.size, 0);
    assert.deepEqual(await n.flush(), []);
    assert.equal(got.length, 1, 'nothing new, nothing sent');
    op('checkin', 'b'); op('next', 'b');
    blockingAsk(op, 'b', '#2', 'Another question');
    n.scan();
    await n.flush();
    assert.equal(got.length, 2);
    assert.equal(JSON.parse(got[1].body).entries.length, 1);
    assert.match(got[1].body, /Another question/);
  });

  test('healthy activity sends nothing', async () => {
    const { op, n } = setup();
    op('progress', 'a', { item: '#1', headline: 'Halfway' });
    op('ask', 'a', { item: '#1', question: 'Tabs or spaces?', assumption: 'Spaces' }); // know-level
    op('propose', 'a', { title: 'An idea' });
    op('checkin', 'b'); op('next', 'b');
    n.scan();
    assert.equal(n.pending.size, 0);
    await n.flush();
    assert.equal(got.length, 0);
  });

  test('a parked project stays silent', async () => {
    const { hub, op, n } = setup();
    hub.humanOp('app', 'settings', { parked: true });
    blockingAsk(op, 'a', '#1', 'Postgres or SQLite?');
    n.scan();
    await n.flush();
    assert.equal(got.length, 0);
  });

  test('entries dismissed or resolved inside the batch window are dropped', async () => {
    const { hub, op, n } = setup();
    blockingAsk(op, 'a', '#1', 'Postgres or SQLite?');
    op('checkin', 'b'); op('next', 'b');
    blockingAsk(op, 'b', '#2', 'Which region?');
    n.scan();
    assert.equal(n.pending.size, 2);
    const v = view(hub, 'app');
    hub.humanOp('app', 'dismiss', { key: v.attention.find((a) => a.headline === 'Which region?').key });
    hub.humanOp('app', 'answer', { question: v.attention.find((a) => a.headline === 'Postgres or SQLite?').question.id, answer: 'SQLite' });
    assert.deepEqual(await n.flush(), []);
    assert.equal(got.length, 0);
  });

  test('a failing channel is retried once, then shows as worth knowing; it recovers on success', async () => {
    const { hub, op, n } = setup();
    reply = 500;
    blockingAsk(op, 'a', '#1', 'Postgres or SQLite?');
    n.scan();
    const [r] = await n.flush();
    assert.equal(got.length, 2, 'tried, then retried once');
    assert.deepEqual(r, { id: 1, kind: 'webhook', ok: false, error: 'HTTP 500' });
    const entry = view(hub, 'app').attention.find((a) => a.kind === 'notify-failing');
    assert.equal(entry.level, 'know');
    assert.match(entry.headline, /webhook are failing \(HTTP 500\)/);
    assert.equal(listChannels(hub.db)[0].failing, true);

    reply = 200;
    op('checkin', 'b'); op('next', 'b');
    blockingAsk(op, 'b', '#2', 'Which region?');
    n.scan();
    await n.flush();
    assert.equal(view(hub, 'app').attention.find((a) => a.kind === 'notify-failing'), undefined);
  });

  test('an entry a down channel missed goes out on a later scan while it still needs you (#744)', async () => {
    const { op, n } = setup();
    reply = 503;
    blockingAsk(op, 'a', '#1', 'Postgres or SQLite?');
    n.scan();
    const [r] = await n.flush();
    assert.equal(r.ok, false);
    reply = 200;
    got.length = 0;
    n.scan();
    assert.ok(n.batch, 'the scan opens a window for the retry');
    const [again] = await n.flush();
    assert.equal(again.ok, true);
    assert.equal(got.length, 1);
    assert.match(got[0].body, /#1 question: Postgres or SQLite\?/);
    n.scan();
    assert.deepEqual(await n.flush(), [], 'sent once it arrived');
    assert.equal(got.length, 1);
  });

  test('an entry resolved while its channel was down is not sent when it comes back (#744)', async () => {
    const { hub, op, n } = setup();
    reply = 503;
    blockingAsk(op, 'a', '#1', 'Postgres or SQLite?');
    n.scan();
    await n.flush();
    hub.humanOp('app', 'answer', { question: view(hub, 'app').attention.find((a) => a.kind === 'question').question.id, answer: 'SQLite' });
    reply = 200;
    got.length = 0;
    n.scan();
    assert.deepEqual(await n.flush(), []);
    assert.equal(got.length, 0);
    assert.equal(hub.db.prepare('SELECT COUNT(*) AS n FROM unsent').get().n, 0, 'nothing left to retry');
  });

  test('a channel down for a day stops retrying old entries but still gets new ones (#744)', async () => {
    const { op, n, advance } = setup();
    reply = 503;
    blockingAsk(op, 'a', '#1', 'Postgres or SQLite?');
    n.scan();
    await n.flush();
    advance(DAY + MIN);
    op('checkin', 'b');
    assert.equal(op('next', 'b').item, '#2'); // someone is working, so "no agent is working" stays quiet
    n.scan();
    assert.deepEqual(await n.flush(), [], 'the old entry is no longer retried');
    reply = 200;
    got.length = 0;
    blockingAsk(op, 'b', '#2', 'Which region?');
    n.scan();
    const [r] = await n.flush();
    assert.equal(r.ok, true);
    const hook = JSON.parse(got[0].body);
    assert.deepEqual(hook.entries.map((e) => e.item), ['#2']);
  });

  test('a channel that never answers times out without holding up agents', async () => {
    const { hub, op, n } = setup({ timeout: 300 });
    reply = 'hang';
    blockingAsk(op, 'a', '#1', 'Postgres or SQLite?');
    n.scan();
    const sending = n.flush();
    const started = Date.now();
    op('checkin', 'b');
    assert.equal(op('next', 'b').item, '#2', 'agent operations carry on while the push hangs');
    assert.ok(Date.now() - started < 50, 'agent operations do not wait on pushes');
    const [r] = await sending;
    assert.equal(r.ok, false);
    assert.match(r.error, /no answer in 0.3s/);
    assert.equal(view(hub, 'app').attention.filter((a) => a.kind === 'notify-failing').length, 1);
    sink.closeAllConnections();
  });

  test('an entry gone for an hour may be pushed again if it comes back', async () => {
    const { hub, n, advance } = setup();
    hub.agentOp('app', 'ask', 'a', { item: '#1', question: 'Postgres or SQLite?', blocking: true });
    n.scan();
    await n.flush();
    assert.equal(got.length, 1);
    hub.humanOp('app', 'dismiss', { key: view(hub, 'app').attention.find((a) => a.kind === 'question').key });
    advance(HOUR + MIN);
    n.scan(); // the dismissed entry has been gone over an hour: forgotten
    hub.db.prepare('DELETE FROM dismissals').run();
    n.scan();
    await n.flush();
    assert.equal(got.length, 2, 're-pushed after coming back');
  });

  test('ntfy gets plain text with a title and a click-through link; a bare topic means ntfy.sh', async () => {
    const { op, n } = setup({ kind: 'ntfy', path: '/my-topic' });
    blockingAsk(op, 'a', '#1', 'Postgres or SQLite?');
    n.scan();
    await n.flush();
    assert.equal(got[0].headers.title, 'nuworq: 1 soon');
    assert.equal(got[0].headers.click, 'http://hub.test/#/p/app');
    assert.match(got[0].body, /^nuworq: 1 soon\n• #1 question: Postgres or SQLite\?\n→ /);
    const hub2 = new Hub();
    assert.equal(addChannel(hub2.db, 'ntfy', 'just-a-topic-name').url, 'https://ntfy.sh/…name');
  });

  test('secrets are never shown back in full, and bad input gets a hint', () => {
    assert.equal(mask('https://hooks.slack.com/services/T000/B000/XXXXsecret'), 'https://hooks.slack.com/…cret');
    const hub = new Hub();
    assert.throws(() => addChannel(hub.db, 'email', 'x'), /unknown channel/);
    assert.throws(() => addChannel(hub.db, 'slack', 'not a url'), (e) => /needs a URL/.test(e.message) && /hooks\.slack\.com/.test(e.hint));
    assert.throws(() => addChannel(hub.db, 'webhook', 'ftp://x.test/y'), /http or https/);
    addChannel(hub.db, 'webhook', 'https://x.test/abcdefghij');
    assert.throws(() => addChannel(hub.db, 'webhook', 'https://x.test/abcdefghij'), /already/);
  });

  test('testChannels sends a test line to each channel', async () => {
    const hub = new Hub();
    got.length = 0; reply = 200;
    addChannel(hub.db, 'webhook', sinkUrl + '/a');
    addChannel(hub.db, 'slack', sinkUrl + '/b');
    const r = await testChannels(hub.db, { baseUrl: 'http://hub.test', retryDelay: 0 });
    assert.deepEqual(r.map((x) => x.ok), [true, true]);
    assert.equal(got.length, 2);
    assert.ok(got.every((g) => /test message/.test(g.body)));
  });

  test('the UI API adds, lists (masked), tests and removes channels', async () => {
    const hub = new Hub();
    got.length = 0; reply = 200;
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (path, body) => fetch(base + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}).then((r) => r.json());
    try {
      assert.equal((await call('/api/notify', { kind: 'webhook', url: sinkUrl + '/secret-path-1234' })).ok, true);
      const listed = await call('/api/notify');
      assert.equal(listed.channels.length, 1);
      assert.ok(!JSON.stringify(listed).includes('secret-path'), 'the secret never comes back');
      const t = await call('/api/notify/test', {});
      assert.equal(t.ok, true);
      assert.equal(got.length, 1);
      assert.match(JSON.parse(got[0].body).text, new RegExp(`→ ${base}`));
      const bad = await call('/api/notify', { kind: 'pager', url: 'x' });
      assert.equal(bad.ok, false);
      assert.ok(bad.hint);
      assert.equal((await call('/api/notify/remove', { id: listed.channels[0].id })).ok, true);
      assert.equal((await call('/api/notify')).channels.length, 0);
    } finally {
      server.close();
    }
  });
});
