// nuworq up (#559): one command brings a machine's setup up, a runner with automatic workers and an operator per
// unparked project, each in its own terminal; nuworq down stops what it started. What to do is worked out here,
// from data the CLI gathers (the hub's projects, the runner's service file, local clones, the operators it started),
// and the commands that open terminals are built here too, so tests check both without running anything.
import { sq } from './runtrust.js';

export const SESSION = 'nuworq'; // the tmux session operators open in, one window per project

const unxml = (s) => String(s).replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[e]));

// One systemd word, unquoted: what service.js's word() wrote, back as it was.
const unword = (s) => s.replace(/\\(.)/g, '$1').replace(/\$\$/g, '$').replace(/%%/g, '%');

// The runner's service definition (src/service.js wrote it), read back: { args, cwd, tokenFile } where args are its
// run flags (what follows `run`) and tokenFile its NUWORQ_AGENT_TOKEN_FILE, the --agent-token it was installed with
// (#582). null when there is no definition, or one this can't read.
export function readService(text, platform) {
  if (!text) return null;
  let command = null, cwd = null, tokenFile = null;
  if (platform === 'darwin') {
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
    if (array) command = [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1]));
    const dir = /<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(text);
    if (dir) cwd = unxml(dir[1]);
    const vars = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text);
    const token = vars && /<key>NUWORQ_AGENT_TOKEN_FILE<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(vars[1]);
    if (token) tokenFile = unxml(token[1]);
  } else if (platform === 'linux') {
    const exec = /^ExecStart=(.*)$/m.exec(text);
    if (exec) command = [...exec[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unword(m[1]));
    const dir = /^WorkingDirectory=(.*)$/m.exec(text);
    if (dir) cwd = dir[1].replace(/%%/g, '%');
    const token = /^Environment="NUWORQ_AGENT_TOKEN_FILE=((?:[^"\\]|\\.)*)"$/m.exec(text);
    if (token) tokenFile = unword(token[1]);
  }
  const at = command?.indexOf('run') ?? -1;
  return at < 0 ? null : { args: command.slice(at + 1), cwd, tokenFile };
}

// --workers auto, in place of any --workers the flags had; the rest stay.
export function autoArgs(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workers') { i++; continue; }
    if (args[i].startsWith('--workers=')) continue;
    out.push(args[i]);
  }
  return [...out, '--workers', 'auto'];
}

const isAuto = (args = []) => args.some((a, i) => a === '--workers=auto' || (a === '--workers' && args[i + 1] === 'auto'));

// What to do. Everything outside comes in as data:
//   projects: the hub's list ({ slug, name, parked, runner, operators: [{ name, machine }] }), archived ones left out;
//   declined: slugs whose staffing the person said no to before;
//   clones: { [slug]: { folder } } for a local clone, { [slug]: { hint } } for none (the hint says where to clone);
//   local: { [slug]: true } for an operator this machine started that still runs (it may not have checked in yet);
//   runner: { supported, args, cwd, tokenFile, up } from its service file (args null: none installed) and its status.
// Returns { runner: { action: 'install' | 'restart' | 'keep' | 'none', why, args, cwd, tokenFile }, staff: [projects
// to ask about], rows: [{ slug, name, parked, staffed, operator: { state: 'running' | 'start' | 'skip', why, folder } }] }.
// A restart keeps the runner's tokenFile, so it keeps the --agent-token it was installed with (#582).
export function upPlan({ projects = [], declined = [], clones = {}, local = {}, runner = {} }) {
  let r;
  const keep = { cwd: runner.cwd, ...(runner.tokenFile ? { tokenFile: runner.tokenFile } : {}) };
  if (runner.supported === false) r = { action: 'none', why: "this platform has no service manager nuworq knows: run `nuworq run --workers auto` under your own" };
  else if (!runner.args) r = { action: 'install', why: 'no runner is installed here', args: ['--workers', 'auto'] };
  else if (!isAuto(runner.args)) r = { action: 'restart', why: `its flags were ${runner.args.join(' ') || 'none'}`, args: autoArgs(runner.args), ...keep };
  else if (!runner.up) r = { action: 'restart', why: "it isn't running", args: runner.args, ...keep };
  else r = { action: 'keep', why: 'it runs with --workers auto', args: runner.args };
  const staff = projects.filter((p) => !p.parked && !p.runner && !declined.includes(p.slug));
  const rows = projects.map((p) => {
    // A hub older than #559 doesn't list operators: none listed isn't none running, so start none (#582).
    const listed = Array.isArray(p.operators);
    const ops = listed ? p.operators : [];
    const who = ops.length ? ops.map((o) => (o.machine ? `${o.name} on ${o.machine}` : o.name)).join(', ') : local[p.slug] ? 'started here' : null;
    let operator;
    if (who) operator = { state: 'running', why: p.parked ? `${who}; ${p.name ?? p.slug} is parked, so stop it` : who };
    else if (p.parked) operator = { state: 'skip', why: 'parked' };
    else if (!listed) operator = { state: 'skip', why: "the hub doesn't say which operators run; update it" };
    else if (clones[p.slug]?.folder) operator = { state: 'start', folder: clones[p.slug].folder };
    else operator = { state: 'skip', why: `no clone here: ${clones[p.slug]?.hint ?? 'clone its repository first'}` };
    return { slug: p.slug, name: p.name ?? p.slug, parked: !!p.parked, staffed: !!p.runner, operator };
  });
  return { runner: r, staff, rows };
}

// Where operators open: tmux when it is installed, else iTerm or Terminal on a Mac, else nowhere (the commands are printed).
export function launcherFor({ tmux = false, platform = process.platform, iterm = false } = {}) {
  if (tmux) return 'tmux';
  if (platform === 'darwin') return iterm ? 'iterm' : 'terminal';
  return 'print';
}

// The shell line that starts one operator: in its folder, writing its pid (the shell's, which exec hands to claude)
// so up knows it runs before it checks in and down can stop it. settings: the --settings JSON (its routine commands).
export function operatorShell({ folder, pidFile, settings, line }) {
  return `cd ${sq(folder)} && echo $$ > ${sq(pidFile)} && exec claude${settings ? ` --settings ${sq(settings)}` : ''} ${sq(line)}`;
}

// An AppleScript string literal.
export const appleString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// The commands that open each window: [{ name, folder, shell }] → argv arrays to run in order. tmux: the nuworq session
// (made by the first when exists is false), one detached window per project. iTerm and Terminal: one window each,
// through osascript. print: none.
export function launchCommands(via, windows, { exists = false, session = SESSION } = {}) {
  if (via === 'tmux') {
    return windows.map((w, i) => (i === 0 && !exists
      ? ['tmux', 'new-session', '-d', '-s', session, '-n', w.name, '-c', w.folder, w.shell]
      : ['tmux', 'new-window', '-d', '-t', `${session}:`, '-n', w.name, '-c', w.folder, w.shell]));
  }
  if (via === 'iterm') {
    return windows.map((w) => ['osascript', '-e', `tell application "iTerm"
  set w to (create window with default profile)
  tell current session of w to write text ${appleString(w.shell)}
end tell`]);
  }
  if (via === 'terminal') return windows.map((w) => ['osascript', '-e', `tell application "Terminal" to do script ${appleString(w.shell)}`]);
  return [];
}

const OP_WORDS = { running: 'running', started: 'started', start: 'would start', skip: 'skipped' };

// The closing table: each project, parked or staffed, its operator; then the runner. dryRun: what would happen.
export function upTable(plan, { dryRun = false } = {}) {
  const head = ['Project', 'Parked', 'Staffed', 'Operator'];
  const body = plan.rows.map((r) => [r.name, r.parked ? 'yes' : 'no', r.staffed ? 'yes' : 'no',
    `${OP_WORDS[r.operator.state] ?? r.operator.state}${r.operator.why ? ` (${r.operator.why})` : r.operator.folder ? ` (${r.operator.folder})` : ''}`]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(w[i]))).join('  ');
  const runner = {
    install: dryRun ? 'would install it, with --workers auto' : 'installed, workers auto',
    restart: dryRun ? `would restart it with ${plan.runner.args.join(' ')} (${plan.runner.why})` : `restarted with ${plan.runner.args.join(' ')} (${plan.runner.why})`,
    keep: 'workers auto, running',
    none: `not set up (${plan.runner.why})`,
    failed: `not up (${plan.runner.why})`,
  }[plan.runner.action];
  return [line(head), ...body.map(line), '', `Runner: ${runner}`].join('\n');
}
