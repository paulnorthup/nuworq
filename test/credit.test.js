import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hub } from '../src/core.js';
import { view } from '../src/insight.js';
import { credit } from '../web/credit.js';
import { appSource } from './appsource.js';

const who = (n) => `<b>${n}</b>`;

// #145: "Recently finished" says only what's on record: no "built by" with no name after it.
describe('who built and verified a finished item', () => {
  test('nobody on record: nothing at all; a builder, a verifier or both: just those', () => {
    assert.equal(credit({ implementer: null, accepted: null }, who), '');
    assert.equal(credit({ implementer: '', accepted: undefined }, who), '');
    assert.equal(credit({ implementer: 'claude-a1', accepted: null }, who), 'built by <b>claude-a1</b>');
    assert.equal(credit({ implementer: null, accepted: 'you' }, who), 'verified by <b>you</b>');
    assert.equal(credit({ implementer: 'codex-b2', accepted: '@paul' }, who), 'built by <b>codex-b2</b> · verified by <b>@paul</b>');
  });

  test('a person moving an item straight to done (no agent) gets no empty "built by" in the view', () => {
    const hub = new Hub();
    hub.tx(() => hub.project('p', { create: true }));
    hub.humanOp('p', 'create', { title: 'By hand', acceptance: 'x' });
    hub.humanOp('p', 'update', { item: '#1', stage: 'done' });
    hub.humanOp('p', 'create', { title: 'By an agent', acceptance: 'x' });
    hub.agentOp('p', 'claim', 'bot', { item: '#2' });
    hub.agentOp('p', 'submit', 'bot', { item: '#2', headline: 'Built', evidence: [{ label: 'tests pass' }] });
    hub.humanOp('p', 'accept', { item: '#2' });
    const v = view(hub, 'p');
    const line = (ref) => credit(v.done.find((d) => d.item === ref), who);
    assert.doesNotMatch(line('#1'), /built by(?! <b>)/);
    assert.match(line('#2'), /built by <b>bot<\/b>/);
  });

  test('the page uses it in Recently finished and the drawer, with no bare "built by" left', () => {
    const app = appSource();
    assert.doesNotMatch(app, /built by \$\{who/);
    assert.match(app, /credit\(i, who\) \? `<div class="s">\$\{credit\(i, who\)\}<\/div>` : ''/);
  });
});
