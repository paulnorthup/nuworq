#!/usr/bin/env node
// nuworq: run the hub, connect agents, and check on projects from a terminal.
import { writeFileSync, existsSync, readFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { join, dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createClient, resolveSettings, repoRoot, HubError, DEFAULT_URL, HUB_FILE, CONNECT_FILE } from '../src/client.js';
import { tools, guide } from '../src/protocol.js';
import { envVar, dataDir, defaultDb, CONFIG_FILES } from '../src/names.js';

const BIN = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(BIN), '..');
// How agents should invoke this CLI: the bare name only if it's really on PATH.
const ON_PATH = (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, 'nuworq')));
const CLI = ON_PATH ? 'nuworq' : `node ${JSON.stringify(BIN)}`;
const BOOL = new Set(['peek', 'blocking', 'demo', 'force', 'all', 'help', 'h', 'auth', 'trust-proxy', 'run', 'here', 'workspaces', 'follow', 'until-idle', 'off']);
const MULTI = new Set(['option', 'evidence']);

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('-') || a === '-' || /^-\d/.test(a)) { pos.push(a); continue; }
    let key = a.replace(/^--?/, '');
    let val;
    const eq = key.indexOf('=');
    if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    else if (BOOL.has(key)) val = true;
    else if (i + 1 < argv.length) val = argv[++i];
    else val = true;
    if (MULTI.has(key)) (flags[key] ??= []).push(val);
    else flags[key] = val;
  }
  return { pos, flags };
}

// `-` as a flag value means: read it from stdin.
let stdinCache;
function readStdin() {
  if (stdinCache === undefined) {
    try { stdinCache = readFileSync(0, 'utf8'); } catch { stdinCache = ''; }
  }
  return stdinCache;
}
const text = (v) => (v === '-' ? readStdin().trim() : v);

const isRef = (s) => typeof s === 'string' && /^#?\d+$/.test(s);
const rest = (pos, from) => pos.slice(from).join(' ').trim() || undefined;
const refs = (v) => (v ? String(v).split(/[\s,]+/).filter(Boolean) : undefined);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const layers = (f) => ({ summary: text(f.summary), detail: text(f.detail) });

function need(v, what) {
  if (v === undefined || v === '' || v === true) throw new HubError(`missing ${what}`, { hint: `See: nuworq help` });
  return v;
}

// positional + flag shapes for each agent operation
const AGENT_CMDS = {
  checkin: (p, f) => ({ model: f.model, client: f.client, status: text(f.status), has: refs(f.has ?? envVar('HAS')) }),
  next: (p, f) => ({ claim: f.peek ? false : undefined }),
  claim: (p, f) => ({ item: need(p[0], '<item>'), touching: refs(f.touching) }),
  progress: (p, f) => ({ item: need(p[0], '<item>'), headline: rest(p, 1) || undefined, ...layers(f), touching: refs(f.touching) }),
  ask: (p, f) => {
    const item = isRef(p[0]) ? p[0] : undefined;
    return {
      item,
      question: need(rest(p, item ? 1 : 0), '<question>'),
      context: text(f.context), detail: text(f.detail),
      options: f.option, assumption: text(f.assume ?? f.assumption),
      blocking: f.blocking ? true : undefined,
    };
  },
  submit: (p, f) => ({
    item: need(p[0], '<item>'), headline: need(rest(p, 1), '<headline>'), ...layers(f), acceptance: text(f.acceptance),
    evidence: f.evidence?.map((e) => {
      const [label, ...url] = String(e).split('|');
      return clean({ label: label.trim(), url: url.join('|').trim() || undefined });
    }),
  }),
  handoff: (p, f) => ({ item: need(p[0], '<item>'), headline: need(rest(p, 1), '<headline>'), ...layers(f) }),
  propose: (p, f) => ({
    title: need(rest(p, 0), '<title>'), ...layers(f), acceptance: text(f.acceptance),
    priority: f.priority, parent: f.parent, depends_on: refs(f['depends-on']), needs: refs(f.needs), size: f.size,
  }),
  refine: (p, f) => ({
    item: need(p[0], '<item>'), title: text(f.title), ...layers(f), acceptance: text(f.acceptance),
    priority: f.priority, depends_on: refs(f['depends-on']), needs: f.needs === undefined ? undefined : refs(f.needs) ?? [], size: f.size,
  }),
  review: (p, f) => ({ item: need(p[0], '<item>'), verdict: need(p[1], '<accept|reject>'), headline: need(rest(p, 2), '<headline>'), attempt: f.attempt, ...layers(f) }),
  comment: (p, f) => {
    const item = isRef(p[0]) && p.length > 1 ? p[0] : undefined;
    return { item, headline: need(rest(p, item ? 1 : 0), '<headline>'), ...layers(f) };
  },
  ack: (p) => ({ steer: need(p[0], '<steer-id>'), response: rest(p, 1) }),
  look: (p, f) => ({ item: p[0], stage: f.stage }),
  signoff: (p, f) => ({ headline: rest(p, 0), summary: text(f.summary) }),
};

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c('1'), dim = c('2'), amber = c('33'), green = c('32'), grey = c('90');
const stateColor = (s) => ({ 'needs-you': amber, flowing: green, stalled: amber }[s] ?? grey);

async function status(flags) {
  const client = createClient(flags);
  const { url } = client.settings;
  const project = client.settings.project ?? (flags.all ? null : (await client.where()).project);
  if (flags.all || !project) {
    const list = await client.get('/api/projects');
    if (!list.length) return console.log(dim('No projects yet. An agent checkin creates one.'));
    const w = Math.max(...list.map((p) => p.name.length));
    for (const p of list) console.log(`${stateColor(p.pulse.state)('●')} ${bold(p.name.padEnd(w))}  ${p.pulse.sentence}`);
    return;
  }
  const v = await client.get(`/api/p/${encodeURIComponent(project)}/view`);
  console.log(`${stateColor(v.pulse.state)('●')} ${bold(v.project.name)}  ${v.pulse.sentence}`);
  const act = v.attention.filter((a) => a.level === 'act');
  act.forEach((a, i) => {
    console.log(`  ${amber(`${i + 1}.`)} ${a.headline}`);
    if (a.sub) console.log(`     ${dim(a.sub)}`);
  });
  const know = v.attention.length - act.length;
  if (know) console.log(dim(`  + ${know} worth knowing`));
  if (act.length || know) console.log(dim(`  ${url}/#/p/${encodeURIComponent(project)}`));
}

function workerPrompt(flags) {
  const { url, remote } = resolveSettings(flags);
  const project = resolveSettings(flags).project ?? 'whichever project the nuworq hub sends you to';
  const name = flags.as || envVar('AGENT') || `worker-${randomBytes(2).toString('hex')}`;
  return `You are an autonomous worker on "${project}", coordinated through nuworq: a shared hub where AI agents and a human facilitator organize work.

If you have nuworq tools (checkin, next, progress, submit, ...), use them. Otherwise use the nuworq CLI from your shell: \`${CLI}\`, adding \`--as ${name}\` to every command.

Your session:
1. checkin. Read the mission, standing decisions and steering, and ack each steer.
2. Loop: next → do the work in this repository → progress at real milestones → submit with evidence (tests run, branch and commits), or handoff with where you left off if you can't finish.
   Work in your own git worktree, never in the main checkout. ${remote
    ? 'For each item the hub names a branch: create it from the latest main on origin with \`git fetch origin\`, then \`git switch -c <branch> origin/main\`, or \`git switch <branch>\` if it exists. Push it (\`git push -u origin <branch>\`) before you submit.'
    : 'For each item the hub names a branch: create it from the latest main with \`git switch -c <branch> main\`, or \`git switch <branch>\` if it exists.'}
3. Got a question? Prefer ask with an assumption and keep going. Only block if you truly can't proceed, and then take other work.
4. Propose work you notice instead of growing your current item.
5. When next says there's nothing ready (mode "idle"), signoff with one line on where things stand, and stop.

Write everything in layers: headline (one line, outcome first), summary (the 5-minute version), detail (the 30-minute version).

${guide({ project, url, via: 'cli', command: CLI })}`;
}

// What this machine can do, as fit tags for the hub (work that needs something else goes elsewhere).
// Cheap checks only; --has adds what can't be detected, e.g. --has browser,linux-vm.
function detectHas(flags) {
  const onPath = (cmd) => (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, cmd)));
  return [...new Set([
    { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform],
    onPath('docker') && 'docker',
    onPath('nvidia-smi') && 'gpu',
    ...(refs(flags.has) ?? []),
  ].filter(Boolean).map((t) => String(t).toLowerCase()))];
}

// A headless worker: ask the hub where work is waiting, give the worker its own git worktree there,
// detached at main (so many can run at once without colliding; each item it claims gets its own branch),
// and start the agent with everything it needs (MCP server, project, a scoped tool allowlist).
// Prints the command, or runs it with --run.
function agentOf(flags) {
  const agent = String(flags.agent || 'claude').toLowerCase();
  if (!['claude', 'codex', 'opencode'].includes(agent)) {
    throw new HubError(`unknown agent "${agent}"`, { hint: 'Use --agent claude, codex or opencode. For anything else, give it the nuworq MCP server (nuworq init) and let it check in.' });
  }
  if (agent === 'opencode' && (typeof flags.model !== 'string' || !flags.model.includes('/'))) {
    throw new HubError('opencode needs a model: --model <provider>/<model>', { hint: 'e.g. --model ollama/qwen3.8:27b-mtp-q4_K_M (Ollama is configured for you), or any provider in your opencode config. A ~27B tool-calling model is reliable; see docs/OPEN-WEIGHT.md.' });
  }
  return agent;
}

async function hubProjects(client) {
  try {
    return await client.get('/api/projects');
  } catch {
    throw new HubError(`The hub isn't reachable at ${client.settings.url}`, { hint: `Start it first: ${CLI} serve` });
  }
}

// The token a started agent gets. Never yours: a hub that requires login needs a separate agent token.
async function agentToken(client, flags) {
  const me = await client.get('/api/me');
  if (me.auth !== 'required') return null;
  // A machine connected with an agent token (nuworq connect) hands that one on.
  const t = flags['agent-token'] || envVar('AGENT_TOKEN') || (me.role === 'agent' ? client.settings.token : null);
  const how = 'Create one on the hub host: nuworq token create <name> --role agent --project <project>. Pass it with --agent-token or NUWORQ_AGENT_TOKEN.';
  if (!t || t === true) throw new HubError('This hub requires login, so workers need their own agent token', { hint: how });
  const who = await createClient({ url: client.settings.url, token: t }).get('/api/me');
  if (who.role !== 'agent') {
    throw new HubError(who.role ? `--agent-token is a ${who.role} token; workers only get agent tokens` : 'The hub refused the agent token (wrong or revoked)', { hint: how });
  }
  return t;
}

async function worker(flags) {
  const s = resolveSettings(flags);
  const agent = agentOf(flags);
  const client = createClient(flags);
  const tags = detectHas(flags);
  const projects = await hubProjects(client);

  // Where to work: the named project, else the one this folder belongs to, else wherever the hub routes us.
  let target = s.project ? projects.find((p) => p.slug === s.project) : null;
  let why = '';
  if (s.project && !target) {
    throw new HubError(`The hub has no project "${s.project}"`, { hint: `Projects: ${projects.map((p) => p.slug).join(', ') || 'none yet'}. Or leave out --project and the hub picks.` });
  }
  if (!target) {
    const here = (await client.where()).project;
    if (here) {
      target = projects.find((p) => p.slug === here);
      why = 'this folder belongs to it';
    }
  }
  if (!target) {
    const routes = await client.get(`/api/route?has=${encodeURIComponent(tags.join(','))}`);
    const best = routes.find((r) => r.path) ?? routes[0];
    if (!best) return console.log(dim('No work is waiting in any project: everything is parked, idle, or waiting on you.'));
    target = projects.find((p) => p.slug === best.project);
    why = `the hub routed here: ${best.item} ${best.title} (${best.mode}, ${best.priority})`;
  }
  const token = flags.run ? await agentToken(client, flags) : null;
  const { name, worktree, main, origin, cwd, cmd } = workerSetup(target, agent, flags, s, token);

  console.log(`${bold(`${name} → ${target.name}`)}${why ? dim(`  (${why})`) : ''}
${dim(worktree ? `Works in its own worktree ${worktree}, detached at ${main}. Each item it claims gets its own branch (the hub names it), made from the latest ${main}. When it's done: git worktree remove ${sq(worktree)}` : `Works in ${cwd}.`)}`);
  if (!flags.run) {
    console.log(`\n${cmd}\n`);
    console.log(dim({
      claude: `Headless agents can't ask permission: they may only use the tools in --allowedTools (set from what's in the folder; change with --allow). ${origin ? 'The only pushes: nuworq/ branches to origin, and landing one on main there.' : 'Never git push.'}`,
      codex: `Codex runs in its workspace-write sandbox; the nuworq MCP server runs outside it, so it can reach the hub.`,
      opencode: `opencode has no sandbox: it may run any shell command except git push (denied). Use a model that calls tools well; see docs/OPEN-WEIGHT.md.`,
    }[agent] + '\nAdd --run to start it now.'));
    if (s.token) console.log(dim('Replace <agent-token> with an agent token (nuworq token create <name> --role agent --project <p>). With --run, pass it as --agent-token.'));
    return;
  }
  const { spawn } = await import('node:child_process');
  const child = spawn('/bin/sh', ['-c', cmd], { stdio: 'inherit' });
  await new Promise((done) => child.on('exit', (code) => { process.exitCode = code ?? 1; done(); }));
}

const sq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

// The branch work lands on: main, or (in a repo without one) the branch the main checkout is on.
function mainBranch(home) {
  const git = (...a) => { try { return execFileSync('git', ['-C', home, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  return git('rev-parse', '--verify', '-q', 'refs/heads/main') ? 'main' : git('symbolic-ref', '-q', '--short', 'HEAD') || 'main';
}

const hasOrigin = (home) => {
  try { return !!execFileSync('git', ['-C', home, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return false; }
};

// The shell command that gives a worker its worktree (detached at main, or at origin/main after a
// fetch when there is an origin; reused if it exists) and starts the agent in it.
// token: the agent token the worker gets when it runs (null: the hub needs none, or we only print).
function workerSetup(target, agent, flags, s, token = null) {
  const home = target.path || process.cwd();
  if (!existsSync(home)) {
    throw new HubError(`${target.name} lives in ${home}, which doesn't exist on this machine`, { hint: 'Set where it lives in the UI (5m view, under the mission).' });
  }

  const name = String(flags.as || `${agent}-${randomBytes(2).toString('hex')}`);
  const isRepo = existsSync(join(home, '.git'));
  // With an origin (GitHub), work starts from main there and lands by pushing to it.
  const origin = isRepo && hasOrigin(home);
  const worktree = isRepo && !flags.here ? join(`${home}.worktrees`, name) : null;
  const main = isRepo ? mainBranch(home) : 'main';
  const cwd = worktree ?? home;
  const tags = detectHas(flags);
  const env = {
    NUWORQ_URL: s.url, NUWORQ_PROJECT: target.slug, NUWORQ_AGENT: name,
    ...(tags.length ? { NUWORQ_HAS: tags.join(',') } : {}),
    ...(token ? { NUWORQ_TOKEN: token } : s.token && !flags.run ? { NUWORQ_TOKEN: '<agent-token>' } : {}),
  };
  const task = [
    `Work on the ${target.name} project using nuworq (project: ${target.slug}). Do the work in this directory.`,
    worktree && origin ? `You work in your own git worktree, ${worktree}. For each item, the hub names a branch: create it from the latest ${main} on origin with \`git fetch origin\`, then \`git switch -c <branch> origin/${main}\`, or \`git switch <branch>\` if it exists. Commit your work there, push the branch before you submit (\`git push -u origin <branch>\`), and include the branch and commit in your evidence. To land accepted work, follow the hub's steps: rebase onto origin/${main}, run the checks, then \`git push origin <branch>:${main}\`. Never work in the main checkout, ${home}.`
      : worktree ? `You work in your own git worktree, ${worktree}. For each item, the hub names a branch: create it from the latest ${main} with \`git switch -c <branch> ${main}\`, or \`git switch <branch>\` if it exists. Commit your work there, and include the branch and commit in your evidence when you submit. Never work in the main checkout, ${home}.` : '',
    'Keep going until next says there is nothing left for you, then sign off.',
  ].filter(Boolean).join(' ');

  const has = (f) => existsSync(join(home, f));
  const run = [
    has('package.json') && ['Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(node:*)'],
    (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) && ['Bash(python3:*)', 'Bash(pytest:*)'],
    has('Cargo.toml') && ['Bash(cargo:*)'],
    has('go.mod') && ['Bash(go:*)'],
    isRepo && ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git switch:*)'],
    // Landing: rebase onto main, then fast-forward main in this one checkout. Nothing else with -C.
    isRepo && ['Bash(git rebase:*)', `Bash(git -C ${home} merge --ff-only:*)`],
    // Through origin: push the item's branch, and land it with git push origin <branch>:main (GitHub
    // refuses anything but a fast-forward there). No other pushes.
    origin && ['Bash(git fetch:*)', 'Bash(git push origin nuworq/:*)'],
  ].filter(Boolean).flat();
  const allow = flags.allow ? String(flags.allow) : ['mcp__nuworq', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(ls:*)', ...run].join(',');
  const mcp = JSON.stringify({ mcpServers: { nuworq: { command: 'node', args: [BIN, 'mcp'], env } } });

  const lines = [];
  if (worktree && origin) lines.push(`git -C ${sq(home)} fetch -q origin`, `{ [ -d ${sq(worktree)} ] || git -C ${sq(home)} worktree add -q --detach ${sq(worktree)} ${sq(`origin/${main}`)}; }`);
  else if (worktree) lines.push(`{ [ -d ${sq(worktree)} ] || git -C ${sq(home)} worktree add -q --detach ${sq(worktree)} ${sq(main)}; }`);
  lines.push(`cd ${sq(cwd)}`);
  if (agent === 'claude') {
    lines.push(`claude -p ${sq(task)} \\\n  --mcp-config ${sq(mcp)} \\\n  --allowedTools ${sq(allow)}`);
  } else if (agent === 'opencode') {
    // Config goes in the environment, not an opencode.json the agent might commit. opencode takes its
    // folder from $PWD (cd keeps it right) and waits on a non-TTY stdin, hence < /dev/null.
    const model = String(flags.model);
    const [provider, ...rest] = model.split('/');
    const config = {
      mcp: { nuworq: { type: 'local', command: ['node', BIN, 'mcp'], enabled: true, environment: { ...env, NUWORQ_MODEL: rest.join('/') } } },
      permission: { bash: { 'git push*': 'deny' } },
      ...(provider === 'ollama' ? { provider: { ollama: { npm: '@ai-sdk/openai-compatible', name: 'Ollama', options: { baseURL: process.env.OLLAMA_URL || 'http://localhost:11434/v1' }, models: { [rest.join('/')]: {} } } } } : {}),
    };
    lines.push(`OPENCODE_CONFIG_CONTENT=${sq(JSON.stringify(config))} \\\n  opencode run -m ${sq(model)} ${sq(task)} < /dev/null`);
  } else {
    const envToml = `{${Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',')}}`;
    lines.push(`codex exec -s workspace-write \\\n  -c ${sq('mcp_servers.nuworq.command="node"')} \\\n  -c ${sq(`mcp_servers.nuworq.args=${JSON.stringify([BIN, 'mcp'])}`)} \\\n  -c ${sq(`mcp_servers.nuworq.env=${envToml}`)} \\\n  ${sq(task)}`);
  }
  return { name, worktree, main: origin ? `origin/${main}` : main, origin, cwd, cmd: lines.join(' && \\\n') };
}

// Keep up to --workers headless workers on waiting work in the projects the human opted in.
async function runCmd(flags) {
  const s = resolveSettings(flags);
  const agent = agentOf(flags);
  const client = createClient(flags);
  await hubProjects(client);
  const token = await agentToken(client, flags);
  const num =(v, d) => (v === undefined ? d : Number(v) > 0 ? Number(v) : (() => { throw new HubError(`expected a positive number, got "${v}"`, { hint: 'See: nuworq help' }); })());
  const { spawn } = await import('node:child_process');
  const { createWriteStream } = await import('node:fs');
  const { run } = await import('../src/runner.js');
  const logs = join(dirname(HUB_FILE), 'logs');
  mkdirSync(logs, { recursive: true });

  const launch = async (r) => {
    const projects = await hubProjects(client);
    const target = projects.find((p) => p.slug === r.project);
    if (!target) throw new HubError(`the hub no longer has project "${r.project}"`);
    const { name, worktree, cwd, cmd } = workerSetup(target, agent, { ...flags, as: undefined, run: true }, s, token);
    const log = join(logs, `${name}.log`);
    const out = createWriteStream(log);
    // Its own process group, so stopping it stops the agent too, not just the shell.
    const child = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    return {
      name, project: target.slug, where: dim(`${worktree ?? cwd}  log: ${log}`),
      kill: (sig) => { try { process.kill(-child.pid, sig); } catch {} },
      exited: new Promise((done) => child.on('exit', (code, sig) => done(code ?? (sig ? `${sig}` : 1)))),
    };
  };

  const workers = num(flags.workers, 1);
  console.log(`${green('●')} ${bold('nuworq run')}  ${dim(`up to ${workers} ${agent} worker${workers > 1 ? 's' : ''} on opted-in projects at ${s.url}; Ctrl-C stops`)}`);
  await run({
    // Only work this machine can do (its fit tags), so no worker is started for work it can't take.
    routes: () => client.get(`/api/route?runner=1&has=${encodeURIComponent(detectHas(flags).join(','))}`),
    launch, workers,
    maxRuns: num(flags['max-runs'], Infinity),
    untilIdle: !!flags['until-idle'],
    maxMinutes: num(flags['max-minutes'], Infinity),
    pollSeconds: num(flags.poll, 30),
    onInterrupt: (fn) => {
      process.on('SIGINT', () => { console.log(dim('\nStopping: no new workers; asking running ones to stop (Ctrl-C again to kill them).')); fn(); });
      process.on('SIGTERM', fn);
    },
  });
}

// One line from stdin, for a secret: not echoed when typed at a terminal.
async function readSecretLine(prompt) {
  const { createInterface } = await import('node:readline');
  const { Writable } = await import('node:stream');
  const tty = !!process.stdin.isTTY;
  if (tty) process.stderr.write(prompt);
  const rl = createInterface({ input: process.stdin, output: new Writable({ write: (c, e, cb) => cb() }), terminal: tty });
  const line = await new Promise((resolve) => {
    rl.once('line', resolve);
    rl.once('close', () => resolve(''));
    rl.once('SIGINT', () => { process.stderr.write('\n'); process.exit(130); });
  });
  rl.close();
  if (tty) process.stderr.write('\n');
  return line.trim();
}

// nuworq connect <url>: use a hub on another machine (a server) from this one. It checks the hub
// answers and takes the token, then saves both where the CLI, the MCP server and `run` look.
async function connect(pos, flags) {
  if (flags.off) {
    if (!existsSync(CONNECT_FILE)) return console.log(dim('Not connected to a hub; nothing to forget.'));
    rmSync(CONNECT_FILE, { force: true });
    return console.log(`${green('Disconnected.')} ${dim(`Removed ${CONNECT_FILE}. This machine finds its hub as before: NUWORQ_URL, .nuworq.json, or a hub serving here.`)}`);
  }
  const url = String(need(pos[0], '<url>')).replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]/i.test(url)) throw new HubError(`"${url}" isn't a hub address`, { hint: 'e.g. nuworq connect https://nuworq.example.com' });
  const health = await createClient({ url, token: '', retryMs: 0 }).get('/api/health').catch(() => null);
  if (!health?.ok) throw new HubError(`No nuworq hub answers at ${url}`, { hint: 'Check the address (it is what you open in the browser) and that the hub is running.' });
  const token = String((typeof flags.token === 'string' && flags.token) || envVar('TOKEN') || await readSecretLine('Token (not shown): ')).trim();
  const me = await createClient({ url, token, retryMs: 0 }).get('/api/me');
  if (me.auth === 'required' && !me.role) {
    throw new HubError(token ? 'The hub refused that token (wrong or revoked)' : 'This hub requires login, and no token was given', {
      hint: 'Pass --token, set NUWORQ_TOKEN, or paste it when asked. Tokens are made on the hub host: nuworq token create <name> --role human|agent.',
    });
  }
  // Written whole with mode 600 and moved into place, so the token is never in a file others can read.
  mkdirSync(dirname(CONNECT_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${CONNECT_FILE}.${process.pid}`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify({ url, token }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, CONNECT_FILE);
  console.log(`${green('Connected')} to ${bold(url)}${me.auth === 'required' ? ` as ${me.name} (${me.role} token)` : dim(' (it needs no login)')}.
${dim(`Saved in ${CONNECT_FILE}, readable only by you. The CLI, the MCP server and nuworq run on this machine use it
now; NUWORQ_URL and NUWORQ_TOKEN still win. Forget it: nuworq connect --off`)}`);
}

function init(flags) {
  const s = resolveSettings(flags);
  // Optional: pin this folder to a project. Usually unnecessary: the hub learns where projects live.
  if (flags.project) {
    // An older .trellis.json here counts as existing config too (a new .nuworq.json would replace it).
    const existing = CONFIG_FILES.find((f) => existsSync(join(process.cwd(), f)));
    if (existing && !flags.force) {
      console.log(dim(`${existing} already exists (use --force to overwrite)`));
    } else {
      writeFileSync(join(process.cwd(), CONFIG_FILES[0]), JSON.stringify({ project: s.project, url: s.url }, null, 2) + '\n');
      console.log(green(`Wrote ${CONFIG_FILES[0]} → project "${s.project}", hub ${s.url}`));
    }
  }
  const q = JSON.stringify(BIN);
  console.log(`${dim('Set up once per agent tool. No project needed: an agent working in a folder the hub knows finds its project; anywhere else, the hub routes it to the work that matters most.')}

${bold('Claude Code')}
  claude mcp add --scope user nuworq -- node ${q} mcp

${bold('Codex')}  ${dim('(~/.codex/config.toml)')}
  [mcp_servers.nuworq]
  command = "node"
  args = [${q}, "mcp"]

${bold('opencode')}  ${dim('(~/.config/opencode/opencode.json)')}
  "mcp": {
    "nuworq": { "type": "local", "command": ["node", ${q}, "mcp"], "enabled": true }
  }

${bold('Any other MCP client')}
  command: node
  args:    [${q}, "mcp"]
  ${dim('optional env: NUWORQ_URL (if the hub is elsewhere), NUWORQ_TOKEN, NUWORQ_AGENT, NUWORQ_MODEL, NUWORQ_PROJECT (to pin one)')}

${bold('Shell-only agents')}  ${dim('(add to AGENTS.md or CLAUDE.md)')}
  This project coordinates work through nuworq. Run \`node ${q} guide\` and follow it.

${bold('Headless worker')}  ${dim('(asks the hub where work is waiting; own worktree, a branch per item; --run starts it)')}
  node ${q} worker --agent claude --run
  node ${q} worker --agent codex --run
  node ${q} worker --agent opencode --model ollama/qwen3.8:27b-mtp-q4_K_M --run`);
}

// The hub's own files: workspaces, the --follow worktrees, and mirrors of repositories it has no checkout of.
const dataHome = (flags) => flags['data-dir'] || envVar('DATA_DIR') || dataDir();
// Workspaces mode keeps one database per workspace here (see src/workspaces.js).
const workspacesDir = (flags) => join(dataHome(flags), 'workspaces');
const reposDir = (flags) => join(dataHome(flags), 'repos');
const dbPath = (flags) => {
  if (flags.workspace) {
    const file = join(workspacesDir(flags), `${String(flags.workspace).toLowerCase()}.db`);
    if (!existsSync(file)) throw new HubError(`no workspace "${flags.workspace}" in ${workspacesDir(flags)}`, { hint: 'See: nuworq workspace list' });
    return file;
  }
  return flags.db || envVar('DB') || defaultDb();
};

// Load the nuworq roadmap project into a real hub database, so nuworq can be built with nuworq.
async function seedCmd(flags) {
  const { Hub } = await import('../src/core.js');
  const { seed } = await import('../src/seed.js');
  const db = dbPath(flags);
  const hub = new Hub({ file: db });
  // A hub seeded before the rename has it as "trellis".
  const have = hub.projects().find((p) => p.slug === 'nuworq' || p.slug === 'trellis');
  if (have) {
    throw new HubError(`${db} already has a "${have.slug}" project`, { hint: 'Nothing to do. Delete that project first if you want a fresh copy.' });
  }
  await seed(hub);
  console.log(`${green('●')} Added the nuworq project to ${db}. Start the hub with: ${CLI} serve`);
}

async function serve(flags) {
  if (flags.follow) return serveFollow(flags);
  const { Hub } = await import('../src/core.js');
  const { createServer } = await import('../src/server.js');
  const { Notifier } = await import('../src/notify.js');
  const host = flags.host || envVar('HOST') || '127.0.0.1';
  const port = Number(flags.port || envVar('PORT') || 4747);
  const loopback = host === 'localhost' || host === '::1' || host.startsWith('127.');
  const auth = flags.auth || !loopback ? 'required' : 'local';
  const trustProxy = !!flags['trust-proxy'];
  if (flags.workspaces) return serveWorkspaces(flags, { host, port, trustProxy });
  const db = flags.demo ? ':memory:' : dbPath(flags);
  const hub = new Hub({ file: db, repos: flags.demo ? null : reposDir(flags) });
  if (flags.demo) {
    try {
      const { seed } = await import('../src/seed.js');
      await seed(hub);
    } catch (e) {
      console.warn(amber(`warning: couldn't load demo data (${e.message}); starting empty`));
    }
  }
  const publicUrl = String(flags['public-url'] || envVar('PUBLIC_URL') || '').replace(/\/+$/, '');
  const server = createServer(hub, { auth, trustProxy, publicUrl });
  if (auth === 'required' && !server.auth.hasHumanToken()) {
    console.error(flags.demo
      ? `error: --demo keeps data in memory, so it can't hold login tokens.
hint: Run the demo on the default host (127.0.0.1) without --auth.`
      : `error: login is required ${loopback ? '(--auth)' : `because ${host} is reachable from other machines`}, but no human token exists yet.
hint: Create one, then start again:
      node ${JSON.stringify(BIN)} token create <your-name> --role human --db ${JSON.stringify(db)}`);
    process.exit(1);
  }
  server.listen(port, host, () => {
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`;
    if (!flags.demo) {
      // Let agents and the CLI on this machine find the hub without configuration.
      try { mkdirSync(dirname(HUB_FILE), { recursive: true }); writeFileSync(HUB_FILE, JSON.stringify({ url, pid: process.pid }) + '\n'); } catch {}
    }
    const notifier = new Notifier(hub, { baseUrl: publicUrl || url }).start();
    server.on('close', () => notifier.stop());
    const authLine = auth === 'required'
      ? `${green('locked')}: browsers log in with a human token; agents send NUWORQ_TOKEN (an agent token)${trustProxy ? '; trusting X-Forwarded-* from your proxy' : ''}`
      : `${amber('open')} on loopback: no login (only this machine can reach it)`;
    console.log(`${green('●')} ${bold('nuworq')} is running at ${bold(url)}${flags.demo ? dim('  (demo data, in memory)') : dim(`  (${db})`)}
  Auth: ${authLine}
${dim(`
  Connect an agent:
    MCP (Claude Code):  claude mcp add --scope user nuworq${auth === 'required' ? ' -e NUWORQ_TOKEN=<agent-token>' : ''} -- node ${JSON.stringify(BIN)} mcp   (once, for every project)
    Shell:              node ${JSON.stringify(BIN)} guide
    Setup for others:   node ${JSON.stringify(BIN)} init     (run in a project folder)
    Headless worker:    node ${JSON.stringify(BIN)} worker --agent claude|codex --run   (goes wherever work is waiting)
    Tool schemas:       ${url}/api/tools?format=openai`)}`);
  });
  const stop = () => { server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// serve --follow: a small supervisor that keeps the hub on the latest main that passes its tests.
// The hub itself runs as a child (serve with the same flags, minus --follow) from its own worktree
// under the data folder (hub-src), never from this checkout, which agents fast-forward. New commits
// are tested in a second worktree there (hub-next). See src/follow.js.
async function serveFollow(flags) {
  const { follow } = await import('../src/follow.js');
  const host = String(flags.host || envVar('HOST') || '127.0.0.1');
  const port = Number(flags.port || envVar('PORT') || 4747);
  if (!port) throw new HubError('--follow needs a fixed port', { hint: 'Pass --port <n> (the supervisor checks the hub there).' });
  const probe = { '0.0.0.0': '127.0.0.1', '::': '::1' }[host] ?? host;
  const repo = repoRoot(ROOT);
  const args = process.argv.slice(3).filter((a) => !/^--?follow(=.*)?$/.test(a));
  const data = dataHome(flags);
  try {
    await follow({
      repo,
      dir: join(data, 'hub-src'),
      next: join(data, 'hub-next'),
      args,
      url: `http://${probe.includes(':') ? `[${probe}]` : probe}:${port}`,
      log: (line) => console.log(`${dim(`[follow ${new Date().toTimeString().slice(0, 8)}]`)} ${line}`),
    });
  } catch (e) {
    throw new HubError(`--follow couldn't start the hub: ${e.message}`, { hint: `It follows the main branch of ${repo}, the git checkout this nuworq runs from. Without --follow, serve runs this copy as it is.` });
  }
}

// Many workspaces, one process: each workspace is its own database, reached by subdomain or /w/<name>/.
async function serveWorkspaces(flags, { host, port, trustProxy }) {
  const { Workspaces } = await import('../src/workspaces.js');
  const { createServer } = await import('../src/server.js');
  const dir = workspacesDir(flags);
  const spaces = new Workspaces({ dir, repos: reposDir(flags) });
  const baseDomain = String(flags['base-domain'] || envVar('BASE_DOMAIN') || '').toLowerCase().replace(/^\.+|\.+$/g, '');
  const server = createServer(spaces, { trustProxy, baseDomain });
  server.listen(port, host, () => {
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`;
    const names = spaces.list();
    console.log(`${green('●')} ${bold('nuworq')} is serving workspaces at ${bold(url)}  ${dim(`(${dir})`)}
  Auth: ${green('locked')}: every workspace has its own tokens${trustProxy ? '; trusting X-Forwarded-* from your proxy' : ''}
  Workspaces: ${names.length ? names.join(', ') : dim('none yet')}
${dim(`  Reached at ${baseDomain ? `<workspace>.${baseDomain} or ` : ''}${url}/w/<workspace>/
  Add one:   node ${JSON.stringify(BIN)} workspace create <name>
  Then:      node ${JSON.stringify(BIN)} token create <you> --role human --workspace <name>`)}`);
  });
  const stop = () => { server.close(); spaces.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function workspace(pos, flags) {
  const { Workspaces } = await import('../src/workspaces.js');
  const spaces = new Workspaces({ dir: workspacesDir(flags) });
  const [sub, name] = pos;
  try {
    if (sub === 'create') {
      const s = spaces.create(need(name, '<name>'));
      return console.log(`${green('Created')} workspace ${bold(s)} (${spaces.file(s)}).
${dim(`  Give someone a login: nuworq token create <name> --role human --workspace ${s}`)}`);
    }
    if (sub === 'list') {
      const names = spaces.list();
      return console.log(names.length ? names.join('\n') : dim(`No workspaces in ${spaces.dir}. Add one: nuworq workspace create <name>`));
    }
    if (sub === 'remove') {
      spaces.remove(need(name, '<name>'));
      return console.log(`${green('Removed')} workspace ${bold(name)} and its database. A running hub stops serving it at once.`);
    }
  } catch (e) {
    throw e.hint || e.status ? new HubError(e.message, { hint: e.hint }) : e;
  }
  throw new HubError('usage: nuworq workspace create <name> | list | remove <name>');
}

// People (the humans, each with a role) are managed on the hub host too, like tokens.
async function person(pos, flags) {
  const { openDb } = await import('../src/db.js');
  const { Auth, PERSON_ROLES } = await import('../src/auth.js');
  const auth = new Auth(openDb(dbPath(flags)));
  const [sub, handle, role] = pos;
  try {
    if (sub === 'add') {
      const p = auth.addPerson(need(handle, '<handle>'), flags.role || 'member', { name: flags.name, email: flags.email });
      return console.log(`${green('Added')} @${p.handle} as ${p.role}. Give them a login: nuworq token create <token-name> --role human --person ${p.handle}`);
    }
    if (sub === 'list') {
      const rows = auth.listPeople();
      if (!rows.length) return console.log(dim('No people yet. Human tokens create one each; or: nuworq person add <handle> --role owner'));
      for (const r of rows) console.log(`@${r.handle.padEnd(20)}${r.role.padEnd(9)}${r.email}`);
      return;
    }
    if (sub === 'remove') {
      const r = auth.removePerson(need(handle, '<handle>'));
      return console.log(`${green('Removed')} @${r.handle}; ${r.revoked} token(s) they held or minted are revoked. Runner tokens are untouched.`);
    }
    if (sub === 'set-role') {
      const p = auth.setRole(need(handle, '<handle>'), need(role ?? flags.role, `<${PERSON_ROLES.join('|')}>`));
      return console.log(`${green('Updated')} @${p.handle} is now ${p.role}.`);
    }
  } catch (e) {
    throw e instanceof HubError ? e : new HubError(e.message, { hint: 'See: nuworq person list' });
  }
  throw new HubError(`usage: nuworq person add <handle> --role ${PERSON_ROLES.join('|')} [--email e] | list | set-role <handle> <role>`);
}

// Invites are made on the hub host too; the link is printed once (only its hash is kept).
async function invite(pos, flags) {
  const { openDb } = await import('../src/db.js');
  const { Auth, PERSON_ROLES } = await import('../src/auth.js');
  const auth = new Auth(openDb(dbPath(flags)));
  const [sub, id] = pos;
  try {
    if (sub === 'create') {
      const inv = auth.createInvite(flags.role || 'member', { email: flags.email, by: flags.by ? `@${String(flags.by).replace(/^@/, '')}` : '' });
      const hub = String(flags['public-url'] || envVar('PUBLIC_URL') || resolveSettings(flags).url).replace(/\/+$/, '');
      const ws = flags.workspace && !flags['public-url'] ? `/w/${String(flags.workspace).toLowerCase()}` : '';
      console.log(`${green('Invite')} ${bold(inv.id)} for a ${inv.role}${flags.email ? ` (${flags.email})` : ''}, valid 7 days, single use. Send this link; it is shown only once:

  ${bold(`${hub}${ws}/invite.html#${inv.token}`)}
`);
      return;
    }
    if (sub === 'list') {
      const rows = auth.listInvites();
      if (!rows.length) return console.log(dim('No invites. Make one: nuworq invite create --role member'));
      for (const r of rows) console.log(`${String(r.id).padEnd(4)}${r.role.padEnd(9)}${(r.email || '—').padEnd(28)}${r.state}${r.used_by ? ` by @${r.used_by}` : ''}`);
      return;
    }
    if (sub === 'revoke') { auth.revokeInvite(need(id, '<id>')); return console.log(`${green('Revoked')} invite ${id}.`); }
  } catch (e) {
    throw e instanceof HubError ? e : new HubError(e.message, { hint: 'See: nuworq invite list' });
  }
  throw new HubError(`usage: nuworq invite create --role ${PERSON_ROLES.join('|')} [--email e] [--by <owner>] [--public-url u] | list | revoke <id>`);
}

// Token management runs on the hub host, straight against the database file.
async function token(pos, flags) {
  const { openDb } = await import('../src/db.js');
  const { Auth } = await import('../src/auth.js');
  const db = dbPath(flags);
  const auth = new Auth(openDb(db));
  const [sub, name] = pos;
  if (sub === 'create') {
    const role = flags.role || 'agent';
    const { slugify } = await import('../src/core.js');
    const projects = (refs(flags.project === true ? '' : flags.project) ?? []).map(slugify).filter(Boolean);
    let plain;
    try {
      plain = auth.createToken(need(name, '<name>'), role, {
        person: flags.person, mintedBy: flags['minted-by'], runner: flags.runner === true ? name : flags.runner, powers: flags.powers, projects,
      });
    } catch (e) { throw new HubError(e.message, { hint: projects.length ? 'Leave out --project for a human token.' : 'See: nuworq token list, nuworq person list' }); }
    console.log(`${green('Created')} ${role} token ${bold(name)}${projects.length ? ` for ${projects.join(', ')}` : ''}. It is shown only this once:

  ${bold(plain)}
`);
    console.log(role === 'human'
      ? dim('  Log in to the web UI with it (you will be asked when you open the hub). `nuworq status` uses it too, via NUWORQ_TOKEN.')
      : dim(`  Give it to an agent as NUWORQ_TOKEN, e.g.:
    claude mcp add nuworq -e NUWORQ_TOKEN=<the token above> -e NUWORQ_URL=https://your-hub -- node ${JSON.stringify(BIN)} mcp
  Agent tokens can only use agent operations, not the UI.`));
    return;
  }
  if (sub === 'list') {
    const rows = auth.listTokens();
    if (!rows.length) return console.log(dim(`No tokens in ${db}. Create one: nuworq token create <name> --role human`));
    const when = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '—');
    const w = Math.max(4, ...rows.map((r) => r.name.length));
    const scopes = rows.map((r) => (r.role === 'human' ? '' : r.projects ? r.projects.split(',').join(', ') : 'all'));
    const sw = Math.max(8, ...scopes.map((x) => x.length)) + 2;
    console.log(dim(`${'id'.padEnd(4)}${'name'.padEnd(w + 2)}${'role'.padEnd(7)}${'prefix'.padEnd(11)}${'created'.padEnd(18)}${'last used'.padEnd(18)}${'status'.padEnd(9)}${'projects'.padEnd(sw)}who · powers`));
    for (const [k, r] of rows.entries()) {
      const who = r.person ? `@${r.person}` : r.runner ? `runner ${r.runner}` : r.minted_by ? `minted by @${r.minted_by}` : '—';
      console.log(`${String(r.id).padEnd(4)}${r.name.padEnd(w + 2)}${r.role.padEnd(7)}${(r.prefix + '…').padEnd(11)}${when(r.created_at).padEnd(18)}${when(r.last_used_at).padEnd(18)}${(r.revoked_at ? amber('revoked') : green('active')) + ' '.repeat(r.revoked_at ? 2 : 3)}${scopes[k].padEnd(sw)}${who}${r.powers ? ` · ${r.powers.join(',')}` : ''}`);
    }
    return;
  }
  if (sub === 'revoke') {
    const r = auth.revoke(need(name, '<name|id>'));
    if (!r) throw new HubError(`no token "${name}"`, { hint: 'See: nuworq token list' });
    return console.log(`${green('Revoked')} ${r.role} token ${bold(r.name)}; its sessions are logged out.`);
  }
  throw new HubError('usage: nuworq token create <name> --role human|agent | list | revoke <name|id>');
}

// Push channels are managed on the hub host, straight against the database file (like tokens).
async function notify(pos, flags) {
  const { openDb } = await import('../src/db.js');
  const n = await import('../src/notify.js');
  const db = openDb(dbPath(flags));
  const [sub, a, b] = pos;
  try {
    if (sub === 'add') {
      const c = n.addChannel(db, need(a, 'ntfy|slack|webhook'), need(b, '<url>'));
      return console.log(`${green('Added')} ${c.kind} channel ${bold(c.id)} (${c.url}). Try it: nuworq notify test`);
    }
    if (sub === 'list') {
      const rows = n.listChannels(db);
      if (!rows.length) return console.log(dim('No push channels. Add one: nuworq notify add ntfy <topic-url> | slack <webhook-url> | webhook <url>'));
      for (const c of rows) console.log(`${String(c.id).padEnd(4)}${c.kind.padEnd(9)}${c.url}  ${c.failing ? amber(`failing: ${c.last_error}`) : green('ok')}`);
      return;
    }
    if (sub === 'remove') { n.removeChannel(db, need(a, '<id>')); return console.log(`${green('Removed')} channel ${a}.`); }
    if (sub === 'test') {
      const results = await n.testChannels(db, { baseUrl: flags['public-url'] || envVar('PUBLIC_URL') || '' });
      if (!results.length) return console.log(dim('No push channels to test. Add one: nuworq notify add ntfy <topic-url>'));
      for (const r of results) console.log(`${String(r.id).padEnd(4)}${r.kind.padEnd(9)}${r.ok ? green('sent') : amber(`failed: ${r.error}`)}`);
      if (results.some((r) => !r.ok)) process.exitCode = 1;
      return;
    }
  } catch (e) {
    throw e.hint && !(e instanceof HubError) ? new HubError(e.message, { hint: e.hint }) : e;
  }
  throw new HubError('usage: nuworq notify add ntfy|slack|webhook <url> | list | remove <id> | test');
}

const HELP = `${bold('nuworq')}: a hub where humans facilitate and AI agents coordinate work.

${bold('Human')}
  serve [--port 4747] [--host 127.0.0.1] [--db path] [--demo] [--auth] [--trust-proxy] [--public-url u] [--follow]
                                         run the hub and web UI. Loopback: no login.
                                         Any other host (or --auth): tokens required.
                                         --follow: keep the hub on the latest main that passes its tests
  token create <name> --role human|agent [--project a,b]
                                         create a token (shown once); run on the hub host.
                                         --project limits an agent token to those projects
  token list | token revoke <name|id>    see or revoke tokens (revoking logs out sessions)
                                         human tokens act as a person: --person <handle>
                                         (default: one named like the token, created as owner)
  person add <handle> --role owner|steward|member|viewer [--email e]
  person list | person set-role <handle> <role> | person remove <handle>   (revokes tokens they minted)
  invite create --role steward [--email e] [--public-url u] | invite list | invite revoke <id>
                                         a single-use, 7-day link that adds a person with that role
  token create <name> [--powers shape,build,review] [--minted-by <handle> | --runner [name]]
                                         agent tokens: what they may do, and who answers for them
                                         owners do everything; stewards steer, decide, answer and
                                         accept; members comment and propose; viewers read
                                         --workspace <name>: that workspace's tokens
  serve --workspaces [--data-dir d] [--base-domain example.com]
                                         one process, many workspaces (one database each),
                                         at <name>.<base-domain> or /w/<name>/. Login always required.
  workspace create|remove <name> | list  manage workspaces on the hub host
  notify add ntfy|slack|webhook <url>    push one batched message when something new needs you
  notify list | remove <id> | test       see, remove or test push channels (run on the hub host)
  status [--all]                         the 30-second view

${bold('Agents')}  (every command takes --as <name>, --project, --url)
  checkin [--model m] [--client c] [--has "docker,macos"]
                                         start here: mission, decisions, steering, answers.
                                         --has: what your machine can do (or NUWORQ_HAS)
  next [--peek]                          claim the most useful work
  claim <item> [--touching "a,b"]        claim a specific item
  progress <item> [headline] [--touching "src/db,src/api.js"]
                                         milestone update (no headline = silent heartbeat); renews your lease
  ask [<item>] <question> [--assume a] [--option x]... [--blocking]
  submit <item> <headline> [--evidence "label|url"]...
  handoff <item> <headline>              release with where you left off
  propose <title> [--acceptance] [--priority now|soon|later] [--parent] [--depends-on "#1,#2"]
          [--needs "docker,linux-vm"] [--size small|large]
  refine <item> [--title] [--acceptance] [--priority] [--depends-on] [--needs] [--size]
  review <item> <accept|reject> <headline> [--attempt n|agent]   (raced items: which attempt to keep)
  comment [<item>] <headline>
  ack <steer-id> [response]
  look [<item>] [--stage s]
  signoff [headline]
  Text flags: --summary, --detail (use "-" to read from stdin)

${bold('Setup')}
  init [--force]                         write .nuworq.json; print MCP config for Claude Code, Codex, opencode
  connect <url> [--token t] | --off      use the hub at <url> from this machine; the MCP server and run pick it up.
                                         Checks it, saves it in ~/.nuworq/connect.json (only you can read it).
                                         The token: --token, else NUWORQ_TOKEN, else one line on stdin
  mcp                                    run the stdio MCP server (one per agent session)
  guide [--via cli|tools]                the agent guide
  tools [--format mcp|openai|anthropic] [--prefix p]   tool schemas
  worker [--agent claude|codex|opencode] [--model provider/model] [--run] [--project p] [--here] [--as name] [--allow tools] [--has tags]
                                         start a headless worker where work is waiting (the hub routes it),
                                         in its own git worktree, a branch per item (--here: no worktree). Without
                                         --run it prints the command instead. opencode needs --model,
                                         e.g. ollama/qwen3.8:27b-mtp-q4_K_M (Ollama is set up for you).
                                         On a hub with login, --run needs --agent-token (or
                                         NUWORQ_AGENT_TOKEN): workers never get your own token.
                                         It reports what this machine has (macos/linux, docker, gpu;
                                         add more with --has).
  run [--workers 1] [--agent claude|codex|opencode] [--model m] [--max-runs M] [--max-minutes T] [--poll 30] [--has tags] [--until-idle]
                                         keep up to N workers on waiting work in projects you opted in
                                         (UI: "Let nuworq run staff this project"); exits when the
                                         queue is empty. Logs: ~/.nuworq/logs. Dollar budgets: not yet.
  prompt [--as name]                     just the worker prompt text, for other agents
  seed                                   add the nuworq roadmap project to your hub's database

Env: NUWORQ_URL (default ${DEFAULT_URL}), NUWORQ_PROJECT, NUWORQ_AGENT, NUWORQ_MODEL, NUWORQ_DB,
     NUWORQ_TOKEN (a token the CLI and MCP server send to a hub that requires login),
     NUWORQ_PUBLIC_URL (the hub's address as you reach it, used for links in push messages)
Deploying on a VM or the internet: docs/DEPLOY.md`;

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { pos, flags } = parse(argv);
  if (!cmd || cmd === 'help' || flags.help || flags.h || cmd === '--help' || cmd === '-h') return console.log(HELP);

  if (cmd === 'serve') return serve(flags);
  if (cmd === 'mcp') {
    const { runMcp } = await import('../src/mcp.js');
    return runMcp({ clientOpts: { url: flags.url, project: flags.project } });
  }
  if (cmd === 'status') return status(flags);
  if (cmd === 'token') return token(pos, flags);
  if (cmd === 'workspace') return workspace(pos, flags);
  if (cmd === 'person') return person(pos, flags);
  if (cmd === 'invite') return invite(pos, flags);
  if (cmd === 'notify') return notify(pos, flags);
  if (cmd === 'guide') {
    const s = resolveSettings(flags);
    return console.log(guide({ project: s.project ?? 'whichever project the hub sends you to', url: s.url, via: flags.via || 'cli', command: CLI }));
  }
  if (cmd === 'tools') return console.log(JSON.stringify(tools(flags.format || 'mcp', flags.prefix || ''), null, 2));
  if (cmd === 'prompt') return console.log(workerPrompt(flags));
  if (cmd === 'worker') return worker(flags);
  if (cmd === 'run') return runCmd(flags);
  if (cmd === 'seed') return seedCmd(flags);
  if (cmd === 'init') return init(flags);
  if (cmd === 'connect') return connect(pos, flags);

  const shape = AGENT_CMDS[cmd];
  if (!shape) throw new HubError(`unknown command "${cmd}"`, { hint: 'See: nuworq help' });
  const agent = flags.as || envVar('AGENT');
  if (!agent) throw new HubError('who are you?', { hint: 'Pass --as <name> (e.g. --as claude-1) or set NUWORQ_AGENT. Keep the same name for your whole session.' });
  const client = createClient(flags);
  const result = await client.call(cmd, clean(shape(pos, flags)), { agent });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  if (e.hint) console.error(`hint: ${e.hint}`);
  if (!(e instanceof HubError)) console.error(e.stack);
  process.exit(1);
});
