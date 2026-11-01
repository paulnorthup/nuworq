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
export const redact = (s) => String(s ?? '').replace(TOKENS, '$1_[redacted]');

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
  const out = Object.entries(env).filter(([k]) => !/^(NUWORQ|TRELLIS)_(AGENT_)?TOKEN$/.test(k));
  const holds = ([, v]) => new RegExp(TOKENS.source).test(String(v));
  const gitConfig = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;
  const dropGit = out.some((e) => gitConfig.test(e[0]) && holds(e));
  return Object.fromEntries(out.filter((e) => !holds(e) && !(dropGit && gitConfig.test(e[0]))));
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
