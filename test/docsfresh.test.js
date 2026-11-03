import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { COMMANDS } from '../src/help.js';
import { OPS } from '../src/protocol.js';
import { cliContract, stale } from './stale.js';

// README, CONTRIBUTING, SECURITY and docs/*.md name only commands and flags nuworq has (#685), as the guide does
// (#384). A command is a `nuworq …` (or `node bin/nuworq.js …`) in inline code or on a line of a code block;
// what a command prints is quoted "like this", never in code. docs/CLI.md is the help itself (test/help.test.js),
// CHANGELOG.md is history, and docs/audit/ and docs/evals/ are records of their day. Bold in these files is
// emphasis or other sites' labels, so labels are checked only in the guide.
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
export const DOCS = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md',
  ...readdirSync(new URL('../docs/', import.meta.url)).filter((f) => f.endsWith('.md') && f !== 'CLI.md').map((f) => `docs/${f}`)];

// The `nuworq …` commands a markdown file names, each cut at a pipe, && or ; and at a # comment.
export function docCommands(text) {
  const out = new Set();
  const add = (s) => {
    for (const part of s.split(/&&|\|\||[;|]/)) {
      const c = part.replace(/(^|\s)#.*$/, '').trim().replace(/^\$\s+/, '').replace(/^node bin\/nuworq\.js\b/, 'nuworq');
      if (/^nuworq\s+[a-z]/.test(c)) out.add(c);
    }
  };
  for (const m of text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)) m[1].split('\n').forEach(add);
  for (const m of text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, '').matchAll(/`([^`\n]+)`/g)) add(m[1]);
  return [...out];
}

describe('README and docs/ name only commands and flags nuworq has (#685)', () => {
  let cli;
  before(() => { cli = cliContract(COMMANDS); });

  test('it reads code spans and code blocks, in both forms', () => {
    const text = 'Run `nuworq up`, or `node bin/nuworq.js serve --demo`.\n\n```bash\n$ nuworq run --workers 3 # three\ngit pull && nuworq update\n```\nIt prints "nuworq updated 1 → 2".';
    assert.deepEqual(docCommands(text).sort(), ['nuworq run --workers 3', 'nuworq serve --demo', 'nuworq up', 'nuworq update']);
    assert.ok(DOCS.includes('README.md') && DOCS.includes('docs/USAGE.md') && !DOCS.includes('docs/CLI.md'));
  });

  test('every command and flag they name is in the help', () => {
    assert.deepEqual(DOCS.flatMap((f) => stale({ commands: docCommands(read(f)) }, { cli }).map((o) => `${f}: ${o}`)), []);
  });

  test('ARCHITECTURE.md names every source file, every operation and every Needs you signal', () => {
    const doc = read('docs/ARCHITECTURE.md');
    const files = readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.js'));
    assert.deepEqual(files.filter((f) => !doc.includes(`src/${f}`)), [], 'src files missing from the architecture');
    assert.match(doc, new RegExp(`## The agent protocol \\(${OPS.length} operations\\)`));
    assert.deepEqual(OPS.map((o) => o.name).filter((n) => !doc.includes(`\`${n}\``)), [], 'operations missing');
    const kinds = [...new Set([...read('src/insight.js').matchAll(/level: [^,]+, kind: '([a-z-]+)'/g)].map((m) => m[1]))];
    assert.ok(kinds.includes('direction') && kinds.includes('notify-failing'), 'it reads the kinds');
    assert.deepEqual(kinds.filter((k) => !doc.includes(`\`${k}\``)), [], 'Needs you signals missing from the attention table');
  });

  test('a flag the help lacks fails, naming the file', () => {
    const f = 'docs/USAGE.md';
    const out = stale({ commands: docCommands(`${read(f)}\nRun \`nuworq operator --detcet\`.`) }, { cli });
    assert.deepEqual(out, ['flag --detcet (in `nuworq operator --detcet`) isn\'t a flag of nuworq operator']);
  });
});
