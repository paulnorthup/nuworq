#!/usr/bin/env node
// Before a repository goes public: every line any commit on any ref ever added, checked for secrets.
//   node scripts/scan-history.js [repo]     (default: this folder)
// It says where each one is (commit, file, what it looks like), never the secret, and exits 1 when it finds
// any. A secret found here is in the history for good: rotate it first, then decide whether to rewrite.
// The shapes are the hub's own (src/secrets.js) plus the secrets a nuworq deployment holds (docs/DEPLOY.md).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { SHAPES } from '../src/secrets.js';

export const DEPLOY_SHAPES = [
  ['a Stripe webhook secret', /\bwhsec_[A-Za-z0-9]{24,}/],
  ['a Stripe live key', /\b[sr]k_live_[A-Za-z0-9]{20,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a Google OAuth client secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
  ['a Turnstile secret', /\b0x4AAAAAAA[A-Za-z0-9_-]{20,}/],
  ['Cloudflare tunnel credentials', /"TunnelSecret"\s*:\s*"/],
  ['a GitHub OAuth client secret', /CLIENT_SECRET\s*=\s*["']?[0-9a-f]{40}\b/],
];

// Fakes in nuworq's own tests that look real on purpose: exact (file, text) pairs, so a real secret in
// the same file still counts. Assembled here, so this file doesn't hold them whole and the scan of its
// own history stays clean.
const FAKES = [
  ['test/feedback.test.js', 'ghp' + '_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['test/secrets.test.js', "'a private key': '-----BEGIN OPENSSH " + "PRIVATE KEY-----\\nb3BlbnNzaC1rZXktdjEAAAAA\\n"],
];

// What one added line holds, or null.
export function secretIn(file, line) {
  for (const [kind, re] of [...SHAPES, ...DEPLOY_SHAPES]) {
    const m = line.match(re);
    if (!m) continue;
    if (FAKES.some(([f, text]) => f === file && line.includes(text) && text.includes(m[0]))) continue;
    return kind;
  }
  return null;
}

// Every hit as { commit, file, kind }, once per commit, file and kind.
export async function scan(repo) {
  const git = spawn('git', ['-C', repo, 'log', '--all', '-p', '--no-color', '--no-ext-diff', '--format=commit %H'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const hits = new Map();
  let commit = '', file = '', lines = 0;
  for await (const line of createInterface({ input: git.stdout, crlfDelay: Infinity })) {
    if (line.startsWith('commit ')) { commit = line.slice(7, 19); continue; }
    if (line.startsWith('+++ ')) { file = line.replace(/^\+\+\+ (b\/)?/, ''); continue; }
    if (!line.startsWith('+')) continue;
    lines++;
    const kind = secretIn(file, line.slice(1));
    if (kind) hits.set(`${commit}\0${file}\0${kind}`, { commit, file, kind });
  }
  const code = await new Promise((done) => git.on('close', done));
  if (code !== 0) throw new Error(`git log failed in ${repo} (exit ${code})`);
  return { hits: [...hits.values()], lines };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repo = resolve(process.argv[2] ?? '.');
  const { hits, lines } = await scan(repo);
  for (const h of hits) console.log(`${h.commit}  ${h.file}: ${h.kind}`);
  console.log(hits.length ? `${hits.length} possible secret(s) in the history of ${repo}: rotate each, then decide whether to rewrite history.` : `No secrets in ${lines} added lines across every ref of ${repo}.`);
  process.exitCode = hits.length ? 1 : 0;
}
