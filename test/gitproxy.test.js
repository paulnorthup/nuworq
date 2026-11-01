import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readCommands, refusedRef, refusal } from '../src/gitproxy.js';

// The ref updates at the head of a push (#472), as git sends them: pkt-lines, capabilities after a NUL on the first.
const pkt = (s) => `${(Buffer.byteLength(s) + 4).toString(16).padStart(4, '0')}${s}`;
const A = 'a'.repeat(40), B = 'b'.repeat(40), Z = '0'.repeat(40);

describe('the hub reads a push before passing it on', () => {
  test('commands and capabilities, only once they are all there', () => {
    const head = pkt(`${A} ${B} refs/heads/nuworq/1-x\0report-status side-band-64k agent=git/2\n`) + pkt(`${Z} ${B} refs/heads/main\n`) + '0000';
    const buf = Buffer.concat([Buffer.from(head), Buffer.from('PACK...')]);
    for (let n = 0; n < head.length; n++) assert.equal(readCommands(buf.subarray(0, n)), null, `${n} bytes are not enough`);
    const r = readCommands(buf);
    assert.deepEqual(r.cmds, [{ old: A, new: B, ref: 'refs/heads/nuworq/1-x' }, { old: Z, new: B, ref: 'refs/heads/main' }]);
    assert.deepEqual(r.caps, ['report-status', 'side-band-64k', 'agent=git/2']);
    assert.equal(r.end, head.length, 'the pack starts after the flush');
    assert.deepEqual(readCommands(Buffer.from('0000')).cmds, [], "git's empty probe before a large push");
    assert.throws(() => readCommands(Buffer.from(pkt('push-cert\0report-status\n'))), /signed pushes/);
    assert.throws(() => readCommands(Buffer.from(pkt('hello\n'))), /not a git push/);
  });

  test('only nuworq/ branches, and no deletions', () => {
    assert.equal(refusedRef({ new: B, ref: 'refs/heads/nuworq/12-fix' }), '');
    assert.match(refusedRef({ new: B, ref: 'refs/heads/main' }), /never push main/);
    assert.match(refusedRef({ new: B, ref: 'refs/tags/v1.0.0' }), /only refs\/heads\/nuworq\/\*/);
    assert.match(refusedRef({ new: B, ref: 'refs/heads/nuworqx' }), /only refs\/heads\/nuworq\/\*/);
    assert.match(refusedRef({ new: Z, ref: 'refs/heads/nuworq/12-fix' }), /never delete/);
  });

  test('a refusal git understands: each ref rejected with its reason, in the side band when asked', () => {
    const cmds = [{ ref: 'refs/heads/main' }, { ref: 'refs/heads/nuworq/1-x' }];
    const plain = refusal(cmds, ['no main', ''], ['report-status'], 'nuworq: no main.').toString();
    assert.equal(plain, `${pkt('unpack ok\n')}${pkt('ng refs/heads/main no main\n')}${pkt('ng refs/heads/nuworq/1-x refused with the others in this push\n')}0000`);
    const banded = refusal(cmds, ['no main', ''], ['report-status', 'side-band-64k'], 'nuworq: no main.').toString('latin1');
    assert.ok(banded.startsWith(pkt('\x02nuworq: no main.\n')), 'the reason as a remote: line');
    assert.ok(banded.endsWith('0000'));
    assert.ok(banded.includes(`\x01${pkt('unpack ok\n')}`));
  });
});
