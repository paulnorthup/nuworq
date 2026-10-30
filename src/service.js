// nuworq run as a service (#172): a LaunchAgent on macOS, a systemd user unit on Linux, so a runner keeps going
// across closed terminals and reboots. Plain text files and the platform's own commands; nothing to install.
// Everything outside (the file system, launchctl/systemctl) is injected so tests run neither.
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const LABEL = 'com.nuworq.run';
export const UNIT = 'nuworq-run.service';

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
// One systemd word: quoted, with what systemd would expand ($, %, \, ") kept literal.
const word = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$').replace(/%/g, '%%')}"`;

// command: [node, bin, 'run', ...flags]. env: what the runner needs from this shell (PATH, NUWORQ_*). log: one file.
export function launchdPlist({ command, env = {}, log }) {
  const strings = (xs) => xs.map((x) => `    <string>${xml(x)}</string>`).join('\n');
  const vars = Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings(command)}
  </array>
  <key>EnvironmentVariables</key>
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

export function systemdUnit({ command, env = {}, log }) {
  return `[Unit]
Description=nuworq run: workers on waiting work
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${command.map(word).join(' ')}
${Object.entries(env).map(([k, v]) => `Environment=${word(`${k}=${v}`)}`).join('\n')}
Restart=always
RestartSec=30
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

// Where the definition lives, and the commands that load and unload it.
export function serviceFor({ platform, home, uid }) {
  if (platform === 'darwin') {
    const file = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    return {
      kind: 'LaunchAgent', file, text: launchdPlist,
      load: [['launchctl', 'bootstrap', `gui/${uid}`, file]],
      unload: [['launchctl', 'bootout', `gui/${uid}/${LABEL}`]],
    };
  }
  if (platform === 'linux') {
    const file = join(home, '.config', 'systemd', 'user', UNIT);
    return {
      kind: 'systemd user unit', file, text: systemdUnit,
      load: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', UNIT]],
      unload: [['systemctl', '--user', 'disable', '--now', UNIT]],
      after: [['systemctl', '--user', 'daemon-reload']],
    };
  }
  return null;
}

const shown = (cmd) => cmd.map((x) => (/^[\w./:@=-]+$/.test(x) ? x : `'${String(x).replace(/'/g, "'\\''")}'`)).join(' ');

// Write the definition and load it; one already there is unloaded and replaced. exec(cmd, args) runs a
// command and rejects when it fails. Returns { file, kind, uninstall }: uninstall is the exact command to remove it.
export async function install({ platform, home, uid, command, env, log, exec, fs = { mkdirSync, writeFileSync } }) {
  const s = serviceFor({ platform, home, uid });
  if (!s) throw Object.assign(new Error(`--install knows macOS (launchd) and Linux (systemd), not ${platform}`), { hint: 'Run nuworq run under your own supervisor instead.' });
  for (const [cmd, ...args] of s.unload) await exec(cmd, args).catch(() => {}); // not loaded yet: fine
  fs.mkdirSync(dirname(s.file), { recursive: true });
  fs.mkdirSync(dirname(log), { recursive: true });
  // 0600: the flags and NUWORQ_* it carries may include a token.
  fs.writeFileSync(s.file, s.text({ command, env, log }), { mode: 0o600 });
  for (const [cmd, ...args] of s.load) await exec(cmd, args);
  return { file: s.file, kind: s.kind, log, uninstall: `${shown(command.slice(0, 3))} --uninstall` };
}

// Stop it and remove the definition. Returns { file, removed }: removed is false when nothing was installed.
export async function uninstall({ platform, home, uid, exec, fs = { rmSync, existsSync } }) {
  const s = serviceFor({ platform, home, uid });
  if (!s) throw Object.assign(new Error(`--uninstall knows macOS (launchd) and Linux (systemd), not ${platform}`), { hint: 'Stop it with your own supervisor.' });
  const was = fs.existsSync(s.file);
  for (const [cmd, ...args] of s.unload) await exec(cmd, args).catch(() => {});
  fs.rmSync(s.file, { force: true });
  for (const [cmd, ...args] of s.after ?? []) await exec(cmd, args).catch(() => {});
  return { file: s.file, kind: s.kind, removed: was };
}

// The environment a service needs from the shell it was installed from: PATH (so the agent CLIs and git are
// found), HOME, and nuworq's own settings (NUWORQ_* and the older TRELLIS_*).
export function serviceEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v != null && (['PATH', 'HOME'].includes(k) || /^(NUWORQ|TRELLIS)_/.test(k))).sort(([a], [b]) => a.localeCompare(b)));
}

// The run flags to keep: everything but --install/--uninstall. --until-idle and --max-runs make run exit,
// which a service would only restart, so they're refused.
export function serviceArgs(argv) {
  const args = argv.filter((a) => !/^--(un)?install$/.test(a));
  const exits = args.find((a) => /^--(until-idle|max-runs)(=|$)/.test(a));
  if (exits) throw Object.assign(new Error(`${exits.split('=')[0]} makes run exit, and a service would just start it again`), { hint: 'Leave it out with --install: the service keeps the runner waiting for work.' });
  return args;
}
