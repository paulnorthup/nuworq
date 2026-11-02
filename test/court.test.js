import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DOT, dotClass } from '../web/timeline.js';
import { appSource } from './appsource.js';

const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
const app = appSource();

// Every event type the hub records: the type literals inside each hub.event(...) / this.event(...) call in src/.
function eventTypes() {
  const types = new Set();
  const dir = new URL('../src/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/\.event\(/g)) {
      let depth = 1, k = m.index + m[0].length;
      while (depth && k < src.length) { const c = src[k++]; if (c === '(') depth++; else if (c === ')') depth--; }
      for (const t of src.slice(m.index, k).matchAll(/type: (?:[^,{}]*\? )?'([a-z_]+)'(?: : '([a-z_]+)')?/g)) {
        types.add(t[1]); if (t[2]) types.add(t[2]);
      }
    }
  }
  return types;
}

// Whose move it is has one color everywhere (#194).
describe('whose move it is has one color everywhere', () => {
  test('every event type the hub records has a timeline dot, and a new one without fails', () => {
    const types = eventTypes();
    assert.ok(types.size > 40, `found ${types.size} event types`);
    const missing = [...types].filter((t) => !(t in DOT));
    assert.deepEqual(missing, [], `add these to DOT in web/timeline.js: ${missing.join(', ')}`);
  });

  test("a dot takes the court the item is in after the event", () => {
    const court = (s) => ({ verifying: 'you', proposed: null })[s];
    const full = (s) => ({ verifying: 'agents', proposed: null })[s];
    for (const t of ['claimed', 'progress', 'landing', 'accepted']) assert.equal(dotClass(t, court), 'c-agents', t);
    assert.equal(dotClass('question', court), 'c-you');
    for (const t of ['answered', 'sent_back', 'handoff']) assert.equal(dotClass(t, court), 'c-queue', t);
    assert.equal(dotClass('submitted', court), 'c-you', 'verifying is yours');
    assert.equal(dotClass('submitted', full), 'c-agents', 'under full autonomy agents verify');
    assert.equal(dotClass('landed', court), 'c-ok');
    assert.equal(dotClass('lease_expired', court), 'c-warn');
    for (const t of ['pr_failed', 'pr_merge_failed']) assert.equal(dotClass(t, court), 'c-bad', t);
    assert.equal(dotClass('comment', court), '', 'a note changes nobody\'s move');
  });

  test('the dots use the same tokens as the lifecycle bar, and the old per-type rules are gone', () => {
    for (const c of ['agents', 'queue', 'you', 'external']) {
      assert.match(css, new RegExp(`\\.tl\\.c-${c}::before \\{ background: var\\(--${c === 'external' ? 'hatch' : c}\\); \\}`), c);
    }
    assert.match(css, /\.tl\.c-ok::before \{ background: var\(--ok\); \}/);
    assert.match(css, /\.tl\.c-warn::before \{ background: var\(--warn\); \}/);
    assert.match(css, /\.tl\.c-bad::before \{ background: var\(--bad\); \}/);
    assert.doesNotMatch(css, /\.tl\.t-/, 'dots follow the court, not the event type');
    assert.match(app, /class="tl t-\$\{e\.type\} \$\{dotClass\(e\.type, courtOf\)\}"/);
  });

  test('each court is one token in the Flow tile, stage pill, courtbar, legend and lifecycle bar', () => {
    for (const [c, tok] of [['agents', 'agents'], ['you', 'you']]) {
      assert.match(css, new RegExp(`\\.stage\\.court-${c} \\{ background: var\\(--${tok}-tint\\); \\}`));
      assert.match(css, new RegExp(`\\.stage-pill\\.court-${c} \\{[^}]*color: var\\(--${tok}\\)`));
    }
    assert.match(css, /\.stage\.court-queue \.n \{ color: var\(--queue\); \}/);
    assert.match(css, /\.stage-pill\.court-queue \{[^}]*var\(--queue\)/, 'outlined in --queue; its text stays --muted to stay readable at 11px');
    assert.match(css, /\.seg-c\.agents, i\.agents, \.lifebar \.agents \{ background: var\(--agents\); \}/);
    assert.match(css, /\.seg-c\.queue, i\.queue, \.lifebar \.queue \{ background: var\(--queue\); \}/);
    assert.match(css, /\.seg-c\.you, i\.you, \.lifebar \.you \{ background: var\(--you\); \}/);
  });

  test('Outside is hatched, not another grey: tile, pill, courtbar, legend and lifecycle bar', () => {
    assert.match(css, /--hatch: repeating-linear-gradient\(/);
    assert.match(css, /\.seg-c\.external, i\.external, \.lifebar \.external \{ background: var\(--hatch\); \}/);
    assert.match(css, /\.stage\.court-external \{ background: var\(--hatch-tint\);/);
    assert.match(css, /\.stage-pill\.court-external \{ background: var\(--hatch-tint\);/);
  });

  test('the unused .lifebar .none rule is gone', () => {
    assert.doesNotMatch(css, /\.lifebar \.none/);
  });
});
