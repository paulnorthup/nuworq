import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// People see "workspace", never "organization", for the top level: projects live within a workspace (#159).
const dir = (d) => readdirSync(new URL(`../${d}/`, import.meta.url), { recursive: d === 'web' }).filter((f) => /\.\w+$/.test(f)).map((f) => `${d}/${f}`);
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const hits = (f, lines) => lines.flatMap((l, i) => (/organi[sz]ation/i.test(l) ? [`${f}:${i + 1}: ${l.trim()}`] : []));

test('nothing in web/ says "organization"', () => {
  assert.deepEqual(dir('web').flatMap((f) => hits(f, read(f).split('\n'))), []);
});

// Server code: its messages (errors, hints, labels) but not its comments. GitHub's own organizations,
// as on the host's app-creation page and its URL, are a different thing and keep their name, as does the
// "Organization permissions" section of GitHub's app settings page (#478).
const code = (l) => (/^\s*(\/\/|--|\*|\/\*)/.test(l) ? '' : l.split(/\s(?:\/\/|--)\s/)[0])
  .replace(/GitHub organization/g, '').replace(/organizations\/\$\{/g, '').replace(/"Organization permissions"/g, '');
test('no server message says "organization"', () => {
  assert.deepEqual(dir('src').filter((f) => f.endsWith('.js')).flatMap((f) => hits(f, read(f).split('\n').map(code))), []);
});

// The CLI too (#217): its help and its errors, not its comments.
test('nothing the CLI prints says "organization"', () => {
  assert.deepEqual(dir('bin').filter((f) => f.endsWith('.js')).flatMap((f) => hits(f, read(f).split('\n').map(code))), []);
  const help = execFileSync(process.execPath, [fileURLToPath(new URL('../bin/nuworq.js', import.meta.url)), 'help', 'all'], { encoding: 'utf8' });
  assert.match(help, /--workspace-cap <n> +workspaces one signed-in person may create/);
  assert.deepEqual(hits('nuworq help', help.split('\n')), []);
});
