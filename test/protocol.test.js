import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Hub, LEASE_MS, MIN } from '../src/core.js';
import { createServer } from '../src/server.js';
import { view } from '../src/insight.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));
const run = promisify(execFile);

function setup(start = Date.UTC(2026, 9, 1, 9)) {
  const clock = { t: start };
  const hub = new Hub({ clock: () => clock.t });
  const agent = (name) => (op, args = {}) => hub.agentOp('demo', op, name, args);
  const human = (action, args = {}) => hub.humanOp('demo', action, args);
  const row = (seq) => hub.q('SELECT * FROM items WHERE seq = ?').get(seq);
  return { hub, clock, agent, human, row };
}

describe('lifecycle', () => {
  test('checkin creates the project; next claims; progress renews; a quiet agent loses the lease', () => {
    const { hub, clock, agent, human, row } = setup();
    const a = agent('claude-1');
    const brief = a('checkin', { model: 'claude-opus-5-5' });
    assert.equal(brief.project, 'demo');
    assert.ok(hub.project('demo'));

    human('create', { title: 'Add retries', acceptance: 'Retries 3x' });
    const n = a('next');
    assert.equal(n.mode, 'work');
    assert.equal(n.item, '#1');
    assert.equal(row(1).stage, 'active');
    assert.equal(row(1).holder, 'claude-1');

    clock.t += 15 * MIN;
    a('progress', { item: '#1', headline: 'Halfway' });
    assert.equal(row(1).lease_until, clock.t + LEASE_MS);

    clock.t += LEASE_MS + MIN;
    hub.sweep();
    const it = row(1);
    assert.equal(it.stage, 'ready');
    assert.equal(it.holder, null);
    assert.equal(it.stalls, 1);
    assert.equal(it.last_worker, 'claude-1');
  });

  test('a steer piggybacks on the next response and ack clears it', () => {
    const { agent, human } = setup();
    const a = agent('claude-1');
    a('checkin');
    human('create', { title: 'Task', acceptance: 'x' });
    a('next');
    human('steer', { body: 'Keep the public API unchanged' });
    const r = a('progress', { item: '#1', headline: 'Working' });
    assert.equal(r.steers.length, 1);
    assert.match(r.hint, /steered/);
    a('ack', { steer: r.steers[0].steer, response: 'Will keep signatures stable' });
    const r2 = a('progress', { item: '#1', headline: 'Still working' });
    assert.equal(r2.steers, undefined);
  });

  test('a blocking ask parks the item; the answer returns it to ready and reaches the asker', () => {
    const { hub, agent, human, row } = setup();
    const a = agent('codex-1');
    a('checkin');
    human('create', { title: 'Write docs', acceptance: 'docs exist' });
    a('next');
    const asked = a('ask', { item: '#1', question: 'Where should docs live?', blocking: true, options: ['README', 'docs/'] });
    assert.equal(asked.blocking, true);
    assert.equal(row(1).stage, 'waiting');
    assert.equal(row(1).holder, null);

    const v = view(hub, 'demo');
    const card = v.attention.find((x) => x.kind === 'question');
    assert.equal(card.level, 'act');
    human('answer', { question: card.question.id, answer: 'docs/' });
    assert.equal(row(1).stage, 'ready');

    const brief = a('checkin');
    assert.equal(brief.answers.length, 1);
    assert.equal(brief.answers[0].answer, 'docs/');
    assert.equal(a('checkin').answers, undefined, 'answers are delivered once');
  });

  test('a non-blocking ask keeps working; overriding it steers the holder', () => {
    const { hub, agent, human, row } = setup();
    const a = agent('claude-1');
    a('checkin');
    human('create', { title: 'Retry policy', acceptance: 'x' });
    a('next');
    const r = a('ask', { item: '#1', question: 'Retry 429s?', assumption: 'Yes, honoring Retry-After' });
    assert.equal(r.blocking, false);
    assert.equal(row(1).stage, 'active');
    const card = view(hub, 'demo').attention.find((x) => x.kind === 'assumption');
    assert.equal(card.level, 'know');
    human('answer', { question: card.question.id, answer: 'No, fail fast on 429' });
    const p = a('progress', { item: '#1', headline: 'Adjusting' });
    assert.equal(p.steers.length, 1);
    assert.match(p.steers[0].body, /fail fast/);
  });

  test('full autonomy: peer review by another agent, never your own; reject sends it back', () => {
    const { agent, human, row } = setup();
    const a = agent('claude-1');
    const b = agent('codex-1');
    a('checkin');
    b('checkin');
    human('settings', { autonomy: 'full' });
    human('create', { title: 'Feature', acceptance: 'works' });
    a('next');
    a('submit', { item: '#1', headline: 'Done', evidence: [{ label: 'tests pass' }] });
    assert.equal(row(1).stage, 'verifying');

    assert.throws(() => a('review', { item: '#1', verdict: 'accept', headline: 'lgtm' }), /own work/);
    assert.equal(a('next').mode, 'idle', 'the implementer is not offered its own review');

    const n = b('next');
    assert.equal(n.mode, 'review');
    assert.equal(n.item, '#1');
    b('review', { item: '#1', verdict: 'reject', headline: 'Missing error handling' });
    assert.equal(row(1).stage, 'ready');
    assert.equal(row(1).rejections, 1);
  });

  test('an over-long headline is trimmed and the overflow moves into the summary', () => {
    const { agent, human, hub } = setup();
    const a = agent('claude-1');
    a('checkin');
    human('create', { title: 'Task', acceptance: 'x' });
    a('next');
    const long = 'Refactored the retry module so that backoff is configurable per upstream, '.repeat(3) + 'and the tail end lives here';
    a('progress', { item: '#1', headline: long, summary: 'Original summary' });
    const e = hub.q(`SELECT * FROM events WHERE type = 'progress' ORDER BY id DESC LIMIT 1`).get();
    assert.ok(e.headline.length <= 141, `headline is ${e.headline.length} chars`);
    assert.ok(e.headline.endsWith('…'));
    assert.match(e.summary, /tail end lives here/);
    assert.match(e.summary, /Original summary/);
  });
});

describe('transports', () => {
  let hub, server, url;
  before(async () => {
    hub = new Hub();
    server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  const post = (path, body, headers = {}) =>
    fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  test('HTTP: missing agent name → 400 with a hint; unknown project → 404', async () => {
    const r1 = await post('/api/p/anything/agent/checkin', {});
    assert.equal(r1.status, 400);
    const b1 = await r1.json();
    assert.ok(b1.hint);

    const r2 = await post('/api/p/no-such-project/agent/next', {}, { 'x-nuworq-agent': 'claude-1' });
    assert.equal(r2.status, 404);
  });

  test('MCP: initialize, list tools, call checkin and next', async () => {
    hub.humanOp(hub.tx(() => hub.project('mcp-proj', { create: true })).slug, 'create', { title: 'MCP task', acceptance: 'x' });
    const child = spawn(process.execPath, [BIN, 'mcp'], {
      env: { ...process.env, NUWORQ_URL: url, NUWORQ_PROJECT: 'mcp-proj', NUWORQ_MODEL: 'gpt-5', NUWORQ_AGENT: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pending = new Map();
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        pending.get(msg.id)?.(msg);
      }
    });
    let id = 0;
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const myId = ++id;
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 5000);
      pending.set(myId, (m) => { clearTimeout(timer); resolve(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    });

    try {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex', version: '1' } });
      assert.equal(init.result.protocolVersion, '2025-06-18');
      assert.match(init.result.instructions, /mcp-proj/);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

      const list = await rpc('tools/list', {});
      assert.equal(list.result.tools.length, 17);
      assert.ok(list.result.tools.some((t) => t.name === 'withdraw'), 'the asker takes back its question (#184)');
      assert.ok(list.result.tools.some((t) => t.name === 'answer'), 'the operator tool (#133)');

      const checkin = await rpc('tools/call', { name: 'checkin', arguments: { model: 'unknown' } }); // NUWORQ_MODEL wins
      assert.ok(!checkin.result.isError, checkin.result.content[0].text);
      const brief = JSON.parse(checkin.result.content[0].text);
      assert.match(brief.you, /^codex-[0-9a-f]{4}$/);

      const next = await rpc('tools/call', { name: 'next', arguments: {} });
      assert.equal(JSON.parse(next.result.content[0].text).item, '#1');

      const bad = await rpc('tools/call', { name: 'claim', arguments: { item: '#99' } });
      assert.equal(bad.result.isError, true);

      const unknown = await rpc('no/such/method', {});
      assert.equal(unknown.error.code, -32601);

      const v = view(hub, 'mcp-proj');
      const a = v.agents.find((x) => x.name === brief.you);
      assert.ok(a, 'agent appears in the view');
      assert.equal(a.model, 'gpt-5');
      assert.equal(a.client, 'codex');
      assert.equal(a.provider, 'OpenAI');
    } finally {
      child.kill();
    }
  });

  test('CLI: checkin, propose, next, submit', async () => {
    const env = { ...process.env, NUWORQ_URL: url, NUWORQ_PROJECT: 'cli-proj', NUWORQ_AGENT: '' };
    const cli = (...args) => run(process.execPath, [BIN, ...args], { env });

    const c = JSON.parse((await cli('checkin', '--as', 'cli-1', '--model', 'qwen3-coder', '--client', 'opencode')).stdout);
    assert.equal(c.project, 'cli-proj');

    const p = JSON.parse((await cli('propose', 'Add a health endpoint', '--as', 'cli-1', '--acceptance', 'GET /health returns 200', '--priority', 'now')).stdout);
    assert.equal(p.stage, 'ready');

    const n = JSON.parse((await cli('next', '--as', 'cli-1')).stdout);
    assert.equal(n.item, p.item);
    assert.match(n.hint, /As soon as you know which files you will change, post progress with a headline and touching/);

    await cli('progress', p.item, 'Routing in place', '--as', 'cli-1', '--touching', 'src/server.js, src/health');
    const held = hub.q(`SELECT touching FROM items WHERE stage = 'active' ORDER BY id DESC LIMIT 1`).get();
    assert.deepEqual(JSON.parse(held.touching), ['src/server.js', 'src/health']);

    const s = JSON.parse((await cli('submit', p.item, 'Health endpoint added', '--as', 'cli-1', '--evidence', 'curl /health → 200|http://example.test/pr/1')).stdout);
    assert.equal(s.ok, true);
    const sub = hub.q(`SELECT data FROM events WHERE type = 'submitted' ORDER BY id DESC LIMIT 1`).get();
    assert.deepEqual(JSON.parse(sub.data).evidence, [{ label: 'curl /health → 200', url: 'http://example.test/pr/1' }]);

    await assert.rejects(cli('next'), (e) => e.code === 1 && /who are you/.test(e.stderr));
    await assert.rejects(cli('claim', '#42', '--as', 'cli-1'), (e) => e.code === 1 && /error: No item #42/.test(e.stderr));

    const status = await cli('status', '--project', 'cli-proj');
    assert.match(status.stdout, /1 thing needs you/);
  });
});
