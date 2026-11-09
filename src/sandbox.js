// Workers stay inside their job (#472). A Claude Code worker's shell runs in Claude Code's sandbox: it writes only
// in its worktree (and the checkout's .git, where its commits go) and temp, can't read the person's keys, and
// reaches only the hub, GitHub, the project's package registries and the hosts a person added for its tests.
// Its allowlist names the project's own test and build commands, never an interpreter (node, python3, …) that
// would run anything. Setting names: https://code.claude.com/docs/en/sandboxing (checked 2026-11-01).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { flag, GIT_RUNS, rebaseRuns, rmOutside } from './gitrules.js';

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
// and the harnesses' own stores, denied wholesale like ~/.codex, opencode and pi: ~/.claude holds every past Claude
// Code session's transcript (~/.claude/projects — they routinely carry pasted keys and .env contents read into
// context, the same class as the shell histories below), settings.json's env block (provider keys), and plugins;
// its OAuth login is in the Keychain on macOS (in .credentials.json on Linux) and a runner worker's harness config
// comes inline, so the folder costs it nothing. Claude Desktop's local store (MCP tokens) in Application Support;
// opencode's config and data: `opencode auth login` keeps provider keys in its XDG data dir (auth.json, and
// mcp-auth.json for MCP logins), next to its sessions (#580, #581); and pi's agent folder, where it keeps auth.json, models.json keys and sessions (#495). Denying them costs the worker nothing: claude
// itself runs outside the sandbox and its permission rules, which hold only for the shell it starts and for its
// file tools, so it still reads its own login. Then every other harness's and toolchain's stored credentials (#616):
// Codex's auth.json, ~/.claude.json (user MCP servers' env and headers), git's XDG credential store, cargo's, gem's
// and Terraform's tokens, yarn's auth; the Gemini, Cursor and Codeium CLIs' own stores (auth, settings, chat
// history); shell and REPL histories (pasted keys), the shell's rc files that define the environment (#891 — the
// same keys, exported there instead of pasted, fish's config with them), atuin's full-history store, and the
// single files that hold a login outright: ~/.pgpass, ~/.my.cnf, git's cookie store, hub's GitHub token,
// rclone's remotes (each remote's password is in rclone.conf), Vault's token, sops' age keys and Terraform's
// own credentials file (~/.terraformrc — ~/.terraform.d is the plugin cache, already denied). The AI-CLI stores
// the first sweep missed (#893): github-copilot's hosts.json (the GitHub OAuth token), ~/.copilot, continue's
// config.json (plaintext provider keys), goose, crush and zed; the toolchains' remaining credential files (#893):
// maven's ~/.m2/settings.xml and NuGet's ~/.nuget/NuGet.Config; and VS Code's local store in Application Support
// (settings-sync tokens; a worker never touches the editor, so denying it costs nothing). And the logins a
// browser keeps: the macOS keychains, Safari's and the browsers' profiles (cookies, saved passwords) on macOS
// and Linux. And the release key's folder, where docs/DEPLOY.md keeps the release key and the release
// workflow's deploy key (#850). The tail the fresh workers-area review found (#899): the agent settings in the
// checkout and the worktree (`nuworq operator --allow` writes .claude/settings(.local).json, direnv exports
// .envrc, VS Code keeps its settings and tasks), sops' age key where macOS puts it (App Support/sops/age),
// VS Code's store where Linux puts it and the sibling editors' (Cursor, Code - Insiders, VSCodium), and the
// toolchains' and CLIs' remaining credential files — npm's XDG npmrc, yarn v1's, pip's, cargo's config beside
// its credentials, podman's auth.json, composer, wrangler, netlify, ngrok (both homes), sentry, pulumi,
// doctl, huggingface (its home and its cache token), databricks, jfrog, snowflake and snowsql, boto, flyctl,
// subversion, aider's conf, and git's own configs whose url.*.insteadOf can carry a token. Denying those two
// doesn't cost a worker its git: a sandbox read-deny surfaces as EPERM, and git dies on EPERM rather than
// skipping the file (git's access_or_die tolerates only missing files and EACCES) — so the worker's shell gets
// GIT_CONFIG_GLOBAL=/dev/null (git then never resolves ~/.gitconfig or ~/.config/git/config) and the person's
// commit identity as env config entries (workerEnv and gitConfigEnv, src/runtrust.js). The other stores are
// read only by their own tools, which skip a file they can't open; a worker's registries are reached with the
// env the runner injects or the project's own config. Where those CLIs keep their logins on each system (#910,
// checked 2026-11-09 against their docs, or their source for flyctl and doctl, whose docs don't say): fly's ~/.fly,
// wrangler's and netlify's XDG config (Preferences on macOS), doctl's and ngrok's Application Support on macOS,
// composer's XDG home on Linux; the older folders stay denied, since a machine that upgraded still has them, and a
// deny on a folder a tool doesn't use costs nothing.
const APP_SUPPORT = '~/Library/Application Support';
const PREFERENCES = '~/Library/Preferences';
export const DENY_READ = ['~/.ssh', '~/.nuworq', '~/.nuworq-release', '~/.aws', '~/.config/gh', '~/.config/gcloud', '~/.azure', '~/.kube', '~/.docker', '~/.git-credentials', '~/.netrc', '~/.npmrc', '~/.pypirc', '~/.gnupg', '~/.claude', '~/.config/opencode', '~/.local/share/opencode', '~/.pi/agent',
  '~/.codex', '~/.claude.json', '~/.gemini', '~/.cursor', '~/.codeium', '~/.config/github-copilot', '~/.copilot', '~/.continue', '~/.config/goose', '~/.config/crush', '~/.config/zed', '~/.config/git/credentials', '~/.config/git/config', '~/.gitconfig', '~/.cargo/credentials', '~/.cargo/credentials.toml', '~/.cargo/config.toml', '~/.cargo/config', '~/.gem/credentials', '~/.terraform.d', '~/.m2', '~/.nuget', '~/.yarnrc.yml', '~/.yarnrc',
  '~/.config/npm', '~/.config/pip', '~/.config/containers', '~/.composer', '~/.jfrog', '~/.pulumi', '~/.config/doctl', '~/.config/snowflake', '~/.snowsql', '~/.boto', '~/.databrickscfg', '~/.config/flyctl', '~/.fly', '~/.wrangler', '~/.config/.wrangler', `${PREFERENCES}/.wrangler`, '~/.netlify', '~/.config/netlify', `${PREFERENCES}/netlify`, '~/.config/composer', `${APP_SUPPORT}/doctl`, `${APP_SUPPORT}/ngrok`, '~/.config/ngrok', '~/.ngrok2', '~/.sentryclirc', '~/.subversion', '~/.aider.conf.yml', '~/.huggingface', '~/.cache/huggingface',
  '~/.zshenv', '~/.zprofile', '~/.zshrc', '~/.zlogin', '~/.profile', '~/.bashrc', '~/.bash_profile', '~/.bash_login', '~/.config/fish',
  '~/.bash_history', '~/.zsh_history', '~/.zsh_sessions', '~/.history', '~/.local/share/fish', '~/.local/share/atuin', '~/.python_history', '~/.node_repl_history', '~/.psql_history', '~/.mysql_history', '~/.sqlite_history',
  '~/.pgpass', '~/.my.cnf', '~/.gitcookies', '~/.config/hub', '~/.config/rclone', '~/.vault-token', '~/.config/sops', '~/.terraformrc',
  '~/Library/Keychains', '~/Library/Cookies', '~/Library/Safari', `${APP_SUPPORT}/Code`, `${APP_SUPPORT}/Code - Insiders`, `${APP_SUPPORT}/VSCodium`, `${APP_SUPPORT}/Cursor`, `${APP_SUPPORT}/sops`, `${APP_SUPPORT}/Claude`, `${APP_SUPPORT}/Google/Chrome`, `${APP_SUPPORT}/Chromium`, `${APP_SUPPORT}/BraveSoftware`, `${APP_SUPPORT}/Microsoft Edge`, `${APP_SUPPORT}/Arc`, `${APP_SUPPORT}/Firefox`,
  '~/.mozilla', '~/.config/google-chrome', '~/.config/chromium', '~/.config/BraveSoftware', '~/.config/microsoft-edge', '~/.config/Code', '~/.config/Code - Insiders', '~/.config/VSCodium'];

// The stores whose place depends on this machine (#910), so DENY_READ can't name them: podman's login in the
// runtime dir, or in /run/containers/<uid> when XDG_RUNTIME_DIR is unset (the file only: rootless podman keeps its run
// state in that folder), which a worker can find whether or not XDG_RUNTIME_DIR reaches it, and the zsh startup files
// and history in a ZDOTDIR away from home. Absolute paths only: a sandbox path can't be relative. A runner started
// without ZDOTDIR in its environment can't see that one.
const ZDOT_FILES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin', '.zsh_history', '.zsh_sessions'];
export function machineDenies(env = process.env, { platform = process.platform, uid = process.getuid?.() } = {}) {
  const linuxUid = platform === 'linux' && uid !== undefined;
  const runtime = [env.XDG_RUNTIME_DIR, linuxUid ? `/run/user/${uid}` : null];
  return [...new Set([
    ...runtime.filter((d) => d?.startsWith('/')).map((d) => join(d, 'containers', 'auth.json')),
    ...(linuxUid ? [`/run/containers/${uid}/auth.json`] : []),
    ...(env.ZDOTDIR?.startsWith('/') ? ZDOT_FILES.map((f) => join(env.ZDOTDIR, f)) : []),
  ])];
}

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
// there), direnv's .envrc (the person's shell) and VS Code's tasks and settings. A worker may not write them, and
// since #899 may not read them either: the settings' env block is exactly where provider keys land, and .envrc is
// where direnv exports the person's project keys.
export const AGENT_SETTINGS = ['.claude', '.envrc', '.vscode'];
const agentSettingsOf = (home, worktree) => [home, worktree].filter(Boolean).flatMap((d) => AGENT_SETTINGS.map((f) => join(d, f)));

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
  ...agentSettingsOf(home, worktree),
];

// Claude Code's sandbox for a worker: hub is the hub's address, home the project's checkout (its .git holds the
// worktree's objects and refs), worktree the worker's own (its folder in .git/worktrees has its name), hosts what a
// person added for the project's tests. landsHere: the project has no origin, so work lands by fast-forwarding the
// checkout itself, which the worker may then write, all but its .git's hooks and config. tokenFile: the worker's own
// token, in ~/.nuworq/tokens (#477), which its git's credential helper reads inside the sandbox; the narrower allowRead
// re-opens that one file in the denied ~/.nuworq (code.claude.com/docs/en/sandboxing, checked 2026-11-01).
export function sandboxSettings({ hub, home, worktree, hosts = [], landsHere = false, tokenFile = null, env = process.env }) {
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
      denyRead: [...DENY_READ, ...machineDenies(env), ...agentSettingsOf(home, worktree)],
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
// checked 2026-11-01). DENY_READ and the agent settings go out as Read and Edit trees only: Claude Code applies Read deny rules to
// Grep and Glob as well — to the directory their path argument resolves to, and best-effort to every built-in
// tool that reads files — while a Glob(path) rule never matches and a Grep rule's content is a pattern, not a
// path (docs checked 2026-11-04), so Grep/Glob trees of these paths would be dead rules.
const rule = (tool, p) => `${tool}(${p.startsWith('~/') ? p : `/${p}`})`;
const tree = (tool, p) => [rule(tool, p), rule(tool, `${p}/**`)];
export function filePermissions({ home, worktree, cwd = worktree ?? home, landsHere = false, env = process.env }) {
  const writable = [...new Set([cwd, ...(landsHere ? [home] : [])].filter(Boolean))];
  return {
    allow: ['Read', 'Glob', 'Grep', ...writable.map((p) => rule('Edit', `${p}/**`))],
    deny: [
      ...[...DENY_READ, ...machineDenies(env)].flatMap((p) => [...tree('Read', p), ...tree('Edit', p)]),
      // The agent settings in the checkout and the worktree: never written (gitDenies), never read either (#899).
      ...agentSettingsOf(home, worktree).flatMap((p) => tree('Read', p)),
      ...gitDenies(home, worktree, { landsHere }).flatMap((p) => tree('Edit', p)),
    ],
  };
}

// The git a worker may run (bin/nuworq.js's allowlist), never with an option that runs a program or writes a file
// (#625): the transport's, a diff or textconv driver, --output, and rebase's exec, editor and strategy. The sandbox
// would still bound such a program, but "exact commands, never an interpreter" means none starts. Deny wins over the
// allowlist. home: the checkout, whose `git -C <home> merge --ff-only` a worker landing there may run.
export const WORKER_GIT = ['git status', 'git diff', 'git log', 'git add', 'git commit', 'git switch', 'git rebase', 'git fetch', 'git push origin', 'git rm'];
export function workerGitDenies({ home = null } = {}) {
  const cmds = [...WORKER_GIT, ...(home ? [`git -C ${home} merge --ff-only`] : [])];
  return [...cmds.flatMap((c) => flag(c, ...GIT_RUNS)), ...rebaseRuns(), ...rmOutside(), ...(home ? flag(`git -C ${home} merge --ff-only`, '--strategy', '-s') : [])];
}

// The npm scripts a worker runs by default (#768): the project's checks (test, lint, check, typecheck, build, and
// their test:unit-style variants), never deploy, release, publish or anything else a script name doesn't promise.
const CHECK_SCRIPT = /^(test|lint|check|typecheck|build)(:[\w.-]+)?$/;
const NOT_A_CHECK = /deploy|release|publish|upload|push|migrate/i;

// The kinds of project a worker knows how to check, by the file that marks each: the commands it may run (each
// with any arguments, unless exact), and how it runs the whole suite and one test (#789). The worker's allowlist
// (projectCommands) and the hints that name a test command (testsLine) both read this, so they can't drift.
export const PROJECT_KINDS = [
  { files: ['package.json'], allow: ['npm test', { exact: 'npm ci' }], all: 'npm test', one: 'npm test -- test/<file>.test.js', not: 'node --test' },
  { files: ['pyproject.toml', 'requirements.txt', 'setup.py'], allow: ['pytest', 'python3 -m pytest'], all: 'pytest', one: 'pytest tests/test_<name>.py', not: 'python3 <file>' },
  { files: ['Cargo.toml'], allow: ['cargo test', 'cargo build', 'cargo check', 'cargo clippy'], all: 'cargo test', one: 'cargo test <name>' },
  { files: ['go.mod'], allow: ['go test', 'go build', 'go vet'], all: 'go test ./...', one: 'go test ./<package>' },
];
const allowRule = (a) => (typeof a === 'string' ? `Bash(${a}:*)` : `Bash(${a.exact})`);
// Whether an allowlist (projectCommands) lets a worker run cmd: a rule's prefix with any arguments, or an exact one.
export const allows = (allow, cmd) => allow.some((r) => {
  const m = /^Bash\((.*?)(:\*)?\)$/.exec(r);
  return m && (m[2] ? cmd === m[1] || cmd.startsWith(`${m[1]} `) : cmd === m[1]);
});
// The kinds of project whose marking file present(file) finds: a checkout's (has) or the hub's mirror's (git.js hasFile).
export const kindsOf = (present) => PROJECT_KINDS.filter((k) => k.files.some((f) => present(f)));

// The project's own checks: npm's check scripts by name (with arguments, e.g. npm test -- test/a.test.js),
// installing what the lockfile says (npm ci: no packages by name, no lockfile rewrite), and the usual test and
// build commands of Python, Rust and Go. Each still runs project code, which is why the sandbox is around it.
// extra: the commands a person added in the project's settings (workerCommands), each with any arguments.
export function projectCommands(home, extra = []) {
  const out = [];
  for (const kind of kindsOf((f) => has(home, f))) {
    out.push(...kind.allow.map(allowRule));
    if (!kind.files.includes('package.json')) continue;
    let scripts = {};
    try { scripts = JSON.parse(readFileSync(join(home, 'package.json'), 'utf8')).scripts ?? {}; } catch { /* not JSON: no scripts */ }
    for (const name of Object.keys(scripts).filter((n) => CHECK_SCRIPT.test(n) && !NOT_A_CHECK.test(n) && n !== 'test')) out.push(`Bash(npm run ${name}:*)`);
  }
  return [...new Set([...out, ...extra.map((c) => `Bash(${c}:*)`)])];
}

// How a worker runs this project's tests without stalling on approval (#789): the commands its allowlist has, for
// the hints and the worker's prompt. present(file): whether the project has that file. extra: its worker commands.
// With none it may run, it says to ask the operator, rather than name one that waits for an approval nobody gives.
export function testsLine(present, extra = []) {
  const kinds = kindsOf(present);
  if (!kinds.length && !extra.length) {
    return 'This project has no test command a worker may run without approval: don\'t start one (it stalls). Ask to: "operator" to run the tests, with the exact command, and use the answer as evidence.';
  }
  const ways = kinds.map((k) => `\`${k.all}\` (one test: \`${k.one}\`)`).concat(extra.map((c) => `\`${c}\``));
  const not = kinds.map((k) => k.not).filter(Boolean).map((c) => `\`${c}\``);
  return `Run tests with ${ways.join(', or ')}: the runner's sandbox allows ${ways.length > 1 ? 'these' : 'it'}${not.length ? `, not ${not.join(' or ')}, which stalls on approval` : ''}.`;
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
