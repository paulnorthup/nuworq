import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { OPS, guide } from '../src/protocol.js';
import { agentArgs, unknownField, POSITIONAL } from '../src/agentargs.js';
import { command } from '../src/help.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));

// A value of the parameter's type, as typed on the command line, and what the body should then hold.
function sample(schema) {
  if (schema.type === 'boolean') return { argv: [], want: true };
  if (schema.type === 'integer' || schema.type === 'number') return { argv: ['3'], want: 3 };
  if (schema.type === 'object') return { argv: ['{"a":1}'], want: { a: 1 } };
  if (schema.type === 'array' && schema.items?.type === 'object') {
    const keys = Object.keys(schema.items.properties);
    return { argv: [keys.map((k) => `${k}-v`).join('|')], want: [Object.fromEntries(keys.map((k) => [k, `${k}-v`]))] };
  }
  if (schema.type === 'array' && schema.items?.type === 'integer') return { argv: ['4,5'], want: [4, 5] };
  if (schema.type === 'array') return { argv: ['x'], want: ['x'] };
  if (schema.enum) return { argv: [schema.enum[0]], want: schema.enum[0] };
  return { argv: ['some value'], want: 'some value' };
}

// What fills an operation's required positional arguments, so a flag alone can be checked.
const filler = { item: '#1', headline: 'h', question: 'q', title: 't', note: 'n', text: 't', reason: 'r', answer: 'a', verdict: 'accept', steer: '1', notes: '1' };
function base(op) {
  const out = [];
  for (const s of POSITIONAL[op.name]) {
    const name = s.replace(/[?.]+$/, '');
    if ((op.required ?? []).includes(name)) out.push(op.params[name].type === 'integer' ? '1' : filler[name]);
  }
  return out;
}

describe('the agent commands come from OPS (#521)', () => {
  test('every parameter of every operation is reachable from the CLI as its --kebab-case flag', () => {
    for (const op of OPS) {
      for (const [param, schema] of Object.entries(op.params ?? {})) {
        const { argv, want } = sample(schema);
        // Required non-positional parameters (retire's --reason) come along so the call parses.
        const extra = (op.required ?? []).filter((r) => r !== param && !POSITIONAL[op.name].some((s) => s.startsWith(r))).flatMap((r) => [`--${r.replace(/_/g, '-')}`, 'r']);
        const { body } = agentArgs(op.name, [...base(op), ...extra, `--${param.replace(/_/g, '-')}`, ...argv]);
        assert.deepEqual(body[param], want, `${op.name} --${param}`);
      }
    }
  });

  test('every operation is a command with generated usage, and help lists its flags', () => {
    for (const op of OPS) {
      const c = command(op.name);
      assert.ok(c, op.name);
      assert.match(c.usage[0], new RegExp(`^${op.name}\\b`));
    }
    assert.ok(command('refine').flags.some(([f]) => f.startsWith('--parent ')));
    assert.ok(command('propose').flags.some(([f]) => f.startsWith('--precondition ')));
    assert.ok(command('submit').flags.some(([f]) => f.startsWith('--conflicts ')));
  });

  test('positional arguments: the item, the rest of the words as the headline, an optional item before a question', () => {
    assert.deepEqual(agentArgs('submit', ['12', 'Parser', 'handles', 'tabs', '--evidence', 'npm test: 48 passed', '--evidence', 'PR|https://x/1|2']).body, {
      item: '12', headline: 'Parser handles tabs', evidence: [{ label: 'npm test: 48 passed' }, { label: 'PR', url: 'https://x/1|2' }],
    });
    assert.deepEqual(agentArgs('ask', ['12', 'Keep', 'it?', '--assume', 'yes', '--option', 'Yes, keep', '--option', 'No']).body, { item: '12', question: 'Keep it?', assumption: 'yes', options: ['Yes, keep', 'No'] });
    assert.deepEqual(agentArgs('ask', ['Why?']).body, { question: 'Why?' });
    assert.deepEqual(agentArgs('retire', ['31', '32', '--reason', 'built in']).body, { notes: [31, 32], reason: 'built in' });
    assert.deepEqual(agentArgs('next', ['--peek']).body, { claim: false });
    assert.deepEqual(agentArgs('next', ['--claim', 'false']).body, { claim: false });
    assert.deepEqual(agentArgs('refine', ['380', '--parent', '1', '--needs', '']).body, { item: '380', parent: '1', needs: [] });
    assert.deepEqual(agentArgs('checkin', ['--role', 'shaper', '--project', 'acme', '--as', 'c']), { body: { role: 'shaper', project: 'acme' }, common: { project: 'acme', as: 'c' } });
    assert.equal(agentArgs('progress', ['12', '--summary', '-'], { read: () => 'from stdin' }).body.summary, 'from stdin');
    // A boolean flag doesn't take the next word: --as after it is still --as.
    assert.deepEqual(agentArgs('propose', ['Release', '--release', '--as', 'c']), { body: { title: 'Release', release: true }, common: { as: 'c' } });
  });

  test('an unknown flag is refused with the nearest valid one', () => {
    assert.throws(() => agentArgs('submit', ['12', 'Done', '--headlin', 'x']), /submit has no flag --headlin: did you mean --headline\?/);
    assert.throws(() => agentArgs('refine', ['12', '--depends', '#3']), /did you mean --depends-on\?/);
    assert.throws(() => agentArgs('look', ['--zzzzzzzz']), (e) => /look has no flag --zzzzzzzz$/.test(e.message));
  });

  test('a missing required argument names it', () => {
    assert.throws(() => agentArgs('submit', ['12']), /missing <headline>/);
    assert.throws(() => agentArgs('retire', ['31']), /missing --reason/);
    assert.throws(() => agentArgs('answer', []), /missing <question-id>/);
  });

  test('the guide names only operations in OPS', () => {
    const names = new Set(OPS.map((o) => o.name));
    for (const via of ['tools', 'cli']) {
      const g = guide({ via, command: 'nuworq' });
      for (const m of g.matchAll(/`nuworq ([a-z]+)`/g)) assert.ok(names.has(m[1]), m[1]);
    }
    assert.ok(guide({ via: 'cli' }).includes('`nuworq learn`'));
  });
});

describe('the hub refuses a field an operation does not take (#521)', () => {
  test('unknownField finds the typo and its nearest field; the hub\'s own extras pass', () => {
    assert.deepEqual(unknownField('submit', { item: '#1', headlin: 'x' }), { field: 'headlin', near: 'headline' });
    assert.equal(unknownField('checkin', { role: 'worker', runner: 'mac', has: [] }), null);
    assert.equal(unknownField('retire', { note: 3, reason: 'r' }), null);
    assert.equal(unknownField('usage', { usage: {} }), null);
  });

  test('submit with a misspelled headline says which field, not only that headline is required', () => {
    const hub = new Hub();
    hub.agentOp('acme', 'checkin', 'a', {});
    hub.agentOp('acme', 'propose', 'a', { title: 'X', acceptance: 'y' });
    assert.throws(() => hub.agentOp('acme', 'submit', 'a', { item: '#1', headlin: 'Done' }), /submit has no field "headlin": did you mean "headline"\?/);
    assert.throws(() => hub.agentOp('acme', 'refine', 'a', { item: '#1', parnet: '#2' }), /did you mean "parent"\?/);
  });
});

describe('nuworq learn, end to end (#521)', () => {
  test('leaves a field note through the CLI', async () => {
    const hub = new Hub();
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const home = mkdtempSync(join(tmpdir(), 'nuworq-learn-'));
    const env = { ...process.env, HOME: home, NUWORQ_NO_UPDATE: '1', NUWORQ_TOKEN: '', NUWORQ_AGENT: '', NUWORQ_PROJECT: '' };
    const cli = (...a) => promisify(execFile)(process.execPath, [BIN, ...a, '--url', url, '--project', 'acme', '--as', 'claude-1'], { cwd: home, env });
    try {
      await cli('checkin');
      const { stdout } = await cli('learn', 'npm', 'test', 'needs', 'Node', '24');
      assert.equal(JSON.parse(stdout).ok, true);
      assert.ok(hub.agentOp('acme', 'look', 'claude-1', { notes: 'all' }).field_notes.some((n) => n.note === 'npm test needs Node 24'));
      await assert.rejects(cli('learn', 'x', '--replace', '3'), /learn has no flag --replace: did you mean --replaces\?/);
    } finally {
      server.close();
    }
  });
});
