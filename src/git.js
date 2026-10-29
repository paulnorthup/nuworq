// What git says about a submission: the worker's branch, its commits, and whether commits named in
// the evidence exist. Shells out to git with short timeouts; any failure means "no git facts".
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const MAX_COMMITS = 20;
const HASH = /\b[0-9a-f]{7,40}\b/g;

function git(repo, ...args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}
const exists = (repo, ref) => git(repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`) !== null;

// Hash-looking words that claim a commit: in evidence labels when they mix digits and letters (so
// "1234567" or "acceded" aren't mistaken for one), and in prose only right after "commit".
export function claimedHashes({ evidence = [], headline = '', summary = '' }) {
  const out = new Set();
  const mixed = (h) => /\d/.test(h) && /[a-f]/.test(h);
  for (const e of evidence) for (const h of `${e.label ?? ''} ${e.url ?? ''}`.match(HASH) ?? []) if (mixed(h)) out.add(h);
  for (const m of `${headline}\n${summary}`.matchAll(/\bcommit(?:ted)?(?: as| at)?:?\s+`?([0-9a-f]{7,40})\b/gi)) out.add(m[1].toLowerCase());
  return [...out];
}

export const isRepo = (repo) => !!repo && existsSync(join(repo, '.git')) && git(repo, 'rev-parse', '--git-dir') !== null;
export const baseOf = (repo) => ['main', 'master'].find((b) => exists(repo, b)) ?? null;
export const branchExists = exists;
export const headOf = (repo, ref) => git(repo, 'rev-parse', '--short', ref);
// Does `into` already contain every commit of `ref`?
export const contains = (repo, into, ref) => git(repo, 'merge-base', '--is-ancestor', ref, into) !== null;
const count = (repo, range) => Number(git(repo, 'rev-list', '--count', range) ?? 0);

// Each item is built on its own branch, cut from the latest main, so it can land on its own.
export function itemBranch(item) {
  const words = String(item.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const short = words.length > 40 ? words.slice(0, 40).replace(/-[^-]*$/, '') : words;
  return `nuworq/${item.seq}-${short || 'work'}`;
}

// repo: the project's main checkout. agent: the submitter. own: the item's branch, if it has one.
// Returns null when there is no repo to ask.
export function gitFacts(repo, agent, claim, own = '') {
  if (!isRepo(repo)) return null;
  const base = baseOf(repo);
  const text = [claim.headline, claim.summary, ...(claim.evidence ?? []).map((e) => e.label)].join(' ');
  // The item's own branch first; then worker branches, nuworq/<agent> (or trellis/<agent> from before the rename).
  const named = text.match(/\b(?:nuworq|trellis)\/[\w.@-]+/)?.[0];
  const branch = [own, `nuworq/${agent}`, `trellis/${agent}`, named].find((b) => b && exists(repo, b)) ?? null;
  const commits = branch && base
    ? (git(repo, 'log', '--format=%h%x09%s', '-n', String(MAX_COMMITS), `${base}..${branch}`) ?? '')
      .split('\n').filter(Boolean).map((l) => { const [hash, ...s] = l.split('\t'); return { hash, subject: s.join('\t') }; })
    : [];
  const behind = branch && base ? count(repo, `${branch}..${base}`) : 0;
  const missing = claimedHashes(claim).filter((h) => !exists(repo, h));
  return { branch, base, commits, behind, missing };
}

// One line for the human, or null when git has nothing to worry about.
export function gitWarning(g) {
  if (!g) return null;
  if (g.missing.length) return `Evidence names commit ${g.missing.join(', ')}, which isn't in the repo`;
  if (g.branch && g.base && !g.commits.length) return `No commits on ${g.branch} ahead of ${g.base}`;
  if (g.behind) return `${g.branch} is ${g.behind} commit(s) behind ${g.base}; rebase onto ${g.base} so the review sees what will land`;
  return null;
}
