import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Hub } from '../src/core.js';
import { findSecret, SHAPES } from '../src/secrets.js';

// Realistic fakes, assembled at runtime so this file never contains a live-looking secret.
const r = (n, set = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') => Array.from({ length: n }, (_, i) => set[(i * 7 + 3) % set.length]).join('');
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const FAKES = {
  'an AWS access key': 'AKIA' + r(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'),
  'a GitHub token': 'ghp_' + r(36),
  'a GitHub fine-grained token': 'github_pat_' + r(22) + '_' + r(59),
  // A JWT (since October 2026): its first segment has - and _, which the classic shape never matched.
  'a GitHub App installation token': 'ghs_' + r(20) + '-' + r(10) + '_' + r(13) + '.' + r(260, B64URL) + '.' + r(80, B64URL),
  'an OpenAI API key': 'sk-proj-' + r(64),
  'a legacy OpenAI API key': 'sk-' + r(48),
  'an Anthropic API key': 'sk-ant-api03-' + r(80),
  'a Slack token': 'xoxb-' + r(12, '0123456789') + '-' + r(24),
  'a Slack webhook URL': `https://hooks.slack.com/services/T${r(8, 'ABCDEFGH0123456789')}/B${r(8, 'ABCDEFGH0123456789')}/${r(24)}`,
  'a private key': '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----',
  'a nuworq token': 'nwq_' + r(43),
  'a bearer token': 'curl -H "Authorization: Bearer ' + r(40) + '" https://api.example.com',
};

describe('secret shapes', () => {
  for (const [name, value] of Object.entries(FAKES)) {
    test(`detects ${name}`, () => {
      const hit = findSecret({ summary: `Ran it with ${value} and it worked` });
      assert.ok(hit, name);
      assert.equal(hit.path, 'summary');
    });
  }

  test('SHAs, UUIDs, hashes, base64 and ordinary prose pass', () => {
    const fine = [
      'Commit 3f786850e387550fdab836ed7e6dc881de23001b on nuworq/claude-a62b',
      'fixed in 3f78685',
      `request ${randomUUID()}`,
      createHash('sha256').update('x').digest('hex'),
      Buffer.from('ordinary text that is fairly long, for base64 purposes').toString('base64'),
      'the task-scheduler-implementation-details and sk-learn-style-transformers-pipeline doc',
      'Set NUWORQ_TOKEN to your agent token (nwq_…); send Authorization: Bearer <token>',
      'risk-assessment-for-the-new-module; ask for a token with `nuworq token create`',
      'ghs_ tokens are JWTs now; see ghs_installation_token_handler.test.js and ghs_request_handler_for_the_installation_flow_v2',
    ];
    for (const s of fine) assert.equal(findSecret(s), null, s);
  });

  test('the secret check takes linear time on long token-like text', () => {
    // Near misses repeated to 1 MB, one or more per shape: each starts a match that fails late, and none
    // is a secret. A check that scans the rest of the run from every start takes minutes on these (#780).
    const MB = 1024 * 1024;
    const fill = (unit) => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);
    const near = [
      '-ghp_a', 'ghp_a_', '-ghs_' + r(8) + '.', '-ghs_' + r(30) + '.' + r(5) + '.', 'ghs_' + r(9) + '.',
      ' AKIA' + r(15, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), ' github_pat_' + r(21), ' sk-ant-' + r(19), ' sk-proj-' + r(19), ' sk-' + r(31),
      ' xoxb-' + r(9), 'hooks.slack.com/services/T' + r(8) + '/B' + r(8) + '/' + r(15) + '.', ' -----BEGIN PRIVATE KEY----',
      ' nwq_' + r(39), 'Authorization: Bearer ' + r(19) + ' ', 'Authorization:  ',
    ];
    for (const unit of near) {
      const text = fill(unit);
      const t = performance.now();
      assert.equal(findSecret({ summary: text }), null, unit);
      const ms = performance.now() - t;
      assert.ok(ms < 500, `${JSON.stringify(unit)} repeated to 1 MB took ${Math.round(ms)} ms`);
    }
  });

  test('a JWT-shaped token is matched whole, for the history scan', () => {
    const token = FAKES['a GitHub App installation token'];
    const m = `see ${token}, then`.match(SHAPES.find(([, re]) => !(re instanceof RegExp))[1]);
    assert.equal(m[0], token);
    assert.equal(m.index, 4);
  });

  test('the path points into nested values', () => {
    assert.deepEqual(findSecret({ evidence: [{ label: 'ok' }, { label: 'x', url: `https://x.test/?key=${FAKES['a GitHub token']}` }] }), { path: 'evidence[1].url', kind: 'a GitHub token' });
    assert.deepEqual(findSecret({ options: ['a', FAKES['a nuworq token']] }), { path: 'options[1]', kind: 'a nuworq token' });
  });
});

describe('the hub refuses secrets before writing anything', () => {
  const secret = FAKES['an Anthropic API key'];
  function setup() {
    const hub = new Hub({ clock: () => Date.UTC(2026, 9, 1, 9) });
    hub.tx(() => hub.project('demo', { create: true }));
    hub.humanOp('demo', 'create', { title: 'Mine', acceptance: 'x' });
    hub.humanOp('demo', 'create', { title: 'Theirs', acceptance: 'x' });
    const op = (agent, name, args) => hub.agentOp('demo', name, agent, args);
    op('a', 'claim', { item: '#1' });
    op('b', 'claim', { item: '#2' });
    const counts = () => JSON.stringify(['events', 'notes', 'questions', 'items'].map((t) => hub.q(`SELECT COUNT(*) AS n FROM ${t}`).get().n)
      .concat(hub.q('SELECT lease_until, updated_at FROM items WHERE seq = 1').get()));
    return { hub, op, counts };
  }

  const cases = [
    ['progress', { item: '#1', headline: 'Halfway', summary: `used ${secret}` }, 'summary'],
    ['progress on an item you do not hold', { item: '#2', headline: `key ${secret}` }, 'headline'],
    ['submit evidence label', { item: '#1', headline: 'Done', evidence: [{ label: `token ${secret}` }] }, 'evidence[0].label'],
    ['submit evidence url', { item: '#1', headline: 'Done', evidence: [{ label: 'log', url: `https://x.test/?k=${secret}` }] }, 'evidence[0].url'],
    ['ask question', { item: '#1', question: `Is ${secret} right?` }, 'question'],
    ['ask assumption', { item: '#1', question: 'Which key?', assumption: `use ${secret}` }, 'assumption'],
    ['learn', { note: `The key is ${secret}` }, 'note'],
    ['propose acceptance', { title: 'New', acceptance: `works with ${secret}` }, 'acceptance'],
    ['comment', { headline: `fyi ${secret}` }, 'headline'],
  ];
  for (const [label, args, field] of cases) {
    test(`${label}: 422 naming ${field}; nothing stored, secret never echoed`, () => {
      const { hub, op, counts } = setup();
      const before = counts();
      const name = label.split(' ')[0];
      let err;
      try { op('a', name, args); } catch (e) { err = e; }
      assert.ok(err, 'refused');
      assert.equal(err.status, 422);
      assert.equal(err.message, `${field} looks like an Anthropic API key; nothing was saved`);
      assert.match(err.hint, /Remove or redact it/);
      assert.ok(!JSON.stringify({ m: err.message, h: err.hint }).includes(secret));
      assert.equal(counts(), before, 'no event, note, question, item change or lease renewal');
      const all = hub.q('SELECT * FROM events').all().concat(hub.q('SELECT * FROM notes').all(), hub.q('SELECT * FROM items').all());
      assert.ok(!JSON.stringify(all).includes(secret));
    });
  }

  test('human ops are checked too', () => {
    const { hub } = setup();
    assert.throws(() => hub.humanOp('demo', 'steer', { body: `use ${secret}` }), (e) => e.status === 422 && /body looks like an Anthropic API key/.test(e.message));
  });
});
