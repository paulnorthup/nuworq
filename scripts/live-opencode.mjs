// Live test: opencode + a local Ollama model works one nuworq item through MCP, against a throwaway hub
// and a tiny throwaway repo. Nothing touches your real hub or ~/.nuworq.
// usage: node scripts/live-opencode.mjs <ollama-model> [small|big] [minutes] [direct|run]
//   e.g. node scripts/live-opencode.mjs qwen3.8:27b-mtp-q4_K_M big 20
//   run: go through `nuworq run --agent opencode` (own worktree and branch) instead of starting opencode here.
// Needs: opencode on PATH, Ollama running with the model pulled. Results: docs/OPEN-WEIGHT.md.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const [MODEL, SIZE = 'small', MINUTES = '15', VIA = 'direct'] = process.argv.slice(2);
if (!MODEL) { console.error('usage: node scripts/live-opencode.mjs <ollama-model> [small|big] [minutes]'); process.exit(1); }
const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));
const T = mkdtempSync(join(tmpdir(), 'nuworq-ow-'));
const repo = join(T, 'repo');
const U = 'http://127.0.0.1:4798';
mkdirSync(repo);
const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString();
git('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'greet.js'), 'export const greet = (name) => `Hello, ${name}`;\n');
git('add', '.');
git('commit', '-qm', 'init');

// The same MCP setup `nuworq init` prints for opencode, plus a local Ollama provider.
let agent = `opencode-${MODEL.replace(/[^a-z0-9]+/gi, '-')}`;
if (VIA === 'direct') writeFileSync(join(repo, 'opencode.json'), JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  provider: { ollama: { npm: '@ai-sdk/openai-compatible', name: 'Ollama', options: { baseURL: 'http://localhost:11434/v1' }, models: { [MODEL]: { name: MODEL } } } },
  mcp: { nuworq: { type: 'local', command: ['node', BIN, 'mcp'], enabled: true, environment: { NUWORQ_URL: U, NUWORQ_PROJECT: 'demo', NUWORQ_AGENT: agent, NUWORQ_MODEL: MODEL } } },
}, null, 2));

// HOME=T: `nuworq serve` writes ~/.nuworq/hub.json, which would repoint every agent on the machine.
const serve = spawn('node', [BIN, 'serve', '--port', '4798', '--db', join(T, 'hub.db')], { stdio: 'ignore', env: { ...process.env, HOME: T } });
await new Promise((r) => setTimeout(r, 1000));
const H = (a, b) => fetch(`${U}/api/p/demo/human/${a}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: U }, body: JSON.stringify(b) }).then((r) => r.json());
try {
  execFileSync('node', [BIN, 'checkin', '--as', 'setup', '--project', 'demo', '--url', U], { stdio: 'ignore', cwd: repo });
  await H('settings', { mission: 'A tiny greeting library.' });
  await H('create', SIZE === 'big'
    ? { title: 'A tested greeting library: farewell(), greetAll(), and a test suite', acceptance: '1. farewell(name) returns "Goodbye, <name>" (default "world"). 2. greetAll(names) returns one greet() line per name, joined by newlines; empty array gives "". 3. test/greet.test.js uses node:test and covers greet, farewell and greetAll including defaults and empty input. 4. package.json has "test": "node --test" and npm test passes. 5. README.md documents the three functions. Committed.' }
    : { title: 'greet() handles a missing name', acceptance: 'greet() with no argument returns "Hello, world". greet("Ana") still returns "Hello, Ana". Committed.' });

  if (VIA === 'run') {
    await H('settings', { runner: true });
    const out = execFileSync('node', [BIN, 'run', '--url', U, '--agent', 'opencode', '--model', `ollama/${MODEL}`, '--workers', '1', '--max-runs', '1', '--max-minutes', MINUTES, '--poll', '5'],
      { env: { ...process.env, HOME: T }, encoding: 'utf8' });
    console.log(out);
    agent = out.match(/▶ (\S+)/)?.[1] ?? agent;
    const db = new DatabaseSync(join(T, 'hub.db'));
    console.log(`#1 is ${db.prepare('SELECT stage FROM items WHERE seq = 1').get().stage}`);
    for (const e of db.prepare('SELECT actor, type, headline, data FROM events WHERE actor = ? ORDER BY id').all(agent)) console.log(`  ${e.type}: ${e.headline}${e.data !== '{}' ? `  ${e.data}` : ''}`);
    const wt = `${repo}.worktrees/${agent}`;
    console.log(`\nworktree ${wt}:\n${execFileSync('git', ['-C', wt, 'log', '--oneline', 'main..HEAD'], { encoding: 'utf8' })}${execFileSync('git', ['-C', wt, 'status', '--short'], { encoding: 'utf8' }) || '(clean)\n'}`);
  } else {
  const task = 'Work on the demo project using nuworq. Do the work in this directory. Commit your work with git, and include the commit in your evidence when you submit. Keep going until next says there is nothing left for you, then sign off.';
  const log = join(T, 'opencode.log');
  console.log(`dir ${T}\nagent ${agent}\nlog ${log}`);
  // opencode run waits on a non-TTY stdin, and takes its project folder from $PWD, not the cwd.
  const oc = spawn('opencode', ['run', '-m', `ollama/${MODEL}`, '--print-logs', task], { cwd: repo, env: { ...process.env, PWD: repo }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = createWriteStream(log);
  oc.stdout.pipe(out);
  oc.stderr.pipe(out);
  oc.stdout.on('data', (d) => process.stdout.write(d));
  const timer = setTimeout(() => { console.log(`\n[timeout after ${MINUTES}m]`); oc.kill('SIGTERM'); }, Number(MINUTES) * 60_000);
  const code = await new Promise((r) => oc.on('exit', r));
  clearTimeout(timer);

  const db = new DatabaseSync(join(T, 'hub.db'));
  console.log(`\n[opencode exited ${code}]  #1 is ${db.prepare('SELECT stage FROM items WHERE seq = 1').get().stage}`);
  for (const e of db.prepare('SELECT actor, type, headline, data FROM events WHERE actor = ? ORDER BY id').all(agent)) console.log(`  ${e.type}: ${e.headline}${e.data !== '{}' ? `  ${e.data}` : ''}`);
  console.log(`\nrepo:\n${git('log', '--oneline')}${git('status', '--short')}`);
  }
} finally {
  serve.kill();
}
