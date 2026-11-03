import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hub, STAGES } from '../src/core.js';
import { OPS } from '../src/protocol.js';
import { view } from '../src/insight.js';

// #706 (from #696's consistency audit): the lifecycle read differently by place. Done said "Accepted." though landing
// is the accepted stage, look couldn't list landing or dropped, the README skipped stages, a tidy hint said "close"
// (there's no such operation), and next's description named three of its six modes.
const op = (name) => OPS.find((o) => o.name === name);
const readme = readFileSync(new URL('../docs/USAGE.md', import.meta.url), 'utf8'); // the README's usage, since #808
const guide = readFileSync(new URL('../src/protocol.js', import.meta.url), 'utf8') + readFileSync(new URL('../src/tidy.js', import.meta.url), 'utf8');

describe('the lifecycle reads the same everywhere (#706)', () => {
  test("Done means on main, and Flow's tooltip says so", () => {
    assert.match(STAGES.done.blurb, /on main/);
    const hub = new Hub();
    hub.tx(() => hub.project('p', { create: true }));
    assert.match(view(hub, 'p').flow.stages.find((s) => s.stage === 'done').blurb, /on main/);
  });

  test('look lists landing and dropped work by stage', () => {
    const hub = new Hub();
    hub.tx(() => hub.project('p', { create: true }));
    const a = hub.agentOp('p', 'propose', 'w1', { title: 'Landing one', acceptance: 'x' }).item;
    const b = hub.agentOp('p', 'propose', 'w1', { title: 'Dropped one', acceptance: 'x' }).item;
    hub.tx(() => hub.move(hub.item(hub.project('p'), a), 'landing', 'w1', {}));
    hub.humanOp('p', 'update', { item: b, stage: 'dropped' });
    for (const stage of ['landing', 'dropped']) {
      assert.ok(op('look').params.stage.enum.includes(stage), `${stage} is in look's stage list`);
      const board = hub.agentOp('p', 'look', 'w1', { stage }).board;
      assert.equal(board[stage].length, 1, `look stage ${stage}`);
    }
  });

  test("README's lifecycle names every stage", () => {
    const line = readme.split('\n').find((l) => l.startsWith('`proposed →'));
    for (const s of Object.keys(STAGES)) assert.match(line, new RegExp(`\\b${s}\\b`), s);
  });

  test('no hint tells an agent to "close" an item, and next names all six modes', () => {
    assert.doesNotMatch(guide, /close it\.|close finished/);
    for (const mode of ['work', 'shape', 'review', 'land', 'tidy', 'question to answer']) assert.match(op('next').description, new RegExp(mode), mode);
  });
});
