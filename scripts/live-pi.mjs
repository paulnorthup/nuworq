// Live test: pi + a local Ollama model works one nuworq item through MCP, against a throwaway hub and a tiny
// throwaway repo. Nothing touches your real hub, ~/.nuworq or ~/.pi/agent: pi's config is a folder in the temp dir.
// usage: node scripts/live-pi.mjs <ollama-model> [small|big] [minutes] [direct|run]
//   e.g. node scripts/live-pi.mjs qwen3.8:27b-mtp-q4_K_M big 20
//   direct: pi started here, registered the way `nuworq connect` does it (pi mcp add nuworq --exposure direct).
//   run: through `nuworq run --agent pi` (its own worktree, config folder and branch).
// Needs: pi (1.4+) on PATH, Ollama running with the model pulled. Results: docs/OPEN-WEIGHT.md.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tap, lines } from '../src/usage.js';

const [MODEL, SIZE = 'small', MINUTES = '15', VIA = 'direct'] = process.argv.slice(2);
if (!MODEL) { console.error('usage: node scripts/live-pi.mjs <ollama-model> [small|big] [minutes] [direct|run]'); process.exit(1); }
const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));
const GUARD = fileURLToPath(new URL('../src/piguard.js', import.meta.url));
const T = mkdtempSync(join(tmpdir(), 'nuworq-pi-'));
const repo = join(T, 'repo');
const U = 'http://127.0.0.1:4799';
mkdirSync(repo);
const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString();
git('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'greet.js'), 'export const greet = (name) => `Hello, ${name}`;\n');
git('add', '.');
git('commit', '-qm', 'init');

// HOME=T: `nuworq serve` writes ~/.nuworq/hub.json, which would repoint every agent on the machine.
const serve = spawn('node', [BIN, 'serve', '--port', '4799', '--db', join(T, 'hub.db')], { stdio: 'ignore', env: { ...process.env, HOME: T } });
await new Promise((r) => setTimeout(r, 1000));
const H = (a, b) => fetch(`${U}/api/p/demo/human/${a}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: U }, body: JSON.stringify(b) }).then((r) => r.json());
const report = (agent) => {
  const db = new DatabaseSync(join(T, 'hub.db'));
  console.log(`#1 is ${db.prepare('SELECT stage FROM items WHERE seq = 1').get().stage}`);
  for (const e of db.prepare('SELECT actor, type, headline, data FROM events WHERE actor = ? ORDER BY id').all(agent)) console.log(`  ${e.type}: ${e.headline}${e.data !== '{}' ? `  ${e.data}` : ''}`);
};
let agent = `pi-${MODEL.replace(/[^a-z0-9]+/gi, '-')}`;
try {
  execFileSync('node', [BIN, 'checkin', '--as', 'setup', '--project', 'demo', '--url', U], { stdio: 'ignore', cwd: repo });
  await H('settings', { mission: 'A tiny greeting library.' });
  await H('create', SIZE === 'big'
    ? { title: 'A tested greeting library: farewell(), greetAll(), and a test suite', acceptance: '1. farewell(name) returns "Goodbye, <name>" (default "world"). 2. greetAll(names) returns one greet() line per name, joined by newlines; empty array gives "". 3. test/greet.test.js uses node:test and covers greet, farewell and greetAll including defaults and empty input. 4. package.json has "test": "node --test" and npm test passes. 5. README.md documents the three functions. Committed.' }
    : { title: 'greet() handles a missing name', acceptance: 'greet() with no argument returns "Hello, world". greet("Ana") still returns "Hello, Ana". Committed.' });

  if (VIA === 'run') {
    await H('settings', { runner: true });
    const out = execFileSync('node', [BIN, 'run', '--url', U, '--agent', 'pi', '--can-read-keys', '--model', `ollama/${MODEL}`, '--workers', '1', '--max-runs', '1', '--max-minutes', MINUTES, '--poll', '5', '--folder', T],
      { env: { ...process.env, HOME: T }, encoding: 'utf8' });
    console.log(out);
    agent = out.match(/▶ (\S+)/)?.[1] ?? agent;
    report(agent);
    const wt = `${repo}.worktrees/${agent}`;
    try {
      console.log(`\nworktree ${wt}:\n${execFileSync('git', ['-C', wt, 'log', '--oneline', 'main..HEAD'], { encoding: 'utf8' })}${execFileSync('git', ['-C', wt, 'status', '--short'], { encoding: 'utf8' }) || '(clean)\n'}`);
    } catch { console.log(`\n(${wt} is gone: the runner removed it, nothing left to lose)\nbranches:\n${git('branch', '-a', '-v')}`); }
  } else {
    // pi's config: a folder of its own, set up with pi's own CLI as `nuworq connect` does, plus Ollama as a provider.
    const dir = join(T, 'pi-agent');
    const env = { ...process.env, PI_CODING_AGENT_DIR: dir };
    execFileSync('pi', ['mcp', 'add', 'nuworq', '--exposure', 'direct', '--env', `NUWORQ_URL=${U}`, '--env', 'NUWORQ_PROJECT=demo', '--env', `NUWORQ_AGENT=${agent}`, '--env', `NUWORQ_MODEL=${MODEL}`, '--', 'node', BIN, 'mcp'], { env, stdio: 'ignore' });
    writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { ollama: { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions', apiKey: 'ollama', models: [{ id: MODEL }] } } }, null, 2));
    console.log(execFileSync('pi', ['mcp', 'list'], { env, encoding: 'utf8' }).trim());
    const task = 'Work on the demo project using nuworq. Do the work in this directory. Commit your work with git, and include the commit in your evidence when you submit. Keep going until next says there is nothing left for you, then sign off.';
    const log = join(T, 'pi.log');
    console.log(`dir ${T}\nagent ${agent}\nlog ${log}`);
    const pi = spawn('pi', ['-p', '--mode', 'json', '--model', `ollama/${MODEL}`, '--no-session', '--no-approve', '--no-extensions', '-e', 'builtin:mcp', '-e', GUARD, '--no-skills', '--no-prompt-templates', '--no-themes', '--', task],
      { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = createWriteStream(log);
    const t = tap('pi', { model: `ollama/${MODEL}` });
    const split = lines((l) => { const shown = t.line(l); if (shown != null) console.log(shown); });
    pi.stdout.setEncoding('utf8');
    pi.stdout.on('data', (d) => { out.write(d); split.write(d); });
    pi.stderr.pipe(out);
    const timer = setTimeout(() => { console.log(`\n[timeout after ${MINUTES}m]`); pi.kill('SIGTERM'); }, Number(MINUTES) * 60_000);
    const code = await new Promise((r) => pi.on('exit', r));
    clearTimeout(timer);
    split.end();
    console.log(`\n[pi exited ${code}]  usage ${JSON.stringify(t.usage())}`);
    report(agent);
    console.log(`\nrepo:\n${git('log', '--oneline')}${git('status', '--short')}`);
  }
} finally {
  serve.kill();
}
