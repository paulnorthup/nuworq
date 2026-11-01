#!/usr/bin/env node
// Before a repository goes public: everything any ref ever held, checked for secrets.
//   node scripts/scan-history.js [repo]     (default: this folder's origin, e.g. git@github.com:paulnorthup/nuworq.git)
// It makes a fresh --mirror clone of the repo (a URL or a folder), so every ref counts, refs/pull/* included,
// which `git fetch origin` never brings. Then it reads every line each commit added (merges against each
// parent, -m), every commit and tag message, and the name of every file ever added, binary ones too.
// It says where each hit is (commit, file, what it looks like), never the secret, and exits 1 when it finds
// any. A secret found here is in the history for good: rotate it first, then decide whether to rewrite.
// The shapes are the hub's own (src/secrets.js), the secrets a nuworq deployment holds (docs/DEPLOY.md),
// file names that hold keys, and long random-looking strings (highEntropy).
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, join, resolve } from 'node:path';
import { SHAPES } from '../src/secrets.js';

export const DEPLOY_SHAPES = [
  ['a Stripe webhook secret', /\bwhsec_[A-Za-z0-9]{24,}/],
  ['a Stripe key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a Google OAuth client secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
  ['a Turnstile secret', /\b0x4AAAAAAA[A-Za-z0-9_-]{20,}/],
  ['Cloudflare tunnel credentials', /"TunnelSecret"\s*:\s*"/],
  ['a Cloudflare API token', /\b(?:CLOUDFLARE|CF)_API_TOKEN\s*[=:]\s*["']?[A-Za-z0-9_-]{40}\b/],
  ['a GitHub OAuth client secret', /CLIENT_SECRET\s*=\s*["']?[0-9a-f]{40}\b/],
  ['a secret in an environment line', /\b[A-Z][A-Z0-9_]*_SECRET\s*=\s*["']?[A-Za-z0-9_+/.=-]{16,}/],
  // A JWT, or a cloudflared tunnel token (base64 JSON, so it starts eyJ too).
  ['a JWT or tunnel token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|\beyJhIjoi[A-Za-z0-9+/=]{40,}/],
  ['an npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
];

// Files that hold keys or environments whatever is in them (an example env file is fine).
export const NAME_SHAPES = [
  ['an environment file', /^\.env(?:\.(?!example$|sample$|template$)[\w.-]+)?$/],
  ['a key file', /\.(?:pem|key|p12|pfx|jks)$|^id_(?:rsa|dsa|ecdsa|ed25519)$/],
];

// Fakes in nuworq's own tests that look real on purpose: exact (file, text) pairs, so a real secret in
// the same file still counts. Assembled here, so this file doesn't hold them whole and the scan of its
// own history stays clean.
const FAKES = [
  ['test/feedback.test.js', 'ghp' + '_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['test/secrets.test.js', "'a private key': '-----BEGIN OPENSSH " + "PRIVATE KEY-----\\nb3BlbnNzaC1rZXktdjEAAAAA\\n"],
];

// A long string that looks random: 32+ characters of letters, digits and base64 punctuation, with upper
// and lower case and digits, at more than 4.5 bits a character. Hex (commit ids, hashes) never gets there.
const CANDIDATE = /[A-Za-z0-9+/_=-]{32,}/g;
const bits = (s) => {
  const n = new Map();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) h -= (k / s.length) * Math.log2(k / s.length);
  return h;
};
// An alphabet ("ABCDEFGH…"), as test helpers spell out the characters they draw from: no key has one.
const counting = (s) => {
  let run = 1;
  for (let i = 1; i < s.length; i++) if ((run = s.charCodeAt(i) === s.charCodeAt(i - 1) + 1 ? run + 1 : 1) >= 8) return true;
  return false;
};
export function highEntropy(line) {
  if (line.includes('data:image/')) return null; // inline images are base64 by design
  for (const m of line.matchAll(CANDIDATE)) {
    const s = m[0];
    if (s.length > 200 || !/[A-Z]/.test(s) || !/[a-z]/.test(s) || !/[0-9]/.test(s)) continue;
    if (/^[A-Za-z]+(?:[-_/][A-Za-z0-9]+)+$/.test(s)) continue; // a path or kebab-case name, not a key
    if (/SHA(?:256|512):$|sha(?:256|384|512)-$/.test(line.slice(0, m.index))) continue; // a fingerprint or integrity hash
    if (counting(s)) continue;
    if (bits(s) > 4.5) return s;
  }
  return null;
}

// What one added line holds, or null.
export function secretIn(file, line) {
  for (const [kind, re] of [...SHAPES, ...DEPLOY_SHAPES]) {
    const m = line.match(re);
    if (!m) continue;
    if (FAKES.some(([f, text]) => f === file && line.includes(text) && text.includes(m[0]))) continue;
    return kind;
  }
  const s = !file.endsWith('.pub') && highEntropy(line); // public keys are meant to be read
  if (s && !FAKES.some(([f, text]) => f === file && text.includes(s))) return 'a high-entropy string';
  return null;
}

// What a file's name says it holds, or null.
export function nameIn(file) {
  const name = basename(file);
  return NAME_SHAPES.find(([, re]) => re.test(name))?.[0] ?? null;
}

const lines = (repo, args) => {
  const git = spawn('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  const done = new Promise((ok) => git.on('close', ok)).then((code) => { if (code !== 0) throw new Error(`git ${args[0]} failed in ${repo} (exit ${code})`); });
  return { rl: createInterface({ input: git.stdout, crlfDelay: Infinity }), done };
};

// Every hit in a repository as it stands (scan it in a mirror clone: see scanMirror), as { commit, file,
// kind }, once per commit, file and kind. file is "(message)" or "(tag <name>)" for messages.
export async function scan(repo) {
  const hits = new Map();
  const hit = (commit, file, kind) => hits.set(`${commit}\0${file}\0${kind}`, { commit, file, kind });
  let added = 0;
  // Every line every commit added, merges against each parent, and the name of every file added or renamed.
  const diff = lines(repo, ['log', '--all', '-m', '-p', '--no-color', '--no-ext-diff', '--no-renames', '--format=commit %H']);
  let commit = '', file = '';
  for await (const line of diff.rl) {
    if (line.startsWith('commit ')) { commit = line.slice(7, 19); continue; }
    if (line.startsWith('diff --git ')) { file = line.match(/ b\/(.*)$/)?.[1] ?? ''; continue; }
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('new file mode')) { // text or binary, and renames (--no-renames)
      const kind = nameIn(file);
      if (kind) hit(commit, file, kind);
      continue;
    }
    if (!line.startsWith('+')) continue;
    added++;
    const kind = secretIn(file, line.slice(1));
    if (kind) hit(commit, file, kind);
  }
  await diff.done;
  // Every commit message, and every annotated tag's.
  const RS = '\x1e';
  for (const [args, where] of [
    [['log', '--all', `--format=${RS}%H%n%B`], (id) => ['(message)', id.slice(0, 12)]],
    [['for-each-ref', 'refs/tags', `--format=${RS}%(refname:short)%0a%(contents)`], (id) => [`(tag ${id})`, id]],
  ]) {
    const msg = lines(repo, args);
    let id = '';
    for await (const line of msg.rl) {
      if (line.startsWith(RS)) { id = line.slice(1); continue; }
      const kind = secretIn('', line);
      if (kind) { const [f, c] = where(id); hit(c, f, kind); }
    }
    await msg.done;
  }
  return { hits: [...hits.values()], lines: added };
}

// A fresh --mirror clone of source (a URL or a folder), scanned, then removed. refs: how many it read.
export async function scanMirror(source) {
  const dir = mkdtempSync(join(tmpdir(), 'nuworq-scan-'));
  try {
    execFileSync('git', ['clone', '--quiet', '--mirror', source, join(dir, 'repo.git')], { stdio: ['ignore', 'ignore', 'inherit'] });
    const refs = execFileSync('git', ['-C', join(dir, 'repo.git'), 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    return { ...(await scan(join(dir, 'repo.git'))), refs: refs.length, pulls: refs.filter((r) => r.startsWith('refs/pull/')).length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let source = process.argv[2];
  if (!source) {
    try { source = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { source = resolve('.'); }
  }
  const { hits, lines: n, refs, pulls } = await scanMirror(source);
  for (const h of hits) console.log(`${h.commit}  ${h.file}: ${h.kind}`);
  console.log(hits.length
    ? `${hits.length} possible secret(s) in the history of ${source}: rotate each, then decide whether to rewrite history.`
    : `No secrets in ${n} added lines, the messages and file names of ${refs} refs (${pulls} pull request refs) of ${source}.`);
  process.exitCode = hits.length ? 1 : 0;
}
