import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, PERSON_CAN } from '../src/core.js';
import { createServer } from '../src/server.js';
import { Workspaces } from '../src/workspaces.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const HOUR = 60 * 60 * 1000;

// A project anyone can watch (#358): off until an owner turns it on, then a public page and its data, with
// nothing but src/live.js's allowlist in them.
describe('the public live view', () => {
  let t = Date.UTC(2026, 9, 30, 9), hub, server, url, token;
  // Every one of these is somewhere in the project; none may reach a visitor.
  const SECRET = {
    summary: 'SECRET-SUMMARY', acceptance: 'SECRET-ACCEPTANCE', headline: 'SECRET-HEADLINE', detail: 'SECRET-DETAIL',
    evidence: 'SECRET-EVIDENCE', note: 'SECRET-FIELD-NOTE', question: 'SECRET-QUESTION', answer: 'SECRET-ANSWER',
    steer: 'SECRET-STEER', decision: 'SECRET-DECISION', email: 'secret-person@example.com', machine: 'SECRET-MACHINE',
    handoff: 'SECRET-HANDOFF', comment: 'SECRET-COMMENT', mission: 'SECRET-MISSION', token: '',
  };
  before(async () => {
    hub = new Hub({ clock: () => t });
    hub.tx(() => hub.project('nuworq', { create: true }));
    const P = 'nuworq';
    hub.humanOp(P, 'settings', { mission: SECRET.mission });
    hub.humanOp(P, 'decide', { body: SECRET.decision });
    // One item lands, with usage; one is built now; one is handed off.
    hub.humanOp(P, 'create', { title: 'Landed thing', summary: SECRET.summary, acceptance: SECRET.acceptance });
    hub.agentOp(P, 'checkin', 'opus-a', { model: 'claude-opus-5-5', machine: SECRET.machine });
    const a = hub.agentOp(P, 'next', 'opus-a', {});
    for (let k = 0; k < 6; k++) { t += HOUR / 6; hub.agentOp(P, 'progress', 'opus-a', { item: a.item }); }
    hub.agentOp(P, 'progress', 'opus-a', { item: a.item, headline: SECRET.headline, detail: SECRET.detail });
    hub.agentOp(P, 'learn', 'opus-a', { note: SECRET.note });
    hub.agentOp(P, 'submit', 'opus-a', { item: a.item, headline: SECRET.headline, evidence: [{ label: SECRET.evidence }], usage: { input_tokens: 10, output_tokens: 1, cost_usd: 3.4 } });
    hub.humanOp(P, 'accept', { item: a.item });
    hub.humanOp(P, 'create', { title: 'Being built', summary: SECRET.summary });
    hub.agentOp(P, 'checkin', 'gpt-b', { model: 'gpt-5', machine: SECRET.machine });
    const b = hub.agentOp(P, 'next', 'gpt-b', {});
    hub.agentOp(P, 'progress', 'gpt-b', { item: b.item, headline: SECRET.headline });
    hub.agentOp(P, 'comment', 'gpt-b', { item: b.item, headline: SECRET.comment });
    const q = hub.agentOp(P, 'ask', 'gpt-b', { item: b.item, question: SECRET.question, assumption: 'go on' });
    hub.humanOp(P, 'answer', { question: q.question ?? q.id, answer: SECRET.answer }, SECRET.email);
    hub.humanOp(P, 'steer', { body: SECRET.steer }, SECRET.email);
    hub.humanOp(P, 'create', { title: 'Someone asked', summary: SECRET.summary }, SECRET.email);
    server = createServer(hub, { auth: 'required' });
    url = `http://127.0.0.1:${await listen(server)}`;
    token = server.auth.createToken('owner', 'human');
    SECRET.token = token;
  });
  after(() => { server.close(); server.closeAllConnections(); });
  const get = (path) => fetch(`${url}${path}`);
  const turn = (live) => fetch(`${url}/api/p/nuworq/human/settings`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ live }) });

  test('off by default: the page and its data answer 404, and only an owner may change it', async () => {
    for (const path of ['/live/nuworq', '/api/live/nuworq', '/live/nope', '/api/live/nope']) assert.equal((await get(path)).status, 404, path);
    assert.ok(PERSON_CAN.owner.includes('settings'));
    for (const role of ['viewer', 'member', 'steward']) assert.ok(!PERSON_CAN[role].includes('settings'), role);
  });

  test('on: no sign-in, the pulse, what is in motion with agent and model, Flow, landed and totals; cacheable', async () => {
    assert.equal((await turn(true)).status, 200);
    const r = await get('/api/live/nuworq');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=15');
    const d = await r.json();
    assert.equal(d.pulse.state, 'flowing');
    assert.match(d.pulse.sentence, /1 agent working on 1 item/);
    assert.deepEqual(d.motion.map(({ item, title, agent, model, stage }) => ({ item, title, agent, model, stage })), [{ item: '#2', title: 'Being built', agent: 'gpt-b', model: 'gpt-5', stage: 'building' }]);
    assert.deepEqual(d.landed.map(({ item, title, agent, model }) => ({ item, title, agent, model })), [{ item: '#1', title: 'Landed thing', agent: 'opus-a', model: 'claude-opus-5-5' }]);
    assert.deepEqual({ ...d.totals, since: undefined }, { since: undefined, landed: 1, sent_back: 0, median_cycle: '1h', cost_per_landed: 3.4 });
    assert.equal(d.flow.throughput.length, 14);
    assert.ok(d.flow.stages.length && 'agents' in d.flow.court);
    assert.equal(d.early_access, 'https://nuworq.com/early-access');
    const page = await get('/live/nuworq');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'public, max-age=15');
    assert.match(await page.text(), /<script type="module" src="\/live\.js">/);
  });

  test('nothing outside the allowlist leaves: no summary, headline, evidence, note, question, answer, steer, decision, email, token or machine', async () => {
    assert.ok(hub.q('SELECT 1 FROM questions WHERE answer LIKE ?').get(`%${SECRET.answer}%`), 'the answer is in the hub');
    const out = (await (await get('/api/live/nuworq')).text()) + (await (await get('/live/nuworq')).text());
    for (const [what, marker] of Object.entries(SECRET)) assert.ok(!out.includes(marker), `${what} leaked`);
  });

  test('turned off, both answer 404 at once, whatever was computed before', async () => {
    assert.equal((await get('/api/live/nuworq')).status, 200);
    assert.equal((await turn(false)).status, 200);
    for (const path of ['/live/nuworq', '/api/live/nuworq']) assert.equal((await get(path)).status, 404, path);
  });
});

// On a hub of workspaces reached by path, the page's script and styles come from under /w/<workspace>/ too.
test('under /w/<workspace>, the live page loads its script and styles, and its data', async () => {
  const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-live-ws-')) });
  spaces.create('acme');
  const hub = spaces.get('acme');
  hub.tx(() => hub.project('nuworq', { create: true }));
  hub.humanOp('nuworq', 'settings', { live: true });
  const server = createServer(spaces, {});
  const url = `http://127.0.0.1:${await listen(server)}`;
  try {
    const page = await fetch(`${url}/w/acme/live/nuworq`);
    assert.equal(page.status, 200);
    const html = await page.text();
    const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
    assert.deepEqual(assets.sort(), ['/w/acme/live.js', '/w/acme/style.css']);
    for (const asset of assets) {
      const r = await fetch(`${url}${asset}`);
      assert.equal(r.status, 200, asset);
      assert.match(r.headers.get('content-type'), asset.endsWith('.js') ? /javascript/ : /css/, asset);
    }
    // live.js asks for the data at the page's path with /live/ turned into /api/live/.
    assert.equal((await fetch(`${url}/w/acme/api/live/nuworq`)).status, 200);
  } finally { server.close(); server.closeAllConnections(); spaces.close(); }
});
