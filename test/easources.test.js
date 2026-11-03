import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';
import { sourceOf } from '../src/directory.js';
import { composeRequest } from '../src/notify.js';

const DAY = 24 * 60 * 60 * 1000;
const REMY = 'remy@example.com';

async function hub() {
  let now = Date.UTC(2026, 9, 31);
  const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-src-')), clock: () => now });
  const server = createServer(spaces, { earlyAccess: { owners: [REMY], verify: async () => true, gate: true } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = spaces.directory;
  const as = (email) => `nuworq_id=${dir.createSession(dir.identify(email, 'github').id)}`;
  const call = async (method, path, body, cookie) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: body && JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const ask = (email, source) => call('POST', '/api/early-access', { email, turnstile: 't', ...(source === undefined ? {} : { source }) });
  return { spaces, dir, call, ask, as, tick: (ms) => { now += ms; }, close: () => { server.close(); spaces.close(); } };
}

describe('early-access sources (#356)', () => {
  test('a source is lowercased and kept when it is at most 64 of a-z 0-9 . - _; anything else is dropped, never refused', async () => {
    assert.equal(sourceOf(' HN '), 'hn');
    assert.equal(sourceOf('news.ycombinator.com'), 'news.ycombinator.com');
    assert.equal(sourceOf('my_list-2'), 'my_list-2');
    assert.equal(sourceOf('a'.repeat(64)), 'a'.repeat(64));
    for (const bad of ['a'.repeat(65), 'hn!', 'two words', 'https://x.com/', '<b>', '', null, undefined, 'été']) assert.equal(sourceOf(bad), '', String(bad));

    const h = await hub();
    try {
      assert.equal((await h.ask('ann@example.com', 'HN')).status, 200);
      assert.equal((await h.ask('bob@example.com', 'not ok!')).status, 200, 'a bad source still makes the request');
      assert.equal((await h.ask('cy@example.com')).status, 200, 'no source at all still works');
      const src = (email) => h.dir.requests().find((r) => r.email === email).source;
      assert.deepEqual(['ann', 'bob', 'cy'].map((n) => src(`${n}@example.com`)), ['hn', '', '']);
      await h.ask('ann@example.com', 'reddit');
      assert.equal(src('ann@example.com'), 'hn', 'a repeat keeps the first source');
      await h.ask('cy@example.com', 'reddit');
      assert.equal(src('cy@example.com'), 'reddit', 'one that had none takes the first it gets');
    } finally { h.close(); }
  });

  test("the owners' push names the source", () => {
    assert.match(composeRequest({ email: 'ann@example.com', github: 'ann', source: 'hn' }).text, /ann@example\.com \(@ann\) via hn asked to come in/);
    assert.equal(composeRequest({ email: 'a@b.co' }).text, 'nuworq: early-access request\na@b.co asked to come in', 'none: as before');
  });

  test('per source, last 14 days and all time: requests, let in, an agent connected, an item landed', async () => {
    const h = await hub();
    const workspace = (email, slug, { agent = false, landed = false } = {}) => {
      h.spaces.create(slug);
      h.dir.identify(email, 'github');
      h.dir.join(email, slug, { created: true });
      const ws = h.spaces.get(slug);
      ws.tx(() => ws.project('app', { create: true }));
      ws.humanOp('app', 'create', { title: 'One', acceptance: 'x' });
      if (agent) ws.agentOp('app', 'checkin', 'a1');
      if (landed) ws.db.prepare("UPDATE items SET stage = 'done'").run();
    };
    const approve = async (email) => {
      const id = h.dir.requests().find((r) => r.email === email).id;
      assert.equal((await h.call('POST', '/api/early-access/decide', { id, approve: true }, h.as(REMY))).status, 200);
    };
    try {
      // 20 days ago: ann came from hn, was let in, and landed an item.
      await h.ask('ann@example.com', 'hn');
      await approve('ann@example.com');
      workspace('ann@example.com', 'annco', { agent: true, landed: true });
      h.tick(20 * DAY);
      // Now: bob from hn (let in, an agent connected, nothing landed), cy from hn (waiting), dee from nowhere,
      // and eve from reddit (let in, made a workspace, no agent yet).
      await h.ask('bob@example.com', 'hn');
      await approve('bob@example.com');
      workspace('bob@example.com', 'bobco', { agent: true });
      await h.ask('cy@example.com', 'hn');
      await h.ask('dee@example.com');
      await h.ask('eve@example.com', 'reddit');
      await approve('eve@example.com');
      workspace('eve@example.com', 'eveco');

      const r = await h.call('GET', '/api/early-access/sources', null, h.as(REMY));
      assert.equal(r.status, 200);
      assert.equal(r.json.days, 14);
      const c = (s) => ({ requests: s[0], let_in: s[1], connected: s[2], landed: s[3] });
      assert.deepEqual(r.json.sources, [
        { source: 'hn', recent: c([2, 1, 1, 0]), all: c([3, 2, 2, 1]) },
        { source: 'reddit', recent: c([1, 1, 0, 0]), all: c([1, 1, 0, 0]) },
        { source: '', recent: c([1, 0, 0, 0]), all: c([1, 0, 0, 0]) },
      ]);
      assert.equal((await h.call('GET', '/api/early-access/sources', null, h.as('bob@example.com'))).status, 403, 'owners only');
      assert.equal((await h.call('GET', '/api/early-access/sources')).status, 401);
    } finally { h.close(); }
  });

  test('the dashboard shows the source on each request and a "Where they came from" section, tagged new', () => {
    const js = readFileSync(new URL('../web/admin.js', import.meta.url), 'utf8');
    assert.match(js, /via \$\{esc\(r\.source\)\}/);
    assert.match(js, /data-new="ea-sources">Where they came from/);
    assert.match(js, /\/api\/early-access\/sources/);
    assert.match(readFileSync(new URL('../web/new.js', import.meta.url), 'utf8'), /'ea-sources': '2026-10-31'/);
  });
});
