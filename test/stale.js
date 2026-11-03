// What the guide (#384) and the docs (#685) name that nuworq doesn't have: test/guidefresh.test.js and
// test/docsfresh.test.js share it.

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

// What's named that nuworq doesn't have, one line each; [] when it all holds.
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
