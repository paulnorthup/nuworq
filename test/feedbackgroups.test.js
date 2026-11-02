import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';
import { Auth } from '../src/auth.js';
import { SYSTEM } from '../src/core.js';
import { features, sameReport, suggest, VAGUE_NOTE } from '../src/feedbackgroups.js';

const ADMIN = 'admin.example.test', APP = 'app.example.test';

function request(port, method, path, { host = APP, headers = {}, body } = {}) {
  const data = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), origin: `http://${host}` } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(data ?? undefined);
  });
}

// 2026-11-02 as the hub saw it: #640 waits for review, and #654, the fix for next offering a review that review
// refuses, is in review itself. paul owns the hub; agents work in acme on one shared token.
async function hub() {
  const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-fbg-')), owners: ['paul@example.com'] });
  spaces.create('nuworq');
  const nw = spaces.get('nuworq');
  const p = nw.project('nuworq', { create: true });
  nw.q('UPDATE projects SET next_seq = 640 WHERE id = ?').run(p.id);
  nw.createItem(p, SYSTEM, { title: 'The runner shows what each worker costs while it runs', summary: 'A line per worker with its spend so far.', acceptance: 'Spend shows per worker.' });
  nw.q('UPDATE projects SET next_seq = 654 WHERE id = ?').run(p.id);
  const fix = nw.createItem(p, SYSTEM, {
    title: 'next never offers a review that review would refuse as the caller token\'s own work',
    summary: 'Since #622 landed, `review` refuses an item built under another agent name on the same token ("You can\'t review your own work (#640)"). But `next`\'s review routing still offers that item to the token\'s other agents.',
    acceptance: 'next never answers with "can\'t review your own work" when other work exists.',
  });
  nw.move(fix, 'verifying', SYSTEM);
  spaces.create('acme');
  const acme = new Auth(spaces.get('acme').db);
  acme.addPerson('paul', 'owner', { email: 'paul@example.com' });
  spaces.get('acme').q('UPDATE people SET verified_at = 1 WHERE handle = ?').run('paul');
  const paulApp = `nuworq_session=${acme.signInByEmail('paul@example.com', 'github').sid}`;
  const agentToken = acme.createToken('bot', 'agent');
  const server = createServer(spaces, {
    publicUrl: `http://${APP}`, adminHost: ADMIN, feedbackProject: 'nuworq/nuworq', feedbackBatchMs: 20,
    earlyAccess: { owners: ['paul@example.com'], verify: null, gate: false },
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const dir = spaces.directory;
  const paul = `nuworq_admin=${dir.createSession(dir.identify('paul@example.com', 'github').id, 'admin')}`;
  const call = (method, path, body, opts = {}) => request(port, method, path, { body, ...opts });
  const asAgent = async (name, path, body) => call('POST', `/w/acme${path}`, body, { headers: { authorization: `Bearer ${agentToken}`, 'x-nuworq-agent': name } });
  const send = async (name, text, item) => {
    await asAgent(name, '/api/p/api/agent/checkin', { model: 'claude-opus-5-5', client: 'claude-code' });
    const r = await asAgent(name, '/api/p/api/agent/feedback', { text, ...(item ? { item } : {}) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  };
  const asPaul = (method, path, body) => call(method, path, body, { host: ADMIN, headers: { cookie: paul } });
  const items = () => nw.q('SELECT seq, title, stage FROM items WHERE project_id = ? ORDER BY seq').all(p.id);
  return { spaces, nw, p, fix, dir, call, send, asAgent, asPaul, paulApp, items, close: () => server.close() };
}

// The day's 18 pieces: 17 agents (16 workers and the operator) hit the same loop, in their own words; one other.
const LOOP = [
  ['claude-2ab1', '`next` offered me the review of #640, then `review` refused it: "You can\'t review your own work (#640)". I didn\'t build it.', '#640'],
  ['claude-ed13', 'next gave me #640 to review and review said "You can\'t review your own work (#640)". I built #640 myself, but next should know that.'],
  ['claude-1f0a', 'Stuck in a loop: next → review #640 → "You can\'t review your own work (#640)" → next offers #640 again.'],
  ['claude-35c2', 'The next tool keeps offering the review of #640, and then I am refused it. No other work is offered.', '#640'],
  ['claude-4d91', 'Got "You can\'t review your own work (#640)" from review right after next handed me #640.'],
  ['claude-5e07', 'next keeps routing me to review #640, which review then refuses as my own work. I never touched it.'],
  ['claude-6a3c', 'Every next call offers #640 for review and every review call refuses it: "You can\'t review your own work (#640)".'],
  ['claude-7b18', 'I can\'t get any work: next offers only the review of #640, then refuses it.', '#640'],
  ['claude-8c2d', 'review: "You can\'t review your own work (#640)". But next offered it to me, and I\'m a different agent from its builder.'],
  ['claude-9d4e', 'Looping on #640: the next tool offers its review, the review tool says it\'s my own work.'],
  ['claude-a05f', '`next` → #640 review → refused as my own work. Signing off since nothing else is offered.', '#640'],
  ['claude-b160', 'Refused: "You can\'t review your own work (#640)". next shouldn\'t offer what review refuses.'],
  ['claude-c271', 'next offered the review of #640 three times in a row; each time review refused it as my own work.'],
  ['claude-d382', 'We share Paul\'s connect token, so review thinks #640 is my own work, but next still offers it. "You can\'t review your own work (#640)"'],
  ['claude-e493', 'Same as others probably: next → review #640 → "You can\'t review your own work (#640)".'],
  ['claude-f5a4', 'The next call offers me #640 to review; review refuses with "You can\'t review your own work (#640)".', '#640'],
  ['claude-code-adf2', 'Operator here: every worker on this machine loops on `next` offering #640\'s review and `review` refusing it ("You can\'t review your own work (#640)").'],
];
const OTHER = ['claude-2ab1', 'checkin repeats every field note each session, even ones I read an hour ago; it costs context before I start any work.'];

describe('feedback arrives in groups (#688)', () => {
  before(() => { process.env.NUWORQ_ALLOW_PRIVATE_HOSTS = '127.0.0.1'; });
  after(() => { delete process.env.NUWORQ_ALLOW_PRIVATE_HOSTS; });

  test('the same report is told by its error text, item or tool; a different one stays apart', () => {
    const f = LOOP.map(([, t, i]) => features(t, i));
    for (let i = 1; i < f.length; i++) assert.ok(f.slice(0, i).some((g) => sameReport(f[i], g)), `piece ${i + 1} joins: ${LOOP[i][1]}`);
    const other = features(OTHER[1]);
    assert.ok(!f.some((g) => sameReport(other, g)), 'the checkin report is its own');
    assert.deepEqual([...features('`next` offered it; the review tool refused').tools].sort(), ['next', 'review']);
    assert.equal(features('I want to get the next thing done').tools.size, 0, 'a word is not a tool');
  });

  test('a group with nothing known suggests new work, or declining a vague one with a note', () => {
    assert.equal(suggest({ pieces: [{ sender: 'a', text: OTHER[1] }] }, null).action, 'approve');
    const vague = suggest({ pieces: [{ sender: 'a', text: 'broken' }] }, null);
    assert.equal(vague.action, 'decline');
    assert.equal(vague.note, VAGUE_NOTE);
  });

  test('2026-11-02 replayed: 18 pieces, 2 groups, the loop linked to #654, decided in one tap, nothing duplicated', async () => {
    const h = await hub();
    try {
      const before = h.items().length;
      const answers = [];
      for (const [name, text, item] of LOOP) answers.push(await h.send(name, text, item));
      await h.send(...OTHER);
      // Agents hear it's known, and that others sent it.
      assert.equal(answers[0].known, '#654');
      assert.match(answers[0].hint, /Already known: #654 fixes this; it's in review/);
      assert.equal(answers[16].others, 16);
      assert.match(answers[16].hint, /16 others sent the same/);

      const { json } = await h.asPaul('GET', '/api/feedback/groups?state=new');
      assert.equal(json.groups.length, 2, 'two groups, not eighteen pieces');
      const loop = json.groups.find((g) => g.count === 17);
      assert.ok(loop, '17 reports of the loop are one group');
      assert.equal(loop.senders.length, 17, 'it says who sent it');
      assert.equal(loop.known.ref, '#654');
      assert.equal(loop.known.line, "#654 fixes this; it's in review.");
      assert.deepEqual({ action: loop.suggest.action, ref: loop.suggest.ref }, { action: 'link', ref: '#654' });
      const other = json.groups.find((g) => g !== loop);
      assert.equal(other.suggest.action, 'approve');
      assert.ok(other.suggest.why);

      // One decision for both: take the suggestions.
      let decisions = 0;
      const r = await h.asPaul('POST', '/api/feedback/groups/decide', { groups: [loop.id, other.id], action: 'suggested' });
      decisions++;
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.ok(decisions <= 3);
      const [l, o] = r.json.groups;
      assert.equal(l.state, 'linked');
      assert.equal(l.decision.ref, '#654');
      assert.equal(o.state, 'approved');
      assert.equal((await h.asPaul('GET', '/api/feedback/groups?state=new')).json.groups.length, 0, 'nothing waits');

      // Linking made nothing; the other report made one proposal. No item about #640's loop besides #654.
      const after = h.items();
      assert.equal(after.length, before + 1);
      assert.ok(!after.slice(before).some((i) => /640/.test(i.title)), 'no duplicate of #654');
      assert.ok(h.dir.feedbackList().filter((f) => f.grp === loop.id).every((f) => f.state === 'linked' && f.proposal === 'nuworq/nuworq#654'));

      // A late report joins the linked group and is linked with it; the same agent again adds nothing.
      const late = await h.send('claude-0a0a', 'next offered #640 for review and review refused: "You can\'t review your own work (#640)".');
      assert.equal(late.known, '#654');
      assert.equal(h.dir.feedbackById(late.feedback).state, 'linked');
      const count = h.dir.feedbackList().length;
      const again = await h.send('claude-0a0a', 'next offered #640 for review and review refused: "You can\'t review your own work (#640)".');
      assert.equal(again.repeat, true);
      assert.equal(again.feedback, late.feedback);
      assert.match(again.hint, /You sent this already/);
      assert.equal(h.dir.feedbackList().length, count, 'nothing new');

      // Every sender is told when #654 lands: an agent at its next checkin.
      h.nw.move(h.nw.item(h.p, 654), 'done', SYSTEM);
      const ci = (await h.asAgent('claude-35c2', '/api/p/api/agent/checkin', { model: 'm' })).json;
      assert.equal(ci.your_feedback[0].state, 'fixed');
    } finally { h.close(); }
  });

  test('a decision can be undone: linked waits again; approved drops the proposal it made while unshaped', async () => {
    const h = await hub();
    try {
      await h.send(...OTHER);
      await h.send(...LOOP[0]);
      const { groups } = (await h.asPaul('GET', '/api/feedback/groups')).json;
      const loop = groups.find((g) => g.known), other = groups.find((g) => !g.known);
      await h.asPaul('POST', '/api/feedback/groups/decide', { groups: [loop.id], action: 'link', ref: '#654' });
      const undone = await h.asPaul('POST', '/api/feedback/groups/undo', { groups: [loop.id] });
      assert.equal(undone.json.groups[0].state, 'new');
      assert.equal(undone.json.groups[0].suggest.action, 'link');

      const made = (await h.asPaul('POST', '/api/feedback/groups/decide', { groups: [other.id], action: 'approve' })).json.groups[0];
      const seq = Number(made.decision.proposal.split('#')[1]);
      assert.equal(h.nw.item(h.p, seq).stage, 'proposed');
      await h.asPaul('POST', '/api/feedback/groups/undo', { groups: [other.id] });
      assert.equal(h.nw.item(h.p, seq).stage, 'dropped', 'the proposal it made is dropped');

      // Decline with a note, no dialog: the note is the request's.
      const d = (await h.asPaul('POST', '/api/feedback/groups/decide', { groups: [other.id], action: 'decline', note: 'Working as meant.' })).json.groups[0];
      assert.equal(d.state, 'declined');
      assert.equal(d.decision.note, 'Working as meant.');
      assert.equal((await h.asPaul('POST', '/api/feedback/groups/decide', { groups: [other.id], action: 'decline' })).status, 409, 'decided once until undone');
      assert.equal((await h.asPaul('POST', '/api/feedback/groups/decide', { groups: [loop.id], action: 'link', ref: '#999' })).status, 400);
      assert.equal((await h.call('GET', '/api/feedback/groups')).status, 403, 'only on the admin host');
    } finally { h.close(); }
  });

  test('the app tells a hub owner what waits, with its count and where it opens', async () => {
    const h = await hub();
    try {
      const seen = async () => (await h.call('GET', '/w/acme/api/feedback', undefined, { headers: { cookie: h.paulApp } })).json;
      assert.equal((await seen()).waiting, undefined, 'nothing waits');
      for (const [name, text, item] of LOOP.slice(0, 3)) await h.send(name, text, item);
      await h.send(...OTHER);
      assert.deepEqual((await seen()).waiting, { groups: 2, pieces: 4, url: `http://${ADMIN}/#feedback` });
    } finally { h.close(); }
  });
});
