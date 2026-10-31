#!/usr/bin/env node
// nuworq: run the hub, connect agents, and check on projects from a terminal.
import { writeFileSync, existsSync, readFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { join, dirname, resolve, delimiter, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir, hostname, tmpdir } from 'node:os';
import { createClient, resolveSettings, repoRoot, repoRemote, checkoutOf, cloneDir, besideOf, HubError, GATEWAY, DEFAULT_URL, HUB_FILE, CONNECT_FILE } from '../src/client.js';
import { tools, guide, skill, planSkill, operatorSkill, operatorStart, TAG_ALIASES } from '../src/protocol.js';
import { envVar, dataDir, defaultDb, CONFIG_FILES } from '../src/names.js';
import { update, describeUpdate } from '../src/update.js';

const BIN = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(BIN), '..');
// How agents should invoke this CLI: the bare name only if it's really on PATH.
const ON_PATH = (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, 'nuworq')));
const CLI = ON_PATH ? 'nuworq' : `node ${JSON.stringify(BIN)}`;
const BOOL = new Set(['peek', 'blocking', 'demo', 'force', 'all', 'help', 'h', 'auth', 'trust-proxy', 'run', 'here', 'workspaces', 'follow', 'until-idle', 'off', 'browser', 'no-browser', 'no-mcp', 'early-access', 'install', 'uninstall', 'operator']);
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
// --evidence "label|url", repeatable.
const evidenceFlags = (list) => list?.map((e) => {
  const [label, ...url] = String(e).split('|');
  return clean({ label: label.trim(), url: url.join('|').trim() || undefined });
});

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
      blocking: f.blocking ? true : undefined, to: f.to,
      escalates: f.escalates, evidence: evidenceFlags(f.evidence),
    };
  },
  answer: (p) => ({ question: need(p[0], '<question-id>'), answer: need(rest(p, 1), '<answer>') }),
  withdraw: (p) => ({ question: need(p[0], '<question-id>'), reason: need(rest(p, 1), '<reason>') }),
  submit: (p, f) => ({
    item: need(p[0], '<item>'), headline: need(rest(p, 1), '<headline>'), ...layers(f), acceptance: text(f.acceptance),
    evidence: evidenceFlags(f.evidence),
  }),
  handoff: (p, f) => ({ item: need(p[0], '<item>'), headline: need(rest(p, 1), '<headline>'), ...layers(f) }),
  propose: (p, f) => ({
    title: need(rest(p, 0), '<title>'), ...layers(f), acceptance: text(f.acceptance),
    priority: f.priority, parent: f.parent, depends_on: refs(f['depends-on']), needs: refs(f.needs), size: f.size, repo: f.repo,
  }),
  refine: (p, f) => ({
    item: need(p[0], '<item>'), title: text(f.title), ...layers(f), acceptance: text(f.acceptance),
    priority: f.priority, depends_on: refs(f['depends-on']), needs: f.needs === undefined ? undefined : refs(f.needs) ?? [], size: f.size, repo: f.repo,
    drop: f.drop, // a person's answer that says to drop it (#207)
  }),
  review: (p, f) => ({ item: need(p[0], '<item>'), verdict: need(p[1], '<accept|reject>'), headline: need(rest(p, 2), '<headline>'), attempt: f.attempt, ...layers(f) }),
  comment: (p, f) => {
    const item = isRef(p[0]) && p.length > 1 ? p[0] : undefined;
    return { item, headline: need(rest(p, item ? 1 : 0), '<headline>'), ...layers(f) };
  },
  ack: (p) => ({ steer: need(p[0], '<steer-id>'), response: rest(p, 1) }),
  feedback: (p, f) => ({ text: need(text(rest(p, 0) ?? f.text), '<what happened>'), item: f.item }),
  look: (p, f) => ({ item: p[0], stage: f.stage }),
  signoff: (p, f) => ({ headline: rest(p, 0), summary: text(f.summary) }),
};

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c('1'), dim = c('2'), amber = c('33'), green = c('32'), grey = c('90');
const stateColor = (s) => ({ 'needs-you': amber, flowing: green, stalled: amber }[s] ?? grey);
// --site-host (NUWORQ_SITE_HOST) once had the hub serve the landing page; old units may still pass it (#164).
const ignoreSiteHost = (flags) => {
  if (flags['site-host'] || envVar('SITE_HOST')) console.warn(amber('--site-host is ignored: nuworq.com is served from nuworq-site now, not by the hub.'));
};

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
  // Who is here (#238): role, where it runs, its current job.
  for (const a of (v.agents ?? []).filter((x) => ['working', 'quiet', 'idle'].includes(x.status))) {
    console.log(`  ${a.role[0].toUpperCase()}${a.role.slice(1)}${a.where ? ` · ${a.where}` : ''}${a.job ? ` — ${a.job}` : ''}  ${dim(a.name)}`);
  }
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
    ? 'For each item the hub names a branch: create it from the latest main on origin with \`git fetch origin\`, then \`git switch -c <branch> origin/main\`, or \`git switch <branch>\` if it exists. Push it (\`git push origin <branch>\`) before you submit.'
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
    // The agent CLIs this machine can run, so items that need one (e.g. a check with a real headless Claude) find it.
    onPath('claude') && 'claude-cli',
    onPath('codex') && 'codex-cli',
    onPath('opencode') && 'opencode',
    onPath('gh') && 'gh',
    flags.browser && 'browser', // --browser: the worker gets one (workerSetup)
    ...(refs(flags.has) ?? []),
  ].filter(Boolean).map((t) => String(t).toLowerCase()))];
}

// An operator session (see Operators in the guide): the tags to declare and the line that starts an attended
// Claude Code session in the project folder as the operator (the nuworq-operator skill, which starts its
// listener; no /loop). It prints them and starts nothing. Detected: the platform, and browser when a Chrome or
// Chromium is installed; --has replaces what was detected.
function operatorCmd(flags) {
  const project = resolveSettings(flags).project ?? basename(process.cwd());
  const onPath = (cmd) => (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, cmd)));
  const chrome = ['/Applications/Google Chrome.app', '/Applications/Chromium.app'].some((a) => existsSync(a))
    || ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].some(onPath);
  const detected = [{ darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform], chrome && 'browser'].filter(Boolean);
  const given = (flags.has ? refs(flags.has) ?? [] : detected).map((t) => String(t).toLowerCase());
  const has = ['operator', ...new Set(given.map((t) => TAG_ALIASES[t] ?? t).filter((t) => t !== 'operator'))];
  const renamed = [...new Set(given.filter((t) => TAG_ALIASES[t]))].map((t) => `${t} is now ${TAG_ALIASES[t]}`);
  if (renamed.length) console.log(dim(`Tag renamed: ${renamed.join(', ')}.`));
  console.log(`${bold('Declare:')} ${has.join(', ')}${flags.has ? '' : dim('  (detected; add what else this session can really do with --has, e.g. --has macos,browser,claude-cli,infra)')}
${dim('infra: the live infrastructure of the project the session checks in to (servers and VMs, DNS, cloud accounts, deploys).')}
${bold('Start it:')} open Claude Code in ${project}'s folder (the terminal or the desktop app's Code tab) and type:

${operatorStart(has)}

It works until nothing waits, then stays idle and listens: each new operator item, operator question or answer
starts a turn on its own. No /loop.${dim(' (With the nuworq plugin it is also /nuworq:nuworq-operator.)')}`);
}

// An operator waiting on the hub (#283): one line when there is something for it, then exit; --follow
// keeps waiting and prints a line per event. Lines are the hub's ids and kinds, never what anyone wrote.
async function waitCmd(flags) {
  if (!flags.operator) throw new HubError('wait for what?', { hint: 'Only operators wait: nuworq wait --operator [--follow].' });
  // Unnamed (a watcher beside the session can't know its name): the operators that checked in with this token.
  const agent = flags.as || envVar('AGENT') || '';
  const { describeEvent } = await import('../src/wait.js');
  // Unnamed, it says which session started it (#335), so it wakes that session's operator, not every one on the token.
  // --follow retries a hub that is away itself (below), for as long as it takes, so the client's own short retry is off.
  const { listenerKeys } = await import('../src/session.js');
  const client = createClient({ ...flags, session: agent ? [] : listenerKeys(), ...(flags.follow ? { retryMs: 0 } : {}) });
  // --follow started beside a session that hasn't checked in yet: no operator on this token is "not yet"
  // for a couple of minutes, retried quietly. Any other refusal ends it at once.
  const settle = Number(flags['settle-ms']) || 120_000, until = Date.now() + settle;
  // #342: the hub restarts on every merge to main. With --follow, a proxy's 502/503/504 (or Cloudflare's 52x/530) or a refused, dropped
  // or timed-out connection is waited out with backoff (about 2 s doubling to 30 s), quietly and keeping
  // `since`, so nothing is lost or repeated. Away for long (10 minutes), it says so once and keeps trying.
  const first = Number(flags['retry-ms']) || 2000, cap = 15 * first, longMs = Number(flags['down-ms']) || 600_000;
  let away = null, told = false;
  for (let since = 0, backoff = first; ;) {
    let r;
    try {
      r = await client.wait({ since, timeout: Number(flags.timeout) || undefined, all: !!flags['all-projects'] }, { agent });
    } catch (e) {
      if (flags.follow && e instanceof HubError && (e.status === 0 || GATEWAY.has(e.status))) {
        away ??= Date.now();
        if (!told && Date.now() - away >= longMs) {
          told = true;
          console.log(`nuworq: hub at ${client.settings.url} unreachable for ${Math.max(1, Math.round((Date.now() - away) / 60_000))} min; still trying.`);
        }
        await new Promise((res) => setTimeout(res, backoff));
        backoff = Math.min(backoff * 2, cap);
        continue;
      }
      if (!flags.follow || agent || e.status !== 403 || !/^no operator has checked in/.test(e.message) || Date.now() >= until) throw e;
      await new Promise((res) => setTimeout(res, Math.min(settle / 12, Math.max(0, until - Date.now()))));
      continue;
    }
    away = null, told = false, backoff = first;
    since = r.at;
    for (const e of r.events) console.log(describeEvent(e));
    if (r.events.length && !flags.follow) return;
  }
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
  // Codex would take the server the same way, but its sandbox keeps it from serving the app to look at.
  if (flags.browser && agent !== 'claude') {
    throw new HubError('--browser is for Claude workers only', { hint: 'Use --agent claude --browser, or leave out --browser.' });
  }
  // Through llm-proxy: opencode with --model proxy/<model> (its OpenAI Chat Completions, /v1, with a personal key),
  // Claude Code and Codex with --proxy (its provider routes, /anthropic and /openai). Provider routes answer only
  // the proxy's owner token, and only on its LAN or tailnet address: on its public hostname they answer 403.
  const proxied = String(flags.model ?? '').startsWith('proxy/');
  if (flags.proxy === undefined && !proxied) return agent;
  if (agent !== 'opencode' && proxied) throw new HubError(`--agent ${agent} doesn't take a proxy/<model> model`, { hint: `Give --agent ${agent} --proxy http://host:4100: it goes through llm-proxy's ${agent === 'claude' ? 'Anthropic' : 'OpenAI'} route with its own models.` });
  if (agent === 'opencode' && !proxied) throw new HubError('--proxy needs a proxy/<model> model', { hint: 'e.g. --agent opencode --model proxy/gpt-5 --proxy http://studio.local:8080' });
  if (!/^https?:\/\/[^/]/.test(proxyUrl(flags))) {
    throw new HubError(`${proxied ? '--model proxy/<model>' : '--proxy'} needs llm-proxy's address`, {
      hint: proxied ? 'Give --proxy http://host:port (or set NUWORQ_LLM_PROXY_URL), and its key in NUWORQ_LLM_PROXY_KEY.'
        : "Give --proxy with llm-proxy's LAN or tailnet address (e.g. http://studio.local:4100), and its owner token in NUWORQ_LLM_PROXY_TOKEN.",
    });
  }
  return agent;
}

// llm-proxy's address for workers: --proxy, else NUWORQ_LLM_PROXY_URL; without a trailing slash or /v1.
const proxyUrl = (flags) => String((typeof flags.proxy === 'string' ? flags.proxy : envVar('LLM_PROXY_URL')) ?? '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');

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
  // With several repositories: the one holding this project's most useful work for this machine.
  if ((target.remotes ?? []).length > 1 && !flags.here) {
    const routes = await client.get(`/api/route?has=${encodeURIComponent(tags.join(','))}`);
    target = { ...target, repo: routes.find((r) => r.project === target.slug)?.repo ?? null };
  }
  const token = flags.run ? await agentToken(client, flags) : null;
  const { name, worktree, main, origin, cwd, cmd } = await setupOrClone(target, agent, flags, s, client, token);

  console.log(`${bold(`${name} → ${target.name}`)}${why ? dim(`  (${why})`) : ''}
${dim(worktree ? `Works in its own worktree ${worktree}, detached at ${main}. Each item it claims gets its own branch (the hub names it), made from the latest ${main}. When it's done: git worktree remove ${sq(worktree)}` : `Works in ${cwd}.`)}`);
  if (!flags.run) {
    console.log(`\n${cmd}\n`);
    console.log(dim({
      claude: `Headless agents can't ask permission: they may only use the tools in --allowedTools (set from what's in the folder; change with --allow). ${origin ? 'Pushes go to origin only: item branches, and landing one on main (GitHub keeps main fast-forward-only).' : 'Never git push.'}`,
      codex: `Codex runs in its workspace-write sandbox; the nuworq MCP server runs outside it, so it can reach the hub.`,
      opencode: `opencode has no sandbox: it may run any shell command except git push (denied). Use a model that calls tools well; see docs/OPEN-WEIGHT.md.`,
    }[agent] + '\nAdd --run to start it now.'));
    if (s.token) console.log(dim('Replace <agent-token> with an agent token (nuworq token create <name> --role agent --project <p>). With --run, pass it as --agent-token.'));
    return;
  }
  const { spawn } = await import('node:child_process');
  const child = spawn('/bin/sh', ['-c', cmd], { stdio: ['inherit', 'pipe', 'inherit'] });
  const usage = await tapUsage(child, agent, flags, (l) => console.log(l));
  await new Promise((done) => child.on('close', (code) => { process.exitCode = code ?? 1; done(); }));
  await reportUsage(s, token, target.slug, name, usage());
}

// Reads the agent's JSON output as it comes: what's worth reading goes to show(), usage is tallied.
async function tapUsage(child, agent, flags, show) {
  const { tap, lines } = await import('../src/usage.js');
  const t = tap(agent, { model: flags.model ? String(flags.model) : '' });
  const split = lines((l) => { const out = t.line(l); if (out != null) show(out); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => split.write(c));
  child.stdout.on('end', () => split.end());
  return () => t.usage();
}

// Recorded against the items the worker held; a hub that can't be reached only costs the record.
async function reportUsage(s, token, project, name, usage) {
  if (!usage) return;
  try {
    await createClient({ url: s.url, token: token ?? s.token }).call('usage', { usage }, { agent: name, project });
  } catch (e) {
    console.error(dim(`Couldn't record ${name}'s usage: ${e.message}`));
  }
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

// Where a worker on target works: this folder with --here; the project's folder if it is on this
// machine; else this machine's checkout of the project's repository, found by remote (a hub on a
// server knows projects by remote, and has no folder for them here); with neither, this folder.
// target.repo: in a project with several repositories, the one its most useful work is in: the
// project's folder only when that is a clone of it, else this machine's checkout of it.
function homeOf(target, flags) {
  if (flags.here) return process.cwd();
  if (target.repo) {
    const recorded = target.path && existsSync(target.path) ? repoRemote(target.path) : '';
    return recorded === target.repo ? target.path : checkoutOf([target.repo]);
  }
  if (target.path && existsSync(target.path)) return target.path;
  if (target.remotes?.length) return checkoutOf(target.remotes);
  if (target.path) {
    throw new HubError(`${target.name} lives in ${target.path}, which doesn't exist on this machine`, { hint: 'Run the worker from a clone of its repository with --here.' });
  }
  return process.cwd();
}

// No checkout of the project here: clone it (#86), so the worker can start. A path remote clones from the
// path; a GitHub one over HTTPS through the hub's GitHub App, when the hub has one. The token reaches git
// only through the credential helper: never in argv, the remote URL or .git/config. Otherwise, or when the
// clone fails, a HubError with the clone command as its hint, as before. Returns the clone's folder.
async function cloneHome(target, flags, s, client, token, missing) {
  const remote = missing.missing;
  const github = /^github\.com\/[^/]+\/[^/]+$/.test(remote);
  if (flags.here || !(remote.startsWith('/') || github)) throw missing;
  if (github) {
    const info = await client.get('/api/info').catch(() => ({}));
    if (!info.github_app || info.github_app === 'create') throw missing;
  }
  const dir = cloneDir(remote);
  const cant = (why) => new HubError(`Couldn't clone ${remote} into ${dir}: ${why}`, { hint: missing.hint });
  if (existsSync(dir)) throw cant('something else is there');
  const helper = `!node ${JSON.stringify(BIN)} git-credential --project ${target.slug}`;
  try {
    execFileSync('git', ['-c', 'credential.https://github.com.helper=', '-c', `credential.https://github.com.helper=${helper}`, '-c', 'credential.https://github.com.useHttpPath=true',
      'clone', '-q', github ? `https://${remote}.git` : remote, dir], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', NUWORQ_URL: s.url, ...(token ?? s.token ? { NUWORQ_TOKEN: token ?? s.token } : {}) },
    });
  } catch (e) {
    throw cant(String(e.stderr ?? e.message).trim().split('\n').filter(Boolean).pop() ?? 'git clone failed');
  }
  console.log(`Cloned ${remote} into ${dir}`);
  return dir;
}

// workerSetup, cloning the project first when this machine has no checkout of it.
async function setupOrClone(target, agent, flags, s, client, token) {
  try {
    return workerSetup(target, agent, flags, s, token);
  } catch (e) {
    if (!(e instanceof HubError) || !e.missing) throw e;
    await cloneHome(target, flags, s, client, token, e);
    return workerSetup(target, agent, flags, s, token);
  }
}

// How a worker's model traffic names itself to llm-proxy: nuworq/<project>/<agent>.
const clientLabel = (project, agent) => `nuworq/${project}/${agent}`;

// The custom model provider Codex is set to use (model_provider in ~/.codex/config.toml), or null for its
// built-in one. Only the top-level key counts, not one inside a [profile] table.
function codexProvider(flags) {
  if (flags['codex-provider']) return String(flags['codex-provider']);
  let text = '';
  try { text = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8'); } catch { return null; }
  const top = text.split(/^\s*\[/m)[0];
  const p = top.match(/^\s*model_provider\s*=\s*"([^"]+)"/m)?.[1];
  return p && p !== 'openai' && /^[\w-]+$/.test(p) ? p : null;
}

// What a worker started with --browser gets: Playwright's MCP server (pinned) driving this machine's Google
// Chrome, headless, with a throwaway profile kept in memory, opening local pages only. Playwright says that
// origin list is no security boundary (redirects aren't checked). Screenshots go to a temp folder, never the worktree.
// Its one tool that runs code in the server process, outside the allowlist, is denied (Playwright: "RCE-equivalent").
const PLAYWRIGHT_MCP = '@playwright/mcp@0.0.83';
const BROWSER_DENY = 'mcp__playwright__browser_run_code_unsafe';
const browserServer = (name) => ({
  command: 'npx',
  args: ['-y', PLAYWRIGHT_MCP, '--headless', '--browser', 'chrome', '--isolated',
    '--allowed-origins', 'http://127.0.0.1:*;http://localhost:*', '--output-dir', join(tmpdir(), 'nuworq-browser', name)],
});

// A Claude worker runs only what the runner gives it (#360). --strict-mcp-config drops the person's own MCP
// servers; plugins come from settings, so every plugin installed on this machine is turned off for the worker.
// Otherwise one installed for a checkout (--scope local) follows into every worktree of it, with its own MCP
// server (a second, unscoped nuworq identity), skills and tool definitions in each worker's context.
function workerSettings() {
  let plugins = {};
  try {
    const file = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'plugins', 'installed_plugins.json');
    plugins = JSON.parse(readFileSync(file, 'utf8')).plugins ?? {};
  } catch { /* none installed */ }
  return JSON.stringify({ enabledPlugins: Object.fromEntries(Object.keys(plugins).map((p) => [p, false])) });
}

// The shell command that gives a worker its worktree (detached at main, or at origin/main after a
// fetch when there is an origin; reused if it exists) and starts the agent in it.
// token: the agent token the worker gets when it runs (null: the hub needs none, or we only print).
// --here: work in this folder (a clone of the project), whatever folder the hub has on record.
function workerSetup(target, agent, flags, s, token = null) {
  const home = homeOf(target, flags);

  const name = String(flags.as || `${agent}-${randomBytes(2).toString('hex')}`);
  const isRepo = existsSync(join(home, '.git'));
  // With an origin (GitHub), work starts from main there and lands by pushing to it.
  const origin = isRepo && hasOrigin(home);
  const worktree = isRepo && !flags.here ? join(`${home}.worktrees`, name) : null;
  const main = isRepo ? mainBranch(home) : 'main';
  const cwd = worktree ?? home;
  const has = (f) => existsSync(join(home, f));
  const browser = agent === 'claude' && !!flags.browser; // --browser: a headless Chrome to look at UI work with
  const tags = detectHas(flags);
  const env = {
    NUWORQ_URL: s.url, NUWORQ_PROJECT: target.slug, NUWORQ_AGENT: name,
    ...(tags.length ? { NUWORQ_HAS: tags.join(',') } : {}),
    // A worker nuworq run started says so at checkin, with its runner (#238); a runner's token says it too.
    ...(flags.run ? { NUWORQ_ROLE: 'worker', NUWORQ_RUNNER: hostname() } : {}),
    ...(token ? { NUWORQ_TOKEN: token } : s.token && !flags.run ? { NUWORQ_TOKEN: '<agent-token>' } : {}),
  };
  const task = [
    `Work on the ${target.name} project using nuworq (project: ${target.slug}). Do the work in this directory.`,
    worktree && origin ? `You work in your own git worktree, ${worktree}. For each item, the hub names a branch: create it from the latest ${main} on origin with \`git fetch origin\`, then \`git switch -c <branch> origin/${main}\`, or \`git switch <branch>\` if it exists. Commit your work there, push the branch before you submit (\`git push origin <branch>\`), and include the branch and commit in your evidence. To land accepted work, follow the hub's steps: rebase onto origin/${main}, run the checks, then \`git push origin <branch>:${main}\`. Never work in the main checkout, ${home}.`
      : worktree ? `You work in your own git worktree, ${worktree}. For each item, the hub names a branch: create it from the latest ${main} with \`git switch -c <branch> ${main}\`, or \`git switch <branch>\` if it exists. Commit your work there, and include the branch and commit in your evidence when you submit. Never work in the main checkout, ${home}.` : '',
    browser && (has('bin/nuworq.js')
      ? 'To check UI work, start a local nuworq with demo data from this worktree on a free port: run `node bin/nuworq.js serve --demo --port 0` in the background; it prints its address, and on loopback it needs no login. When you ship a visible UI feature, add its key with today\'s date to web/new.js and data-new="<key>" to its element, so people see it\'s new.'
      : 'To check UI work, start the app from this worktree on a free local port, in the background.'),
    browser && 'Then look at it with the browser tools (mcp__playwright: local pages only) at desktop width and at 375px wide (browser_resize); the app is light only, so there is no dark mode to check. Take each screenshot without a file name, look at it, and describe in your evidence what you saw. Stop the server when you are done.',
    'While you work, run only the tests that cover what you change; run the full test suite once, just before you submit.',
    'Keep going until next says there is nothing left for you, then sign off.',
  ].filter(Boolean).join(' ');

  const run = [
    has('package.json') && ['Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(node:*)'],
    (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) && ['Bash(python3:*)', 'Bash(pytest:*)'],
    has('Cargo.toml') && ['Bash(cargo:*)'],
    has('go.mod') && ['Bash(go:*)'],
    isRepo && ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git switch:*)'],
    // Landing: rebase onto main, then fast-forward main in this one checkout. Nothing else with -C.
    isRepo && ['Bash(git rebase:*)', `Bash(git -C ${home} merge --ff-only:*)`],
    // Through origin: push the item's branch, and land it with git push origin <branch>:main. Claude Code
    // matches allowed commands at word boundaries, so the rule is "git push origin"; main itself is kept
    // fast-forward-only by the repository's rules on GitHub (no force-push, no delete).
    origin && ['Bash(git fetch:*)', 'Bash(git push origin:*)'],
  ].filter(Boolean).flat();
  const allow = [...(flags.allow ? [String(flags.allow)] : ['mcp__nuworq', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(ls:*)', ...run]),
    ...(browser ? ['mcp__playwright'] : [])].join(',');
  const mcp = JSON.stringify({ mcpServers: { nuworq: { command: 'node', args: [BIN, 'mcp'], env }, ...(browser ? { playwright: browserServer(name) } : {}) } });

  // The worktree first. `nuworq run` runs this part on its own, so a checkout that can't be updated is told
  // apart from an agent that fails.
  const setup = [];
  if (worktree && origin) {
    // A fetch over HTTPS from GitHub gets a read-only token for the project's repository from the hub's
    // GitHub App: the worker holds no item yet. git asks its own helpers first, and SSH needs none.
    const reader = `!NUWORQ_URL=${s.url}${token ? ` NUWORQ_TOKEN=${token}` : ''} node ${JSON.stringify(BIN)} git-credential --project ${target.slug} --as ${name}`;
    setup.push(`git -C ${sq(home)} -c ${sq(`credential.https://github.com.helper=${reader}`)} -c credential.https://github.com.useHttpPath=true fetch -q origin`,
      `{ [ -d ${sq(worktree)} ] || git -C ${sq(home)} worktree add -q --detach ${sq(worktree)} ${sq(`origin/${main}`)}; }`);
  } else if (worktree) setup.push(`{ [ -d ${sq(worktree)} ] || git -C ${sq(home)} worktree add -q --detach ${sq(worktree)} ${sq(main)}; }`);
  const lines = [`cd ${sq(cwd)}`];
  // Pushes over HTTPS to GitHub get a one-repo, one-hour token from the hub's GitHub App, asked for by git
  // itself: this worker's processes only (no config file changes), and the agent never sees the token.
  if (origin) {
    const helper = `!NUWORQ_URL=${s.url}${token ? ` NUWORQ_TOKEN=${token}` : ''} node ${JSON.stringify(BIN)} git-credential --as ${name}`;
    lines.push(`export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=credential.https://github.com.helper GIT_CONFIG_VALUE_0=${sq(helper)} GIT_CONFIG_KEY_1=credential.https://github.com.useHttpPath GIT_CONFIG_VALUE_1=true`);
  }
  // Workers each running a Node project's whole suite on every core at once saturate the machine: their test
  // runs take at most 2 files at a time (unless the operator set otherwise). Node refuses --test-concurrency in
  // NODE_OPTIONS, so the project's test script reads this (nuworq's own does: scripts/run-tests.js).
  if (has('package.json')) lines.push('export NUWORQ_TEST_CONCURRENCY=${NUWORQ_TEST_CONCURRENCY:-2}');
  // Started here (--run), the agent speaks JSON, so its usage can be read and recorded (src/usage.js tap).
  const json = flags.run ? { claude: ' \\\n  --output-format stream-json --verbose', codex: ' --json', opencode: ' --format json' }[agent] : '';
  // Model traffic says who it is, so llm-proxy (when it goes through one) can be read per worker (#76).
  // Other endpoints ignore the header.
  const label = clientLabel(target.slug, name);
  if (agent === 'claude') {
    const headers = [process.env.ANTHROPIC_CUSTOM_HEADERS, `x-client-name: ${label}`].filter(Boolean).join('\n');
    // --proxy: Claude Code's traffic goes to llm-proxy's Anthropic route with the proxy's owner token (not the
    // hub's read-only NUWORQ_LLM_PROXY_KEY). The shell expands it, so it's never in argv or printed.
    const via = flags.proxy === undefined ? '' : `ANTHROPIC_BASE_URL=${sq(`${proxyUrl(flags)}/anthropic`)} ANTHROPIC_AUTH_TOKEN="$NUWORQ_LLM_PROXY_TOKEN" \\\n  `;
    lines.push(`${via}ANTHROPIC_CUSTOM_HEADERS=${sq(headers)} \\\n  claude -p ${sq(task)}${json} \\\n  --mcp-config ${sq(mcp)} --strict-mcp-config \\\n  --settings ${sq(workerSettings())} \\\n  --allowedTools ${sq(allow)}${browser ? ` \\\n  --disallowedTools ${sq(BROWSER_DENY)}` : ''}`);
  } else if (agent === 'opencode') {
    // Config goes in the environment, not an opencode.json the agent might commit. opencode takes its
    // folder from $PWD (cd keeps it right) and waits on a non-TTY stdin, hence < /dev/null.
    const model = String(flags.model);
    const [provider, ...rest] = model.split('/');
    const headers = { 'x-client-name': label };
    const config = {
      mcp: { nuworq: { type: 'local', command: ['node', BIN, 'mcp'], enabled: true, environment: { ...env, NUWORQ_MODEL: rest.join('/') } } },
      permission: { bash: { 'git push*': 'deny' } },
      provider: provider === 'ollama'
        ? { ollama: { npm: '@ai-sdk/openai-compatible', name: 'Ollama', options: { baseURL: process.env.OLLAMA_URL || 'http://localhost:11434/v1', headers }, models: { [rest.join('/')]: {} } } }
        // The key spends money: opencode reads it from the worker's environment, so it's in neither argv nor this config.
        : provider === 'proxy'
          ? { proxy: { npm: '@ai-sdk/openai-compatible', name: 'llm-proxy', options: { baseURL: `${proxyUrl(flags)}/v1`, apiKey: '{env:NUWORQ_LLM_PROXY_KEY}', headers }, models: { [rest.join('/')]: {} } } }
          : { [provider]: { options: { headers } } }, // merged with the provider's own config
    };
    lines.push(`OPENCODE_CONFIG_CONTENT=${sq(JSON.stringify(config))} \\\n  opencode run${json} -m ${sq(model)} ${sq(task)} < /dev/null`);
  } else {
    const envToml = `{${Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',')}}`;
    // Codex's built-in openai provider takes no headers; a custom one (how traffic reaches llm-proxy) does.
    // --proxy: a provider of its own for llm-proxy's OpenAI route (Responses), keyed by the owner token from the
    // worker's environment (env_key), so the token is never in argv or printed.
    const provider = flags.proxy === undefined ? codexProvider(flags) : null;
    const named = flags.proxy !== undefined
      ? ` \\\n  -c ${sq('model_provider="llmproxy"')} \\\n  -c ${sq(`model_providers.llmproxy={name="llm-proxy",base_url=${JSON.stringify(`${proxyUrl(flags)}/openai/v1`)},env_key="NUWORQ_LLM_PROXY_TOKEN",wire_api="responses",http_headers={"x-client-name"=${JSON.stringify(label)}}}`)}`
      : provider ? ` \\\n  -c ${sq(`model_providers.${provider}.http_headers={"x-client-name"=${JSON.stringify(label)}}`)}` : '';
    lines.push(`codex exec${json} -s workspace-write \\\n  -c ${sq('mcp_servers.nuworq.command="node"')} \\\n  -c ${sq(`mcp_servers.nuworq.args=${JSON.stringify([BIN, 'mcp'])}`)} \\\n  -c ${sq('mcp_servers.nuworq.default_tools_approval_mode="approve"')} \\\n  -c ${sq(`mcp_servers.nuworq.env=${envToml}`)}${named} \\\n  ${sq(task)}`);
  }
  return {
    name, worktree, main: origin ? `origin/${main}` : main, origin, cwd,
    checkout: setup.join(' && '), start: lines.join(' && \\\n'), cmd: [...setup, ...lines].join(' && \\\n'),
  };
}

// `nuworq run --install [run flags]`: the same runner as a LaunchAgent (macOS) or systemd user unit (Linux), so
// it outlives the terminal and comes back after a reboot. --uninstall stops and removes it (#172).
async function runService(flags) {
  const svc = await import('../src/service.js');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { userInfo } = await import('node:os');
  const exec = (cmd, args) => promisify(execFile)(cmd, args);
  const where = { platform: process.platform, home: homedir(), uid: userInfo().uid, exec };
  if (flags.uninstall) {
    const r = await svc.uninstall(where).catch((e) => { throw new HubError(e.message, { hint: e.hint }); });
    return console.log(r.removed ? `${green('Removed')} the ${r.kind} ${dim(r.file)}: the runner has stopped.` : dim(`No runner was installed (${r.file}).`));
  }
  let args;
  try { args = svc.serviceArgs(process.argv.slice(3)); } catch (e) { throw new HubError(e.message, { hint: e.hint }); }
  const log = join(dirname(HUB_FILE), 'logs', 'run.log');
  // It starts where it was installed and looks for checkouts beside this one, as `nuworq run` typed here does (#225).
  const cwd = process.cwd();
  const env = svc.serviceEnv(process.env, { repos: besideOf(cwd) });
  const r = await svc.install({ ...where, command: [svc.stableNode(process.execPath), BIN, 'run', ...args], env, log, cwd })
    .catch((e) => { throw new HubError(e.message, { hint: e.hint ?? 'Run it without --install to see what goes wrong.' }); });
  // Loaded isn't running (#250): only report success once the runner is up.
  if (!r.up) process.exitCode = 1;
  console.log(`${r.up ? `${green('●')} Installed ${bold('nuworq run')} as a ${r.kind}, and the runner is up: it runs now, after every reboot, and again if it stops.`
    : `${amber('!')} Installed ${bold('nuworq run')} as a ${r.kind}, but the runner isn't up after 10 seconds. Check on it with: ${r.status}\n  and read the log below for why it stopped.`}
  Runs in: ${cwd}  ${dim(`(checkouts: ${env.NUWORQ_REPOS ?? env.TRELLIS_REPOS})`)}
  Wrote:   ${r.file}
  Log:     ${r.log}
  Remove:  ${r.uninstall}${process.platform === 'linux' ? `\n  ${dim('To keep it running while you are logged out: loginctl enable-linger')}` : ''}`);
  // Opted-in projects it couldn't work on from there: say so now, with the fix, not later in the log.
  const projects = await createClient(flags).get('/api/projects').catch(() => null);
  if (!projects) return console.log(dim(`  Couldn't reach the hub to check this machine has checkouts of its projects.`));
  const roots = env.NUWORQ_REPOS ?? env.TRELLIS_REPOS ?? '';
  const missing = svc.missingCheckouts(projects, (remotes) => checkoutOf(remotes, { cwd, roots }));
  if (!missing.length) return;
  console.log(`\n${amber('!')} No checkout here of ${missing.length === 1 ? 'an opted-in project' : `${missing.length} opted-in projects`}. The runner clones ${missing.length === 1 ? 'it' : 'them'} when the hub's GitHub App can, and otherwise skips ${missing.length === 1 ? 'it' : 'them'}. To clone yourself:`);
  for (const m of missing) console.log(`  ${bold(m.name ?? m.slug)} (${m.remote})\n    ${m.hint}`);
  console.log(dim(`  Then run nuworq run --install again from here, or install it with NUWORQ_REPOS=<the folder holding your checkouts>.`));
}

// Keep up to --workers headless workers on waiting work in the projects the human opted in.
async function runCmd(flags) {
  if (flags.install || flags.uninstall) return runService(flags);
  const s = resolveSettings(flags);
  const agent = agentOf(flags);
  const client = createClient(flags);
  await hubProjects(client);
  const token = await agentToken(client, flags);
  const num =(v, d) => (v === undefined ? d : Number(v) > 0 ? Number(v) : (() => { throw new HubError(`expected a positive number, got "${v}"`, { hint: 'See: nuworq help' }); })());
  const { spawn, execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { createWriteStream } = await import('node:fs');
  const { run, cleanWorktree } = await import('../src/runner.js');
  const logs = join(dirname(HUB_FILE), 'logs');
  mkdirSync(logs, { recursive: true });

  const launch = async (r) => {
    const projects = await hubProjects(client);
    const target = projects.find((p) => p.slug === r.project);
    if (!target) throw new HubError(`the hub no longer has project "${r.project}"`);
    // The route names the repository of the work it found; with several, the worker starts there.
    const repo = (target.remotes ?? []).length > 1 ? r.repo : null;
    let setup;
    try {
      setup = await setupOrClone({ ...target, repo }, agent, { ...flags, as: undefined, run: true }, s, client, token);
    } catch (e) {
      // This machine can't work on the project (no checkout of it here): the runner leaves it to others.
      if (e instanceof HubError) e.skip = true;
      throw e;
    }
    const { name, worktree, cwd, checkout, start } = setup;
    const log = join(logs, `${name}.log`);
    // Its worktree, at the latest main. When git can't do that (e.g. it can't reach origin), the agent never
    // starts: the runner leaves the project alone for a while and the others go on.
    if (checkout) {
      try {
        await promisify(execFile)('/bin/sh', ['-c', checkout], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 5 * 60_000 });
      } catch (e) {
        const err = String(e.stderr || e.message).trim();
        writeFileSync(log, `${err}\n`);
        const said = err.split('\n').find((l) => /^(fatal|error):/.test(l)) ?? err.split('\n').pop();
        throw Object.assign(new HubError(`couldn't update its checkout: ${said}`, { hint: `log: ${log}` }), { skip: true, pause: true });
      }
    }
    const out = createWriteStream(log);
    // Its own process group, so stopping it stops the agent too, not just the shell.
    const child = spawn('/bin/sh', ['-c', start], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const usage = await tapUsage(child, agent, flags, (l) => out.write(`${l}\n`));
    child.stderr.pipe(out, { end: false });
    return {
      name, project: target.slug, where: dim(`${worktree ?? cwd}  log: ${log}`),
      kill: (sig) => { try { process.kill(-child.pid, sig); } catch {} },
      exited: new Promise((done) => child.on('close', async (code, sig) => {
        out.end();
        await reportUsage(s, token, target.slug, name, usage());
        // Its worktree goes with it, unless something there would be lost.
        if (worktree) {
          const git = async (args) => (await promisify(execFile)('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout;
          const r = await cleanWorktree(worktree, git).catch((e) => ({ kept: true, why: `git couldn't remove it (${String(e.stderr || e.message).trim().split('\n')[0]})` }));
          if (r.kept) console.log(dim(`  kept ${name}'s worktree, ${worktree}: ${r.why}`));
        }
        done(code ?? (sig ? `${sig}` : 1));
      })),
      spent: () => usage()?.cost_usd ?? 0, // what its CLI said it cost, for --max-usd
    };
  };

  const workers = num(flags.workers, 1);
  const reporter = createClient({ url: s.url, token: token ?? s.token });
  console.log(`${green('●')} ${bold('nuworq run')}  ${dim(`up to ${workers} ${agent} worker${workers > 1 ? 's' : ''} on opted-in projects at ${s.url}; Ctrl-C stops`)}`);
  await run({
    // Only work this machine can do (its fit tags), so no worker is started for work it can't take.
    routes: () => client.get(`/api/route?runner=1&has=${encodeURIComponent(detectHas(flags).join(','))}`),
    launch, workers,
    // How this runner is, on every poll (#171), with the workers' agent token: a runner token names the runner.
    report: (state) => reporter.post('/api/runner', { name: hostname(), machine: hostname(), ...state }),
    // Asked of the hub, not the routes: a quick worker can claim and exit between two polls. A minute
    // of slack covers clocks that differ.
    claimed: async (w) => (await client.get(`/api/claims?agent=${encodeURIComponent(w.name)}&since=${w.started - 60_000}`)).claims > 0,
    maxRuns: num(flags['max-runs'], Infinity),
    untilIdle: !!flags['until-idle'],
    maxMinutes: num(flags['max-minutes'], Infinity),
    maxUsd: num(flags['max-usd'], Infinity),
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

const readConnection = () => { try { return JSON.parse(readFileSync(CONNECT_FILE, 'utf8')); } catch { return null; } };

// Revoke the saved token on its hub. Says so when the hub can't be reached; the file goes anyway.
async function revokeSaved(c) {
  if (!c?.url || !c.token) return null;
  try {
    const r = await createClient({ url: c.url, token: c.token, retryMs: 0 }).post('/api/me/revoke', {});
    return r.revoked ? `Revoked the token ${r.revoked} on ${c.url}.` : null;
  } catch (e) {
    return e.status === 401 ? null : amber(`Couldn't revoke the token on ${c.url} (${e.message}); revoke it there: nuworq token revoke <name>.`);
  }
}

// A device login: the hub shows a code, a person approves it in the browser, the CLI collects a token.
async function deviceLogin(url, flags) {
  const hub = createClient({ url, token: '', retryMs: 0 });
  const d = await hub.post('/api/device/start', { machine: hostname().split('.')[0] });
  console.log(`To connect this machine, open ${bold(d.verify_url_complete)}
and approve the code ${bold(d.user_code)} (signed in as a member or above). It expires in ${Math.round(d.expires_in / 60)} minutes.`);
  // Open the browser when there is a person at this terminal; nothing breaks when it can't.
  if (process.stdout.isTTY && !flags['no-browser']) {
    const { spawn } = await import('node:child_process');
    const opener = { darwin: 'open', win32: 'explorer' }[process.platform] ?? 'xdg-open';
    try { spawn(opener, [d.verify_url_complete], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
  }
  let wait = d.interval ?? 5;
  for (;;) {
    await new Promise((r) => setTimeout(r, wait * 1000));
    const r = await hub.post('/api/device/poll', { device_code: d.device_code });
    if (r.status === 'approved') return { token: r.token, by: r.person };
    if (r.status === 'slow_down') wait = (r.interval ?? wait) + 1;
  }
}

// nuworq connect <url> | <workspace> --hub <url>: use a hub on another machine (a server) from this one.
// It checks the hub answers, gets a token (a device login approved in the browser, or --token), saves
// both where the CLI, the MCP server and `run` look, and registers the MCP server with the agent tools
// installed here. nuworq disconnect undoes exactly that.
async function connect(pos, flags) {
  if (flags.off) return disconnect();
  let target = String(need(pos[0], '<url> or <workspace> --hub <url>'));
  let workspace = null;
  if (!/^https?:\/\//i.test(target) && flags.hub) {
    workspace = target.toLowerCase();
    target = `${String(flags.hub).replace(/\/+$/, '')}/w/${encodeURIComponent(workspace)}`;
  }
  let url = target.replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]/i.test(url)) throw new HubError(`"${url}" isn't a hub address`, { hint: 'e.g. nuworq connect https://acme.nuworq.com, or nuworq connect acme --hub https://nuworq.com' });
  workspace ??= url.match(/\/w\/([^/]+)$/)?.[1] ?? null;
  const probe = createClient({ url, token: '', retryMs: 0 });
  const health = await probe.get('/api/health').catch(() => null);
  if (!health?.ok) throw new HubError(`No nuworq hub answers at ${url}`, { hint: 'Check the address (it is what you open in the browser) and that the hub is running.' });
  // A hub that moved to a subdomain (nuworq.com → app.nuworq.com) is saved at its new address.
  url = probe.settings.url;
  const open = await createClient({ url, token: '', retryMs: 0 }).get('/api/me');
  // --token -: read it from stdin (pasted at a hidden prompt, or piped).
  const given = typeof flags.token === 'string' ? (flags.token === '-' ? await readSecretLine('Token (not shown): ') : flags.token) : envVar('TOKEN');
  let token = String(given ?? '').trim();
  if (open.auth === 'required' && !token) token = (await deviceLogin(url, flags)).token;
  const me = await createClient({ url, token, retryMs: 0 }).get('/api/me');
  if (me.auth === 'required' && !me.role) {
    throw new HubError('The hub refused that token (wrong or revoked)', {
      hint: 'Leave --token out to log in through the browser, or make one on the hub host: nuworq token create <name> --role agent.',
    });
  }
  // Connecting again replaces the old token: revoke it first. The tools set up last time stay recorded.
  const old = readConnection();
  const notes = [old?.token && old.token !== token ? await revokeSaved(old) : null];
  const { registerMcp } = await import('../src/connect.js');
  const mcp = flags['no-mcp'] ? { added: old?.added ?? [], lines: [] } : registerMcp({ bin: BIN, home: homedir(), kept: old?.added ?? [], url });
  // Written whole with mode 600 and moved into place, so the token is never in a file others can read.
  mkdirSync(dirname(CONNECT_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${CONNECT_FILE}.${process.pid}`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify({ url, token, ...(workspace ? { workspace } : {}), added: mcp.added }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, CONNECT_FILE);
  console.log(`${green('Connected')} to ${bold(url)}${me.auth === 'required' ? ` as ${me.name} (${me.role} token)` : dim(' (it needs no login)')}.
${[...notes.filter(Boolean), ...mcp.lines.map((l) => `  ${l}`)].join('\n')}${notes.some(Boolean) || mcp.lines.length ? '\n' : ''}${dim(`Saved in ${CONNECT_FILE}, readable only by you. The CLI, the MCP server and nuworq run on this machine use it
now; NUWORQ_URL and NUWORQ_TOKEN still win. Undo all of it: nuworq disconnect`)}`);
}

// nuworq disconnect: revoke the saved token on its hub, remove the MCP entries connect added (only
// those), and forget the hub. Harmless when not connected.
async function disconnect() {
  const c = readConnection();
  if (!c && !existsSync(CONNECT_FILE)) return console.log(dim('Not connected to a hub; nothing to undo.'));
  const { unregisterMcp } = await import('../src/connect.js');
  const lines = [await revokeSaved(c), ...unregisterMcp({ home: homedir(), added: c?.added ?? [] }).map((l) => `  ${l}`)].filter(Boolean);
  rmSync(CONNECT_FILE, { force: true });
  console.log(`${green('Disconnected.')}${lines.length ? `\n${lines.join('\n')}` : ''}
${dim(`Removed ${CONNECT_FILE}. This machine finds its hub as before: NUWORQ_URL, .nuworq.json, or a hub serving here.`)}`);
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
  default_tools_approval_mode = "approve"   ${dim('# headless Codex can\'t answer a prompt')}

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
// One deploy key per repository the hub mirrors: keys/<host>/<owner>/<repo> (see sshCommandFor in src/git.js).
const keysDir = (flags) => join(dataHome(flags), 'keys');
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
  const hub = new Hub({ file: db, repos: flags.demo ? null : reposDir(flags), keys: flags.demo ? null : keysDir(flags) });
  if (flags.demo) {
    try {
      const { seed } = await import('../src/seed.js');
      await seed(hub);
    } catch (e) {
      console.warn(amber(`warning: couldn't load demo data (${e.message}); starting empty`));
    }
  }
  const publicUrl = String(flags['public-url'] || envVar('PUBLIC_URL') || '').replace(/\/+$/, '');
  const { oauthFromEnv } = await import('../src/oauth.js');
  const { appFromEnv, appFromFile } = await import('../src/ghapp.js');
  // Measured usage for agents that go through llm-proxy (NUWORQ_LLM_PROXY_URL / _KEY). Not on a hub with
  // workspaces: one host key would read every tenant's traffic.
  hub.llmProxy = (await import('../src/llmproxy.js')).proxyFromEnv();
  // The GitHub App: from the environment, else the one the hub created for itself (Create GitHub App).
  const appFile = join(dataHome(flags), 'github-app.json');
  ignoreSiteHost(flags);
  const server = createServer(hub, { auth, trustProxy, publicUrl, oauth: oauthFromEnv(), githubApp: appFromEnv() ?? appFromFile(appFile), appFile, packageDir: join(dataHome(flags), 'package') });
  if (auth === 'required' && !server.auth.hasHumanToken()) {
    console.error(flags.demo
      ? `error: --demo keeps data in memory, so it can't hold login tokens.
hint: Run the demo on the default host (127.0.0.1) without --auth.`
      : `error: login is required ${loopback ? '(--auth)' : `because ${host} is reachable from other machines`}, but no human token exists yet.
hint: Create one, then start again:
      node ${JSON.stringify(BIN)} token create <your-name> --role human --db ${JSON.stringify(db)}`);
    process.exit(1);
  }
  server.listen(port, host, async () => {
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
    // The same commands as the Connect dialog: the installed `nuworq`, never a path into this checkout (#157).
    const base = publicUrl || url;
    const pkg = await server.package;
    console.log(`${green('●')} ${bold('nuworq')} is running at ${bold(url)}${flags.demo ? dim('  (demo data, in memory)') : dim(`  (${db})`)}
  Auth: ${authLine}
${dim(`
  Connect an agent (on any machine):
${pkg ? `    Install (once):     npm install -g ${base}/nuworq.tgz\n` : ''}    Connect (once):     nuworq connect ${base}   (logs in, registers nuworq with Claude Code, Codex and opencode)
    Keep workers going: nuworq run --workers 3 --agent claude   (add --browser for UI checks; Ctrl-C stops)
    Shell:              nuworq guide
    Tool schemas:       ${base}/api/tools?format=openai`)}`);
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
  const { follow, backups } = await import('../src/follow.js');
  const host = String(flags.host || envVar('HOST') || '127.0.0.1');
  const port = Number(flags.port || envVar('PORT') || 4747);
  if (!port) throw new HubError('--follow needs a fixed port', { hint: 'Pass --port <n> (the supervisor checks the hub there).' });
  const probe = { '0.0.0.0': '127.0.0.1', '::': '::1' }[host] ?? host;
  const repo = repoRoot(ROOT);
  const args = process.argv.slice(3).filter((a) => !/^--?follow(=.*)?$/.test(a));
  const data = dataHome(flags);
  // Copied before every move, to <data>/backups: the one database, or every workspace's.
  const store = flags.demo ? null : backups({
    dir: join(data, 'backups'),
    ...(flags.workspaces ? { workspaces: workspacesDir(flags) } : { db: resolve(dbPath(flags)) }),
  });
  try {
    await follow({
      repo,
      store,
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
  // Plans (#113): off unless the host turns them on; organizations the owners belong to are never limited.
  const plans = /^(1|on|true|yes)$/i.test(String(flags.plans ?? envVar('PLANS') ?? ''));
  // The hub's owners: one list for everything that asks (--owners, NUWORQ_HUB_OWNERS, or NUWORQ_OWNERS).
  const owners = String(flags.owners ?? envVar('HUB_OWNERS') ?? envVar('OWNERS') ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const spaces = new Workspaces({ dir, repos: reposDir(flags), keys: keysDir(flags), plans, owners });
  const baseDomain = String(flags['base-domain'] || envVar('BASE_DOMAIN') || '').toLowerCase().replace(/^\.+|\.+$/g, '');
  const { oauthFromEnv } = await import('../src/oauth.js');
  const publicUrl = String(flags['public-url'] || envVar('PUBLIC_URL') || '').replace(/\/+$/, '');
  // Workspaces one person may create; --org-cap and NUWORQ_ORG_CAP are its older names, still accepted.
  const orgCap = Number(flags['workspace-cap'] || flags['org-cap'] || envVar('WORKSPACE_CAP') || envVar('ORG_CAP')) || undefined;
  const { appFromEnv, appFromFile } = await import('../src/ghapp.js');
  const { notifyWorkspaces, workspaceUrl } = await import('../src/notify.js');
  let pushes = null;
  // Early access: requests through a Turnstile-checked form, decided by the hub's owners (by verified email).
  const { turnstile } = await import('../src/directory.js');
  const secret = envVar('TURNSTILE_SECRET');
  const earlyAccess = flags['early-access'] || secret || owners.length
    ? { owners, verify: secret ? turnstile(secret) : null, sitekey: envVar('TURNSTILE_SITEKEY') ?? '', gate: !!flags['early-access'] }
    : null;
  ignoreSiteHost(flags);
  // The admin host (e.g. admin.nuworq.com): the owners' dashboard, signed in on its own address.
  const adminHost = String(flags['admin-host'] || envVar('ADMIN_HOST') || '');
  if (adminHost && !owners.length) console.warn(amber(`--admin-host ${adminHost} has no owners, so nobody can get in: set --owners or NUWORQ_HUB_OWNERS.`));
  // Feedback about nuworq (#295): where the owners' approved feedback becomes a proposal; off without one.
  const feedbackProject = String(flags['feedback-project'] || envVar('FEEDBACK_PROJECT') || '');
  // Billing (#227): Stripe, from the environment only; off unless NUWORQ_STRIPE_WEBHOOK_SECRET is set.
  const { billingFromEnv } = await import('../src/billing.js');
  const server = createServer(spaces, { trustProxy, baseDomain, publicUrl, adminHost, oauth: oauthFromEnv(), orgCap, githubApp: appFromEnv() ?? appFromFile(join(dataHome(flags), 'github-app.json')), packageDir: join(dataHome(flags), 'package'), earlyAccess, billing: billingFromEnv(), feedbackProject });
  server.listen(port, host, () => {
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`;
    const names = spaces.list();
    console.log(`${green('●')} ${bold('nuworq')} is serving workspaces at ${bold(url)}  ${dim(`(${dir})`)}
  Auth: ${green('locked')}: every workspace has its own tokens${trustProxy ? '; trusting X-Forwarded-* from your proxy' : ''}
  Workspaces: ${names.length ? names.join(', ') : dim('none yet')}${adminHost ? `\n  Admin: ${adminHost}, owners ${owners.join(', ') || 'none'}` : ''}
${dim(`  Reached at ${baseDomain ? `<workspace>.${baseDomain} or ` : ''}${url}/w/<workspace>/
  Add one:   node ${JSON.stringify(BIN)} workspace create <name>
  Then:      node ${JSON.stringify(BIN)} token create <you> --role human --workspace <name>`)}`);
    // Pushes: each workspace's own channels, linking to its own address.
    pushes = notifyWorkspaces(spaces, (name) => workspaceUrl(name, { baseDomain, publicUrl, url }));
  });
  const stop = () => { pushes?.stop(); server.close(); spaces.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function workspace(pos, flags) {
  const { Workspaces } = await import('../src/workspaces.js');
  const owners = String(flags.owners ?? envVar('HUB_OWNERS') ?? envVar('OWNERS') ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const spaces = new Workspaces({ dir: workspacesDir(flags), owners });
  const [sub, name] = pos;
  try {
    if (sub === 'create') {
      // Made by the hub's host, so unlimited (people who sign up get Free): see Workspaces.planOf.
      const s = spaces.create(need(name, '<name>'));
      return console.log(`${green('Created')} workspace ${bold(s)} (${spaces.file(s)}).
${dim(`  Give someone a login: nuworq token create <name> --role human --workspace ${s}`)}`);
    }
    // A single hub's database becomes a workspace (#204): see "From one hub to workspaces" in DEPLOY.md.
    if (sub === 'adopt') {
      const r = spaces.adopt(need(name, '<name>'), resolve(dbPath(flags)));
      console.log(`${green('Adopted')} ${dbPath(flags)} as workspace ${bold(r.workspace)} (${r.file}).
  The original is untouched; a copy from now: ${r.backup}`);
      await adoptInstallations(spaces, r.workspace, flags);
      return console.log(`  Next: restart the hub with --workspaces (same --data-dir). Agents, runners and the CLI that saved its root
  address keep working there; people find it at /w/${r.workspace}/${dim(' (or its subdomain with --base-domain)')}.`);
    }
    // A GitHub App installation's deliveries reach the workspace it is bound to (#226).
    if (sub === 'bind-installation') {
      const ws = need(pos[2], '<workspace>');
      return reportBinding(spaces.bindInstallations(ws, [need(name, '<id>')]), ws);
    }
    if (sub === 'list') {
      const names = spaces.list();
      if (!names.length) return console.log(dim(`No workspaces in ${spaces.dir}. Add one: nuworq workspace create <name>`));
      // Each one's plan, the same the admin dashboard shows and sets (#169).
      const why = (p) => (p.source === 'set' ? `set by ${p.set_by || 'host'} ${new Date(p.set_at).toISOString().slice(0, 10)}` : p.source === 'owners' ? 'a hub owner is in it' : p.source === 'early_access' ? 'early access' : p.source === 'billing' ? 'paid' : 'default');
      return console.log(names.map((n) => { const p = spaces.planInfo(n); return `${n}  ${bold(p.plan)} ${dim(`(${why(p)})`)}`; }).join('\n'));
    }
    // The hub owner's override: unlimited (Pro, Team, or yours), or free.
    if (sub === 'plan') {
      const plan = need(pos[2], '<free|unlimited>');
      spaces.setPlan(need(name, '<name>'), plan, 'host');
      return console.log(`${green('Set')} ${bold(name)} to ${bold(plan)}. A running hub applies it at the next claim.`);
    }
    if (sub === 'remove') {
      spaces.remove(need(name, '<name>'));
      return console.log(`${green('Removed')} workspace ${bold(name)} and its database. A running hub stops serving it at once.`);
    }
  } catch (e) {
    throw e.hint || e.status ? new HubError(e.message, { hint: e.hint }) : e;
  }
  throw new HubError('usage: nuworq workspace create <name> | adopt <name> [--db file] | bind-installation <id> <workspace> | list | remove <name> | plan <name> <free|unlimited>');
}

// The single hub's GitHub App keeps working after adopt (#226): every installation of it is bound to the
// adopted workspace, so its webhooks reach it there. Without an app, or GitHub, it says how to bind one later.
async function adoptInstallations(spaces, ws, flags) {
  const { appFromEnv, appFromFile, GitHubApp } = await import('../src/ghapp.js');
  const later = `nuworq workspace bind-installation <id> ${ws}`;
  const conf = appFromEnv() ?? appFromFile(join(dataHome(flags), 'github-app.json'));
  if (!conf) return console.log(dim(`  No GitHub App on this hub. If one sends it webhooks, bind each installation: ${later}`));
  let ids;
  try {
    ids = (await new GitHubApp(conf).installations()).map((i) => i.id);
  } catch (e) {
    return console.log(amber(`  Couldn't list the GitHub App's installations (${e.message}). Bind each one (its id ends https://github.com/settings/installations/<id>): ${later}`));
  }
  if (!ids.length) return console.log(dim(`  The GitHub App isn't installed anywhere yet. Once it is: ${later}`));
  reportBinding(spaces.bindInstallations(ws, ids), ws);
}

function reportBinding({ bound, elsewhere }, ws) {
  if (bound.length) console.log(`${green('Bound')} GitHub App installation${bound.length > 1 ? 's' : ''} ${bound.join(', ')} to ${bold(ws)}: their webhooks reach it.`);
  for (const e of elsewhere) console.log(amber(`  Installation ${e.id} is bound to workspace ${e.workspace}, so it stays there.`));
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
      const c = n.addChannel(db, need(a, 'ntfy|slack|webhook'), need(b, '<url>'), Date.now(), { person: flags.person });
      return console.log(`${green('Added')} ${c.kind} channel ${bold(c.id)} (${c.url})${c.person ? ` for ${c.person}: only what they own` : ''}. Try it: nuworq notify test`);
    }
    if (sub === 'list') {
      const rows = n.listChannels(db);
      if (!rows.length) return console.log(dim('No push channels. Add one: nuworq notify add ntfy <topic-url> | slack <webhook-url> | webhook <url>'));
      for (const c of rows) console.log(`${String(c.id).padEnd(4)}${c.kind.padEnd(9)}${(c.person ?? 'everyone').padEnd(12)}${c.url}  ${c.failing ? amber(`failing: ${c.last_error}`) : green('ok')}`);
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
                                         [--workspace-cap 5]: workspaces one signed-in person may create
                                         [--early-access]: making a workspace takes an approved request
                                         (owners: --owners or NUWORQ_HUB_OWNERS emails; form at /early-access with
                                         NUWORQ_TURNSTILE_SITEKEY, checked with NUWORQ_TURNSTILE_SECRET)
                                         [--admin-host admin.example.com] (with --public-url): the owners'
                                         dashboard; early-access requests are decided only there
                                         [--feedback-project <workspace>/<project>] (with --admin-host): feedback
                                         about nuworq is on; approving a piece proposes it there
  workspace create|remove <name> | list  manage workspaces on the hub host
  workspace adopt <name> [--db file]     turn a single hub's database into workspace <name> (a copy is kept);
                                         tokens saved with the hub's root address keep working there, and
                                         its GitHub App's installations are bound to it
  workspace bind-installation <id> <workspace>   GitHub App deliveries for installation <id> reach <workspace>
  notify add ntfy|slack|webhook <url> [--person bea]   push one batched message when something new needs you
                                         (--person: a channel for bea, only what bea owns)
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
  ask [<item>] <question> [--assume a] [--option x]... [--blocking] [--to human|reporter|operator]
  ask <question> --escalates <question-id> --evidence "label|url"...
                                         operators only: carry a question up to the human, with evidence
  answer <question-id> <answer>          operators only: answer a question asked to: operator
  withdraw <question-id> <reason>        take back your own open question: answered another way, or moot
  submit <item> <headline> [--evidence "label|url"]...
  handoff <item> <headline>              release with where you left off
  propose <title> [--acceptance] [--priority now|soon|later] [--parent] [--depends-on "#1,#2"]
          [--needs "docker,linux-vm"] [--size small|large] [--repo github.com/acme/api]
  refine <item> [--title] [--acceptance] [--priority] [--depends-on] [--needs] [--size] [--repo]
  review <item> <accept|reject> <headline> [--attempt n|agent]   (raced items: which attempt to keep)
  comment [<item>] <headline>
  ack <steer-id> [response]
  look [<item>] [--stage s]
  signoff [headline]
  Text flags: --summary, --detail (use "-" to read from stdin)

${bold('Setup')}
  init [--force]                         write .nuworq.json; print MCP config for Claude Code, Codex, opencode
  connect <url> | <workspace> --hub <url> [--token t|-] [--no-browser] [--no-mcp]
                                         use that hub from this machine: log in through the browser (a code
                                         you approve), save it in ~/.nuworq/connect.json (only you can read it),
                                         and add the nuworq MCP server to Claude Code, Codex and opencode here.
                                         --token t (or NUWORQ_TOKEN) skips the browser; --token - reads one line
  disconnect                             revoke that token, remove what connect added, forget the hub
  skill [--dir d]                        write the nuworq, nuworq-plan and nuworq-operator skills for Claude (generated; connect does them too)
  skill --plugin [dir]                   write the Claude Code plugin (MCP server + both skills; default: plugin/)
  mcp                                    run the stdio MCP server (one per agent session)
  git-credential get --as <name>         git credential helper: a one-repo, one-hour GitHub token for the item
                                         <name> holds, from the hub's GitHub App (workers set it up themselves)
  guide [--via cli|tools]                the agent guide
  operator [--project p] [--has tags]    print the tags an operator session declares and the line that starts it
                                         to paste into Claude Code in the project folder (runs nothing). Operator
                                         tags: claude-cli, infra (the project's live infrastructure: servers and
                                         VMs, DNS, cloud accounts, deploys), github-admin, browser
  wait --operator [--follow] [--as name] [--project p | --all-projects]
                                         block until there is something for an operator (its work, a question
                                         to it, an answer, steering) and print one line; --follow: one per event.
                                         Without --as: the operator of the Claude Code session that started
                                         it (else the operators that checked in with this token).
                                         Only this folder's project, unless --project or --all-projects.
  tools [--format mcp|openai|anthropic] [--prefix p]   tool schemas
  worker [--agent claude|codex|opencode] [--model provider/model] [--run] [--project p] [--here] [--as name] [--allow tools] [--has tags] [--browser]
                                         start a headless worker where work is waiting (the hub routes it),
                                         in its own git worktree, a branch per item (--here: no worktree). Without
                                         --run it prints the command instead. opencode needs --model,
                                         e.g. ollama/qwen3.8:27b-mtp-q4_K_M (Ollama is set up for you).
                                         --model proxy/<model> --proxy <url> (or NUWORQ_LLM_PROXY_URL) routes
                                         opencode through llm-proxy, key from NUWORQ_LLM_PROXY_KEY (also on run);
                                         --agent claude|codex --proxy <url> sends Claude Code or Codex through its
                                         Anthropic or OpenAI route: <url> is its LAN or tailnet address, and the
                                         key its owner token, from NUWORQ_LLM_PROXY_TOKEN.
                                         On a hub with login, --run needs --agent-token (or
                                         NUWORQ_AGENT_TOKEN): workers never get your own token.
                                         It reports what this machine has (macos/linux, docker, gpu;
                                         add more with --has). --browser (Claude only): the worker gets a
                                         headless Chrome (Playwright MCP, local pages only) to check UI
                                         work with, and has "browser".
  run [--workers 1] [--agent claude|codex|opencode] [--model m] [--max-runs M] [--max-minutes T] [--max-usd X] [--poll 30] [--has tags] [--browser] [--until-idle]
                                         keep up to N workers on waiting work in projects you opted in
                                         (UI: "Let nuworq run staff this project"); waits for work, or
                                         with --until-idle exits when the queue is empty. Workers that
                                         keep failing pause it (5m, then longer, up to 30m), and a project
                                         whose checkout can't be updated waits the same way while the
                                         others go on. Logs: ~/.nuworq/logs. --max-usd stops launching
                                         once workers' reported spend reaches X (codex and local models
                                         report no cost, so they don't count against it).
                                         --browser: each worker gets a browser, as with worker --browser.
                                         A worker's worktree is removed when it exits, unless it holds
                                         uncommitted changes or commits on no branch (then it says where).
  run --install [run flags] | run --uninstall
                                         the same runner as a service: a LaunchAgent (macOS) or systemd
                                         user unit (Linux) that survives closed terminals and reboots;
                                         installing again replaces it. Log: ~/.nuworq/logs/run.log
                                         Install from a checkout: it runs there and finds the ones beside it
  update                               install the hub's newer nuworq now, if it is signed by the release key
                                         this install pinned (otherwise, or offline, it keeps this version and
                                         says why). Every command checks by itself at most every 10 minutes;
                                         NUWORQ_NO_UPDATE=1 turns that off.
  prompt [--as name]                     just the worker prompt text, for other agents
  seed                                   add the nuworq roadmap project to your hub's database

Env: NUWORQ_URL (default ${DEFAULT_URL}), NUWORQ_PROJECT, NUWORQ_AGENT, NUWORQ_MODEL, NUWORQ_DB,
     NUWORQ_TOKEN (a token the CLI and MCP server send to a hub that requires login),
     NUWORQ_PUBLIC_URL (the hub's address as you reach it, used for links in push messages),
     NUWORQ_LLM_PROXY_URL and NUWORQ_LLM_PROXY_KEY (serve: measured usage for agents that send
     x-client-name: nuworq/<project>/<agent> through llm-proxy; a read-only key), and behind Cloudflare
     Access NUWORQ_LLM_PROXY_ACCESS_ID and NUWORQ_LLM_PROXY_ACCESS_SECRET (a service token; serve only),
     NUWORQ_LLM_PROXY_TOKEN (llm-proxy's owner token, for Claude and Codex workers with --proxy)
Deploying on a VM or the internet: docs/DEPLOY.md`;

// git's credential helper protocol (git help credential): for "get" on github.com, a token from the hub's
// GitHub App for the repository of the item this agent holds. Anything else, or a different repository,
// gets no answer, and git goes on to its other helpers. Errors go to stderr, where git shows them.
async function gitCredential(pos, flags) {
  if (pos[0] !== 'get') return;
  let input = '';
  for await (const c of process.stdin) input += c;
  const ask = Object.fromEntries(input.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  if (ask.host !== 'github.com') return;
  // --project: a read-only token to clone or fetch that project's repository (a worker before it holds an item).
  if (flags.project) {
    const repo = `github.com/${String(ask.path ?? '').replace(/\.git$/, '').replace(/\/+$/, '')}`;
    let r;
    try {
      r = await createClient(flags).post('/api/agent/credential', { purpose: 'clone', project: String(flags.project), repo, agent: flags.as || envVar('AGENT') || undefined });
    } catch (e) {
      if (e.status === 404) return; // no GitHub App: git uses whatever else is set up, quietly
      throw e;
    }
    return process.stdout.write(`username=${r.username}\npassword=${r.password}\n`);
  }
  const agent = flags.as || envVar('AGENT');
  if (!agent) throw new HubError('who are you?', { hint: 'The helper needs --as <name> or NUWORQ_AGENT.' });
  let r;
  try {
    r = await createClient(flags).post('/api/agent/credential', { agent });
  } catch (e) {
    if (e.status === 404) return; // the hub has no GitHub App: git uses whatever else is set up, quietly
    throw e;
  }
  // With credential.useHttpPath, git says which repository; a token for another one would be refused anyway.
  const want = String(ask.path ?? '').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
  if (want && `github.com/${want}` !== r.repo.toLowerCase()) {
    return console.error(`nuworq: the token is for ${r.repo}, the item you hold; this push goes to github.com/${want}`);
  }
  process.stdout.write(`username=${r.username}\npassword=${r.password}\n`);
}

// The package's self-update (src/update.js). Never throws: offline, or anything else, keeps this version.
async function selfUpdate(flags, { force = false } = {}) {
  try {
    return await update({ root: ROOT, hub: resolveSettings(flags).url, dir: join(dataDir(), 'update'), force, ...(force ? {} : { timeoutMs: 3000 }) });
  } catch (e) {
    return { status: 'skipped', reason: e.message };
  }
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { pos, flags } = parse(argv);
  if (!cmd || cmd === 'help' || flags.help || flags.h || cmd === '--help' || cmd === '-h') return console.log(HELP);

  if (cmd === 'serve') return serve(flags);
  if (cmd === 'update') {
    const r = await selfUpdate(flags, { force: true });
    console.log(describeUpdate(r));
    if (['refused', 'failed'].includes(r.status)) process.exitCode = 1;
    return;
  }
  // A signed new version from the hub, at most every 10 minutes; it applies to the next run. A git
  // credential helper answers git right away. An MCP server checks in the background, for the next session.
  if (cmd !== 'git-credential') {
    const pending = selfUpdate(flags).then((r) => { if (['updated', 'refused', 'failed'].includes(r.status)) console.error(`nuworq: ${describeUpdate(r)}`); });
    if (cmd !== 'mcp') await pending;
  }
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
  if (cmd === 'operator') return operatorCmd(flags);
  if (cmd === 'wait') return waitCmd(flags);
  if (cmd === 'skill' && flags.plugin) {
    // The Claude Code plugin (src/plugin.js): <dir> (default this checkout's plugin/), plus the marketplace
    // that lists it when it is this checkout's own.
    const { pluginFiles, marketplace } = await import('../src/plugin.js');
    const dir = resolve(typeof flags.plugin === 'string' ? flags.plugin : join(ROOT, 'plugin'));
    const files = Object.entries(pluginFiles()).map(([f, text]) => [join(dir, f), text]);
    if (dir === join(ROOT, 'plugin')) files.push([join(ROOT, '.claude-plugin', 'marketplace.json'), marketplace()]);
    for (const [file, text] of files) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
      console.log(`${green('Wrote')} ${file}`);
    }
    return;
  }
  if (cmd === 'skill') {
    // The nuworq skills for Claude, generated from the protocol: <dir>/nuworq/SKILL.md, <dir>/nuworq-plan/SKILL.md
    // and <dir>/nuworq-operator/SKILL.md (default ~/.claude/skills).
    const dir = resolve(String(flags.dir || join(homedir(), '.claude', 'skills')));
    const url = resolveSettings(flags).url;
    for (const [name, make] of [['nuworq', skill], ['nuworq-plan', planSkill], ['nuworq-operator', operatorSkill]]) {
      const file = join(dir, name, 'SKILL.md');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, make({ url }));
      console.log(`${green('Wrote')} ${file}`);
    }
    return;
  }
  if (cmd === 'tools') return console.log(JSON.stringify(tools(flags.format || 'mcp', flags.prefix || ''), null, 2));
  if (cmd === 'prompt') return console.log(workerPrompt(flags));
  if (cmd === 'worker') return worker(flags);
  if (cmd === 'run') return runCmd(flags);
  if (cmd === 'seed') return seedCmd(flags);
  if (cmd === 'init') return init(flags);
  if (cmd === 'connect') return connect(pos, flags);
  if (cmd === 'disconnect') return disconnect();
  if (cmd === 'git-credential') return gitCredential(pos, flags);

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
