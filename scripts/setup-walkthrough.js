#!/usr/bin/env node
// The newcomer's setup, measured (#492): from a signed-in workspace with a project to the three sessions (workers,
// an operator, a shaper), counted and timed against docs/evals/setup.md's targets. A throwaway hub with login
// required, a fresh HOME, and the real `nuworq connect`, run as at a terminal so it asks as it asks a person.
// The answers are a newcomer's: the plugin yes, staffing no (a yes installs a real background
// service on this machine), the operator yes. The browser approval is the same HTTP call the device page makes,
// and `claude` is a stand-in that records what connect asked of it. Nothing on this machine changes.
// Prints one line per step, the totals, and each target met or not; exits 1 when one isn't.
//   node scripts/setup-walkthrough.js
// Not walked here, rerun by hand (docs/evals/setup.md): installing the package, the plugin from GitHub, the
// staffing service, a real operator and the shaper in the Claude Code app.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Hub } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nuworq.js');
const dir = mkdtempSync(join(tmpdir(), 'nuworq-setup-walk-'));
const home = join(dir, 'home'), origin = join(dir, 'origin.git'), work = join(home, 'src', 'demo'), bin = join(dir, 'bin');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The project's repository, and the newcomer's clone of it in their fresh HOME.
mkdirSync(dirname(work), { recursive: true });
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
for (const [k, v] of [['user.name', 'Walkthrough'], ['user.email', 'walk@example.com'], ['commit.gpgsign', 'false']]) git(work, 'config', k, v);
writeFileSync(join(work, 'README.md'), '# demo\n');
git(work, 'add', '.'); git(work, 'commit', '-qm', 'start'); git(work, 'push', '-q', 'origin', 'main');

// claude, as connect calls it: it records each call and answers as an installed Claude Code does.
const calls = join(dir, 'claude-calls');
mkdirSync(bin);
const installed = JSON.stringify({ version: 2, plugins: { 'nuworq@nuworq': [{ scope: 'user' }] } });
writeFileSync(join(bin, 'claude'), `#!/bin/sh
echo "$*" >> ${JSON.stringify(calls)}
[ "$2" = get ] && exit 1
[ "$1" = --help ] && echo "Usage: claude [options] [command] [prompt]"
if [ "$1 $2 $3" = "plugin install nuworq@nuworq" ]; then mkdir -p "$HOME/.claude/plugins"; echo '${installed}' > "$HOME/.claude/plugins/installed_plugins.json"; fi
exit 0
`);
chmodSync(join(bin, 'claude'), 0o755);

// The hub: login required, an owner with project Demo, and the newcomer joined through an invite.
const hub = new Hub({ file: join(dir, 'hub.db'), repos: join(dir, 'mirrors') });
const auth = new Auth(hub.db);
auth.addPerson('paul', 'owner');
const ownerToken = auth.createToken('paul-cli', 'human', { person: 'paul' });
const server = createServer(hub, { auth: 'required', sweepMs: 1_000 });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
let cookie = '';
async function http(method, path, body, { token } = {}) {
  const headers = { origin: url, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : cookie ? { cookie } : {}) };
  const r = await fetch(url + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(json)}`);
  return json;
}

// A command typed at a terminal, answered as its prompts appear. The CLI runs as it does for a person at one:
// stdin and stdout say they are terminals, so connect asks rather than answering no for them. Its prompts go to
// stderr, a plain pipe here, so readline reads answers line by line.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NUWORQ_')));
// A newcomer's PATH: claude and node, and none of this machine's nuworq, pi or other tools.
Object.assign(env, { HOME: home, NO_COLOR: '1', PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':') });
const atTerminal = (args) => ['--input-type=module', '-e',
  `process.stdin.isTTY = true; process.stdout.isTTY = true; process.argv = [process.argv[0], ${JSON.stringify(BIN)}, ...${JSON.stringify(args)}]; await import(${JSON.stringify(pathToFileURL(BIN).href)});`];
const PROMPT = /(\[y\/N\]|\[Y\/n\]|\[[\d.]+\]:|\[1-\d+, Enter for none\]:) *$/;
function terminal(args, { answer, onOutput }) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, atTerminal(args), { cwd: work, env });
    let out = '', asked = 0;
    const prompts = [];
    const look = () => {
      const text = out.replace(/\r/g, '');
      onOutput?.(text);
      const lines = text.split('\n');
      const last = lines.at(-1);
      if (PROMPT.test(last) && prompts.length === asked) {
        prompts.push(last.trim());
        const reply = answer(last);
        asked++;
        p.stdin.write(`${reply}\n`);
      }
    };
    p.stdout.on('data', (d) => { out += d; look(); });
    p.stderr.on('data', (d) => { out += d; look(); });
    p.on('close', (code) => (code === 0 ? resolve({ out: out.replace(/\r/g, ''), prompts }) : reject(new Error(`nuworq ${args.join(' ')} exited ${code}:\n${out}`))));
  });
}

const steps = [];
async function step(name, place, counts, fn) {
  const start = performance.now();
  const note = await fn();
  // counts() may give secs measured elsewhere, for steps that happen inside one command.
  const s = { name, place, secs: (performance.now() - start) / 1000, typed: 0, pastes: 0, copied: 0, yesno: 0, other: 0, approvals: 0, app: 0, switches: 0, ...counts(), note: note ?? '' };
  steps.push(s);
  const tally = Object.entries(s).filter(([k, v]) => !['name', 'place', 'secs', 'note'].includes(k) && v).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`${String(steps.length).padStart(2)}. ${name} [${place}] (${s.secs.toFixed(1)}s)${tally ? ` ${tally}` : ''}${note ? `\n    ${note}` : ''}`);
}

let connectResult;
try {
  await http('POST', '/api/projects', { name: 'Demo', remote: origin, mission: 'A setup walk' }, { token: ownerToken });
  const invite = await http('POST', '/api/invites', { role: 'steward' }, { token: ownerToken });
  await http('POST', '/api/invite/accept', { token: invite.link.split('#')[1], handle: 'newcomer' });
  console.log(`From a signed-in workspace (@newcomer, steward) with a project (Demo), on ${url}:\n`);

  await step('Connect an agent: copy the first block, paste it in the clone', 'hub page → terminal', () => ({ copied: 1, pastes: 1, typed: 1 }), async () =>
    `npm install -g ${url}/nuworq.tgz && nuworq connect ${url} (the install isn't run here: the walk runs this checkout's CLI)`);

  // connect: the device approval in the browser, then its questions.
  let approved = null, firstPrompt = null;
  const started = performance.now();
  connectResult = await terminal(['connect', url, '--no-browser'], {
    answer: (prompt) => {
      firstPrompt ??= performance.now();
      if (/plugin/i.test(prompt)) return 'y';
      if (/Staff /.test(prompt)) return 'n';
      if (/operator/i.test(prompt)) return 'y';
      return '';
    },
    onOutput: (text) => {
      const code = text.match(/approve the code (\S+)/)?.[1];
      if (code && !approved) { approved = performance.now(); http('POST', '/api/device/approve', { user_code: code, approve: true }).catch((e) => console.error(e)); }
    },
  });
  const said = connectResult.out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (process.argv.includes('--verbose')) console.log(`${connectResult.out}\n`);
  const ended = performance.now();
  await step('Approve this machine', 'browser (device page)', () => ({ approvals: 1, secs: (firstPrompt - started) / 1000 }), async () =>
    `the code shows ${((approved - started) / 1000).toFixed(1)}s after the paste; the walk approves it at once, and connect sees it at its next poll`);
  const yesno = connectResult.prompts.filter((p) => /\[[yY]\/[nN]\]$/.test(p));
  const other = connectResult.prompts.filter((p) => !/\[[yY]\/[nN]\]$/.test(p));
  await step("Answer connect's questions", 'terminal', () => ({ yesno: yesno.length, other: other.length, secs: (ended - firstPrompt) / 1000 }), async () =>
    connectResult.prompts.map((p, i) => `Q${i + 1}: ${p.length > 110 ? `${p.slice(0, 60)}…${p.slice(-40)}` : p}`).join('\n    '));
  // A prompt's answer isn't echoed, so what connect says next follows it on the same line.
  const slash = connectResult.out.match(/Last, to plan work with a shaper: .* type (\/nuworq[:-]shaper)/)?.[1];
  await step('Start a shaper: type one line in the Claude Code app', 'Claude Code app', () => ({ app: slash ? 1 : 0 }), async () => (slash ? `connect says: ${slash}` : `connect said no shaper line: ${said.slice(-3).join(' | ')}`));
  const ran = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
  await step('What connect set up (claude calls)', 'terminal', () => ({}), async () => ran.map((c) => (c.length > 70 ? `${c.slice(0, 40)}…${c.slice(-25)}` : c)).join('; ') || 'none');

  // The totals, and the targets (docs/evals/setup.md), from a signed-in workspace with a project.
  const sum = (k) => steps.reduce((n, s) => n + s[k], 0);
  const places = [...new Set(steps.flatMap((s) => s.place.split(' → ')))];
  const total = { copied: sum('copied'), pastes: sum('pastes'), typed: sum('typed'), yesno: sum('yesno'), other: sum('other'), approvals: sum('approvals'), app: sum('app'), switches: sum('switches') };
  console.log(`\nTotal: ${steps.reduce((n, s) => n + s.secs, 0).toFixed(1)}s; ${total.copied} copied block, ${total.pastes} paste, ${total.typed} command typed, ${total.yesno} yes/no and ${total.other} other answers, ${total.approvals} browser approval, ${total.app} line in the Claude Code app, ${total.switches} settings switches; ${places.length} places (${places.join(', ')}).`);
  const targets = [
    ['1 copied block', total.copied === 1],
    ['at most 3 yes/no answers', total.yesno <= 3],
    ['1 browser approval', total.approvals === 1],
    ['1 line typed in the Claude Code app', total.app === 1],
    ['no settings switch', total.switches === 0],
  ];
  for (const [t, ok] of targets) console.log(`  ${ok ? 'met' : 'NOT MET'}: ${t}`);
  console.log("  by hand: every step's words match the guide (docs/evals/setup.md)");
  if (targets.some(([, ok]) => !ok)) process.exitCode = 1;
} finally {
  server.close();
  hub.close?.();
  rmSync(dir, { recursive: true, force: true });
}
