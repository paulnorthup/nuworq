import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// One word, one meaning (#707, found by #696): release is a version, review is the peer verdict, a comment is for
// the record and a field note is an agent's lesson, landed is on main, submitted is waiting to be verified, and a
// person's guidance is a steer. What people and agents read (web/, the hub's messages, the tool descriptions) says so.
const dir = (d) => readdirSync(new URL(`../${d}/`, import.meta.url), { recursive: true }).filter((f) => /\.(js|html)$/.test(f)).map((f) => `${d}/${f}`);
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
// Code, not its comments.
const code = (l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l.split(/\s\/\/\s/)[0]);
const OLD = [
  [/Release an item/, 'handoff hands off; release means a version'],
  [/field-notes review|Review (\$\{p\.name\}'s|these) field notes|reviewed the field notes/i, 'a field-notes tidy'],
  [/security reviews?\b/i, 'a security audit'],
  [/>Note</, 'Comment, as `nuworq comment`'],
  [/\bnote: 'Note'/, 'Comment'],
  [/Keep as a note\b/, 'Keep as a field note'],
  [/leave a note\b/, 'leave a comment'],
  [/'Noted'/, 'Comment added'],
  [/Recently finished/, 'Recently landed'],
  [/finished in 14 days|finished more than|Nothing finished|recently finished|taken or finished|shaped or finished/i, 'landed'],
  [/finished it \$\{/, 'submitted it'],
  [/\bnudges\b/, 'steers'],
  [/Nothing to review/, 'Nothing to verify'],
  [/is reviewing\b(?! #)/, 'is verifying'], // an agent's own `review` holds the item: "x is reviewing #N" stays
  [/>Review it</, 'Verify it'],
  [/direction: 'Direction'/, "a card label that isn't memory's Direction today"],
];
const hits = (f) => read(f).split('\n').map(code).flatMap((l, i) => OLD.filter(([re]) => re.test(l)).map(([, use]) => `${f}:${i + 1}: say ${use}: ${l.trim().slice(0, 120)}`));

test('web/ and the hub\'s words use each term one way', () => {
  assert.deepEqual([...dir('web'), 'src/protocol.js', 'src/core.js', 'src/insight.js', 'src/security.js', 'src/fieldnotes.js'].flatMap(hits), []);
});

test('the reference and the skills follow', () => {
  for (const f of ['docs/CLI.md', 'plugin/skills/nuworq/SKILL.md']) assert.doesNotMatch(read(f), /Release an item|field-notes review/i, f);
  assert.match(read('docs/CLI.md'), /nuworq handoff: hand off an item you hold unfinished/);
});
