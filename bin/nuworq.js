#!/usr/bin/env node
// nuworq: run the hub, connect agents, and check on projects from a terminal.
import { writeFileSync, existsSync, readFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { join, dirname, resolve, delimiter, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir, hostname, tmpdir } from 'node:os';
import { createClient, resolveSettings, repoRoot, repoRemote, checkoutOf, cloneDir, besideOf, HubError, GATEWAY, DEFAULT_URL, HUB_FILE, CONNECT_FILE } from '../src/client.js';
import { tools, guide, userSkills, operatorStart, TAG_ALIASES, LISTENER } from '../src/protocol.js';
import { envVar, dataDir, defaultDb, CONFIG_FILES } from '../src/names.js';
import { checkName, sq, safe, redact, lockDown, tokenFile, dropTokenFile, withoutTokens, workerEnv, harnessKeys, namedEnv, chosenFolders, chooseFolders, inChosen, toOffer, loopback } from '../src/runtrust.js';
import { sandboxSettings, filePermissions, projectCommands, sandboxHosts } from '../src/sandbox.js';
import { update, describeUpdate, staleListener, takeNews, describeNews, installedChanges, installed, differs } from '../src/update.js';

const BIN = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(BIN), '..');
// How agents should invoke this CLI: the bare name only if it's really on PATH.
const ON_PATH = (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, 'nuworq')));
const CLI = ON_PATH ? 'nuworq' : `node ${JSON.stringify(BIN)}`;
const BOOL = new Set(['peek', 'blocking', 'demo', 'force', 'all', 'help', 'h', 'auth', 'trust-proxy', 'run', 'here', 'workspaces', 'follow', 'until-idle', 'off', 'browser', 'no-browser', 'no-mcp', 'skills','early-access', 'install', 'uninstall', 'operator', 'sweep', 'dry-run', 'yes', 'no', 'start', 'detect', 'smoke', 'can-read-keys']);
const MULTI = new Set(['option', 'evidence', 'env', 'env-secret']);

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

const refs = (v) => (v ? String(v).split(/[\s,]+/).filter(Boolean) : undefined);

function need(v, what) {
  if (v === undefined || v === '' || v === true) throw new HubError(`missing ${what}`, { hint: `See: nuworq help` });
  return v;
}

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
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
    onPath('pi') && 'pi',
    onPath('gh') && 'gh',
    flags.browser && 'browser', // --browser: the worker gets one (workerSetup)
    ...(refs(flags.has) ?? []),
  ].filter(Boolean).map((t) => String(t).toLowerCase()))];
}

// An operator session (see Operators in the guide): the tags to declare and the line that starts an attended
// Claude Code session in the project folder as the operator (the plugin's operator skill, which starts its
// listener; no /loop). It prints them and starts nothing. Detected: the platform, and browser when a Chrome or
// Chromium is installed; --has replaces what was detected.
// First, one line when this CLI's listener is below what the hub expects (#419): updating the plugin never
// updates the CLI its listener runs. --check <level> (the operator skill's, before it goes idle) prints only
// that line, and nothing when this CLI is new enough.
async function operatorCmd(flags) {
  const hub = await fetch(`${new URL(resolveSettings(flags).url).origin}/api/package`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.json()).then((b) => Number(b?.listener) || 0).catch(() => 0);
  const stale = staleListener({ root: ROOT, have: LISTENER, need: Math.max(hub, Number(flags.check) || 0) });
  if (stale) console.log(stale);
  if (flags.check !== undefined) {
    if (stale) process.exitCode = 1;
    return;
  }
  const project = resolveSettings(flags).project ?? basename(process.cwd());
  const { has, renamed } = operatorHas(flags);
  if (renamed.length) console.log(dim(`Tag renamed: ${renamed.join(', ')}.`));
  const op = await import('../src/operator.js');
  // This machine's own infra check (#494): set by its person, kept in ~/.nuworq/operator.json, never from the hub.
  // Only a person at a terminal changes it (#607): --detect runs the check, so an agent's shell never sets one.
  if (flags['infra-check'] !== undefined || flags.without === 'infra' || flags.with === 'infra') {
    const check = typeof flags['infra-check'] === 'string' ? flags['infra-check'].trim() : undefined;
    const patch = { ...(check !== undefined ? { infra_check: check || null } : {}), ...(flags.without === 'infra' ? { without_infra: true } : flags.with === 'infra' ? { without_infra: null } : {}) };
    const { answerer } = await import('../src/setup.js');
    const now = await op.changeInfra(OPERATOR_FILE, patch, process.stdin.isTTY && process.stdout.isTTY ? answerer('ask', askLine) : null);
    if (!now) {
      process.exitCode = 1;
      return console.log(process.stdin.isTTY && process.stdout.isTTY ? 'Nothing changed.' : 'Nothing changed: only a person at a terminal changes this machine\'s infra settings. Run it in your own terminal.');
    }
    console.log(now.without_infra ? `This machine declares no ${bold('infra')}: it can't reach ${project}'s live systems. Undo: nuworq operator --with infra`
      : now.infra_check ? `${bold('infra')} is declared only while ${bold(now.infra_check)} passes. Clear it: nuworq operator --infra-check ""`
      : `${bold('infra')} is declared: a person starts this attended operator here.`);
    return;
  }
  if (flags.detect) return detectCmd(flags);
  // --allow takes a value elsewhere (worker --allow <tools>), so a flag after it here arrives as its value.
  if (flags.allow) return allowCmd(typeof flags.allow === 'string' && flags.allow.startsWith('--') ? { ...flags, [flags.allow.slice(2)]: true } : flags);
  // --start: open Claude Code here as the operator, as connect does on a yes (#490).
  if (flags.start) return startOperator(process.cwd(), flags.has ? has : null);
  console.log(`${bold('Start it:')} open Claude Code in ${project}'s folder (the terminal or the desktop app's Code tab) and type:

${operatorStart(flags.has ? has : null)}

${flags.has ? `It declares ${has.join(', ')}.` : `Capabilities are optional: left out, it detects what this session can do (see nuworq operator --detect).`}
It works until nothing waits, then stays idle and listens: each new operator item, operator question or answer
starts a turn on its own. No /loop. ${dim('nuworq operator --start opens it for you, with its routine commands allowed.')}${dim(` (Without the nuworq plugin: ${operatorStart(flags.has ? has : null, { plugin: false })}.)`)}`);
}

const OPERATOR_FILE = join(dataDir(), 'operator.json');

// The tags typed with --has, with old names renamed. renamed: old tag names given, with their new ones.
function operatorHas(flags) {
  const given = (refs(flags.has) ?? []).map((t) => String(t).toLowerCase());
  const has = ['operator', ...new Set(given.map((t) => TAG_ALIASES[t] ?? t).filter((t) => t !== 'operator'))];
  const renamed = [...new Set(given.filter((t) => TAG_ALIASES[t]))].map((t) => `${t} is now ${TAG_ALIASES[t]}`);
  return { has, renamed };
}

// What this session can do (#494, src/operator.js): the project's repositories come from the hub, else this
// folder's origin.
async function detectOperator(flags) {
  const { detect, localOf } = await import('../src/operator.js');
  const { execFile } = await import('node:child_process');
  const run = (cmd, args) => new Promise((ok) => execFile(cmd, args, { encoding: 'utf8', timeout: 20_000 }, (e, out, err) => ok({ ok: !e, out: e ? `${err || e.message}` : out })));
  const onPath = (cmd) => (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, cmd)));
  const chrome = ['/Applications/Google Chrome.app', '/Applications/Chromium.app'].some((a) => existsSync(a))
    || ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].some(onPath);
  const named = resolveSettings(flags).project;
  const here = repoRemote();
  const projects = await createClient({ ...flags, retryMs: 0 }).get('/api/projects').catch(() => []);
  const p = (Array.isArray(projects) ? projects : []).find((x) => (named ? x.slug === named : (x.remotes ?? []).includes(here)));
  const repos = p?.remotes?.length ? p.remotes : here ? [here] : [];
  return detect({ run, chrome, repos, local: localOf(OPERATOR_FILE) });
}

// nuworq operator --detect: what to declare, and why each tag is in or out. The last line is the one the operator
// says first.
async function detectCmd(flags) {
  const { declared } = await import('../src/operator.js');
  const { has, found } = await detectOperator(flags);
  console.log(`${bold('Declare:')} ${has.join(',')}`);
  for (const f of found) console.log(`  ${f.ok ? green('✓') : dim('✗')} ${f.tag}: ${f.why}`);
  console.log(declared(found));
}

// nuworq operator --allow [--off]: the operator's routine commands without prompts, in this project's
// .claude/settings.local.json, after a yes; --off takes exactly those rules out again.
async function allowCmd(flags) {
  const { rules, applyRules, sshHost, localOf } = await import('../src/operator.js');
  const r = rules({ host: sshHost(localOf(OPERATOR_FILE).infra_check) });
  const file = join(repoRoot(), '.claude', 'settings.local.json');
  if (!flags.off) {
    console.log(`Lets the operator run these without asking, in ${file}:\n  ${r.allow.join(' ')}\nThese still ask: ${r.deny.join(' ')}`);
    const { answerer } = await import('../src/setup.js');
    const mode = flags.yes ? 'yes' : process.stdin.isTTY && process.stdout.isTTY ? 'ask' : 'no';
    if (!await answerer(mode, askLine)('Add them?')) return console.log(dim(mode === 'no' ? 'Nothing changed: run it at a terminal, or with --yes.' : 'Nothing changed.'));
  }
  const done = applyRules(file, r, { off: !!flags.off });
  console.log(flags.off ? `Removed ${done.removed} rule${done.removed === 1 ? '' : 's'} from ${file}.` : `Added ${done.added} rule${done.added === 1 ? '' : 's'} to ${file}. Undo: nuworq operator --allow --off`);
}

// Claude Code in folder as the operator (#490): `claude "<the operator line>"` starts it with the line already
// sent, and gives the terminal back when the session ends. A Claude Code whose help shows no [prompt] argument
// can't take one: then it prints the line to paste. has: typed capabilities, or null for the bare line, which
// detects them (#494). Its routine commands are allowed for this session (--settings), destructive ones still ask.
async function startOperator(folder, has = null) {
  const { line, settings, cant } = await operatorLaunch(has);
  if (cant) return console.log(`${amber('!')} ${cant}. Open Claude Code in ${folder} and type:\n\n${line}\n`);
  console.log(`${green('●')} Starting the operator: Claude Code in ${folder}, with ${bold(line)} sent.`);
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('claude', ['--settings', settings, line], { cwd: folder, stdio: 'inherit' });
  if (r.error) console.log(`${amber('!')} Couldn't start Claude Code (${r.error.message}). Open it in ${folder} and type: ${line}`);
}

// The operator line, the --settings that allow its routine commands, and why this Claude Code can't take them (cant:
// not on PATH, or no first-prompt argument), for startOperator and nuworq up.
async function operatorLaunch(has = null) {
  const { pluginInstalled } = await import('../src/connect.js');
  const { rules, sshHost, localOf } = await import('../src/operator.js');
  const line = operatorStart(has, { plugin: pluginInstalled(homedir()) });
  const settings = JSON.stringify({ permissions: rules({ host: sshHost(localOf(OPERATOR_FILE).infra_check) }) });
  let help = '';
  try { help = execFileSync('claude', ['--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }); } catch {}
  const cant = /\[prompt\]/.test(help) ? null : help ? "This Claude Code can't take a first prompt" : "Claude Code isn't on PATH";
  return { line, settings, cant };
}

// Staff a project with workers on this machine, up to a daily budget (#490): the hub turns staffing on, at once
// on a hub without logins, else once an owner approves it in the browser. Returns the lines to print.
async function staffProject(project, budget, flags) {
  const client = createClient(flags);
  const r = await client.post('/api/staff', { project: project.slug, budget, machine: hostname().split('.')[0] });
  const name = project.name ?? project.slug;
  const done = `${green('●')} Staffed ${bold(name)}: its workers may spend up to $${budget} a day (change it in ${name}'s Settings).`;
  if (r.staffed) return [done];
  console.log(`To staff ${name}, an owner approves it at ${bold(r.verify_url_complete)} (the code ${bold(r.user_code)}). It expires in ${Math.round(r.expires_in / 60)} minutes.`);
  if (process.stdout.isTTY && !flags['no-browser']) {
    const { spawn } = await import('node:child_process');
    const opener = { darwin: 'open', win32: 'explorer' }[process.platform] ?? 'xdg-open';
    try { spawn(opener, [r.verify_url_complete], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
  }
  const hub = createClient({ url: client.settings.url, token: '', retryMs: 0 });
  let wait = r.interval ?? 5;
  for (;;) {
    await new Promise((ok) => setTimeout(ok, wait * 1000));
    const p = await hub.post('/api/device/poll', { device_code: r.device_code }).catch((e) => { throw new HubError(`it wasn't approved: ${e.message}`, { hint: e.hint }); });
    if (p.status === 'approved') return [done];
    if (p.status === 'slow_down') wait = (p.interval ?? wait) + 1;
  }
}

// nuworq staff [<project>] [--budget usd]: connect's staffing question on its own (#490). The project is the
// one this folder is a clone of, unless named; the runner is installed from here.
async function staffCmd(pos, flags) {
  const { chooseProject, budgetOf } = await import('../src/setup.js');
  const mode = flags.yes ? 'yes' : process.stdin.isTTY && process.stdout.isTTY ? 'ask' : 'yes';
  const ask = askLine;
  const projects = await hubProjects(createClient(flags));
  const at = await chooseProject({ projects, named: pos[0] ?? flags.project, remote: repoRemote(), root: repoRoot(), mode, ask, say: console.log });
  if (at.none) throw new HubError(at.none, { hint: 'nuworq staff <project> [--budget 20]' });
  const usd = await budgetOf(mode, ask, flags.budget);
  for (const l of await staffProject(at.project, usd, flags)) console.log(l);
  await runService({ ...flags, folder: besideOf(process.cwd()) }, { argv: [] });
}

// nuworq up (#559, src/up.js): the runner with --workers auto, staffing for unstaffed projects (asked once), and an
// operator in its own terminal for each unparked project with none. Safe to run again: it starts only what's missing.
// --dry-run says what it would do. The operators it starts write their pids in ~/.nuworq/operators, for nuworq down.
const UP_FILE = join(dirname(HUB_FILE), 'up.json');
const PIDS = join(dirname(HUB_FILE), 'operators');
const pidOf = (slug) => join(PIDS, `${checkName('project', slug)}.pid`);
// The pid of an operator up started that still runs: alive, and still claude (not a pid since reused).
function runningPid(file) {
  let pid;
  try { pid = Number(readFileSync(file, 'utf8').trim()); } catch { return null; }
  if (!(pid > 0)) return null;
  try { process.kill(pid, 0); } catch { return null; }
  try { return /claude/.test(execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) ? pid : null; } catch { return null; }
}

async function upCmd(flags) {
  const { upPlan, upClones, readService, launcherFor, launchCommands, operatorShell, upTable, SESSION } = await import('../src/up.js');
  const svc = await import('../src/service.js');
  const { userInfo } = await import('node:os');
  const dryRun = !!flags['dry-run'];
  const client = createClient(flags);
  const projects = await hubProjects(client);
  if (!Array.isArray(projects) || !projects.length) return console.log(dim('The hub has no projects yet: add one on the hub (+ Project), then run nuworq up again.'));
  const saved = (() => { try { return JSON.parse(readFileSync(UP_FILE, 'utf8')); } catch { return {}; } })();
  const declined = Array.isArray(saved.declined) ? saved.declined : [];

  // The runner: its service file, read back, and whether it's up.
  const s = svc.serviceFor({ platform: process.platform, home: homedir(), uid: userInfo().uid });
  const read = s && existsSync(s.file) ? readService(readFileSync(s.file, 'utf8'), process.platform) : null;
  let up = false;
  if (read) { try { up = s.up(execFileSync(s.status[0], s.status.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch {} }
  const runner = { supported: !!s, args: read?.args ?? null, cwd: read?.cwd && existsSync(read.cwd) ? read.cwd : null, tokenFile: read?.tokenFile && existsSync(read.tokenFile) ? read.tokenFile : null, up };

  // Each project's clone here, found as the runner finds them: from where it runs, beside it, and NUWORQ_REPOS.
  // The hub's folder for a project only when the person chose it, or it's a checkout of the project's repo (#617).
  const from = runner.cwd ?? process.cwd();
  const clones = upClones(projects, {
    chosen: chosenFolders(dirname(HUB_FILE)), exists: existsSync, inChosen,
    remoteOf: (dir) => { try { return repoRemote(dir); } catch { return ''; } },
    checkout: (remotes) => checkoutOf(remotes, { cwd: from }),
  });
  const local = Object.fromEntries(projects.filter((p) => runningPid(pidOf(p.slug))).map((p) => [p.slug, true]));

  // Staffing, asked once for every unparked project that isn't staffed; a no is remembered.
  const first = upPlan({ projects, declined, clones, local, runner });
  if (first.staff.length) {
    const names = first.staff.map((p) => p.name ?? p.slug).join(', ');
    const mode = flags.yes ? 'yes' : flags.no ? 'no' : process.stdin.isTTY && process.stdout.isTTY ? 'ask' : 'no';
    if (dryRun) console.log(`Would ask: staff ${names} with workers on this machine?`);
    else {
      const { answerer, budgetOf } = await import('../src/setup.js');
      if (await answerer(mode, askLine)(`Not staffed: ${names}. Staff ${first.staff.length > 1 ? 'them' : 'it'} with workers on this machine? Its runner starts Claude Code workers on waiting work, on your Claude account, up to a daily cap you set next.`)) {
        const usd = await budgetOf(mode, askLine, flags.budget);
        for (const p of first.staff) {
          try {
            for (const l of await staffProject(p, usd, flags)) console.log(l);
            p.runner = true;
          } catch (e) { console.log(`${amber('!')} Couldn't staff ${p.name ?? p.slug}: ${e.message}${e.hint ? ` (${e.hint})` : ''}`); }
        }
      } else if (mode === 'ask' || flags.no) {
        mkdirSync(dirname(UP_FILE), { recursive: true, mode: 0o700 });
        writeFileSync(UP_FILE, `${JSON.stringify({ ...saved, declined: [...new Set([...declined, ...first.staff.map((p) => p.slug)])] }, null, 2)}\n`, { mode: 0o600 });
        console.log(dim(`Not staffed; nuworq up won't ask again. Later: nuworq staff <project>, or its Settings on the hub.`));
      }
    }
  }
  const plan = upPlan({ projects, declined, clones, local, runner });
  const onPath = (cmd) => (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, cmd)));
  const via = launcherFor({ tmux: onPath('tmux'), platform: process.platform, iterm: existsSync('/Applications/iTerm.app') });
  const starting = plan.rows.filter((r) => r.operator.state === 'start');
  if (dryRun) {
    const where = { tmux: `tmux (the ${SESSION} session, a window per project)`, iterm: 'iTerm windows', terminal: 'Terminal windows', print: 'nowhere: it would print the commands' }[via];
    if (starting.length) console.log(`Would start ${starting.length === 1 ? 'an operator' : `${starting.length} operators`} in ${where}.`);
    console.log(upTable(plan, { dryRun: true }));
    return;
  }

  // The runner, installed or restarted with --workers auto.
  if (plan.runner.action === 'install' || plan.runner.action === 'restart') {
    const before = process.exitCode;
    try {
      await runService(flags, { argv: plan.runner.args, cwd: plan.runner.cwd ?? process.cwd(), agentTokenFile: plan.runner.tokenFile });
      if (process.exitCode && process.exitCode !== before) plan.runner = { ...plan.runner, action: 'failed', why: "it didn't come up; see the lines above" };
    } catch (e) { plan.runner = { ...plan.runner, action: 'failed', why: e.message }; }
    console.log('');
  }

  // The operators, each in its own terminal.
  let attach = false;
  if (starting.length) {
    const { line, settings, cant } = await operatorLaunch(null);
    if (cant) for (const r of starting) r.operator = { state: 'skip', why: `${cant}; open Claude Code in ${r.operator.folder} and type ${line}` };
    else {
      mkdirSync(PIDS, { recursive: true, mode: 0o700 });
      const windows = starting.map((r) => ({ name: r.slug, folder: r.operator.folder, shell: operatorShell({ folder: r.operator.folder, pidFile: pidOf(r.slug), settings, line }), row: r }));
      if (via === 'print') {
        console.log(`No tmux, and no Terminal to open: start each operator in its own terminal with:`);
        for (const w of windows) { console.log(`  ${bold(w.row.name)}: ${w.shell}`); w.row.operator = { state: 'skip', why: 'start it with the command above' }; }
      } else {
        let exists = false;
        if (via === 'tmux') { try { execFileSync('tmux', ['has-session', '-t', SESSION], { stdio: 'ignore' }); exists = true; } catch {} }
        const cmds = launchCommands(via, windows, { exists });
        windows.forEach((w, i) => {
          try {
            execFileSync(cmds[i][0], cmds[i].slice(1), { stdio: ['ignore', 'ignore', 'pipe'] });
            w.row.operator = { state: 'started', why: { tmux: `tmux window ${SESSION}:${w.name}`, iterm: 'an iTerm window', terminal: 'a Terminal window' }[via] };
            if (via === 'tmux') attach = true;
          } catch (e) {
            // The first tmux window makes the session: when it fails, the next one has to make it instead.
            if (via === 'tmux' && i === 0 && !exists && cmds[1]) cmds[1] = launchCommands(via, [windows[1]])[0];
            w.row.operator = { state: 'skip', why: `couldn't open it: ${String(e.stderr || e.message).trim().split('\n')[0]}` };
          }
        });
      }
    }
  }
  console.log(upTable(plan));
  if (attach) console.log(`\nThe operators run in tmux: ${bold(`tmux attach -t ${SESSION}`)}`);
  const parkedOps = plan.rows.filter((r) => r.parked && r.operator.state === 'running');
  if (parkedOps.length) console.log(`${amber('!')} ${parkedOps.map((r) => r.name).join(', ')} ${parkedOps.length > 1 ? 'are' : 'is'} parked but still has an operator: end that session.`);
}

// nuworq down (#559): stop the operators nuworq up started (each session signs itself off as it ends, #558), and the
// runner service.
async function downCmd(flags) {
  const { readdirSync } = await import('node:fs');
  let files = [];
  try { files = readdirSync(PIDS).filter((f) => f.endsWith('.pid')); } catch {}
  let stopped = 0;
  for (const f of files) {
    const pid = runningPid(join(PIDS, f));
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); stopped++; console.log(`${green('●')} Stopped the operator for ${bold(f.replace(/\.pid$/, ''))} (pid ${pid}).`); } catch {}
    }
    rmSync(join(PIDS, f), { force: true });
  }
  if (!stopped) console.log(dim('No operator nuworq up started is running.'));
  await runService({ ...flags, uninstall: true });
  console.log(dim('Bring it all back with: nuworq up'));
}

// One line typed at the terminal, after a prompt (on stderr, so piped output stays clean).
async function askLine(prompt) {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const said = await new Promise((resolve) => { rl.question(prompt, resolve); rl.once('close', () => resolve('')); });
  rl.close();
  return said;
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
  // or timed-out connection (#406: an answer long overdue counts as one) is waited out with backoff (about 2 s doubling to 30 s), quietly and keeping
  // `since`, so nothing is lost or repeated. Away for long (10 minutes), it says so once and keeps trying.
  const first = Number(flags['retry-ms']) || 2000, cap = 15 * first, longMs = Number(flags['down-ms']) || 600_000;
  let away = null, told = false, crowded = false;
  for (let since = 0, backoff = first; ;) {
    let r;
    try {
      r = await client.wait({ since, timeout: Number(flags.timeout) || undefined, all: !!flags['all-projects'], ...(flags['grace-ms'] ? { grace: Number(flags['grace-ms']) } : {}) }, { agent });
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
      // Too many listeners already wait on this token (#479), e.g. ones left from sessions that ended: say so once,
      // then keep trying with the same backoff, so this one starts hearing as soon as a place frees up.
      if (flags.follow && e instanceof HubError && e.status === 429) {
        if (!crowded) console.log(`nuworq: ${e.message}; waiting for a place. ${e.hint ?? ''}`.trim());
        crowded = true;
        await new Promise((res) => setTimeout(res, backoff));
        backoff = Math.min(backoff * 2, cap);
        continue;
      }
      if (!flags.follow || agent || e.status !== 403 || !/^no operator has checked in/.test(e.message) || Date.now() >= until) throw e;
      await new Promise((res) => setTimeout(res, Math.min(settle / 12, Math.max(0, until - Date.now()))));
      continue;
    }
    away = null, told = false, crowded = false, backoff = first;
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
  if (!['claude', 'codex', 'opencode', 'pi'].includes(agent)) {
    throw new HubError(`unknown agent "${agent}"`, { hint: 'Use --agent claude, codex, opencode or pi. For anything else, give it the nuworq MCP server (nuworq init) and let it check in.' });
  }
  if (agent === 'opencode' && (typeof flags.model !== 'string' || !flags.model.includes('/'))) {
    throw new HubError('opencode needs a model: --model <provider>/<model>', { hint: 'e.g. --model ollama/qwen3.8:27b-mtp-q4_K_M (Ollama is configured for you), or any provider in your opencode config. A ~27B tool-calling model is reliable; see docs/OPEN-WEIGHT.md.' });
  }
  if (agent === 'pi' && (typeof flags.model !== 'string' || !flags.model.includes('/'))) {
    throw new HubError('pi needs a model: --model <provider>/<model>', { hint: "e.g. --model ollama/qwen3.8:27b-mtp-q4_K_M (Ollama is configured for you), or a pi built-in provider such as anthropic/claude-sonnet-5-5 with its key in the environment (ANTHROPIC_API_KEY): pi workers don't get your ~/.pi/agent sign-ins. See docs/OPEN-WEIGHT.md." });
  }
  // Only Claude Code's sandbox keeps a worker's shell from the machine's keys (#615, DENY_READ in src/sandbox.js).
  // A hostile hub's task text could have any other harness read them and report them back, so starting one takes
  // the person saying they know.
  if (agent !== 'claude' && !flags['can-read-keys']) {
    throw new HubError(`${agent} workers can read this machine's keys, so they start only with --can-read-keys`, {
      hint: `${readsKeys(agent)} To start it anyway: add --can-read-keys. To keep the keys out of reach: --agent claude.`,
    });
  }
  // Codex would take the server the same way, but its sandbox keeps it from serving the app to look at.
  if (flags.browser && agent !== 'claude') {
    throw new HubError('--browser is for Claude workers only', { hint: 'Use --agent claude --browser, or leave out --browser.' });
  }
  // Through llm-proxy: opencode and pi with --model proxy/<model> (its OpenAI Chat Completions, /v1, with a personal
  // key), Claude Code and Codex with --proxy (its provider routes, /anthropic and /openai). Provider routes answer only
  // the proxy's owner token, and only on its LAN or tailnet address: on its public hostname they answer 403.
  const proxied = String(flags.model ?? '').startsWith('proxy/');
  const byModel = agent === 'opencode' || agent === 'pi';
  if (flags.proxy === undefined && !proxied) return agent;
  if (!byModel && proxied) throw new HubError(`--agent ${agent} doesn't take a proxy/<model> model`, { hint: `Give --agent ${agent} --proxy http://host:4100: it goes through llm-proxy's ${agent === 'claude' ? 'Anthropic' : 'OpenAI'} route with its own models.` });
  if (byModel && !proxied) throw new HubError('--proxy needs a proxy/<model> model', { hint: `e.g. --agent ${agent} --model proxy/gpt-5 --proxy http://studio.local:8080` });
  if (!/^https?:\/\/[^/]/.test(proxyUrl(flags))) {
    throw new HubError(`${proxied ? '--model proxy/<model>' : '--proxy'} needs llm-proxy's address`, {
      hint: proxied ? 'Give --proxy http://host:port (or set NUWORQ_LLM_PROXY_URL), and its key in NUWORQ_LLM_PROXY_KEY.'
        : "Give --proxy with llm-proxy's LAN or tailnet address (e.g. http://studio.local:4100), and its owner token in NUWORQ_LLM_PROXY_TOKEN.",
    });
  }
  if (!proxied && !privateHost(new URL(proxyUrl(flags)).hostname)) {
    throw new HubError(`--proxy ${proxyUrl(flags)} is a public address: llm-proxy refuses its provider routes there`, {
      hint: "Claude Code and Codex go through llm-proxy's /anthropic and /openai routes, which answer only on its LAN or tailnet address. Give --proxy http://studio.local:4100 (or its tailnet name or 100.x address), and its owner token in NUWORQ_LLM_PROXY_TOKEN.",
    });
  }
  return agent;
}

// What a harness other than Claude Code can read, in one line (#615).
const readsKeys = (agent) => `A ${agent} worker's shell can read this machine's keys (~/.ssh, ~/.aws, ~/.nuworq, ~/.config/gh and the rest Claude workers can't): ${agent === 'codex' ? "Codex's workspace-write sandbox limits writes and network, not reads" : `${agent} has no sandbox`}.`;

// A LAN or tailnet host: loopback, private and CGNAT (Tailscale 100.64/10) IPs, single-label names, and
// local or tailnet suffixes (.local, .lan, .internal, .home.arpa, .ts.net). Anything else is a public hostname.
function privateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.includes(':')) return h === '::1' || /^f[cd]|^fe[89ab]/.test(h);
  const ip = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return !h.includes('.') || /\.(local|lan|internal|home\.arpa|localhost|ts\.net)$/.test(h);
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
  // NUWORQ_AGENT_TOKEN_FILE: how an installed runner keeps its --agent-token off its command line (#477).
  const fromFile = () => { try { return readFileSync(envVar('AGENT_TOKEN_FILE'), 'utf8').trim() || null; } catch { return null; } };
  const t = flags['agent-token'] || envVar('AGENT_TOKEN') || (envVar('AGENT_TOKEN_FILE') && fromFile()) || (me.role === 'agent' ? client.settings.token : null);
  const how = 'Create one on the hub host: nuworq token create <name> --role agent --project <project>. Pass it with --agent-token or NUWORQ_AGENT_TOKEN.';
  if (!t || t === true) throw new HubError('This hub requires login, so workers need their own agent token', { hint: how });
  const who = await createClient({ url: client.settings.url, token: t }).get('/api/me');
  if (who.role !== 'agent') {
    throw new HubError(who.role ? `--agent-token is a ${who.role} token; workers only get agent tokens` : 'The hub refused the agent token (wrong or revoked)', { hint: how });
  }
  return t;
}

async function worker(flags) {
  envNames(flags);
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
  const { name, worktree, main, origin, cwd, cmd, checkout, start, keys, tokenAt, piDir } = await setupOrClone(target, agent, flags, s, client, token);

  console.log(`${bold(`${name} → ${target.name}`)}${why ? dim(`  (${why})`) : ''}
${dim(worktree ? `Works in its own worktree ${worktree}, detached at ${main}. Each item it claims gets its own branch (the hub names it), made from the latest ${main}. When it's done: git worktree remove ${sq(worktree)}` : `Works in ${cwd}.`)}`);
  if (agent !== 'claude') console.log(amber(readsKeys(agent)));
  if (!flags.run) {
    console.log(`\n${cmd}\n`);
    console.log(dim({
      claude: `Headless agents can't ask permission: they may only use the tools in --allowedTools (the project's own test and build commands; change with --allow). Their shell runs in Claude Code's sandbox: it writes only in the worktree and temp, and reaches only the hub, GitHub, the project's registries and the hosts its settings add. ${origin ? 'Pushes go through the hub, which takes nuworq/ branches only; the hub lands work on main.' : 'Never git push.'}`,
      codex: `Codex runs in its workspace-write sandbox (it limits writes and network, not reads); the nuworq MCP server runs outside it, so it can reach the hub.`,
      opencode: `opencode has no sandbox, so it runs only on projects without a remote, and never git pushes (denied). Use a model that calls tools well; see docs/OPEN-WEIGHT.md.`,
      pi: `pi has no sandbox, so it runs only on projects without a remote, and never git pushes (nuworq's pi extension blocks it). Its config is a folder of its own (${piDir}): none of your pi extensions, skills, MCP servers or sign-ins follow it in. Use a model that calls tools well; see docs/OPEN-WEIGHT.md.`,
    }[agent] + '\nAdd --run to start it now.'));
    if (s.token) console.log(dim('Replace <agent-token> with an agent token (nuworq token create <name> --role agent --project <p>). With --run, pass it as --agent-token.'));
    return;
  }
  const { spawn } = await import('node:child_process');
  // Its checkout as the runner (the person's git setup, SSH agent included); the agent itself on an allowlisted
  // environment: only what its harness needs to reach its model, which it keeps from its shell (#616).
  try {
    if (checkout) execFileSync('/bin/sh', ['-c', checkout], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...withoutTokens(), GIT_TERMINAL_PROMPT: '0' } });
  } catch (e) {
    dropTokenFile(tokenAt);
    dropPiDir(piDir);
    process.exitCode = e.status ?? 1;
    return;
  }
  const child = spawn('/bin/sh', ['-c', start], { stdio: ['inherit', 'pipe', 'inherit'], env: workerEnv(keys) });
  const usage = await tapUsage(child, agent, flags, (l) => console.log(l));
  await new Promise((done) => child.on('close', (code) => { process.exitCode = code ?? 1; done(); }));
  dropTokenFile(tokenAt);
  dropPiDir(piDir);
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
// flags.chosen (nuworq run, #477): the folders the person chose on this machine. The hub's folder for a project
// counts only when it is one of them, and a checkout found by remote only inside one.
function homeOf(target, flags) {
  if (flags.here) return process.cwd();
  if (flags.chosen) {
    const ok = (p) => inChosen(p, flags.chosen);
    const home = target.path && ok(target.path) && existsSync(target.path) && (!target.repo || repoRemote(target.path) === target.repo)
      ? target.path
      : target.repo || target.remotes?.length ? checkoutOf(target.repo ? [target.repo] : target.remotes) : null;
    if (home && ok(home)) return home;
    throw new HubError(home ? `${home} isn't a folder you chose for workers on this machine` : `${target.name ?? target.slug} has no folder you chose for workers on this machine`, {
      hint: 'Run `nuworq run` in a terminal to choose the folders workers may use, or add one with `nuworq run --folder <path>`.',
    });
  }
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
  // A path remote is a folder on this machine: only a hub on this machine may have one cloned (#477).
  if (remote.startsWith('/') && !loopback(s.url)) throw missing;
  if (github) {
    const info = await client.get('/api/info').catch(() => ({}));
    if (!info.github_app || info.github_app === 'create') throw missing;
  }
  const dir = cloneDir(remote);
  const cant = (why) => new HubError(`Couldn't clone ${remote} into ${dir}: ${why}`, { hint: missing.hint });
  if (existsSync(dir)) throw cant('something else is there');
  if (flags.chosen && !inChosen(dir, flags.chosen)) throw cant("that isn't inside a folder you chose for workers; run `nuworq run` in a terminal to choose one");
  const helper = `!node ${sq(BIN)} git-credential --project ${sq(checkName('project', target.slug))}`;
  const file = token ?? s.token ? tokenFile(dirname(HUB_FILE), `clone-${randomBytes(3).toString('hex')}`, token ?? s.token) : null;
  try {
    execFileSync('git', ['-c', 'credential.https://github.com.helper=', '-c', `credential.https://github.com.helper=${helper}`, '-c', 'credential.https://github.com.useHttpPath=true',
      'clone', '-q', github ? `https://${remote}.git` : remote, dir], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...withoutTokens(), GIT_TERMINAL_PROMPT: '0', NUWORQ_URL: s.url, ...(file ? { NUWORQ_TOKEN_FILE: file } : {}) },
    });
  } catch (e) {
    throw cant(redact(String(e.stderr || '').trim().split('\n').filter(Boolean).pop() ?? 'git clone failed'));
  } finally {
    dropTokenFile(file);
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

// The variable a custom Codex provider takes its key from (env_key in its [model_providers.<p>] table), so a worker's
// environment keeps it (#616). null when there's none to read.
function codexKey(provider) {
  if (!provider) return null;
  let text = '';
  try { text = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8'); } catch { return null; }
  const table = text.split(/^\s*(?=\[)/m).find((t) => t.startsWith(`[model_providers.${provider}]`)) ?? '';
  const k = table.match(/^\s*env_key\s*=\s*"([^"]+)"/m)?.[1];
  return k && /^\w+$/.test(k) ? k : null;
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

// A pi worker's config folder (#495), ~/.nuworq/pi/<worker>, made fresh each start: mcp.json with the nuworq server
// (direct exposure: its tools as they are; the token only as the path of its file, #477), and models.json for the
// provider of --model. Ollama and llm-proxy (proxy/<model>, OpenAI Chat Completions) are providers it adds; any other
// is one of pi's built-in ones, which only gets the x-client-name header, and its key from the environment.
const PI_GUARD = fileURLToPath(new URL('../src/piguard.js', import.meta.url));
function piConfig(name, { env, model, label, proxy }) {
  const dir = join(dirname(HUB_FILE), 'pi', checkName('worker name', name));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const [provider, ...rest] = model.split('/');
  const id = rest.join('/');
  const headers = { 'x-client-name': label };
  const providers = provider === 'ollama'
    ? { ollama: { baseUrl: process.env.OLLAMA_URL || 'http://localhost:11434/v1', api: 'openai-completions', apiKey: 'ollama', headers, models: [{ id }] } }
    // The key spends money: pi reads it from the worker's environment ($NAME), so it's in neither argv nor this file.
    : provider === 'proxy'
      ? { proxy: { name: 'llm-proxy', baseUrl: `${proxy}/v1`, api: 'openai-completions', apiKey: '$NUWORQ_LLM_PROXY_KEY', headers, models: [{ id }] } }
      : { [provider]: { headers } };
  const write = (f, v) => writeFileSync(join(dir, f), `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 });
  write('mcp.json', { mcpServers: { nuworq: { command: 'node', args: [BIN, 'mcp'], env: { ...env, NUWORQ_MODEL: id, NUWORQ_CLIENT: 'pi' }, exposure: 'direct' } } });
  write('models.json', { providers });
  return dir;
}
const dropPiDir = (dir) => { try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } };

// A Claude worker runs only what the runner gives it (#360). --strict-mcp-config drops the person's own MCP
// servers; plugins come from settings, so every plugin installed on this machine is turned off for the worker.
// Otherwise one installed for a checkout (--scope local) follows into every worktree of it, with its own MCP
// server (a second, unscoped nuworq identity), skills and tool definitions in each worker's context.
// Skills in ~/.claude/skills (nuworq-operator among them) aren't plugins: --disable-slash-commands keeps every
// skill and command out (#368). A worker needs none: its task and the nuworq MCP server's instructions say it all.
// Its shell runs in Claude Code's sandbox (#472, src/sandbox.js): writes in its worktree, the checkout's .git and
// temp only, and the network to the hub, GitHub, the project's registries and the hosts a person added for it.
// Its file tools answer to permissions instead, which say the same (filePermissions): edits in its folder only, and
// no reads of the keys the sandbox hides. Set here, from --settings, so no settings file in the repository can loosen it.
// own: the allowlist is the person's (--allow), so only the denies are added to it.
function workerSettings(sandbox, { own = false } = {}) {
  let plugins = {};
  try {
    const file = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'plugins', 'installed_plugins.json');
    plugins = JSON.parse(readFileSync(file, 'utf8')).plugins ?? {};
  } catch { /* none installed */ }
  const files = sandbox && filePermissions(sandbox);
  return JSON.stringify({ enabledPlugins: Object.fromEntries(Object.keys(plugins).map((p) => [p, false])),
    ...(sandbox ? { sandbox: sandboxSettings(sandbox), permissions: own ? { deny: files.deny } : files } : {}) });
}

// A worker's git, set in its environment (#472). credential.helper's empty value drops every helper set before it
// (osxkeychain, gh, the person's own), and so do the github.com ones; then nuworq's, the only one. Pushes for
// github.com, by HTTPS or SSH address, go to the hub's /api/git/. SSH addresses fetch over HTTPS too, and the
// SSH agent is unset, so no SSH key of the person's is ever used.
function gitEnv({ hub, tokenAt, name, project }) {
  // Every value quoted, and the token only as the path of its 0600 file (#477).
  const helper = `!NUWORQ_URL=${sq(hub)}${tokenAt ? ` NUWORQ_TOKEN_FILE=${sq(tokenAt)}` : ''} node ${sq(BIN)} git-credential --project ${sq(project)} --as ${sq(name)}`;
  const through = `${hub.replace(/\/+$/, '')}/api/git/github.com/`;
  const config = [
    ['credential.helper', ''], ['credential.https://github.com.helper', ''], ['credential.helper', helper], ['credential.useHttpPath', 'true'],
    ['url.https://github.com/.insteadOf', 'git@github.com:'], ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
    [`url.${through}.pushInsteadOf`, 'https://github.com/'], [`url.${through}.pushInsteadOf`, 'git@github.com:'], [`url.${through}.pushInsteadOf`, 'ssh://git@github.com/'],
  ];
  return `unset SSH_AUTH_SOCK && export GIT_CONFIG_COUNT=${config.length} ${config.map(([k, v], i) => `GIT_CONFIG_KEY_${i}=${sq(k)} GIT_CONFIG_VALUE_${i}=${sq(v)}`).join(' ')}`;
}

// The shell command that gives a worker its worktree (detached at main, or at origin/main after a
// fetch when there is an origin; reused if it exists) and starts the agent in it.
// token: the agent token the worker gets when it runs (null: the hub needs none, or we only print).
// --here: work in this folder (a clone of the project), whatever folder the hub has on record.
function workerSetup(target, agent, flags, s, token = null) {
  const home = homeOf(target, flags);

  // Names from the hub (and --as) reach shells and file names: plain names only (#477).
  checkName('project', target.slug);
  const name = checkName('worker name', flags.as || `${agent}-${randomBytes(2).toString('hex')}`);
  // The project's extra sandbox hosts, as the hub sends them (#624): the hub checks them when a person sets them, but
  // a runner trusts its machine, not the hub. Anything but host names (a bare *, a URL, *.com) starts nothing.
  let hosts;
  try { hosts = sandboxHosts(target.sandbox_hosts ?? []); } catch (e) {
    throw new HubError(`Not starting a worker for ${target.name ?? target.slug}: the hub sent sandbox hosts the runner refuses (${e.message})`, {
      hint: 'A person sets them in the project\'s Settings, as host names (api.example.com, *.example.com). A hub that sends anything else isn\'t trusted to widen a worker\'s network.',
    });
  }
  // Its agent token goes in a 0600 file the MCP server and the credential helper read; only the file's path is
  // in the commands and the environment (#477).
  const tokenAt = token ? tokenFile(dirname(HUB_FILE), name, token) : null;
  const isRepo = existsSync(join(home, '.git'));
  // With an origin (GitHub), work starts from main there and lands by pushing to it.
  const origin = isRepo && hasOrigin(home);
  // opencode and pi have no sandbox to keep their shell in (#472): they run only where there is nothing to push to.
  if ((agent === 'opencode' || agent === 'pi') && origin) {
    throw new HubError(`${agent} workers aren't started for ${target.name}: it has a remote, and ${agent} has no sandbox`, {
      hint: `${agent}'s shell could read this machine's keys and reach any host, so it works only on projects without an origin. Use --agent claude (its shell runs in Claude Code's sandbox) or --agent codex --can-read-keys (workspace-write: limited writes and network, but it can read the keys).`,
    });
  }
  const worktree = isRepo && !flags.here ? join(`${home}.worktrees`, name) : null;
  const main = isRepo ? mainBranch(home) : 'main';
  const cwd = worktree ?? home;
  const has = (f) => existsSync(join(home, f));
  const browser = agent === 'claude' && !!flags.browser; // --browser: a headless Chrome to look at UI work with
  const tags = detectHas(flags);
  // The model it runs on, when one is named (--model, or the job's under model routing, #347): the agent starts on
  // it, and checks in saying so. opencode and pi name their own (provider/model) below.
  const model = typeof flags.model === 'string' && flags.model ? flags.model : '';
  const env = {
    NUWORQ_URL: s.url, NUWORQ_PROJECT: target.slug, NUWORQ_AGENT: name,
    ...(tags.length ? { NUWORQ_HAS: tags.join(',') } : {}),
    ...(model && agent !== 'opencode' && agent !== 'pi' ? { NUWORQ_MODEL: model } : {}),
    // A worker nuworq run started says so at checkin, with its runner (#238); a runner's token says it too.
    ...(flags.run ? { NUWORQ_ROLE: 'worker', NUWORQ_RUNNER: hostname() } : {}),
    ...(tokenAt ? { NUWORQ_TOKEN_FILE: tokenAt } : s.token && !flags.run ? { NUWORQ_TOKEN: '<agent-token>' } : {}),
  };
  const task = [
    `Work on the ${target.name} project using nuworq (project: ${target.slug}). Do the work in this directory.`,
    worktree && origin ? `You work in your own git worktree, ${worktree}. For each item, the hub names a branch: create it from the latest ${main} on origin with \`git fetch origin\`, then \`git switch -c <branch> origin/${main}\`, or \`git switch <branch>\` if it exists. Commit your work there, push the branch before you submit (\`git push origin <branch>\`), and include the branch and commit in your evidence. Your pushes go through the hub, which takes only nuworq/ branches: ${main} and tags are the hub's. To land accepted work, follow the hub's steps: rebase onto origin/${main}; where CI checks the pull request, push the rebased branch and let its checks decide; otherwise run the checks, push the rebased branch (\`git push origin <branch> --force-with-lease\`), then submit; the hub puts it on ${main}. Never work in the main checkout, ${home}.`
      : worktree ? `You work in your own git worktree, ${worktree}. For each item, the hub names a branch: create it from the latest ${main} with \`git switch -c <branch> ${main}\`, or \`git switch <branch>\` if it exists. Commit your work there, and include the branch and commit in your evidence when you submit. Never work in the main checkout, ${home}.` : '',
    browser && (has('bin/nuworq.js')
      ? 'To check UI work, start a local nuworq with demo data from this worktree on a free port: run `node bin/nuworq.js serve --demo --port 0` in the background; it prints its address, and on loopback it needs no login. When you ship a visible UI feature, add its key with today\'s date to web/new.js and data-new="<key>" to its element, so people see it\'s new.'
      : 'To check UI work, start the app from this worktree on a free local port, in the background.'),
    browser && 'Then look at it with the browser tools (mcp__playwright: local pages only) at desktop width and at 375px wide (browser_resize), in light and in dark: the app follows the device, so to check dark set document.documentElement.dataset.theme = "dark" with browser_evaluate. Take each screenshot without a file name, look at it, and describe in your evidence what you saw. Stop the server when you are done.',
    'While you work, run only the tests that cover what you change. For the whole suite, follow the hint `next` gives: where CI checks the pull request, CI runs it; otherwise run it once, just before you submit.',
    // Routed (#347), it was started on the model this one job calls for, so it takes that job and no other.
    flags.job ? `You were started on ${model} for one job: ${flags.job.mode} ${flags.job.item}. After checkin, claim ${flags.job.item}, do that job, then sign off. If you can't claim it, sign off; don't take other work.`
      : 'Keep going until next says there is nothing left for you, then sign off.',
  ].filter(Boolean).join(' ');

  // The project's own test and build commands, never an interpreter that runs anything (#472, src/sandbox.js).
  const run = [
    projectCommands(home),
    // nuworq itself: the demo hub its UI work is looked at with.
    browser && has('bin/nuworq.js') && ['Bash(node bin/nuworq.js serve --demo --port 0)'],
    isRepo && ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git switch:*)', 'Bash(git rebase:*)'],
    // Landing without an origin: fast-forward main in this one checkout. Nothing else with -C.
    isRepo && !origin && [`Bash(git -C ${home} merge --ff-only:*)`],
    // Through origin: fetch, and push the item's branch. Every push goes through the hub, which passes on only
    // nuworq/ branches (src/gitproxy.js); landing on main is the hub's.
    origin && ['Bash(git fetch:*)', 'Bash(git push origin:*)'],
  ].filter(Boolean).flat();
  const allow = [...(flags.allow ? [String(flags.allow)] : ['mcp__nuworq', 'Bash(ls:*)', ...run]),
    ...(browser ? ['mcp__playwright'] : [])].join(',');
  const mcp = JSON.stringify({ mcpServers: { nuworq: { command: 'node', args: [BIN, 'mcp'], env }, ...(browser ? { playwright: browserServer(name) } : {}) } });

  // The worktree first. `nuworq run` runs this part on its own, so a checkout that can't be updated is told
  // apart from an agent that fails.
  const setup = [];
  if (worktree && origin) {
    // A fetch over HTTPS from GitHub gets a read-only token for the project's repository from the hub's
    // GitHub App: the worker holds no item yet. Only that helper: the person's own are reset. SSH needs none.
    // Every value in it quoted, and the token only as the path of its 0600 file (#477).
    const reader = `!NUWORQ_URL=${sq(s.url)}${tokenAt ? ` NUWORQ_TOKEN_FILE=${sq(tokenAt)}` : ''} node ${sq(BIN)} git-credential --project ${sq(target.slug)} --as ${sq(name)}`;
    setup.push(`git -C ${sq(home)} -c credential.helper= -c credential.https://github.com.helper= -c ${sq(`credential.https://github.com.helper=${reader}`)} -c credential.https://github.com.useHttpPath=true fetch -q origin`,
      `{ [ -d ${sq(worktree)} ] || git -C ${sq(home)} worktree add -q --detach ${sq(worktree)} ${sq(`origin/${main}`)}; }`);
  } else if (worktree) setup.push(`{ [ -d ${sq(worktree)} ] || git -C ${sq(home)} worktree add -q --detach ${sq(worktree)} ${sq(main)}; }`);
  const lines = [`cd ${sq(cwd)}`];
  // git in this worker's processes only (no config file changes): nuworq's helper is its one credential helper
  // (the person's keychain, gh and any other are reset), answering GitHub with a read-only token for the project's
  // repository and the hub with the worker's name. Pushes to GitHub go to the hub instead (#472), which passes
  // nuworq/ branches on with its own token. SSH remotes go over HTTPS, without the person's SSH agent.
  if (origin) lines.push(gitEnv({ hub: s.url, tokenAt, name, project: target.slug }));
  // Node's fetch goes through the sandbox's proxy, as git and curl do (the credential helper reaches the hub).
  if (agent === 'claude') lines.push('export NODE_USE_ENV_PROXY=1');
  // Workers each running a Node project's whole suite on every core at once saturate the machine: their test
  // runs take at most 2 files at a time (unless the operator set otherwise). Node refuses --test-concurrency in
  // NODE_OPTIONS, so the project's test script reads this (nuworq's own does: scripts/run-tests.js).
  if (has('package.json')) lines.push('export NUWORQ_TEST_CONCURRENCY=${NUWORQ_TEST_CONCURRENCY:-2}');
  // Started here (--run), the agent speaks JSON, so its usage can be read and recorded (src/usage.js tap).
  const json = flags.run ? { claude: ' \\\n  --output-format stream-json --verbose', codex: ' --json', opencode: ' --format json', pi: ' --mode json' }[agent] : '';
  // Model traffic says who it is, so llm-proxy (when it goes through one) can be read per worker (#76).
  // Other endpoints ignore the header.
  const label = clientLabel(target.slug, name);
  // What its harness needs from the environment to reach its model; workerEnv passes on that and no other secret (#616).
  const codexOwn = agent === 'codex' && flags.proxy === undefined ? codexProvider(flags) : null;
  const harness = harnessKeys(agent, { proxy: flags.proxy !== undefined, model, codexKey: codexKey(codexOwn) });
  let piDir = null;
  if (agent === 'claude') {
    // The runner's own headers (they may carry llm-proxy's x-proxy-token) are expanded by the shell from the
    // inherited variable, so their values are never in argv or printed (#493).
    const headers = `"\${ANTHROPIC_CUSTOM_HEADERS:+$ANTHROPIC_CUSTOM_HEADERS\n}"${sq(`x-client-name: ${label}`)}`;
    // --proxy: Claude Code's traffic goes to llm-proxy's Anthropic route with the proxy's owner token (not the
    // hub's read-only NUWORQ_LLM_PROXY_KEY). The shell expands it, so it's never in argv or printed; then it goes, so
    // only the name Claude Code scrubs carries it.
    if (flags.proxy !== undefined) lines.push(`export ANTHROPIC_BASE_URL=${sq(`${proxyUrl(flags)}/anthropic`)} ANTHROPIC_AUTH_TOKEN="$NUWORQ_LLM_PROXY_TOKEN"`, 'unset NUWORQ_LLM_PROXY_TOKEN');
    // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: its shell, hooks and MCP servers start without Claude Code's own credentials (#616).
    lines.push(`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 ANTHROPIC_CUSTOM_HEADERS=${headers} \\\n  claude -p ${sq(task)}${json}${model ? ` --model ${sq(model)}` : ''} \\\n  --mcp-config ${sq(mcp)} --strict-mcp-config \\\n  --settings ${sq(workerSettings({ hub: s.url, home, worktree, hosts, landsHere: !origin, tokenFile: tokenAt }, { own: !!flags.allow }))} --disable-slash-commands \\\n  --allowedTools ${sq(allow)}${browser ? ` \\\n  --disallowedTools ${sq(BROWSER_DENY)}` : ''}`);
  } else if (agent === 'opencode') {
    // Config goes in the environment, not an opencode.json the agent might commit. opencode takes its
    // folder from $PWD (cd keeps it right) and waits on a non-TTY stdin, hence < /dev/null.
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
  } else if (agent === 'pi') {
    // pi reads its config from one folder (PI_CODING_AGENT_DIR): this worker's own, written here, so none of the
    // person's ~/.pi/agent (extensions, skills, prompt templates, MCP servers, sign-ins, AGENTS.md) follows it in, and
    // nothing lands in the worktree. --no-approve skips a project's .pi folder; its AGENTS.md still loads, as for
    // Claude. Extensions are off but two: pi's own MCP support (builtin:mcp; --no-extensions drops it too) and nuworq's guard
    // (src/piguard.js, from this package: no git push). No codemode, so no tool reaches bash around the guard. No session file.
    piDir = piConfig(name, { env, model, label, proxy: proxyUrl(flags) });
    lines.push(`PI_CODING_AGENT_DIR=${sq(piDir)} \\\n  pi -p${json} --model ${sq(model)} --no-session --no-approve \\\n  --no-extensions -e builtin:mcp -e ${sq(PI_GUARD)} --no-skills --no-prompt-templates --no-themes \\\n  -- ${sq(task)} < /dev/null`);
  } else {
    const envToml = `{${Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',')}}`;
    // Codex's built-in openai provider takes no headers; a custom one (how traffic reaches llm-proxy) does.
    // --proxy: a provider of its own for llm-proxy's OpenAI route (Responses), keyed by the owner token from the
    // worker's environment (env_key), so the token is never in argv or printed.
    const provider = codexOwn;
    const named = flags.proxy !== undefined
      ? ` \\\n  -c ${sq('model_provider="llmproxy"')} \\\n  -c ${sq(`model_providers.llmproxy={name="llm-proxy",base_url=${JSON.stringify(`${proxyUrl(flags)}/openai/v1`)},env_key="NUWORQ_LLM_PROXY_TOKEN",wire_api="responses",http_headers={"x-client-name"=${JSON.stringify(label)}}}`)}`
      : provider ? ` \\\n  -c ${sq(`model_providers.${provider}.http_headers={"x-client-name"=${JSON.stringify(label)}}`)}` : '';
    // Its shell starts without the key Codex reaches its model with (#616): by name, and anything named like a key,
    // token or secret (Codex's default excludes, set here so no config turns them off).
    const scrub = ` \\\n  -c ${sq('shell_environment_policy.ignore_default_excludes=false')} \\\n  -c ${sq(`shell_environment_policy.exclude=${JSON.stringify(harness.secret)}`)}`;
    lines.push(`codex exec${json}${model ? ` -m ${sq(model)}` : ''} -s workspace-write \\\n  -c ${sq('mcp_servers.nuworq.command="node"')} \\\n  -c ${sq(`mcp_servers.nuworq.args=${JSON.stringify([BIN, 'mcp'])}`)} \\\n  -c ${sq('mcp_servers.nuworq.default_tools_approval_mode="approve"')} \\\n  -c ${sq(`mcp_servers.nuworq.env=${envToml}`)}${named}${scrub} \\\n  ${sq(task)}`);
  }
  return {
    name, home, worktree, main: origin ? `origin/${main}` : main, origin, cwd, tokenAt, piDir,
    keys: [...harness.secret, ...harness.config, ...namedEnv(flags.env, flags['env-secret'])],
    checkout: setup.join(' && '), start: lines.join(' && \\\n'), cmd: [...setup, ...lines].join(' && \\\n'),
  };
}

// `nuworq run --install [run flags]`: the same runner as a LaunchAgent (macOS) or systemd user unit (Linux), so
// it outlives the terminal and comes back after a reboot. --uninstall stops and removes it (#172).
// argv: the run flags the service keeps (connect and staff pass their own: #490). cwd: where it starts, this folder
// unless given (nuworq up keeps the folder an installed runner had: #559). agentTokenFile: the token file an installed
// runner had, kept when no --agent-token is given (nuworq up restarting it: #582).
// The variables named with --env and --env-secret (#616), checked; a name it won't pass is a HubError with its hint.
function envNames(flags) {
  try { return namedEnv(flags.env, flags['env-secret']); } catch (e) { throw new HubError(e.message, { hint: e.hint }); }
}

async function runService(flags, { argv = process.argv.slice(3), cwd = process.cwd(), agentTokenFile: kept = null } = {}) {
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
  try { args = svc.serviceArgs(argv); } catch (e) { throw new HubError(e.message, { hint: e.hint }); }
  // The variables named with --env go into the service with their values from this shell (#616); a secret never
  // does: the service's definition isn't a place for one.
  const named = envNames(flags);
  if (flags['env-secret'] !== undefined) throw new HubError('--env-secret isn\'t kept by an installed runner: its service definition would hold the secret', { hint: 'Run nuworq run --env-secret … in a terminal instead, or leave it out.' });
  lockDown(dirname(HUB_FILE));
  // The folders its workers may use, chosen now while there's a terminal to ask in (#477).
  await chooseWorkFolders(flags, await createClient(flags).get('/api/projects').catch(() => []), resolveSettings(flags));
  // --agent-token never goes on the service's command line, where ps shows it: a 0600 file it reads instead.
  const taken = svc.takeToken(args);
  args = taken.args;
  const agentTokenFile = taken.token ? tokenFile(dirname(HUB_FILE), 'run-agent', taken.token) : kept;
  const log = join(dirname(HUB_FILE), 'logs', 'run.log');
  // It starts where it was installed and looks for checkouts beside this one, as `nuworq run` typed here does (#225).
  // NUWORQ_SERVICE: it knows it's the service, so it may exit to move onto a newly installed nuworq (#456).
  const env = { ...svc.serviceEnv(process.env, { repos: besideOf(cwd), names: named }), NUWORQ_SERVICE: svc.LABEL, ...(agentTokenFile ? { NUWORQ_AGENT_TOKEN_FILE: agentTokenFile } : {}) };
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

// The folders workers may use on this machine (#477), kept in ~/.nuworq/folders.json: those chosen before, any
// --folder given now, and, in a terminal, each place this runner looks for checkouts (beside this folder, and
// NUWORQ_REPOS) that the person says yes to. A folder the hub names is offered only by a hub on this machine,
// and still asked about. A service, with no terminal, uses only what was chosen.
async function chooseWorkFolders(flags, projects, s) {
  const dir = dirname(HUB_FILE);
  const given = [flags.folder].flat().filter((f) => typeof f === 'string' && f).map((f) => resolve(f));
  let chosen = given.length ? chooseFolders(dir, given) : chosenFolders(dir);
  const local = loopback(s.url) ? (projects ?? []).filter((p) => !p.remotes?.length && p.path).map((p) => p.path) : [];
  const offer = toOffer([besideOf(process.cwd()), ...String(envVar('REPOS') ?? '').split(delimiter), ...local], chosen);
  if (offer.length && process.stdin.isTTY && process.stdout.isTTY) {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const yes = [];
    try {
      for (const f of offer) if (/^y(es)?$/i.test((await rl.question(`Let workers work in checkouts inside ${bold(f)}? [y/N] `)).trim())) yes.push(f);
    } finally { rl.close(); }
    if (yes.length) chosen = chooseFolders(dir, yes);
  }
  if (!chosen.length) {
    console.log(`${amber('!')} No folder is chosen for workers on this machine, so none will start. Run ${bold('nuworq run')} in a terminal to choose, or ${bold('nuworq run --folder <path>')}.`);
  }
  return chosen;
}

// Staffing is never off without saying so (#491): --staff <project> opts it in; with none opted in, it says so, and
// at a terminal offers the project of the clone it runs in (or asks which). A yes turns on the same switch as Settings.
async function staffing(client, projects, flags) {
  const { staffCheck } = await import('../src/runner.js');
  const { remote, root } = client.settings;
  const here = projects.find((p) => !p.parked && ((remote && (p.remotes ?? []).includes(remote)) || (p.path && p.path === root))) ?? null;
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  const rl = tty ? (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    await staffCheck({
      projects, here, staff: flags.staff, ask: rl ? (q) => rl.question(q) : null, log: (l) => console.log(l.startsWith('No project') ? `${amber('!')} ${l}` : l),
      optIn: (p) => client.post(`/api/p/${encodeURIComponent(p.slug)}/human/settings`, { runner: true }).catch((e) => {
        throw new HubError(`Couldn't staff ${p.name ?? p.slug}: ${e.message}`, { hint: `Turn on "Staff it with nuworq run" in its Settings on the hub (this machine's token may not change settings).` });
      }),
    });
  } catch (e) {
    throw e.hint && !(e instanceof HubError) ? new HubError(e.message, { hint: e.hint }) : e;
  } finally { rl?.close(); }
}

// Keep up to --workers headless workers on waiting work in the projects the human opted in.
async function runCmd(flags) {
  if (flags.install || flags.uninstall) return runService(flags);
  envNames(flags); // a name it won't pass stops it here, before any work starts
  const s = resolveSettings(flags);
  const agent = agentOf(flags);
  if (agent !== 'claude') console.log(amber(readsKeys(agent)));
  const client = createClient(flags);
  await staffing(client, await hubProjects(client), flags);
  const token = await agentToken(client, flags);
  const num =(v, d) => (v === undefined ? d : Number(v) > 0 ? Number(v) : (() => { throw new HubError(`expected a positive number, got "${v}"`, { hint: 'See: nuworq help' }); })());
  const { spawn, execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { createWriteStream } = await import('node:fs');
  const { run, cleanWorktree, cleanBranch, sweep, sweepLine, unstaffedLine, refsOf, restoreRefs, restoredLine, keptLine } = await import('../src/runner.js');
  // The worktrees of the workers running now: each one's branch is its own to move (#618).
  const live = new Set();
  const logs = join(dirname(HUB_FILE), 'logs');
  lockDown(dirname(HUB_FILE)); // 0700 folders and 0600 files, again on every start (#477)
  const chosen = await chooseWorkFolders(flags, await hubProjects(client), s);
  const git = async (args) => (await promisify(execFile)('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout;
  // The branches of a project's done and dropped items; merged: those whose PR merged (#455).
  const finishedOf = async (slug) => {
    const r = await client.get(`/api/finished?project=${encodeURIComponent(slug)}`);
    return { finished: new Set(r.branches ?? []), merged: new Set(r.merged ?? []) };
  };

  // The sweep (#444): every opted-in project's checkout on this machine, minus what running workers are in.
  // Weekly from the runner (when it last ran is kept in sweep.json), or now with --sweep (--dry-run: only say).
  const SWEPT = join(dirname(HUB_FILE), 'sweep.json');
  const sweepAll = async (running = [], dryRun = false) => {
    const { statSync } = await import('node:fs');
    // Since its HEAD last moved (a checkout, commit or switch); its index changes on any git status, even ours.
    const idle = async (path) => {
      const dir = (await git(['-C', path, 'rev-parse', '--absolute-git-dir'])).trim();
      const at = Math.max(...['HEAD', 'logs/HEAD'].map((f) => { try { return statSync(join(dir, f)).mtimeMs; } catch { return 0; } }));
      return Date.now() - at;
    };
    const homes = new Map();
    for (const target of await hubProjects(client)) {
      let home;
      try { home = homeOf(target, { chosen }); } catch { continue; }
      if (home && existsSync(join(home, '.git')) && !homes.has(home)) homes.set(home, target);
    }
    for (const [home, target] of homes) {
      const r = await sweep({ home, ...await finishedOf(target.slug), git, idle, keep: running.map((w) => w.worktree).filter(Boolean), dryRun });
      console.log(sweepLine(target.name ?? target.slug, r, { dryRun }));
      for (const k of r.kept) console.log(dim(`  kept ${k.what}: ${k.why}${k.detail ? ` (${k.detail})` : ''}`));
      if (dryRun) for (const w of [...r.worktrees.map((x) => `worktree ${x}`), ...r.branches.map((x) => `branch ${x}`)]) console.log(dim(`  ${w}`));
    }
    if (!dryRun) writeFileSync(SWEPT, `${JSON.stringify({ at: Date.now() })}\n`);
  };
  if (flags.sweep) return sweepAll([], !!flags['dry-run']);
  const sweptAt = (() => { try { return Number(JSON.parse(readFileSync(SWEPT, 'utf8')).at) || 0; } catch { return 0; } })();

  const launch = async (r) => {
    const projects = await hubProjects(client);
    const target = projects.find((p) => p.slug === r.project);
    if (!target) throw new HubError(`the hub no longer has project "${r.project}"`);
    // The route names the repository of the work it found; with several, the worker starts there.
    const repo = (target.remotes ?? []).length > 1 ? r.repo : null;
    // A project that routes models (#347) names the one this job calls for: the worker starts on it, for that one job.
    const routed = r.model ? { model: r.model, job: r } : {};
    let setup;
    try {
      setup = await setupOrClone({ ...target, repo }, agent, { ...flags, as: undefined, run: true, chosen, ...routed }, s, client, token);
    } catch (e) {
      // This machine can't work on the project (no checkout of it here): the runner leaves it to others.
      if (e instanceof HubError) e.skip = true;
      throw e;
    }
    const { name, home, worktree, cwd, checkout, start, keys, tokenAt, piDir } = setup;
    const log = join(logs, `${name}.log`);
    // Its worktree, at the latest main. When git can't do that (e.g. it can't reach origin), the agent never
    // starts: the runner leaves the project alone for a while and the others go on.
    if (checkout) {
      try {
        await promisify(execFile)('/bin/sh', ['-c', checkout], { env: { ...withoutTokens(), GIT_TERMINAL_PROMPT: '0' }, timeout: 5 * 60_000 });
      } catch (e) {
        // git's own words only: the error's message holds the whole command.
        const err = redact(String(e.stderr || (e.killed ? 'timed out' : `exited with ${e.code ?? 'an error'}`)).trim());
        writeFileSync(log, `${err}\n`, { mode: 0o600 });
        dropTokenFile(tokenAt);
        dropPiDir(piDir);
        const said = err.split('\n').find((l) => /^(fatal|error):/.test(l)) ?? err.split('\n').pop();
        throw Object.assign(new HubError(`couldn't update its checkout: ${said}`, { hint: `log: ${log}` }), { skip: true, pause: true });
      }
    }
    // The checkout's branches and tags as the worker starts (#618), to put back whatever it moves that isn't its own.
    const refsBefore = worktree ? await refsOf(home, git).catch(() => null) : null;
    if (worktree) live.add(worktree);
    const out = createWriteStream(log, { mode: 0o600 });
    // Its own process group, so stopping it stops the agent too, not just the shell. Never the runner's tokens, and
    // of its other secrets only what the agent's harness reaches its model with (#616).
    const child = spawn('/bin/sh', ['-c', start], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: workerEnv(keys) });
    // Its log holds no tokens (#477).
    const usage = await tapUsage(child, agent, { ...flags, ...routed }, (l) => out.write(`${redact(l)}\n`));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => out.write(redact(c)));
    return {
      name, project: target.slug, worktree, where: dim(`${worktree ?? cwd}  log: ${log}`),
      kill: (sig) => { try { process.kill(-child.pid, sig); } catch {} },
      exited: new Promise((done) => child.on('close', async (code, sig) => {
        out.end();
        dropTokenFile(tokenAt);
        dropPiDir(piDir);
        await reportUsage(s, token, target.slug, name, usage());
        // Its worktree goes with it, unless something there would be lost; and its branch, once its item is
        // done or dropped and all of it is on origin (#444).
        if (worktree) {
          live.delete(worktree);
          const branch = (await git(['-C', worktree, 'symbolic-ref', '-q', '--short', 'HEAD']).catch(() => '')).trim();
          if (refsBefore) await guardRefs({ home, branch, name, project: target.slug, before: refsBefore });
          const r = await cleanWorktree(worktree, git).catch((e) => ({ kept: true, why: `git couldn't remove it (${String(e.stderr || e.message).trim().split('\n')[0]})` }));
          if (r.kept) console.log(dim(`  kept ${name}'s worktree, ${worktree}: ${r.why}`));
          else if (branch) await finishedOf(target.slug).then((f) => cleanBranch(home, branch, f.finished, git, f.merged)).catch(() => false);
        }
        done(code ?? (sig ? `${sig}` : 1));
      })),
      spent: () => usage()?.cost_usd ?? 0, // what its CLI said it cost, for --max-usd
    };
  };

  // After a worker exits (#618): origin's refs fetched by the runner itself, then every other branch or tag it moved
  // goes back, said in the runner's output and on the worker's item.
  const guardRefs = async ({ home, branch, name, project, before }) => {
    const siblings = await Promise.all([...live].map((w) => git(['-C', w, 'symbolic-ref', '-q', '--short', 'HEAD']).then((b) => b.trim(), () => '')));
    await git(['-C', home, 'fetch', '-q', '--prune', 'origin']).catch(() => {});
    const g = await restoreRefs(home, before, git, { own: [branch], live: siblings }).catch((e) => {
      console.error(dim(`  couldn't check what ${name} did to ${home}'s branches: ${String(e.stderr || e.message).trim().split('\n')[0]}`));
      return { restored: [], kept: [] };
    });
    if (!g.restored.length && !g.kept.length) return;
    const lines = [...g.restored.map((r) => restoredLine(home, r)), ...g.kept.map(keptLine)];
    for (const l of lines) console.log(amber(`  ${name}: ${l}`));
    const item = branch.match(/^nuworq\/(\d+)-/)?.[1];
    const n = g.restored.length;
    try {
      await createClient({ url: s.url, token: token ?? s.token }).call('comment', {
        ...(item ? { item: `#${item}` } : {}),
        headline: n ? `The runner put back ${n === 1 ? 'a branch' : `${n} branches or tags`} ${name} moved outside its own${g.kept.length ? `; ${g.kept.length} checked out elsewhere to check` : ''}`
          : `${g.kept.length === 1 ? 'A branch' : `${g.kept.length} branches`} checked out elsewhere moved while ${name} ran: check ${g.kept.length === 1 ? 'it' : 'them'}`,
        summary: lines.join('\n'),
      }, { agent: name, project });
    } catch (e) { console.error(dim(`  couldn't say so on the hub: ${e.message}`)); }
  };

  // --workers auto (#533): as many as the machine has room for, up to --max-workers (half its cores by default).
  const { autoMax } = await import('../src/runner.js');
  const { loadavg, availableParallelism, freemem } = await import('node:os');
  const machine = () => ({ load: loadavg()[0], cores: availableParallelism(), free: process.availableMemory?.() || freemem() });
  const auto = flags.workers === 'auto';
  const workers = auto ? 'auto' : num(flags.workers, 1);
  const maxWorkers = auto ? num(flags['max-workers'], autoMax(availableParallelism())) : undefined;
  const reporter = createClient({ url: s.url, token: token ?? s.token });
  const howMany = auto ? `as many ${agent} workers as this machine has room for (up to ${maxWorkers})` : `up to ${workers} ${agent} worker${workers > 1 ? 's' : ''}`;
  console.log(`${green('●')} ${bold('nuworq run')}  ${dim(`${howMany} on opted-in projects at ${s.url}; Ctrl-C stops`)}`);
  // The package it started on: when an update replaces it on disk, the code in memory is the old one (#456).
  const startedOn = installed(ROOT);
  const { supervised } = await import('../src/service.js');
  const r = await run({
    updated: () => { const now = installed(ROOT); return differs(startedOn, now) ? `${startedOn.label} → ${now.label}` : null; },
    supervised: supervised(),
    // Only work this machine can do (its fit tags), so no worker is started for work it can't take.
    // Its agent and --model too: a project that routes models (#347) says which model each job calls for.
    routes: () => client.get(`/api/route?runner=1&has=${encodeURIComponent(detectHas(flags).join(','))}&agent=${agent}${typeof flags.model === 'string' ? `&model=${encodeURIComponent(flags.model)}` : ''}`),
    // Work waiting where it doesn't staff (#491): every project's routes, not only the opted-in ones.
    unstaffed: async () => unstaffedLine(await client.get(`/api/route?has=${encodeURIComponent(detectHas(flags).join(','))}&agent=${agent}`), await hubProjects(client)),
    launch, workers, maxWorkers, machine, sweep: (running) => sweepAll(running), sweptAt,
    // What it prints and logs: no tokens, and no control characters from hub text (#477).
    log: (line) => console.log(safe(line)),
    // How this runner is, on every poll (#171), with the workers' agent token: a runner token names the runner.
    report: (state) => reporter.post('/api/runner', JSON.parse(redact(JSON.stringify({ name: hostname(), machine: hostname(), ...state })))),
    // Asked of the hub, not the routes: a quick worker can claim and exit between two polls. A minute
    // of slack covers clocks that differ.
    claimed: async (w) => (await client.get(`/api/claims?agent=${encodeURIComponent(w.name)}&since=${w.started - 60_000}`)).claims > 0,
    took: async (w) => (await client.get(`/api/claims?agent=${encodeURIComponent(w.name)}&since=${w.started - 60_000}`)).first ?? null,
    // A worker that exited without signing off (#558), say it crashed: what it held goes back now, not at its lease's end.
    // At most 5 s, since it counts as running until then.
    signoff: (w) => Promise.race([reporter.call('signoff', { headline: 'Worker exited' }, { agent: w.name, project: w.project }), new Promise((r) => setTimeout(r, 5000).unref())]),
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
  // Exit 0 and the service (KeepAlive, Restart=always) starts it again, on the new code.
  if (r.restart) process.exit(0);
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
  // A person at the terminal is asked; --yes and --no answer for them, and with no terminal it's a no (#490).
  const mode = flags.yes ? 'yes' : flags.no ? 'no' : process.stdin.isTTY && process.stdout.isTTY ? 'ask' : 'no';
  if (!flags['no-mcp']) notes.push(await offerPlugin(flags, mode));
  const { registerMcp } = await import('../src/connect.js');
  const mcp = flags['no-mcp'] ? { added: old?.added ?? [], lines: [] } : registerMcp({ bin: BIN, home: homedir(), kept: old?.added ?? [], url });
  const cleared = flags['no-mcp'] ? null : await clearLeftovers(mode, old?.added ?? []);
  if (cleared) mcp.lines.push(cleared);
  // Written whole with mode 600 and moved into place, so the token is never in a file others can read.
  mkdirSync(dirname(CONNECT_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${CONNECT_FILE}.${process.pid}`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify({ url, token, ...(workspace ? { workspace } : {}), added: mcp.added }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, CONNECT_FILE);
  console.log(`${green('Connected')} to ${bold(url)}${me.auth === 'required' ? ` as ${me.name} (${me.role} token)` : dim(' (it needs no login)')}.
${[...notes.filter(Boolean), ...mcp.lines.map((l) => `  ${l}`)].join('\n')}${notes.some(Boolean) || mcp.lines.length ? '\n' : ''}${dim(`Saved in ${CONNECT_FILE}, readable only by you. The CLI, the MCP server and nuworq run on this machine use it
now; NUWORQ_URL and NUWORQ_TOKEN still win. Undo all of it: nuworq disconnect`)}`);
  if (!flags['no-mcp']) await setUp({ ...flags, url, token }, mode);
}

// The rest of the setup, once connected (#490, src/setup.js): workers for the project this folder is a clone of,
// an operator, and how to start a shaper.
async function setUp(flags, mode) {
  const { chooseProject, finishSetup } = await import('../src/setup.js');
  const { pluginInstalled } = await import('../src/connect.js');
  const say = (l) => console.log(l);
  const projects = await createClient(flags).get('/api/projects').catch(() => null);
  if (!projects) return say(dim("Couldn't list the hub's projects, so nothing more was set up."));
  const root = (() => { try { execFileSync('git', ['rev-parse', '--show-toplevel'], { stdio: 'ignore' }); return repoRoot(); } catch { return null; } })();
  const at = await chooseProject({ projects, named: flags.project, remote: repoRemote(), root, mode, ask: askLine, say });
  say('');
  if (at.none) return say(at.none);
  const remote = at.project.remotes?.[0];
  const { mirrorSource } = await import('../src/git.js');
  const clone = at.folder || !remote ? null : `git clone ${mirrorSource(remote) ?? remote} ${cloneDir(remote)}`;
  const has = flags.has ? operatorHas(flags).has : null; // none typed: the operator detects them (#494)
  await finishSetup({
    mode, ask: askLine, say, project: at.project, folder: at.folder, clone, budget: flags.budget,
    plugin: pluginInstalled(homedir()),
    actions: {
      staff: (p, usd) => staffProject(p, usd, flags),
      installRunner: async () => { await runService({ ...flags, folder: besideOf(at.folder ?? process.cwd()) }, { argv: [] }); return []; },
      startOperator: () => startOperator(at.folder, has),
    },
  });
}

// Claude Code takes nuworq as its plugin (#432): one copy of the skills, shown as /nuworq:shaper and
// /nuworq:operator. Without it, connect asks a person at the terminal to install it, and writes the MCP server
// and the skills itself only when they decline (or the install fails). With no one to ask, or --skills, it
// writes them as before and says how to get the plugin.
// mode (#490): 'ask' asks; 'yes' installs it; 'no' says how. An install for some folders only (#496) counts as
// none: it says which folders it covers, then offers the account's.
async function offerPlugin(flags, mode) {
  const { pluginScopes, claudeCode, installPlugin, PLUGIN_INSTALL, staleMarketplace, repinMarketplace, repinCommands, REPIN } = await import('../src/connect.js');
  const scopes = pluginScopes(homedir());
  if (!claudeCode()) return null;
  // Added before releases (#608): it follows main, so it moves onto the release branch, without asking (it's how
  // the plugin already should install), and the plugin goes back everywhere it was installed. With no one to run
  // it for (--no), the commands to do it. Then on as usual: a folder-only install still gets the account's offer.
  if (staleMarketplace(homedir())) {
    const { MARKETPLACE } = await import('../src/plugin.js');
    const repin = repinCommands(homedir());
    if (mode === 'no') return amber(`  Claude Code's nuworq marketplace follows main, not releases. Move it onto the release branch: ${repin}`);
    const folders = REPIN(homedir()).filter((s) => s.cwd).length;
    const failed = repinMarketplace(homedir());
    if (failed) return amber(`${failed}. Claude Code's nuworq marketplace may now be missing or still follow main; to put it right: ${repin}`);
    const where = [scopes.account && 'for your account', folders && `in ${folders === 1 ? 'one folder' : `${folders} folders`}`].filter(Boolean).join(' and ');
    console.error(`  Claude Code: moved the ${bold('nuworq')} marketplace onto the release branch (${MARKETPLACE}), so the plugin updates only to approved releases${where ? `, and installed the plugin again ${where}` : ''}.`);
  }
  if (scopes.account) return null;
  const n = scopes.folders.length;
  const covers = n ? `  Claude Code has the nuworq plugin only for ${n > 1 ? `${n} folders` : 'one folder'} (${scopes.folders.slice(0, 3).join(', ')}${n > 3 ? ` and ${n - 3} more` : ''}), so other projects don't get /nuworq:shaper and /nuworq:operator.` : '';
  const how = PLUGIN_INSTALL.map((a) => `claude ${a.join(' ')}`).join(' && ');
  if (flags.skills || mode === 'no') return `${covers ? `${covers}\n` : ''}${dim(`Claude Code takes nuworq best as its plugin, installed for your account, with /nuworq:shaper and /nuworq:operator: ${how}, then connect again.`)}`;
  if (covers) console.error(covers);
  const { answerer } = await import('../src/setup.js');
  if (!await answerer(mode, askLine)('Install the nuworq plugin for Claude Code, for every project? It adds its MCP server and the /nuworq:shaper and /nuworq:operator commands, and costs nothing.', { def: true })) return null;
  const failed = installPlugin();
  return failed ? amber(`${failed}. Added the server and skills to Claude Code directly instead.`) : `  Claude Code: installed the ${bold('nuworq')} plugin (${how}).`;
}

// With the plugin installed for the account (#496), what an earlier nuworq left in Claude Code beside it (skills shown
// as /nuworq-operator, a second MCP server) goes too, recorded or not: listed and asked about once at a terminal
// (--yes answers for you), else the commands to remove them. What connect recorded it already took back itself.
async function clearLeftovers(mode, kept) {
  const { pluginInstalled, leftovers, leftoverCommands, removeLeftovers } = await import('../src/connect.js');
  if (!pluginInstalled(homedir())) return null;
  const skip = [...kept.filter((k) => k.tool === 'skill').flatMap((k) => k.files ?? [k.file]), ...(kept.some((k) => k.tool === 'claude') ? ['claude'] : [])];
  const found = leftovers(homedir(), { skip });
  if (!found.skills.length && !found.mcp) return null;
  const what = [found.skills.length && `the ${found.skills.map((d) => basename(d)).join(', ')} skill folder${found.skills.length > 1 ? 's' : ''} in ${dirname(found.skills[0])}`, found.mcp && 'a user-scope nuworq MCP server'].filter(Boolean).join(' and ');
  const { answerer } = await import('../src/setup.js');
  if (!await answerer(mode, askLine)(`An earlier nuworq left ${what} in Claude Code, beside the plugin (they show as /nuworq-… commands, or a second nuworq). Remove them?`, { def: true })) return `Claude Code: an earlier nuworq left ${what} beside the plugin. To remove them: ${leftoverCommands(found).join(' && ')}`;
  const problems = removeLeftovers(found);
  return problems.length ? amber(`Claude Code: ${problems.join('; ')}`) : `Claude Code: removed what an earlier nuworq left beside the plugin: ${what}`;
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

${bold('pi')}  ${dim('(1.4+, ~/.pi/agent/mcp.json)')}
  pi mcp add nuworq --exposure direct -- node ${q} mcp

${bold('Any other MCP client')}
  command: node
  args:    [${q}, "mcp"]
  ${dim('optional env: NUWORQ_URL (if the hub is elsewhere), NUWORQ_TOKEN, NUWORQ_AGENT, NUWORQ_MODEL, NUWORQ_PROJECT (to pin one)')}

${bold('Shell-only agents')}  ${dim('(add to AGENTS.md or CLAUDE.md)')}
  This project coordinates work through nuworq. Run \`node ${q} guide\` and follow it.

${bold('Headless worker')}  ${dim('(asks the hub where work is waiting; own worktree, a branch per item; --run starts it)')}
  node ${q} worker --agent claude --run
  node ${q} worker --agent codex --can-read-keys --run
  node ${q} worker --agent opencode --model ollama/qwen3.8:27b-mtp-q4_K_M --can-read-keys --run
  node ${q} worker --agent pi --model ollama/qwen3.8:27b-mtp-q4_K_M --can-read-keys --run
  ${dim("Only Claude workers' shells are kept from this machine's keys; --can-read-keys says you know the others can read them.")}`);
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

// serve --smoke (#544): what --follow boots on copies of the live data before a switch, to check the new code starts
// on them. No sweep ever runs (no mirrors, preconditions or GitHub calls), and no pushes or hub.json are started.
const SMOKE = { sweepMs: 2 ** 31 - 1 };

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
  const server = createServer(hub, { auth, trustProxy, publicUrl, oauth: oauthFromEnv(), githubApp: appFromEnv() ?? appFromFile(appFile), appFile, packageDir: join(dataHome(flags), 'package'), ...(flags.smoke ? SMOKE : {}) });
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
    if (flags.smoke) return console.log(`nuworq booted on ${db} at ${url} (smoke: no pushes, no sweeps)`);
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
${pkg ? `    Install (once):     npm install -g ${base}/nuworq.tgz\n` : ''}    Connect (once):     nuworq connect ${base}   (logs in, registers nuworq with Claude Code, Codex, opencode and pi)
    Keep workers going: nuworq run --workers 3 --agent claude   (add --browser for UI checks; Ctrl-C stops)
    Shell:              nuworq guide
    Tool schemas:       ${base}/api/tools?format=openai`)}`);
  });
  // Drained first (#545): requests in flight finish, waits answer and streams reconnect. A second signal doesn't wait.
  let stopping = false;
  const stop = async () => { if (stopping) process.exit(0); stopping = true; await server.drain(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// serve --follow: a small supervisor that keeps the hub on the latest main that passes its tests.
// The hub itself runs as a child (serve with the same flags, minus --follow) from its own worktree
// under the data folder (hub-src), never from this checkout, which agents fast-forward. New commits
// are tested in a second worktree there (hub-next). See src/follow.js.
// This process only works out the settings and hands over to src/follow.js run on its own (#546), which
// loads only node: modules: a commit that changes the CLI moves the hub and never restarts the supervisor.
// A commit goes live once CI's required check passed for it (#543), asked of GitHub with the hub's own App
// (src/followhub.js ci): the suite isn't run again here. The supervisor gets only where the app is ({ app }), or
// null without one or for a remote not on GitHub: then the suite runs here, as before.
async function followCi(repo, data) {
  const { appFromEnv, appFromFile } = await import('../src/ghapp.js');
  const app = join(data, 'github-app.json');
  return (appFromEnv() ?? appFromFile(app)) && repoRemote(repo).startsWith('github.com/') ? { app } : null;
}

async function serveFollow(flags) {
  const host = String(flags.host || envVar('HOST') || '127.0.0.1');
  const port = Number(flags.port || envVar('PORT') || 4747);
  if (!port) throw new HubError('--follow needs a fixed port', { hint: 'Pass --port <n> (the supervisor checks the hub there).' });
  const probe = { '0.0.0.0': '127.0.0.1', '::': '::1' }[host] ?? host;
  const repo = repoRoot(ROOT);
  const args = process.argv.slice(3).filter((a) => !/^--?follow(=.*)?$/.test(a));
  const data = dataHome(flags);
  const settings = {
    repo,
    // Copied before every move, to <data>/backups: the one database, or every workspace's.
    store: flags.demo ? null : { dir: join(data, 'backups'), ...(flags.workspaces ? { workspaces: workspacesDir(flags) } : { db: resolve(dbPath(flags)) }) },
    ci: await followCi(repo, data),
    dir: join(data, 'hub-src'),
    next: join(data, 'hub-next'),
    args,
    url: `http://${probe.includes(':') ? `[${probe}]` : probe}:${port}`,
    // A red main is reported in the workspace whose project lives in this repo (#561).
    ...(flags.workspaces ? { workspaces: workspacesDir(flags), workspace: typeof flags.workspace === 'string' ? flags.workspace : null } : {}),
    color: !!tty,
    hint: `It follows the main branch of ${repo}, the git checkout this nuworq runs from. Without --follow, serve runs this copy as it is.`,
  };
  const { spawn } = await import('node:child_process');
  const p = spawn(process.execPath, [join(ROOT, 'src', 'follow.js'), JSON.stringify(settings)], { stdio: 'inherit' });
  // Signals reach the supervisor (it stops the hub in order); this process leaves with its exit code.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => p.kill(sig));
  const code = await new Promise((r) => p.on('exit', (c, sig) => r(c ?? (sig ? 1 : 0))));
  process.exit(code);
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
  const spaces = new Workspaces({ dir, repos: reposDir(flags), keys: keysDir(flags), backups: join(dataHome(flags), 'backups'), plans, owners });
  // A smoke boot opens every workspace now, so each one's migrations run before it answers health (#544).
  if (flags.smoke) for (const name of spaces.list()) spaces.get(name, { touch: false });
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
  const server = createServer(spaces, { trustProxy, baseDomain, publicUrl, adminHost, oauth: oauthFromEnv(), orgCap, githubApp: appFromEnv() ?? appFromFile(join(dataHome(flags), 'github-app.json')), packageDir: join(dataHome(flags), 'package'), earlyAccess, billing: billingFromEnv(), feedbackProject, ...(flags.smoke ? SMOKE : {}) });
  server.listen(port, host, () => {
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`;
    if (flags.smoke) return console.log(`nuworq booted ${spaces.list().length} workspaces in ${dir} at ${url} (smoke: no pushes, no sweeps)`);
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
  let stopping = false;
  const stop = async () => { if (stopping) process.exit(0); stopping = true; pushes?.stop(); await server.drain(); spaces.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function workspace(pos, flags) {
  const { Workspaces } = await import('../src/workspaces.js');
  const owners = String(flags.owners ?? envVar('HUB_OWNERS') ?? envVar('OWNERS') ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const spaces = new Workspaces({ dir: workspacesDir(flags), backups: join(dataHome(flags), 'backups'), owners });
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
      return console.log(`${green('Removed')} workspace ${bold(name)}, its database and its backups. A running hub stops serving it at once.`);
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
      // The host vouches for the email it types here (#470), unlike an owner adding someone through the API.
      const p = auth.addPerson(need(handle, '<handle>'), flags.role || 'member', { name: flags.name, email: flags.email, verified: true });
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

// git's credential helper protocol (git help credential): for "get" on github.com, a token from the hub's
// GitHub App for the repository of the item this agent holds. Anything else, or a different repository,
// gets no answer, and git goes on to its other helpers. Errors go to stderr, where git shows them.
async function gitCredential(pos, flags) {
  if (pos[0] !== 'get') return;
  let input = '';
  for await (const c of process.stdin) input += c;
  const ask = Object.fromEntries(input.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  // The hub itself, where a worker's pushes go (#472): its name, and its agent token as the password.
  const hub = new URL(resolveSettings(flags).url);
  if (ask.host === hub.host && ask.protocol === hub.protocol.slice(0, -1)) {
    const agent = flags.as || envVar('AGENT');
    if (!agent) throw new HubError('who are you?', { hint: 'The helper needs --as <name> or NUWORQ_AGENT.' });
    return process.stdout.write(`username=${agent}\npassword=${resolveSettings(flags).token || 'none'}\n`);
  }
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
const UPDATES = () => join(dataDir(), 'update');
async function selfUpdate(flags, { force = false } = {}) {
  try {
    return await update({ root: ROOT, hub: resolveSettings(flags).url, dir: UPDATES(), force, ...(force ? {} : { timeoutMs: 3000 }) });
  } catch (e) {
    return { status: 'skipped', reason: e.message };
  }
}

const unknownCommand = (cmd, near) => new HubError(`unknown command "${cmd}"`, { hint: `${near ? `Did you mean ${near}? ` : ''}See: nuworq help` });

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { pos, flags } = parse(argv);
  // Help (#481): a bare nuworq, one command's (help <command>, <command> --help), or all of it.
  if (!cmd || cmd === 'help' || flags.help || flags.h || cmd === '--help' || cmd === '-h') {
    const help = await import('../src/help.js');
    const o = { width: process.stdout.isTTY ? process.stdout.columns || 80 : 80, style: { bold, dim } };
    const want = cmd === 'help' ? pos[0] : cmd?.startsWith('-') ? undefined : cmd;
    if (!want) return console.log(help.bare(o));
    if (want === 'all') return console.log(flags.markdown ? help.reference({ markdown: true }) : help.reference(o));
    const one = help.commandHelp(want, o);
    if (!one) throw unknownCommand(want, help.nearest(want));
    return console.log(one);
  }

  if (cmd === 'serve') return serve(flags);
  if (cmd === 'update') {
    const r = await selfUpdate(flags, { force: true });
    console.log(describeUpdate(r));
    // It just printed the changelog lines, so the next command doesn't say them again (#436).
    if (r.status === 'updated') takeNews(UPDATES(), 'cli');
    if (['refused', 'failed'].includes(r.status)) process.exitCode = 1;
    return;
  }
  if (cmd === 'changes') {
    const { version, changes } = installedChanges(ROOT);
    if (!version) return console.log('This nuworq has no version, so no changelog entry to show.');
    return console.log(changes?.length ? `nuworq ${version}:\n${changes.map((l) => `  ${l}`).join('\n')}` : `nuworq ${version} has no changelog entry.`);
  }
  // What a background update installed since the last command, said once (#436). An MCP server, the operator's
  // listener and git's credential helper say nothing: no person reads them, so the news waits for one who does.
  const quiet = ['mcp', 'wait', 'git-credential'].includes(cmd);
  if (!quiet) {
    const news = takeNews(UPDATES(), 'cli');
    if (news) console.error(describeNews(news));
  }
  // A signed new version from the hub, at most every 10 minutes; it applies to the next run. A git
  // credential helper answers git right away. An MCP server checks in the background, for the next session.
  if (cmd !== 'git-credential') {
    const pending = selfUpdate(flags).then((r) => {
      if (r.status === 'updated' && quiet) return;
      if (['updated', 'refused', 'failed'].includes(r.status)) console.error(`nuworq: ${describeUpdate(r)}`);
      if (r.status === 'updated') takeNews(UPDATES(), 'cli');
    });
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
  if (cmd === 'staff') return staffCmd(pos, flags);
  if (cmd === 'up') return upCmd(flags);
  if (cmd === 'down') return downCmd(flags);
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
    // The nuworq skills for Claude, generated from the protocol: <dir>/nuworq/SKILL.md, <dir>/nuworq-shaper/SKILL.md
    // and <dir>/nuworq-operator/SKILL.md (default ~/.claude/skills). The plugin carries them as shaper and operator.
    const dir = resolve(String(flags.dir || join(homedir(), '.claude', 'skills')));
    for (const [name, text] of Object.entries(userSkills({ url: resolveSettings(flags).url }))) {
      const file = join(dir, name, 'SKILL.md');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
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

  // The agent commands come from the protocol (#521, src/agentargs.js), which parses their flags itself.
  const { POSITIONAL, agentArgs } = await import('../src/agentargs.js');
  if (!Object.hasOwn(POSITIONAL, cmd)) throw unknownCommand(cmd, (await import('../src/help.js')).nearest(cmd));
  let args;
  try { args = agentArgs(cmd, argv, { read: () => readStdin().trim() }); } catch (e) { throw new HubError(e.message, { hint: e.hint }); }
  const { body, common } = args;
  if (cmd === 'checkin' && body.has === undefined && envVar('HAS')) body.has = refs(envVar('HAS'));
  const agent = common.as || envVar('AGENT');
  if (!agent) throw new HubError('who are you?', { hint: 'Pass --as <name> (e.g. --as claude-1) or set NUWORQ_AGENT. Keep the same name for your whole session.' });
  const client = createClient(common);
  const result = await client.call(cmd, body, { agent });
  console.log(JSON.stringify(result)); // compact, like the hub's own responses (#528)
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  if (e.hint) console.error(`hint: ${e.hint}`);
  if (!(e instanceof HubError)) console.error(e.stack);
  process.exit(1);
});
