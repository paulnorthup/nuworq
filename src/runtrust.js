// A runner trusts its own machine, not the hub (#477). What the hub sends is checked before it reaches a shell,
// workers run only in folders the person chose here, the agent token travels in a 0600 file (never argv, a
// string sh runs, or the agent's environment), and what is logged or reported has its tokens taken out.
import { readFileSync, writeFileSync, mkdirSync, chmodSync, readdirSync, statSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { HubError } from './client.js';

// Slugs and worker names as they reach shells and file names: nothing a shell would read as syntax.
export const NAME = /^[a-z0-9._-]+$/;
export function checkName(what, v) {
  const s = String(v ?? '');
  if (!NAME.test(s) || s === '.' || s === '..') {
    throw new HubError(`the ${what} "${printable(s).slice(0, 60)}" isn't a plain name (a-z, 0-9, ".", "_", "-")`, { hint: 'A hub only ever sends plain names: this one may not be the hub you think it is.' });
  }
  return s;
}

// One shell word, single-quoted.
export const sq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

// Tokens out of anything logged or sent to the hub: nuworq's (nwq_) and GitHub's (ghs_, ghp_, gho_, ghu_, github_pat_).
const TOKENS = /\b(nwq|ghs|ghp|gho|ghu|ghr|github_pat)_[A-Za-z0-9_]{4,}/g;
// Model keys too (#626): Anthropic's sk-ant-…, OpenAI's sk-… and sk-proj-…, llm-proxy's sk-proxy-…; a key in a header
// line, whatever its shape; and the value of any secret in this runner's own environment (llm-proxy's owner token has
// no shape of its own), a path aside.
const KEYS = /\bsk-[A-Za-z0-9_-]{8,}/g;
const HEADERS = /\b(authorization:\s*bearer|x-proxy-token:|x-api-key:)\s*[^\s"',]+/gi;
const secrets = (env) => Object.entries(env).filter(([k, v]) => /KEY|TOKEN|SECRET|PASSWORD/.test(k) && String(v ?? '').length >= 12 && !/^[/~]/.test(v))
  .map(([, v]) => String(v)).sort((a, b) => b.length - a.length);
export const redact = (s, env = process.env) => {
  let out = String(s ?? '');
  for (const v of secrets(env)) out = out.split(v).join('[redacted]');
  return out.replace(TOKENS, '$1_[redacted]').replace(KEYS, 'sk-[redacted]').replace(HEADERS, '$1 [redacted]');
};

// Text from the hub, safe to print: no control characters (terminal escapes among them); newlines and tabs stay.
// eslint-disable-next-line no-control-regex
export const printable = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

// What a runner prints or writes to its log: both.
export const safe = (s) => printable(redact(s));

// Only what's the person's own: ~/.nuworq and its logs and tokens 0700, their files 0600. Set again on every
// start, since mkdir's mode does nothing to a folder that's already there. Other folders inside are left alone.
export function lockDown(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const files = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) if (e.isFile()) chmodSync(join(d, e.name), 0o600); };
  files(dir);
  for (const sub of ['logs', 'tokens']) {
    const d = join(dir, sub);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
    files(d);
  }
}

// The agent token for one worker, in a file only this user can read. Its path goes where the token used to:
// NUWORQ_TOKEN_FILE, read by the MCP server and the git credential helper (src/client.js resolveSettings).
export function tokenFile(dir, name, token) {
  const d = join(dir, 'tokens');
  mkdirSync(d, { recursive: true, mode: 0o700 });
  chmodSync(d, 0o700);
  const file = join(d, `${checkName('worker name', name)}.token`);
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
export const dropTokenFile = (file) => { try { if (file) rmSync(file, { force: true }); } catch { /* gone */ } };

// The environment a worker starts with: the runner's own, minus every token in it (the person's own included, and
// any variable holding one, e.g. a credential helper an older runner exported).
// Git's GIT_CONFIG_COUNT/KEY_n/VALUE_n go together: when one goes, they all do, or git refuses to start.
export function withoutTokens(env = process.env) {
  const out = Object.entries(env).filter(([k]) => !/^NUWORQ_(AGENT_)?TOKEN$/.test(k));
  const holds = ([, v]) => new RegExp(TOKENS.source).test(String(v));
  const gitConfig = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;
  const dropGit = out.some((e) => gitConfig.test(e[0]) && holds(e));
  return Object.fromEntries(out.filter((e) => !holds(e) && !(dropGit && gitConfig.test(e[0]))));
}

// The environment a worker's agent starts with (#616): an allowlist, not the runner's own minus what looks like a
// token. Where things are (PATH, HOME, temp, locale, the network proxy and CA certificates, toolchain folders) and
// nuworq's own settings, never its secrets; then the names its harness needs to reach its model (keys: workerSetup's
// `keys`, each one its harness keeps from its own shell). AWS_*, OPENAI_API_KEY for a Claude worker, an SSH agent,
// npm's auth: none of it is there to read. Values holding a nuworq or GitHub token go too, whatever their name.
// Not XDG_CONFIG_HOME or XDG_DATA_HOME, whatever the person's shell exports (#891): they are exactly where
// credentials pile up — ~/.config and ~/.local/share in the sandbox's deny list — and a person's non-default dir
// for them would move that pile outside every deny. The same for XDG_CACHE_HOME and CARGO_HOME (#899): a
// non-default cache dir moves huggingface's token out of ~/.cache, a non-default cargo home moves its
// credentials and config out of ~/.cargo. Without them each tool falls back to the default, denied, path.
const BASE_ENV = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'LANG', 'TZ', '__CF_USER_TEXT_ENCODING', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'GOPATH', 'GOROOT', 'GOCACHE', 'RUSTUP_HOME', 'JAVA_HOME', 'NVM_DIR', 'PYENV_ROOT', 'VOLTA_HOME', 'PNPM_HOME', 'BUN_INSTALL']);
const nuworqSetting = (k) => /^NUWORQ_/.test(k) && !/TOKEN|KEY|SECRET|PASS|ACCESS/.test(k);
export function workerEnv(keys = [], env = process.env) {
  const keep = (k) => BASE_ENV.has(k) || /^LC_[A-Z]+$/.test(k) || nuworqSetting(k) || keys.includes(k);
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => keep(k) && !new RegExp(TOKENS.source).test(String(v))));
}

// The project's own variables the person names for workers (#616), e.g. `nuworq run --env DOCKER_HOST,VIRTUAL_ENV`:
// names only, the values come from the runner's environment. One that looks like a secret is refused unless it's
// named with --env-secret, so passing a credential to a worker's agent is a choice, never a slip. env, secret: the
// flags' values (a string, several, or a list).
const SECRETISH = /KEY|TOKEN|SECRET|PASS|CREDENTIAL|AUTH|PRIVATE|SESSION|COOKIE/i;
export function namedEnv(env, secret) {
  const names = (v) => [v ?? []].flat().filter((x) => x !== true).flatMap((x) => String(x).split(/[\s,]+/)).filter(Boolean);
  const plain = names(env), secrets = names(secret);
  const bad = [...plain, ...secrets].find((n) => !/^[A-Za-z_]\w*$/.test(n));
  if (bad) throw Object.assign(new Error(`--env takes variable names, not "${bad}"`), { hint: 'e.g. nuworq run --env DOCKER_HOST,VIRTUAL_ENV: the values come from this shell.' });
  const looks = plain.filter((n) => SECRETISH.test(n));
  if (looks.length) throw Object.assign(new Error(`${looks.join(', ')} looks like a secret, so --env doesn't pass it`), { hint: `A worker's agent could read it and send it wherever it reaches. To pass it anyway: --env-secret ${looks.join(',')}` });
  return [...new Set([...plain, ...secrets])];
}

// What each harness needs from the environment to reach its model, and which of it is secret: the secrets each one
// keeps out of its own shell. Claude Code does with CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 (these four among the names it
// scrubs, checked in 2.1.309), Codex with shell_environment_policy.exclude. opencode and pi have no sandbox and no
// such setting: their shell sees their one model key (#615). proxy: --proxy (Claude Code, Codex: the owner token);
// model: opencode's and pi's <provider>/<model>; codexKey: a custom Codex provider's env_key.
export const CLAUDE_SCRUBS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_OAUTH_TOKEN'];
export function harnessKeys(agent, { proxy = false, model = '', codexKey = null } = {}) {
  if (agent === 'claude') {
    return { secret: [...CLAUDE_SCRUBS, ...(proxy ? ['NUWORQ_LLM_PROXY_TOKEN'] : [])],
      config: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CONFIG_DIR'] };
  }
  if (agent === 'codex') {
    return { secret: [...new Set(['OPENAI_API_KEY', 'CODEX_API_KEY', ...(proxy ? ['NUWORQ_LLM_PROXY_TOKEN'] : []), ...(codexKey ? [codexKey] : [])])],
      config: ['OPENAI_BASE_URL', 'CODEX_HOME'] };
  }
  const provider = String(model).split('/')[0];
  const key = provider === 'proxy' ? ['NUWORQ_LLM_PROXY_KEY'] : provider === 'ollama' || !/^[\w-]+$/.test(provider) ? []
    : [`${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`, ...(provider === 'google' ? ['GEMINI_API_KEY'] : [])];
  return { secret: key, config: ['OLLAMA_URL'] };
}

// ── the folders a runner may work in: the person's choice on this machine (folders.json) ──

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

export function chosenFolders(dir) {
  try {
    const f = JSON.parse(readFileSync(join(dir, 'folders.json'), 'utf8')).folders;
    return Array.isArray(f) ? f.filter((x) => typeof x === 'string' && x.startsWith('/')) : [];
  } catch { return []; }
}

export function chooseFolders(dir, add) {
  const all = [...new Set([...chosenFolders(dir), ...add.map(real)])];
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'folders.json'), `${JSON.stringify({ folders: all }, null, 2)}\n`, { mode: 0o600 });
  return all;
}

// Whether path is one of the chosen folders or inside one.
export function inChosen(path, chosen) {
  if (!path) return false;
  const p = real(path);
  return chosen.some((c) => { const r = real(c); return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep); });
}

// The folders to offer the person: where the runner looks for checkouts (cwd's neighbours, NUWORQ_REPOS), and a
// local project's own folder, each existing and not chosen yet.
export function toOffer(candidates, chosen) {
  return [...new Set(candidates.filter(Boolean).map(real))].filter((p) => existsSync(p) && statSync(p).isDirectory() && !inChosen(p, chosen));
}

// A hub on this machine: only its path remotes may be cloned (a remote hub's would read any folder here).
export const loopback = (url) => { try { return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(url).hostname); } catch { return false; } };
