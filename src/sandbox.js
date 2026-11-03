// Workers stay inside their job (#472). A Claude Code worker's shell runs in Claude Code's sandbox: it writes only
// in its worktree (and the checkout's .git, where its commits go) and temp, can't read the person's keys, and
// reaches only the hub, GitHub, the project's package registries and the hosts a person added for its tests.
// Its allowlist names the project's own test and build commands, never an interpreter (node, python3, …) that
// would run anything. Setting names: https://code.claude.com/docs/en/sandboxing (checked 2026-11-01).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { flag, GIT_RUNS, rebaseRuns } from './gitrules.js';

export const HOSTS_HINT = 'Give host names only, e.g. api.stripe.com or *.example.com, separated by commas.';

// What git, and every dependency install, needs from GitHub.
export const GITHUB_HOSTS = ['github.com', '*.github.com', '*.githubusercontent.com'];

// Package registries, by the file that says a project uses them.
const REGISTRIES = [
  [['package.json'], ['registry.npmjs.org']],
  [['pyproject.toml', 'requirements.txt', 'setup.py'], ['pypi.org', 'files.pythonhosted.org']],
  [['Cargo.toml'], ['crates.io', 'index.crates.io', 'static.crates.io']],
  [['go.mod'], ['proxy.golang.org', 'sum.golang.org']],
];

// What no worker reads, whatever its task says: keys, the person's nuworq login, cloud and GitHub CLI credentials,
// and the harnesses' own logins: Claude Code's OAuth token (in this file on Linux; macOS keeps it in the Keychain)
// and opencode's config and data: `opencode auth login` keeps provider keys in its XDG data dir (auth.json, and
// mcp-auth.json for MCP logins), next to its sessions (#580, #581); and pi's agent folder, where it keeps auth.json, models.json keys and sessions (#495). Denying them costs the worker nothing: claude
// itself runs outside the sandbox and its permission rules, which hold only for the shell it starts and for its
// file tools, so it still reads its own login. Then every other harness's and toolchain's stored credentials (#616):
// Codex's auth.json, ~/.claude.json (user MCP servers' env and headers), git's XDG credential store, cargo's, gem's
// and Terraform's tokens, yarn's auth; shell and REPL histories (pasted keys); and the logins a browser keeps: the
// macOS keychains, Safari's and the browsers' profiles (cookies, saved passwords) on macOS and Linux.
const APP_SUPPORT = '~/Library/Application Support';
export const DENY_READ = ['~/.ssh', '~/.nuworq', '~/.aws', '~/.config/gh', '~/.config/gcloud', '~/.azure', '~/.kube', '~/.docker', '~/.git-credentials', '~/.netrc', '~/.npmrc', '~/.pypirc', '~/.gnupg', '~/.claude/.credentials.json', '~/.config/opencode', '~/.local/share/opencode', '~/.pi/agent',
  '~/.codex', '~/.claude.json', '~/.config/git/credentials', '~/.cargo/credentials', '~/.cargo/credentials.toml', '~/.gem/credentials', '~/.terraform.d', '~/.yarnrc.yml',
  '~/.bash_history', '~/.zsh_history', '~/.zsh_sessions', '~/.history', '~/.local/share/fish', '~/.python_history', '~/.node_repl_history', '~/.psql_history', '~/.mysql_history', '~/.sqlite_history',
  '~/Library/Keychains', '~/Library/Cookies', '~/Library/Safari', `${APP_SUPPORT}/Google/Chrome`, `${APP_SUPPORT}/Chromium`, `${APP_SUPPORT}/BraveSoftware`, `${APP_SUPPORT}/Microsoft Edge`, `${APP_SUPPORT}/Arc`, `${APP_SUPPORT}/Firefox`,
  '~/.mozilla', '~/.config/google-chrome', '~/.config/chromium', '~/.config/BraveSoftware', '~/.config/microsoft-edge'];

// A project's extra hosts, as a person gives them: a list, or names split by commas or spaces. Host names only
// ("api.example.com", "*.example.com", "localhost:8080"), never a URL or a path. A wildcard covers a domain, never a
// whole top-level one ("*.com"). The runner checks what the hub sends with this too (#624).
export function sandboxHosts(v) {
  const list = (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)).map((h) => String(h ?? '').trim().toLowerCase()).filter(Boolean);
  const bad = list.filter((h) => !/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/.test(h) || /^\*\.[^.]+$/.test(h));
  if (bad.length) throw Object.assign(new Error(`${bad.join(', ')} ${bad.length === 1 ? "isn't a host name" : "aren't host names"}`), { hint: HOSTS_HINT });
  return [...new Set(list)];
}

const has = (home, f) => existsSync(join(home, f));

// The registries a project in home uses.
export const registriesOf = (home) => REGISTRIES.filter(([files]) => files.some((f) => has(home, f))).flatMap(([, hosts]) => hosts);

// What of the checkout's .git a worker writes to commit, fetch and rebase in its worktree: objects, refs and their
// logs, and its own worktree's folder (its HEAD, index and rebase state). Not hooks or config: an unsandboxed git
// there (the runner's next fetch, or the person) would run what a worker put in them, as the person.
export const gitWrites = (home, name) => [
  ...['objects', 'refs', 'logs', 'packed-refs', 'packed-refs.lock', 'shallow', 'shallow.lock', 'rr-cache'].map((p) => join(home, '.git', p)),
  ...(name ? [join(home, '.git', 'worktrees', name)] : []),
];

// What an unsandboxed tool later reads from a folder a worker may write (#606): Claude Code's project settings (an
// operator in the checkout, or the next worker in this worktree, starts with them; `nuworq operator --allow` writes
// there), direnv's .envrc (the person's shell) and VS Code's tasks and settings.
export const AGENT_SETTINGS = ['.claude', '.envrc', '.vscode'];

// Other workers' folders in the checkout's .git/worktrees (#606), as they are when this worker starts: their
// commondir and gitdir point the runner's unsandboxed git (its cleanup when they exit) at a config, so a worker that
// may write the whole checkout must not write them. name: this worker's own folder, left out.
export function otherWorktrees(home, name) {
  try {
    return readdirSync(join(home, '.git', 'worktrees'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== name).map((d) => join(home, '.git', 'worktrees', d.name));
  } catch { return []; }
}

// Never written, whatever else is: what git runs or reads its settings from. Exact paths, not globs: on Linux a
// sandbox path takes only a trailing /** (code.claude.com/docs/en/settings-reference, "Sandbox settings").
// The worktree's own .git file too: pointed at a folder of the worker's making, the runner's git there (its
// cleanup when the worker exits) would read that folder's config. And the agent settings in the checkout and the
// worktree; with landsHere, where the worker may write the whole checkout, every other worker's .git/worktrees folder.
export const gitDenies = (home, worktree, { landsHere = false } = {}) => [
  ...['hooks', 'config', 'config.lock', 'config.worktree', 'modules', 'info', 'commondir'].map((p) => join(home, '.git', p)),
  ...(worktree ? ['config.worktree', 'commondir', 'gitdir'].map((p) => join(home, '.git', 'worktrees', basename(worktree), p)) : []),
  ...(worktree ? [join(worktree, '.git')] : []),
  ...(landsHere ? otherWorktrees(home, worktree && basename(worktree)) : []),
  ...[home, worktree].filter(Boolean).flatMap((d) => AGENT_SETTINGS.map((f) => join(d, f))),
];

// Claude Code's sandbox for a worker: hub is the hub's address, home the project's checkout (its .git holds the
// worktree's objects and refs), worktree the worker's own (its folder in .git/worktrees has its name), hosts what a
// person added for the project's tests. landsHere: the project has no origin, so work lands by fast-forwarding the
// checkout itself, which the worker may then write, all but its .git's hooks and config. tokenFile: the worker's own
// token, in ~/.nuworq/tokens (#477), which its git's credential helper reads inside the sandbox; the narrower allowRead
// re-opens that one file in the denied ~/.nuworq (code.claude.com/docs/en/sandboxing, checked 2026-11-01).
export function sandboxSettings({ hub, home, worktree, hosts = [], landsHere = false, tokenFile = null }) {
  const hubHost = hub ? new URL(hub).host : '';
  return {
    enabled: true,
    failIfUnavailable: true, // no sandbox on this machine: the worker doesn't start, rather than run without one
    allowUnsandboxedCommands: false, // no retrying a refused command outside it
    autoAllowBashIfSandboxed: false, // the allowlist still decides what runs
    network: {
      allowedDomains: [...new Set([hubHost, ...GITHUB_HOSTS, ...registriesOf(home), ...hosts].filter(Boolean))],
      strictAllowlist: true, // anything else is refused, not asked about: nobody is there to answer
      allowLocalBinding: true, // tests and the demo server listen on loopback
    },
    filesystem: {
      allowWrite: landsHere ? [home] : gitWrites(home, worktree && basename(worktree)),
      denyWrite: gitDenies(home, worktree, { landsHere }),
      denyRead: DENY_READ,
      ...(tokenFile ? { allowRead: [tokenFile] } : {}),
    },
  };
}

// The sandbox holds only for the shell; Claude Code's own file tools (Read, Edit, Write, Glob, Grep) answer to
// permission rules instead, so these say the same (#472). Edit and Write only in the worker's folder (cwd: its
// worktree, or the checkout itself) and, when work lands here, the checkout; never git's hooks or config there.
// Read, Glob and Grep anywhere but the keys DENY_READ names, the worker's own token file included: only its git's
// credential helper reads that, in the shell. Deny wins over allow. Rule paths: //abs is absolute, ~/ the home
// folder. Edit rules cover Write too, and a Write(path) rule never matches (code.claude.com/docs/en/permissions,
// checked 2026-11-01).
const rule = (tool, p) => `${tool}(${p.startsWith('~/') ? p : `/${p}`})`;
const tree = (tool, p) => [rule(tool, p), rule(tool, `${p}/**`)];
export function filePermissions({ home, worktree, cwd = worktree ?? home, landsHere = false }) {
  const writable = [...new Set([cwd, ...(landsHere ? [home] : [])].filter(Boolean))];
  return {
    allow: ['Read', 'Glob', 'Grep', ...writable.map((p) => rule('Edit', `${p}/**`))],
    deny: [
      ...DENY_READ.flatMap((p) => [...tree('Read', p), ...tree('Edit', p)]),
      ...gitDenies(home, worktree, { landsHere }).flatMap((p) => tree('Edit', p)),
    ],
  };
}

// The git a worker may run (bin/nuworq.js's allowlist), never with an option that runs a program or writes a file
// (#625): the transport's, a diff or textconv driver, --output, and rebase's exec, editor and strategy. The sandbox
// would still bound such a program, but "exact commands, never an interpreter" means none starts. Deny wins over the
// allowlist. home: the checkout, whose `git -C <home> merge --ff-only` a worker landing there may run.
export const WORKER_GIT = ['git status', 'git diff', 'git log', 'git add', 'git commit', 'git switch', 'git rebase', 'git fetch', 'git push origin'];
export function workerGitDenies({ home = null } = {}) {
  const cmds = [...WORKER_GIT, ...(home ? [`git -C ${home} merge --ff-only`] : [])];
  return [...cmds.flatMap((c) => flag(c, ...GIT_RUNS)), ...rebaseRuns(), ...(home ? flag(`git -C ${home} merge --ff-only`, '--strategy', '-s') : [])];
}

// The npm scripts a worker runs by default (#768): the project's checks (test, lint, check, typecheck, build, and
// their test:unit-style variants), never deploy, release, publish or anything else a script name doesn't promise.
const CHECK_SCRIPT = /^(test|lint|check|typecheck|build)(:[\w.-]+)?$/;
const NOT_A_CHECK = /deploy|release|publish|upload|push|migrate/i;

// The project's own checks: npm's check scripts by name (with arguments, e.g. npm test -- test/a.test.js),
// installing what the lockfile says (npm ci: no packages by name, no lockfile rewrite), and the usual test and
// build commands of Python, Rust and Go. Each still runs project code, which is why the sandbox is around it.
// extra: the commands a person added in the project's settings (workerCommands), each with any arguments.
export function projectCommands(home, extra = []) {
  const out = [];
  if (has(home, 'package.json')) {
    let scripts = {};
    try { scripts = JSON.parse(readFileSync(join(home, 'package.json'), 'utf8')).scripts ?? {}; } catch { /* not JSON: no scripts */ }
    out.push('Bash(npm test:*)', 'Bash(npm ci)');
    for (const name of Object.keys(scripts).filter((n) => CHECK_SCRIPT.test(n) && !NOT_A_CHECK.test(n) && n !== 'test')) out.push(`Bash(npm run ${name}:*)`);
  }
  if (['pyproject.toml', 'requirements.txt', 'setup.py'].some((f) => has(home, f))) out.push('Bash(pytest:*)', 'Bash(python3 -m pytest:*)');
  if (has(home, 'Cargo.toml')) out.push('Bash(cargo test:*)', 'Bash(cargo build:*)', 'Bash(cargo check:*)', 'Bash(cargo clippy:*)');
  if (has(home, 'go.mod')) out.push('Bash(go test:*)', 'Bash(go build:*)', 'Bash(go vet:*)');
  return [...new Set([...out, ...extra.map((c) => `Bash(${c}:*)`)])];
}

export const COMMANDS_HINT = 'Give whole commands, one per line, e.g. npm run e2e or make test: words only, no ;, |, &, $, quotes or redirects, and not an interpreter on its own (node, python3, bash…) or code given inline (node -e, npm exec, npx).';
// Alone, these run whatever follows them: a person adds `node scripts/check.js`, never `node`.
const RUNS_ANYTHING = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'php', 'deno', 'bun', 'npx', 'bunx', 'pnpx', 'sh', 'bash', 'zsh', 'fish', 'env', 'sudo', 'eval', 'exec', 'xargs', 'curl', 'wget', 'ssh', 'git', 'npm', 'make']);
// The commands a person lets workers run beyond the project's checks (#768): a list, or one per line (or comma).
// Each is plain words, so it can't chain another command, and isn't an interpreter or a tool with nothing after it.
// The runner checks what the hub sends with this too, as with sandbox hosts (#624).
export function workerCommands(v) {
  const list = (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]+/)).map((c) => String(c ?? '').trim().replace(/\s+/g, ' ')).filter(Boolean);
  const bad = list.filter((c) => c.length > 200 || !/^[\w.@/+=-]+( [\w.@/:+=-]+)*$/.test(c) || RUNS_ANYTHING.has(c) || /^(sudo|env|eval|exec|xargs|curl|wget|ssh|sh|bash|zsh|npx|bunx|pnpx) /.test(c)
    // Nor one that runs code given inline: node -e, python -c, npm exec.
    || /^(node|python3?|ruby|perl|php|deno|bun) (-e|-c|-p|-r|--eval|--print)\b/.test(c) || /^npm (exec|x) /.test(c));
  // Quoted: a refusal shown at its field starts with a capital, which would change the command.
  if (bad.length) throw Object.assign(new Error(`${bad.map((c) => `"${c}"`).join(', ')} ${bad.length === 1 ? "isn't a command workers may run" : "aren't commands workers may run"}`), { hint: COMMANDS_HINT });
  if (list.length > 20) throw Object.assign(new Error('At most 20 commands'), { hint: 'Name the commands workers need for this project\'s checks; a script that runs several counts as one.' });
  return [...new Set(list)];
}
