// Workers stay inside their job (#472). A Claude Code worker's shell runs in Claude Code's sandbox: it writes only
// in its worktree (and the checkout's .git, where its commits go) and temp, can't read the person's keys, and
// reaches only the hub, GitHub, the project's package registries and the hosts a person added for its tests.
// Its allowlist names the project's own test and build commands, never an interpreter (node, python3, …) that
// would run anything. Setting names: https://code.claude.com/docs/en/sandboxing (checked 2026-11-01).
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

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

// What no worker reads, whatever its task says: keys, the person's nuworq login, cloud and GitHub CLI credentials.
export const DENY_READ = ['~/.ssh', '~/.nuworq', '~/.aws', '~/.config/gh', '~/.config/gcloud', '~/.azure', '~/.kube', '~/.docker', '~/.git-credentials', '~/.netrc', '~/.npmrc', '~/.pypirc', '~/.gnupg'];

// A project's extra hosts, as a person gives them: a list, or names split by commas or spaces. Host names only
// ("api.example.com", "*.example.com", "localhost:8080"), never a URL or a path.
export function sandboxHosts(v) {
  const list = (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)).map((h) => String(h ?? '').trim().toLowerCase()).filter(Boolean);
  const bad = list.filter((h) => !/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/.test(h));
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

// Never written, whatever else is: what git runs or reads its settings from. Exact paths, not globs: on Linux a
// sandbox path takes only a trailing /** (code.claude.com/docs/en/settings-reference, "Sandbox settings").
// The worktree's own .git file too: pointed at a folder of the worker's making, the runner's git there (its
// cleanup when the worker exits) would read that folder's config.
export const gitDenies = (home, worktree) => [
  ...['hooks', 'config', 'config.lock', 'config.worktree', 'modules', 'info', 'commondir'].map((p) => join(home, '.git', p)),
  ...(worktree ? ['config.worktree', 'commondir', 'gitdir'].map((p) => join(home, '.git', 'worktrees', basename(worktree), p)) : []),
  ...(worktree ? [join(worktree, '.git')] : []),
];

// Claude Code's sandbox for a worker: hub is the hub's address, home the project's checkout (its .git holds the
// worktree's objects and refs), worktree the worker's own (its folder in .git/worktrees has its name), hosts what a
// person added for the project's tests. landsHere: the project has no origin, so work lands by fast-forwarding the
// checkout itself, which the worker may then write, all but its .git's hooks and config.
export function sandboxSettings({ hub, home, worktree, hosts = [], landsHere = false }) {
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
      denyWrite: gitDenies(home, worktree),
      denyRead: DENY_READ,
    },
  };
}

// The project's own test and build commands: npm's scripts by name (with arguments, e.g. npm test -- test/a.test.js),
// installing what the lockfile says (no packages by name), and the usual test and build commands of Python, Rust
// and Go. Each still runs project code, which is why the sandbox is around it.
export function projectCommands(home) {
  const out = [];
  if (has(home, 'package.json')) {
    let scripts = {};
    try { scripts = JSON.parse(readFileSync(join(home, 'package.json'), 'utf8')).scripts ?? {}; } catch { /* not JSON: no scripts */ }
    out.push('Bash(npm test:*)', 'Bash(npm ci)', 'Bash(npm install)');
    for (const name of Object.keys(scripts).filter((n) => /^[\w:.-]+$/.test(n) && n !== 'test')) out.push(`Bash(npm run ${name}:*)`);
  }
  if (['pyproject.toml', 'requirements.txt', 'setup.py'].some((f) => has(home, f))) out.push('Bash(pytest:*)', 'Bash(python3 -m pytest:*)');
  if (has(home, 'Cargo.toml')) out.push('Bash(cargo test:*)', 'Bash(cargo build:*)', 'Bash(cargo check:*)', 'Bash(cargo clippy:*)');
  if (has(home, 'go.mod')) out.push('Bash(go test:*)', 'Bash(go build:*)', 'Bash(go vet:*)');
  return out;
}
