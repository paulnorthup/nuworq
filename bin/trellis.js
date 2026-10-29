#!/usr/bin/env node
// trellis: run the hub, connect agents, and check on projects from a terminal.
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createClient, resolveSettings, HubError, DEFAULT_URL, HUB_FILE } from '../src/client.js';
import { tools, guide } from '../src/protocol.js';

const BIN = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(BIN), '..');
// How agents should invoke this CLI: the bare name only if it's really on PATH.
const ON_PATH = (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, 'trellis')));
const CLI = ON_PATH ? 'trellis' : `node ${JSON.stringify(BIN)}`;
const BOOL = new Set(['peek', 'blocking', 'demo', 'force', 'all', 'help', 'h', 'auth', 'trust-proxy', 'run', 'here']);
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
  if (v === undefined || v === '' || v === true) throw new HubError(`missing ${what}`, { hint: `See: trellis help` });
  return v;
}

// positional + flag shapes for each agent operation
const AGENT_CMDS = {
  checkin: (p, f) => ({ model: f.model, client: f.client, status: text(f.status) }),
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
    priority: f.priority, parent: f.parent, depends_on: refs(f['depends-on']),
  }),
  refine: (p, f) => ({
    item: need(p[0], '<item>'), title: text(f.title), ...layers(f), acceptance: text(f.acceptance),
    priority: f.priority, depends_on: refs(f['depends-on']),
  }),
  review: (p, f) => ({ item: need(p[0], '<item>'), verdict: need(p[1], '<accept|reject>'), headline: need(rest(p, 2), '<headline>'), ...layers(f) }),
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
  const { url } = resolveSettings(flags);
  const project = resolveSettings(flags).project ?? 'whichever project the Trellis hub sends you to';
  const name = flags.as || process.env.TRELLIS_AGENT || `worker-${randomBytes(2).toString('hex')}`;
  return `You are an autonomous worker on "${project}", coordinated through Trellis: a shared hub where AI agents and a human facilitator organize work.

If you have Trellis tools (checkin, next, progress, submit, ...), use them. Otherwise use the Trellis CLI from your shell: \`${CLI}\`, adding \`--as ${name}\` to every command.

Your session:
1. checkin. Read the mission, standing decisions and steering, and ack each steer.
2. Loop: next → do the work in this repository → progress at real milestones → submit with evidence (tests run, commits), or handoff with where you left off if you can't finish.
3. Got a question? Prefer ask with an assumption and keep going. Only block if you truly can't proceed, and then take other work.
4. Propose work you notice instead of growing your current item.
5. When next says there's nothing ready (mode "idle"), signoff with one line on where things stand, and stop.

Write everything in layers: headline (one line, outcome first), summary (the 5-minute version), detail (the 30-minute version).

${guide({ project, url, via: 'cli', command: CLI })}`;
}

// A headless worker: ask the hub where work is waiting, give the worker its own git worktree and
// branch there (so many can run at once without colliding), and start the agent with everything it
// needs (MCP server, project, a scoped tool allowlist). Prints the command, or runs it with --run.
function agentOf(flags) {
  const agent = String(flags.agent || 'claude').toLowerCase();
  if (!['claude', 'codex', 'opencode'].includes(agent)) {
    throw new HubError(`unknown agent "${agent}"`, { hint: 'Use --agent claude, codex or opencode. For anything else, give it the Trellis MCP server (trellis init) and let it check in.' });
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
  const t = flags['agent-token'] || process.env.TRELLIS_AGENT_TOKEN;
  const how = 'Create one on the hub host: trellis token create <name> --role agent --project <project>. Pass it with --agent-token or TRELLIS_AGENT_TOKEN.';
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
    const routes = await client.get('/api/route');
    const best = routes.find((r) => r.path) ?? routes[0];
    if (!best) return console.log(dim('No work is waiting in any project: everything is parked, idle, or waiting on you.'));
    target = projects.find((p) => p.slug === best.project);
    why = `the hub routed here: ${best.item} ${best.title} (${best.mode}, ${best.priority})`;
  }
  const token = flags.run ? await agentToken(client, flags) : null;
  const { name, worktree, branch, cwd, cmd } = workerSetup(target, agent, flags, s, token);

  console.log(`${bold(`${name} → ${target.name}`)}${why ? dim(`  (${why})`) : ''}
${dim(worktree ? `Works in its own worktree ${worktree}, on branch ${branch}. Merge the branch when you accept the work, then: git worktree remove ${sq(worktree)}` : `Works in ${cwd}.`)}`);
  if (!flags.run) {
    console.log(`\n${cmd}\n`);
    console.log(dim({
      claude: `Headless agents can't ask permission: they may only use the tools in --allowedTools (set from what's in the folder; change with --allow). Never git push.`,
      codex: `Codex runs in its workspace-write sandbox; the Trellis MCP server runs outside it, so it can reach the hub.`,
      opencode: `opencode has no sandbox: it may run any shell command except git push (denied). Use a model that calls tools well; see docs/OPEN-WEIGHT.md.`,
    }[agent] + '\nAdd --run to start it now.'));
    if (s.token) console.log(dim('Replace <agent-token> with an agent token (trellis token create <name> --role agent --project <p>). With --run, pass it as --agent-token.'));
    return;
  }
  const { spawn } = await import('node:child_process');
  const child = spawn('/bin/sh', ['-c', cmd], { stdio: 'inherit' });
  await new Promise((done) => child.on('exit', (code) => { process.exitCode = code ?? 1; done(); }));
}

const sq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

// The shell command that gives a worker its worktree and branch and starts the agent in it.
// token: the agent token the worker gets when it runs (null: the hub needs none, or we only print).
function workerSetup(target, agent, flags, s, token = null) {
  const home = target.path || process.cwd();
  if (!existsSync(home)) {
    throw new HubError(`${target.name} lives in ${home}, which doesn't exist on this machine`, { hint: 'Set where it lives in the UI (5m view, under the mission).' });
  }

  const name = String(flags.as || `${agent}-${randomBytes(2).toString('hex')}`);
  const isRepo = existsSync(join(home, '.git'));
  const worktree = isRepo && !flags.here ? join(`${home}.worktrees`, name) : null;
  const branch = `trellis/${name}`;
  const cwd = worktree ?? home;
  const env = {
    TRELLIS_URL: s.url, TRELLIS_PROJECT: target.slug, TRELLIS_AGENT: name,
    ...(token ? { TRELLIS_TOKEN: token } : s.token && !flags.run ? { TRELLIS_TOKEN: '<agent-token>' } : {}),
  };
  const task = [
    `Work on the ${target.name} project using Trellis. Do the work in this directory.`,
    worktree ? `You are in your own git worktree on branch ${branch}: commit your work there, and include the branch and commit in your evidence when you submit.` : '',
    'Keep going until next says there is nothing left for you, then sign off.',
  ].filter(Boolean).join(' ');

  const has = (f) => existsSync(join(home, f));
  const run = [
    has('package.json') && ['Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(node:*)'],
    (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) && ['Bash(python3:*)', 'Bash(pytest:*)'],
    has('Cargo.toml') && ['Bash(cargo:*)'],
    has('go.mod') && ['Bash(go:*)'],
    isRepo && ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)'],
  ].filter(Boolean).flat();
  const allow = flags.allow ? String(flags.allow) : ['mcp__trellis', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(ls:*)', ...run].join(',');
  const mcp = JSON.stringify({ mcpServers: { trellis: { command: 'node', args: [BIN, 'mcp'], env } } });

  const lines = [];
  if (worktree) lines.push(`git -C ${sq(home)} worktree add -q -b ${sq(branch)} ${sq(worktree)}`);
  lines.push(`cd ${sq(cwd)}`);
  if (agent === 'claude') {
    lines.push(`claude -p ${sq(task)} \\\n  --mcp-config ${sq(mcp)} \\\n  --allowedTools ${sq(allow)}`);
  } else if (agent === 'opencode') {
    // Config goes in the environment, not an opencode.json the agent might commit. opencode takes its
    // folder from $PWD (cd keeps it right) and waits on a non-TTY stdin, hence < /dev/null.
    const model = String(flags.model);
    const [provider, ...rest] = model.split('/');
    const config = {
      mcp: { trellis: { type: 'local', command: ['node', BIN, 'mcp'], enabled: true, environment: { ...env, TRELLIS_MODEL: rest.join('/') } } },
      permission: { bash: { 'git push*': 'deny' } },
      ...(provider === 'ollama' ? { provider: { ollama: { npm: '@ai-sdk/openai-compatible', name: 'Ollama', options: { baseURL: process.env.OLLAMA_URL || 'http://localhost:11434/v1' }, models: { [rest.join('/')]: {} } } } } : {}),
    };
    lines.push(`OPENCODE_CONFIG_CONTENT=${sq(JSON.stringify(config))} \\\n  opencode run -m ${sq(model)} ${sq(task)} < /dev/null`);
  } else {
    const envToml = `{${Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',')}}`;
    lines.push(`codex exec -s workspace-write \\\n  -c ${sq('mcp_servers.trellis.command="node"')} \\\n  -c ${sq(`mcp_servers.trellis.args=${JSON.stringify([BIN, 'mcp'])}`)} \\\n  -c ${sq(`mcp_servers.trellis.env=${envToml}`)} \\\n  ${sq(task)}`);
  }
  return { name, worktree, branch, cwd, cmd: lines.join(' && \\\n') };
}

// Keep up to --workers headless workers on waiting work in the projects the human opted in.
async function runCmd(flags) {
  const s = resolveSettings(flags);
  const agent = agentOf(flags);
  const client = createClient(flags);
  await hubProjects(client);
  const token = await agentToken(client, flags);
  const num =(v, d) => (v === undefined ? d : Number(v) > 0 ? Number(v) : (() => { throw new HubError(`expected a positive number, got "${v}"`, { hint: 'See: trellis help' }); })());
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
  console.log(`${green('●')} ${bold('trellis run')}  ${dim(`up to ${workers} ${agent} worker${workers > 1 ? 's' : ''} on opted-in projects at ${s.url}; Ctrl-C stops`)}`);
  await run({
    routes: () => client.get('/api/route?runner=1'),
    launch, workers,
    maxRuns: num(flags['max-runs'], Infinity),
    maxMinutes: num(flags['max-minutes'], Infinity),
    pollSeconds: num(flags.poll, 30),
    onInterrupt: (fn) => {
      process.on('SIGINT', () => { console.log(dim('\nStopping: no new workers; asking running ones to stop (Ctrl-C again to kill them).')); fn(); });
      process.on('SIGTERM', fn);
    },
  });
}

function init(flags) {
  const s = resolveSettings(flags);
  // Optional: pin this folder to a project. Usually unnecessary: the hub learns where projects live.
  if (flags.project) {
    const file = join(process.cwd(), '.trellis.json');
    if (existsSync(file) && !flags.force) {
      console.log(dim(`.trellis.json already exists (use --force to overwrite)`));
    } else {
      writeFileSync(file, JSON.stringify({ project: s.project, url: s.url }, null, 2) + '\n');
      console.log(green(`Wrote .trellis.json → project "${s.project}", hub ${s.url}`));
    }
  }
  const q = JSON.stringify(BIN);
  console.log(`${dim('Set up once per agent tool. No project needed: an agent working in a folder the hub knows finds its project; anywhere else, the hub routes it to the work that matters most.')}

${bold('Claude Code')}
  claude mcp add --scope user trellis -- node ${q} mcp

${bold('Codex')}  ${dim('(~/.codex/config.toml)')}
  [mcp_servers.trellis]
  command = "node"
  args = [${q}, "mcp"]

${bold('opencode')}  ${dim('(~/.config/opencode/opencode.json)')}
  "mcp": {
    "trellis": { "type": "local", "command": ["node", ${q}, "mcp"], "enabled": true }
  }

${bold('Any other MCP client')}
  command: node
  args:    [${q}, "mcp"]
  ${dim('optional env: TRELLIS_URL (if the hub is elsewhere), TRELLIS_TOKEN, TRELLIS_AGENT, TRELLIS_MODEL, TRELLIS_PROJECT (to pin one)')}

${bold('Shell-only agents')}  ${dim('(add to AGENTS.md or CLAUDE.md)')}
  This project coordinates work through Trellis. Run \`node ${q} guide\` and follow it.

${bold('Headless worker')}  ${dim('(asks the hub where work is waiting; own worktree and branch; --run starts it)')}
  node ${q} worker --agent claude --run
  node ${q} worker --agent codex --run
  node ${q} worker --agent opencode --model ollama/qwen3.8:27b-mtp-q4_K_M --run`);
}

const dbPath = (flags) => flags.db || process.env.TRELLIS_DB || join(homedir(), '.trellis', 'trellis.db');

// Load the Trellis roadmap project into a real hub database, so Trellis can be built with Trellis.
async function seedCmd(flags) {
  const { Hub } = await import('../src/core.js');
  const { seed } = await import('../src/seed.js');
  const db = dbPath(flags);
  const hub = new Hub({ file: db });
  if (hub.projects().some((p) => p.slug === 'trellis')) {
    throw new HubError(`${db} already has a "trellis" project`, { hint: 'Nothing to do. Delete that project first if you want a fresh copy.' });
  }
  await seed(hub);
  console.log(`${green('●')} Added the Trellis project to ${db}. Start the hub with: ${CLI} serve`);
}

async function serve(flags) {
  const { Hub } = await import('../src/core.js');
  const { createServer } = await import('../src/server.js');
  const host = flags.host || process.env.TRELLIS_HOST || '127.0.0.1';
  const port = Number(flags.port || process.env.TRELLIS_PORT || 4747);
  const loopback = host === 'localhost' || host === '::1' || host.startsWith('127.');
  const auth = flags.auth || !loopback ? 'required' : 'local';
  const trustProxy = !!flags['trust-proxy'];
  const db = flags.demo ? ':memory:' : dbPath(flags);
  const hub = new Hub({ file: db });
  if (flags.demo) {
    try {
      const { seed } = await import('../src/seed.js');
      await seed(hub);
    } catch (e) {
      console.warn(amber(`warning: couldn't load demo data (${e.message}); starting empty`));
    }
  }
  const server = createServer(hub, { auth, trustProxy });
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
    const authLine = auth === 'required'
      ? `${green('locked')}: browsers log in with a human token; agents send TRELLIS_TOKEN (an agent token)${trustProxy ? '; trusting X-Forwarded-* from your proxy' : ''}`
      : `${amber('open')} on loopback: no login (only this machine can reach it)`;
    console.log(`${green('●')} ${bold('Trellis')} is running at ${bold(url)}${flags.demo ? dim('  (demo data, in memory)') : dim(`  (${db})`)}
  Auth: ${authLine}
${dim(`
  Connect an agent:
    MCP (Claude Code):  claude mcp add --scope user trellis${auth === 'required' ? ' -e TRELLIS_TOKEN=<agent-token>' : ''} -- node ${JSON.stringify(BIN)} mcp   (once, for every project)
    Shell:              node ${JSON.stringify(BIN)} guide
    Setup for others:   node ${JSON.stringify(BIN)} init     (run in a project folder)
    Headless worker:    node ${JSON.stringify(BIN)} worker --agent claude|codex --run   (goes wherever work is waiting)
    Tool schemas:       ${url}/api/tools?format=openai`)}`);
  });
  const stop = () => { server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
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
    try { plain = auth.createToken(need(name, '<name>'), role, projects); } catch (e) { throw new HubError(e.message, { hint: projects.length ? 'Leave out --project for a human token.' : 'See: trellis token list' }); }
    console.log(`${green('Created')} ${role} token ${bold(name)}${projects.length ? ` for ${projects.join(', ')}` : ''}. It is shown only this once:

  ${bold(plain)}
`);
    console.log(role === 'human'
      ? dim('  Log in to the web UI with it (you will be asked when you open the hub). `trellis status` uses it too, via TRELLIS_TOKEN.')
      : dim(`  Give it to an agent as TRELLIS_TOKEN, e.g.:
    claude mcp add trellis -e TRELLIS_TOKEN=<the token above> -e TRELLIS_URL=https://your-hub -- node ${JSON.stringify(BIN)} mcp
  Agent tokens can only use agent operations, not the UI.`));
    return;
  }
  if (sub === 'list') {
    const rows = auth.listTokens();
    if (!rows.length) return console.log(dim(`No tokens in ${db}. Create one: trellis token create <name> --role human`));
    const when = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '—');
    const w = Math.max(4, ...rows.map((r) => r.name.length));
    console.log(dim(`${'id'.padEnd(4)}${'name'.padEnd(w + 2)}${'role'.padEnd(7)}${'prefix'.padEnd(11)}${'created'.padEnd(18)}${'last used'.padEnd(18)}${'status'.padEnd(9)}projects`));
    for (const r of rows) {
      const scope = r.role === 'human' ? '' : r.projects ? r.projects.split(',').join(', ') : 'all';
      console.log(`${String(r.id).padEnd(4)}${r.name.padEnd(w + 2)}${r.role.padEnd(7)}${(r.prefix + '…').padEnd(11)}${when(r.created_at).padEnd(18)}${when(r.last_used_at).padEnd(18)}${(r.revoked_at ? amber('revoked') : green('active')) + ' '.repeat(r.revoked_at ? 2 : 3)}${scope}`);
    }
    return;
  }
  if (sub === 'revoke') {
    const r = auth.revoke(need(name, '<name|id>'));
    if (!r) throw new HubError(`no token "${name}"`, { hint: 'See: trellis token list' });
    return console.log(`${green('Revoked')} ${r.role} token ${bold(r.name)}; its sessions are logged out.`);
  }
  throw new HubError('usage: trellis token create <name> --role human|agent | list | revoke <name|id>');
}

const HELP = `${bold('trellis')}: a hub where humans facilitate and AI agents coordinate work.

${bold('Human')}
  serve [--port 4747] [--host 127.0.0.1] [--db path] [--demo] [--auth] [--trust-proxy]
                                         run the hub and web UI. Loopback: no login.
                                         Any other host (or --auth): tokens required.
  token create <name> --role human|agent [--project a,b]
                                         create a token (shown once); run on the hub host.
                                         --project limits an agent token to those projects
  token list | token revoke <name|id>    see or revoke tokens (revoking logs out sessions)
  status [--all]                         the 30-second view

${bold('Agents')}  (every command takes --as <name>, --project, --url)
  checkin [--model m] [--client c]       start here: mission, decisions, steering, answers
  next [--peek]                          claim the most useful work
  claim <item> [--touching "a,b"]        claim a specific item
  progress <item> [headline] [--touching "src/db,src/api.js"]
                                         milestone update (no headline = silent heartbeat); renews your lease
  ask [<item>] <question> [--assume a] [--option x]... [--blocking]
  submit <item> <headline> [--evidence "label|url"]...
  handoff <item> <headline>              release with where you left off
  propose <title> [--acceptance] [--priority now|soon|later] [--parent] [--depends-on "#1,#2"]
  refine <item> [--title] [--acceptance] [--priority] [--depends-on]
  review <item> <accept|reject> <headline>
  comment [<item>] <headline>
  ack <steer-id> [response]
  look [<item>] [--stage s]
  signoff [headline]
  Text flags: --summary, --detail (use "-" to read from stdin)

${bold('Setup')}
  init [--force]                         write .trellis.json; print MCP config for Claude Code, Codex, opencode
  mcp                                    run the stdio MCP server (one per agent session)
  guide [--via cli|tools]                the agent guide
  tools [--format mcp|openai|anthropic] [--prefix p]   tool schemas
  worker [--agent claude|codex|opencode] [--model provider/model] [--run] [--project p] [--here] [--as name] [--allow tools]
                                         start a headless worker where work is waiting (the hub routes it),
                                         in its own git worktree and branch (--here: no worktree). Without
                                         --run it prints the command instead. opencode needs --model,
                                         e.g. ollama/qwen3.8:27b-mtp-q4_K_M (Ollama is set up for you).
                                         On a hub with login, --run needs --agent-token (or
                                         TRELLIS_AGENT_TOKEN): workers never get your own token.
  run [--workers 1] [--agent claude|codex|opencode] [--model m] [--max-runs M] [--max-minutes T] [--poll 30]
                                         keep up to N workers on waiting work in projects you opted in
                                         (UI: "Let trellis run staff this project"); exits when the
                                         queue is empty. Logs: ~/.trellis/logs. Dollar budgets: not yet.
  prompt [--as name]                     just the worker prompt text, for other agents
  seed                                   add the Trellis roadmap project to your hub's database

Env: TRELLIS_URL (default ${DEFAULT_URL}), TRELLIS_PROJECT, TRELLIS_AGENT, TRELLIS_MODEL, TRELLIS_DB,
     TRELLIS_TOKEN (a token the CLI and MCP server send to a hub that requires login)
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

  const shape = AGENT_CMDS[cmd];
  if (!shape) throw new HubError(`unknown command "${cmd}"`, { hint: 'See: trellis help' });
  const agent = flags.as || process.env.TRELLIS_AGENT;
  if (!agent) throw new HubError('who are you?', { hint: 'Pass --as <name> (e.g. --as claude-1) or set TRELLIS_AGENT. Keep the same name for your whole session.' });
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
