import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mentions } from '../src/userguide.js';
import { COMMANDS } from '../src/help.js';

// The guide never names what nuworq no longer has (#384): every `nuworq …` command and flag is in the CLI's help,
// every **label** is in a web/ file, and every /path is a page src/server.js serves. The marks are documented at
// the top of src/userguide.js.
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
// Flags every agent command takes (the help's Agents heading and its Text flags line).
const GLOBAL = ['--as', '--project', '--url', '--summary', '--detail', '--help'];

// The help's table (#481), as each command's flags: those in its usage lines and its Flags.
export function cliContract(commands) {
  const cmds = new Map();
  for (const c of commands) {
    const text = [...c.usage, ...(c.flags ?? []).map(([f]) => f)].join(' ');
    cmds.set(c.name, new Set([...text.matchAll(/--[a-z][\w-]*/g)].map((m) => m[0])));
  }
  return cmds;
}

// What the guide names that nuworq doesn't have, one line each; [] when it all holds.
export function stale({ commands = [], labels = [], paths = [] }, { cli, webText, served }) {
  const out = [];
  const anyFlag = new Set([...cli.values()].flatMap((s) => [...s]));
  for (const c of commands) {
    const words = c.split(/\s+/);
    if (words[0] === 'nuworq') {
      const cmd = words[1];
      if (!cli.has(cmd)) { out.push(`command "nuworq ${cmd}" (in \`${c}\`) isn't in nuworq help`); continue; }
      for (const f of c.matchAll(/(?:^|\s)(--[a-z][\w-]*)/g)) {
        if (!cli.get(cmd).has(f[1]) && !GLOBAL.includes(f[1])) out.push(`flag ${f[1]} (in \`${c}\`) isn't a flag of nuworq ${cmd}`);
      }
    } else if (/^--[a-z][\w-]*$/.test(c) && !anyFlag.has(c)) {
      out.push(`flag ${c} isn't in nuworq help`);
    }
  }
  // A label built from a template ("Sign in with ${p.label}") counts by its fixed words: all but its last word.
  const templated = (l) => { const head = l.split(' ').slice(0, -1); return head.length >= 2 && webText.includes(`${head.join(' ')} \${`); };
  for (const l of labels) if (!webText.includes(l) && !templated(l)) out.push(`label **${l}** isn't in any web/ file`);
  for (const p of paths) if (!served(p)) out.push(`page ${p} isn't served by src/server.js`);
  return out;
}

describe('the getting-started guide names only what nuworq has (#384)', () => {
  let cli, webText, served;
  before(async () => {
    cli = cliContract(COMMANDS);
    // The web app's text, and Get started's button labels, which the hub sends to web/getstarted.js to draw.
    webText = [...readdirSync(new URL('../web/', import.meta.url), { recursive: true }).filter((f) => /\.(js|html)$/.test(f)).map((f) => `web/${f}`), 'src/getstarted.js'].map(read).join('\n');
    const server = read('src/server.js');
    served = (p) => server.includes(`'${p}'`) || server.includes(`"${p}"`) || server.includes(`\`${p}\``);
  });

  test('the help parses into commands with their flags', () => {
    assert.ok(cli.get('run').has('--max-usd') && cli.get('run').has('--install'), 'run, both its lines');
    assert.ok(cli.get('connect').has('--no-mcp'));
    assert.ok(cli.get('propose').has('--acceptance') && cli.get('propose').has('--needs'), 'a continued line counts');
    assert.ok(!cli.get('checkin').has('--max-usd'), 'flags stay with their command');
  });

  test('every command, flag, label and page in the guide exists', () => {
    const m = mentions();
    assert.ok(m.commands.length && m.labels.length && m.paths.includes('/early-access'), 'the guide names some of each');
    assert.deepEqual(stale(m, { cli, webText, served }), []);
  });

  test('a renamed flag, an unknown command, a missing label or page each fail, naming it', () => {
    const m = mentions();
    const renamed = { ...m, commands: m.commands.map((c) => (c === 'nuworq run --install' ? 'nuworq run --instal' : c)) };
    assert.deepEqual(stale(renamed, { cli, webText, served }), ['flag --instal (in `nuworq run --instal`) isn\'t a flag of nuworq run']);
    assert.deepEqual(stale({ commands: ['nuworq lanch --run'] }, { cli, webText, served }), ['command "nuworq lanch" (in `nuworq lanch --run`) isn\'t in nuworq help']);
    assert.deepEqual(stale({ commands: ['--no-mpc'] }, { cli, webText, served }), ['flag --no-mpc isn\'t in nuworq help']);
    assert.deepEqual(stale({ labels: ['Staff it with nuworq walk'] }, { cli, webText, served }), ['label **Staff it with nuworq walk** isn\'t in any web/ file']);
    assert.deepEqual(stale({ paths: ['/early-acess'] }, { cli, webText, served }), ['page /early-acess isn\'t served by src/server.js']);
  });
});
