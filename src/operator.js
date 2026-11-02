// What an operator session can really do, and the permission rules that let its routine commands run without
// prompts (#494). Detection lives here and only here: `nuworq operator --detect` prints it, and the operator
// skill checks in with it when the person typed no capabilities. Commands run through run(cmd, args), so tests
// fake them. The infra check is this machine's own, set by its person and kept in ~/.nuworq/operator.json:
// never sent by the hub (see the decision "Never run code fetched at runtime", and #477).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { OPS, OPERATOR_WAIT } from './protocol.js';

const OS = { darwin: ['macos', 'macOS'], linux: ['linux', 'Linux'], win32: ['windows', 'Windows'] };
const first = (s) => String(s ?? '').trim().split('\n')[0];

// This machine's operator settings: { infra_check, without_infra }.
export function localOf(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { return {}; }
}
export function saveLocal(file, patch) {
  const next = Object.fromEntries(Object.entries({ ...localOf(file), ...patch }).filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false));
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

// A change to this machine's infra settings (#607), saved only once confirm(question) says yes: a person at a
// terminal (bin/nuworq.js passes null without one, as in an agent's shell). The check is a command --detect runs
// with /bin/sh, so whoever sets it runs code here later. Returns the settings, or null when nothing changed.
export async function changeInfra(file, patch, confirm) {
  const check = patch.infra_check;
  const question = check ? `--detect will run ${JSON.stringify(check)} with /bin/sh to decide whether this machine declares infra. Set it?`
    : check !== undefined ? 'Clear this machine\'s infra check?'
    : patch.without_infra ? 'Declare no infra on this machine?' : 'Declare infra on this machine again?';
  if (!confirm || !await confirm(question)) return null;
  return saveLocal(file, patch);
}

// repos: the project's repositories (github.com/owner/name). chrome: a Chrome or Chromium is installed.
// Returns { has, found: [{ tag, ok, why }] }: has is "operator" plus each tag found.
export async function detect({ platform = process.platform, run, chrome = false, repos = [], local = {} }) {
  const found = [];
  const os = OS[platform];
  if (os) found.push({ tag: os[0], ok: true, why: `this machine runs ${os[1]}` });

  const claude = await run('claude', ['--version']);
  found.push(claude.ok ? { tag: 'claude-cli', ok: true, why: `claude runs (${first(claude.out)})` } : { tag: 'claude-cli', ok: false, why: "claude doesn't run here" });

  const gh = repos.filter((r) => r.startsWith('github.com/')).map((r) => r.slice('github.com/'.length));
  if (!gh.length) {
    found.push({ tag: 'github-admin', ok: false, why: 'the project has no GitHub repository' });
  } else {
    const not = [];
    for (const r of gh) {
      const a = await run('gh', ['api', `repos/${r}`, '--jq', '.permissions.admin']);
      if (!a.ok || first(a.out) !== 'true') not.push(a.ok ? `not admin on ${r}` : `gh can't read ${r} (${first(a.out) || 'not signed in?'})`);
    }
    found.push(not.length ? { tag: 'github-admin', ok: false, why: not.join('; ') } : { tag: 'github-admin', ok: true, why: `admin on ${gh.join(', ')}` });
  }

  found.push(chrome ? { tag: 'browser', ok: true, why: 'Chrome or Chromium is installed' } : { tag: 'browser', ok: false, why: 'no Chrome or Chromium here' });

  if (local.without_infra) {
    found.push({ tag: 'infra', ok: false, why: 'this machine was set --without infra' });
  } else if (local.infra_check) {
    const c = await run('/bin/sh', ['-c', local.infra_check]);
    found.push(c.ok ? { tag: 'infra', ok: true, why: `its check passed (${local.infra_check})` } : { tag: 'infra', ok: false, why: `its check failed (${local.infra_check})` });
  } else {
    found.push({ tag: 'infra', ok: true, why: 'a person started this attended operator here' });
  }
  return { has: ['operator', ...found.filter((f) => f.ok).map((f) => f.tag)], found };
}

// The one line an operator says first, e.g. "Operator: macos, claude-cli, github-admin (admin on acme/api), infra".
export function declared(found) {
  const shown = found.filter((f) => f.ok).map((f) => (f.tag === 'github-admin' ? `${f.tag} (${f.why})` : f.tag));
  return `Operator: ${shown.join(', ') || 'no capabilities beyond operator'}`;
}

// The host an infra check reaches with ssh, if it does: the first argument after ssh that isn't an option.
export function sshHost(check) {
  const words = String(check ?? '').trim().split(/\s+/);
  const at = words.indexOf('ssh');
  if (at < 0) return null;
  for (let i = at + 1; i < words.length; i++) {
    const w = words[i];
    if (/^-[bcDEeFIiJLlmOopQRSWw]$/.test(w)) { i++; continue; } // an option with a value
    if (w.startsWith('-')) continue;
    return w.replace(/^[^@]*@/, '') || null;
  }
  return null;
}

// The operator's routine commands, allowed; their destructive forms, denied so they still prompt (deny wins).
// Claude Code matches rule text: `*` is any text, spaces included, and `:*` means "and anything" only at the
// very end. Commands it allows outright; checkout (its path form discards work) and the rest of remote still ask.
export const OPERATOR_GIT_CMDS = ['status', 'diff', 'log', 'show', 'fetch', 'pull', 'switch', 'add', 'commit', 'rebase', 'push', 'branch', 'tag', 'worktree', 'rev-parse', 'ls-remote'];
// A flag, wherever it sits: first (`git push -fu`) or later (`git push origin x --force`), with its value attached or not.
const flag = (cmd, ...flags) => flags.flatMap((f) => [`Bash(${cmd} ${f}*)`, `Bash(${cmd} * ${f}*)`]);
// A short flag bundled with others too (#607), e.g. `-uf` for -f: letters are the command's short flags, and a
// bundle starts with one of them, so `--dry-run` never matches. Rule text can't say "within one word", so a later
// word may make it match (`-u origin feature`): that command asks, which is the safe side.
const short = (cmd, letters, ...targets) => targets.flatMap((t) => flag(cmd, `-${t}`, ...[...letters].filter((x) => x !== t).map((x) => `-${x}*${t}`)));
// Options that make git run a program or write a file, denied on every git command the operator may run (#607).
const GIT_RUNS = ['--upload-pack', '--receive-pack', '--exec', '--output', '--ext-diff', '--textconv'];
// nuworq's commands an operator runs without prompts (#607): the agent operations, which only talk to the hub,
// and what reads: --detect, --check, the listener and the guide. Never `nuworq:*`: other commands start
// programs, write files or change this machine's settings, so they ask.
const NUWORQ = () => [...OPS.map((o) => o.name), 'operator --detect', 'operator --check', OPERATOR_WAIT.replace(/^nuworq /, '').replace(/ --follow$/, ''), 'guide'];
export function rules({ host = null } = {}) {
  const git = OPERATOR_GIT_CMDS;
  const gh = ['pr', 'run', 'repo view', 'issue view', 'issue list', 'release view', 'release list'];
  const allow = [
    ...NUWORQ().map((c) => `Bash(nuworq ${c}:*)`), 'mcp__nuworq', 'mcp__plugin_nuworq_nuworq',
    ...git.map((c) => `Bash(git ${c}:*)`),
    'Bash(git remote)', 'Bash(git remote -v)', 'Bash(git remote get-url *)',
    ...gh.map((c) => `Bash(gh ${c}:*)`),
    // gh api with the path first, so the flags after it can be denied; flags first, or graphql, still ask.
    'Bash(gh api repos/*)', 'Bash(gh api /repos/*)',
    ...(host ? [`Bash(ssh ${host}:*)`] : []),
  ];
  const deny = [
    // Force-pushes, and deleting or rewriting refs on a remote: --delete, an empty source (`origin :x`), --mirror, --prune.
    // `:**`, not `:*`: at the end, `:*` would read as "and anything" and deny every push.
    ...flag('git push', '--force', '--delete', '--mirror', '--prune'), ...short('git push', '46dfnquv', 'f', 'd'), 'Bash(git push * +*)', 'Bash(git push * :**)',
    // Deleting, moving or force-resetting branches and tags.
    ...flag('git branch', '--delete', '--force'), ...short('git branch', 'acCdDfilmMqrtuv', 'd', 'D', 'f', 'M', 'C'),
    ...flag('git tag', '--delete', '--force'), ...short('git tag', 'adefFilmnsuv', 'd', 'f'),
    // Throwing away uncommitted work.
    ...flag('git switch', '--force', '--discard-changes'), ...short('git switch', 'cCdfmqt', 'f', 'C'),
    ...flag('git worktree remove', '--force'), ...short('git worktree remove', 'fq', 'f'),
    // Running a program or writing a file (#607): through the transport, a configured diff or textconv driver,
    // --output, or rebase's exec, interactive editor and merge strategy (a git-merge-* on PATH).
    ...git.flatMap((c) => flag(`git ${c}`, ...GIT_RUNS)),
    ...flag('git rebase', '--interactive', '--strategy', '--edit-todo'), ...short('git rebase', 'CfikmnqrsvxX', 'x', 'i', 's'),
    ...flag('git pull', '--strategy', '--rebase=i'), ...short('git pull', '46afknqrstuv', 's'),
    ...short('git ls-remote', 'bhqtu', 'u'),
    // This machine's operator settings: its infra check is a command --detect runs (they also need a person at a
    // terminal, bin/nuworq.js operatorCmd).
    ...flag('nuworq operator', '--infra-check', '--with', '--allow', '--start'),
    // gh api only reads: no method but GET, and no fields or input (which make it a write).
    ...flag('gh api', '-X', '--method', '-f', '-F', '--field', '--raw-field', '--input'),
    'Bash(gh repo delete:*)', 'Bash(gh release delete:*)', 'Bash(gh run delete:*)',
  ];
  return { allow, deny };
}

// Add the rules to a Claude Code settings file (the project's .claude/settings.local.json), keeping everything
// else in it. off: remove exactly those rules. Returns { added, removed }.
export function applyRules(file, r, { off = false } = {}) {
  let cfg = {};
  if (existsSync(file)) {
    try { cfg = JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { throw Object.assign(new Error(`${file} isn't plain JSON`), { hint: 'Fix it or move it aside, then run this again.' }); }
  }
  const perms = { ...(cfg.permissions ?? {}) };
  let added = 0, removed = 0;
  for (const kind of ['allow', 'deny']) {
    const have = [...(perms[kind] ?? [])];
    if (off) {
      const kept = have.filter((x) => !r[kind].includes(x));
      removed += have.length - kept.length;
      perms[kind] = kept;
    } else {
      for (const x of r[kind]) if (!have.includes(x)) { have.push(x); added++; }
      perms[kind] = have;
    }
    if (!perms[kind].length) delete perms[kind];
  }
  cfg.permissions = perms;
  if (!Object.keys(perms).length) delete cfg.permissions;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return { added, removed };
}
