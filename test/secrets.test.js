import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Hub } from '../src/core.js';
import { findSecret } from '../src/secrets.js';

// Realistic fakes, assembled at runtime so this file never contains a live-looking secret.
const r = (n, set = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') => Array.from({ length: n }, (_, i) => set[(i * 7 + 3) % set.length]).join('');
const FAKES = {
  'an AWS access key': 'AKIA' + r(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'),
  'a GitHub token': 'ghp_' + r(36),
  'a GitHub fine-grained token': 'github_pat_' + r(22) + '_' + r(59),
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
      'Commit 3f786850e387550fdab836ed7e6dc881de23001b on trellis/claude-a62b',
      'fixed in 3f78685',
      `request ${randomUUID()}`,
      createHash('sha256').update('x').digest('hex'),
      Buffer.from('ordinary text that is fairly long, for base64 purposes').toString('base64'),
      'the task-scheduler-implementation-details and sk-learn-style-transformers-pipeline doc',
      'Set NUWORQ_TOKEN to your agent token (nwq_…); send Authorization: Bearer <token>',
      'Set TRELLIS_TOKEN to your agent token (trl_…); send Authorization: Bearer <token>',
      'risk-assessment-for-the-new-module; ask for a token with `nuworq token create`',
      'risk-assessment-for-the-new-module; ask for a token with `trellis token create`',
    ];
    for (const s of fine) assert.equal(findSecret(s), null, s);
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
