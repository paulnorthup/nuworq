#!/usr/bin/env node
// Releases are signed on GitHub Actions (#813): .github/workflows/release.yml runs this on each pushed vX.Y.Z tag.
//   node scripts/release.js check <vX.Y.Z> <out dir>
//       the `check` job, unprivileged: refuses a tag that isn't a release (releaseRefusal, in src/package.js), builds
//       its package exactly as the hub does (src/package.js archive) into <out dir>, and shows on the job summary its
//       version, commit, sha256 and changelog entry. It reads the last signed release from this repository's GitHub
//       Releases (GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_TOKEN) and, when NUWORQ_HUB names one, the hub's: a
//       release must be newer than either.
// Agents can change this file, so nothing the approval rests on comes only from it: the workflow's `changes` job
// checks the tag again and says whether this code changed, and `sign` runs none of the repository's code.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { archive, TAG, newer, releaseRefusal, lastOnHub, latest } from '../src/package.js';
import { changelogEntry } from '../src/update.js';

// The rules every signer shares live in the package (src/package.js), so signing by hand (`nuworq release sign`)
// runs them from a signed release.
export { TAG, newer, releaseRefusal, lastOnHub, latest, handCheck } from '../src/package.js';

const git = (repo, args) => new Promise((resolve, reject) => {
  execFile('git', ['-C', repo, ...args], { timeout: 120_000, maxBuffer: 16 << 20 }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(out)));
});
const show = (repo, commit, path) => git(repo, ['show', `${commit}:${path}`]).catch(() => null);
const timeOf = async (repo, commit) => Number((await git(repo, ['log', '-1', '--format=%ct', commit])).trim());

// The newest signed release on GitHub: of the repository's published releases with a nuworq-<commit>.tgz.sig asset,
// the newest version, other than skip (the tag being released). { tag, version, commit, time, where } or null.
// get: fetch.
export async function lastOnGitHub(repo, { api, slug, token, skip, get = fetch }) {
  const r = await get(`${api}/repos/${slug}/releases?per_page=100`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'nuworq-release', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`GitHub's releases of ${slug} answered ${r.status}`);
  let best = null;
  for (const rel of await r.json()) {
    const m = TAG.exec(rel.tag_name ?? '');
    if (!m || rel.draft || rel.tag_name === skip || !(rel.assets ?? []).some((a) => /^nuworq-[0-9a-f]{40}\.tgz\.sig$/.test(a.name))) continue;
    if (best && !newer(m[1], best.version)) continue;
    const commit = (await git(repo, ['rev-parse', `${rel.tag_name}^{commit}`]).catch(() => '')).trim();
    if (commit) best = { tag: rel.tag_name, version: m[1], commit, where: 'the last release signed on GitHub' };
  }
  return best && { ...best, time: await timeOf(repo, best.commit) };
}

// The check job's summary: what the repository's code says of the release.
export function summary({ tag, commit, sha256, changes, last, refusal }) {
  const lines = [`## ${refusal ? 'Not a release' : 'Release'} ${tag}`, ''];
  if (refusal) return [...lines, `${tag} (${commit.slice(0, 7)}) won't be signed: ${refusal}. No one is asked to approve it.`, ''].join('\n');
  lines.push(`Commit: \`${commit}\``, `Package sha256: \`${sha256}\``, '');
  lines.push(last ? `Last signed release: v${last.version ?? '?'} (\`${last.commit.slice(0, 7)}\`)` : 'Last signed release: none found', '');
  lines.push('### What it ships', '', changes || '(no changelog entry)', '');
  return lines.join('\n');
}

async function main([cmd, tag, out], env = process.env) {
  const repo = process.cwd();
  const say = (key, value) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
  if (cmd !== 'check' || !tag || !out) {
    console.error('usage: release.js check <vX.Y.Z> <out dir>');
    process.exitCode = 2;
    return;
  }
  const commit = (await git(repo, ['rev-parse', `${tag}^{commit}`])).trim();
  const slug = env.GITHUB_REPOSITORY;
  const onGitHub = slug ? await lastOnGitHub(repo, { api: env.GITHUB_API_URL || 'https://api.github.com', slug, token: env.GITHUB_TOKEN, skip: tag }) : null;
  const onHub = env.NUWORQ_HUB ? await lastOnHub(repo, env.NUWORQ_HUB) : null;
  const last = latest(onGitHub, onHub);
  // No key here: the tag must pin the key the last signed release pinned (else main's), so one that swaps
  // release-key.pub is refused before anyone is asked. sign verifies against it with the key itself.
  const pub = (await show(repo, last?.commit ?? 'refs/remotes/origin/main', 'release-key.pub')) ?? '';
  const refusal = await releaseRefusal(repo, { tag, commit, main: 'refs/remotes/origin/main', pub, last });
  const write = (text) => { console.log(text); if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`); };
  if (refusal) { write(summary({ tag, commit, refusal })); process.exitCode = 1; return; }
  mkdirSync(out, { recursive: true });
  const file = join(out, `nuworq-${commit}.tgz`);
  await archive(repo, commit, file);
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  const changes = changelogEntry(await show(repo, commit, 'CHANGELOG.md'), TAG.exec(tag)[1], { first: true }) ?? '';
  write(summary({ tag, commit, sha256, changes: changes.trim(), last }));
  say('commit', commit); say('sha256', sha256);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
