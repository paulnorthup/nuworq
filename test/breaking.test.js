import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hub } from '../src/core.js';
import { itemView } from '../src/insight.js';
import { MODE_RULES, OPS } from '../src/protocol.js';

// Items say when they break someone (#398): who must do what once it ships, so the release knows how to bump.
const WHO = 'Machines on Node 24 must upgrade to 26 before `nuworq update`';
function project() {
  const hub = new Hub({ clock: () => Date.UTC(2026, 9, 31, 9) });
  hub.tx(() => hub.project('p', { create: true }));
  hub.humanOp('p', 'settings', { autonomy: 'full' });
  hub.agentOp('p', 'checkin', 'a1', { model: 'opus' });
  return hub;
}

describe('the breaking flag (#398)', () => {
  test('propose sets it; next, look and the drawer show it', () => {
    const hub = project();
    const { item } = hub.agentOp('p', 'propose', 'a1', { title: 'Require Node 26', acceptance: 'engines says 26', breaking: ` ${WHO} ` });
    assert.equal(hub.agentOp('p', 'look', 'a1', { item }).breaking, WHO, 'look, trimmed');
    assert.equal(itemView(hub, 'p', 1).breaking, WHO, 'the drawer');
    assert.equal(hub.agentOp('p', 'next', 'a1', {}).breaking, WHO, 'next');
  });

  test('refine sets and changes it, "" clears it, and an item that breaks nobody shows nothing', () => {
    const hub = project();
    const { item } = hub.agentOp('p', 'propose', 'a1', { title: 'A new flag', acceptance: 'x' });
    assert.equal(hub.agentOp('p', 'look', 'a1', { item }).breaking, undefined);
    assert.equal(itemView(hub, 'p', 1).breaking, null);
    assert.deepEqual(hub.agentOp('p', 'refine', 'a1', { item, breaking: WHO }).changed, [`breaking: ${WHO}`], 'the change is recorded');
    assert.equal(hub.agentOp('p', 'look', 'a1', { item }).breaking, WHO);
    hub.agentOp('p', 'refine', 'a1', { item, breaking: 'Scripts calling `nuworq run --once` must drop the flag' });
    assert.match(hub.agentOp('p', 'look', 'a1', { item }).breaking, /--once/);
    hub.agentOp('p', 'refine', 'a1', { item, breaking: '' });
    assert.equal(hub.agentOp('p', 'look', 'a1', { item }).breaking, undefined, 'cleared');
    hub.agentOp('p', 'refine', 'a1', { item, title: 'A new flag, renamed' });
    assert.equal(hub.agentOp('p', 'look', 'a1', { item }).breaking, undefined, 'a refine without it leaves it as it was');
  });

  test('propose and refine offer it in their schemas', () => {
    for (const name of ['propose', 'refine']) assert.ok(OPS.find((t) => t.name === name).params.breaking, name);
    assert.match(OPS.find((t) => t.name === 'refine').params.breaking.description, /"" clears it/);
  });

  test('the drawer shows who must act when it ships', () => {
    const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    assert.match(app, /it\.breaking \? `<div class="d-sec"><div class="label"><span data-new="breaking">/);
  });
});

describe('the hints say when to set it and that review checks it (#398, #527)', () => {
  test('shape: the API or tools, the CLI, the runtime minimum, or a manual migration; tooling updates are not breaking', () => {
    for (const re of [/Set breaking when/, /API route or tool removed or changed incompatibly/, /CLI command or flag removed/, /runtime minimum raised/, /manual migration/, /who must do what/, /dev tools and a runtime only tested in CI break nobody/]) {
      assert.match(MODE_RULES.shape, re);
    }
  });
  test('review: the reviewer checks the flag is set when it should be, and accurate', () => {
    assert.match(MODE_RULES.review, /Check breaking too/);
    assert.match(MODE_RULES.review, /reject it when missing, wrong, or set on a change that breaks nobody/);
  });
  test('the freshness sweep proposes a breaking upgrade with breaking set', () => {
    assert.match(MODE_RULES.fresh, /Propose each breaking upgrade[^\n]*breaking set to who must do what/);
  });
});
