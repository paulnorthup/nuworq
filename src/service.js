// nuworq run as a service (#172): a LaunchAgent on macOS, a systemd user unit on Linux, so a runner keeps going
// across closed terminals and reboots. Plain text files and the platform's own commands; nothing to install.
// Everything outside (the file system, launchctl/systemctl) is injected so tests run neither.
import { mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';

export const LABEL = 'com.nuworq.run';
export const UNIT = 'nuworq-run.service';
// The release signer (scripts/signer.js, #430): its own service beside the runner, installed the same way.
export const SIGNER = { label: 'com.nuworq.signer', unit: 'nuworq-signer.service', description: 'nuworq release signer: signs each release tag on main' };

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
// One systemd word: quoted, with what systemd would expand ($, %, \, ") kept literal.
const word = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$').replace(/%/g, '%%')}"`;

// command: [node, bin, 'run', ...flags]. env: what the runner needs from this shell (PATH, NUWORQ_*). log: one file.
// cwd: where it was installed from; the runner starts there, so it finds the checkouts `nuworq run` would (#225).
// label: the job's name, the runner's unless given (the signer's is SIGNER.label).
export function launchdPlist({ command, env = {}, log, cwd, label = LABEL }) {
  const strings = (xs) => xs.map((x) => `    <string>${xml(x)}</string>`).join('\n');
  const vars = Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${strings(command)}
  </array>
${cwd ? `  <key>WorkingDirectory</key>\n  <string>${xml(cwd)}</string>\n` : ''}  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

export function systemdUnit({ command, env = {}, log, cwd, description = 'nuworq run: workers on waiting work' }) {
  return `[Unit]
Description=${description}
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${command.map(word).join(' ')}
${cwd ? `WorkingDirectory=${String(cwd).replace(/%/g, '%%')}\n` : ''}${Object.entries(env).map(([k, v]) => `Environment=${word(`${k}=${v}`)}`).join('\n')}
Restart=always
RestartSec=30
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

// Where the definition lives, and the commands that load and unload it. label, unit: the runner's unless given.
export function serviceFor({ platform, home, uid, label = LABEL, unit = UNIT }) {
  if (platform === 'darwin') {
    const file = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    return {
      kind: 'LaunchAgent', file, text: (o) => launchdPlist({ ...o, label }),
      load: [['launchctl', 'bootstrap', `gui/${uid}`, file]],
      unload: [['launchctl', 'bootout', `gui/${uid}/${label}`]],
      // bootout returns before launchd has torn the job down; bootstrap meanwhile fails with "5: Input/output
      // error" (#250). print fails once it's gone, and shows the pid once it's up.
      status: ['launchctl', 'print', `gui/${uid}/${label}`], waitGone: true,
      up: (out) => /\bpid = \d+/.test(out),
    };
  }
  if (platform === 'linux') {
    const file = join(home, '.config', 'systemd', 'user', unit);
    return {
      kind: 'systemd user unit', file, text: systemdUnit,
      load: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', unit]],
      unload: [['systemctl', '--user', 'disable', '--now', unit]],
      after: [['systemctl', '--user', 'daemon-reload']],
      // disable --now waits for the stop itself, so there's nothing to wait out before loading.
      status: ['systemctl', '--user', 'is-active', unit],
      up: (out) => out.trim() === 'active',
    };
  }
  return null;
}

const shown = (cmd) => cmd.map((x) => (/^[\w./:@=-]+$/.test(x) ? x : `'${String(x).replace(/'/g, "'\\''")}'`)).join(' ');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// What a failed command said: its stderr (launchd's own words) rather than node's "Command failed: …".
const said = (e) => String(e?.stderr ?? '').trim() || e.message;

// Write the definition and load it; one already there is unloaded and replaced. exec(cmd, args) runs a
// command, resolves with { stdout } and rejects when it fails; sleep(ms) waits. Waits for the old job to be gone,
// retries a failed load once, then waits up to ~10s for the runner to be up (#250).
// Returns { file, kind, log, up, status, uninstall }: up is false when it didn't start in time; status and uninstall
// are the exact commands to check on it and to remove it.
// label, unit, description: whose service it is, the runner's unless given (SIGNER for the release signer).
export async function install({ platform, home, uid, command, env, log, cwd, exec, sleep = pause, fs = { mkdirSync, writeFileSync }, label, unit, description }) {
  const s = serviceFor({ platform, home, uid, label, unit });
  if (!s) throw Object.assign(new Error(`--install knows macOS (launchd) and Linux (systemd), not ${platform}`), { hint: 'Run nuworq run under your own supervisor instead.' });
  const status = () => exec(s.status[0], s.status.slice(1)).then((r) => ({ ok: true, out: String(r?.stdout ?? '') }), () => ({ ok: false, out: '' }));
  for (const [cmd, ...args] of s.unload) await exec(cmd, args).catch(() => {}); // not loaded yet: fine
  if (s.waitGone) for (let i = 0; i < 40 && (await status()).ok; i++) await sleep(250); // ~10s, then try anyway
  fs.mkdirSync(dirname(s.file), { recursive: true });
  fs.mkdirSync(dirname(log), { recursive: true });
  // 0600: the flags and NUWORQ_* it carries may include a token.
  fs.writeFileSync(s.file, s.text({ command, env, log, cwd, description }), { mode: 0o600 });
  const load = async () => { for (const [cmd, ...args] of s.load) await exec(cmd, args); };
  await load().catch(async () => { await sleep(2000); await load(); }).catch((e) => {
    throw Object.assign(new Error(`Couldn't load the ${s.kind}: ${said(e)}`), { hint: `Load it yourself with: ${shown(s.load.at(-1))}` });
  });
  let up = false;
  for (let i = 0; !(up = s.up((await status()).out)) && i < 20; i++) await sleep(500);
  return { file: s.file, kind: s.kind, log, up, status: shown(s.status), uninstall: `${shown(command.slice(0, 3))} --uninstall` };
}

// Stop it and remove the definition. Returns { file, removed }: removed is false when nothing was installed.
export async function uninstall({ platform, home, uid, exec, fs = { rmSync, existsSync }, label, unit }) {
  const s = serviceFor({ platform, home, uid, label, unit });
  if (!s) throw Object.assign(new Error(`--uninstall knows macOS (launchd) and Linux (systemd), not ${platform}`), { hint: 'Stop it with your own supervisor.' });
  const was = fs.existsSync(s.file);
  for (const [cmd, ...args] of s.unload) await exec(cmd, args).catch(() => {});
  fs.rmSync(s.file, { force: true });
  for (const [cmd, ...args] of s.after ?? []) await exec(cmd, args).catch(() => {});
  return { file: s.file, kind: s.kind, removed: was };
}

// The environment a service needs from the shell it was installed from: PATH (so the agent CLIs and git are
// found), HOME, and nuworq's own settings (NUWORQ_* and the older TRELLIS_*). repos: the folder holding the
// checkout it was installed beside, kept as NUWORQ_REPOS unless the shell already set one (#225).
export function serviceEnv(env = process.env, { repos } = {}) {
  const kept = Object.entries(env).filter(([k, v]) => v != null && (['PATH', 'HOME'].includes(k) || /^(NUWORQ|TRELLIS)_/.test(k)));
  if (repos && !env.NUWORQ_REPOS && !env.TRELLIS_REPOS) kept.push(['NUWORQ_REPOS', repos]);
  return Object.fromEntries(kept.sort(([a], [b]) => a.localeCompare(b)));
}

// The node a service runs: the first `node` on PATH (e.g. /opt/homebrew/bin/node) when it is this very binary,
// so `brew upgrade node` doesn't pull the versioned Cellar path from under it (#225); else execPath itself.
export function stableNode(execPath, { path = process.env.PATH ?? '', real = realpathSync } = {}) {
  const same = (a, b) => { try { return real(a) === real(b); } catch { return false; } };
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const node = join(dir, 'node');
    try { real(node); } catch { continue; } // none here: the next folder
    return same(node, execPath) ? node : execPath;
  }
  return execPath;
}

// The opted-in projects this machine has no checkout of, so the installed runner would skip them:
// [{ slug, name, remote, hint }]. find(remotes) is checkoutOf, from where the service will start (#225).
export function missingCheckouts(projects, find, { exists = existsSync } = {}) {
  const out = [];
  for (const p of projects) {
    if (!p.runner || p.parked) continue;
    const remotes = p.remotes ?? [];
    if (remotes.length <= 1 && p.path && exists(p.path)) continue;
    for (const remote of remotes) {
      try { find([remote]); } catch (e) { out.push({ slug: p.slug, name: p.name, remote, hint: e.hint }); }
    }
  }
  return out;
}

// The run flags to keep: everything but --install/--uninstall. --until-idle and --max-runs make run exit,
// which a service would only restart, so they're refused.
export function serviceArgs(argv) {
  const args = argv.filter((a) => !/^--(un)?install$/.test(a));
  const exits = args.find((a) => /^--(until-idle|max-runs)(=|$)/.test(a));
  if (exits) throw Object.assign(new Error(`${exits.split('=')[0]} makes run exit, and a service would just start it again`), { hint: 'Leave it out with --install: the service keeps the runner waiting for work.' });
  return args;
}
