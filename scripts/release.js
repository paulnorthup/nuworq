#!/usr/bin/env node
// Releases are signed on GitHub Actions (#813): .github/workflows/release.yml runs this on each pushed vX.Y.Z tag.
//   node scripts/release.js check <vX.Y.Z> <out dir>
//       the `check` job, unprivileged: refuses a tag that isn't a release (releaseRefusal, below), builds its package
//       exactly as the hub does (src/package.js archive) into <out dir>, and shows on the job summary its version,
//       commit, sha256 and changelog entry. It reads the last signed release from this repository's GitHub Releases
//       (GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_TOKEN) and, when NUWORQ_HUB names one, the hub's: a release must be
//       newer than either.
// Agents can change this file, so nothing the approval rests on comes only from it: the workflow's `changes` job
// checks the tag again and says whether this code changed, and `sign` runs none of the repository's code.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { archive } from '../src/package.js';
import { versionOf, changelogEntry } from '../src/update.js';

export const TAG = /^v(\d+\.\d+\.\d+)$/;

const git = (repo, args) => new Promise((resolve, reject) => {
  execFile('git', ['-C', repo, ...args], { timeout: 120_000, maxBuffer: 16 << 20 }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(out)));
});
const show = (repo, commit, path) => git(repo, ['show', `${commit}:${path}`]).catch(() => null);
const timeOf = async (repo, commit) => Number((await git(repo, ['log', '-1', '--format=%ct', commit])).trim());

// a > b, as X.Y.Z versions.
export const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

// Why tag at commit mustn't be signed: '' when it may. The one set of rules for every signer: the Mac signer
// (scripts/signer.js) and the release workflow. main: a ref naming origin's main. pub: the release key's public
// half (PEM). last: the newest signed release, { version, commit, time, where } or null; where names it in a refusal.
export async function releaseRefusal(repo, { tag, commit, main, pub, last = null }) {
  const m = TAG.exec(tag ?? '');
  if (!m) return `${tag} isn't a release tag (vX.Y.Z)`;
  const version = m[1];
  const short = commit.slice(0, 7);
  if (last) {
    const time = await timeOf(repo, commit);
    if (time <= last.time || (last.version && !newer(version, last.version))) {
      return `older than ${last.where ?? 'the last signed release'}${last.version ? ` v${last.version}` : ''} (${last.commit.slice(0, 7)}), and signing it would roll installs back`;
    }
  }
  if (!(await git(repo, ['merge-base', '--is-ancestor', commit, main]).then(() => true, () => false))) return `${short} isn't on origin's main`;
  const said = versionOf(await show(repo, commit, 'package.json'));
  if (said !== version) return `its package.json says ${said ?? 'no version'}, not ${version}`;
  if (changelogEntry(await show(repo, commit, 'CHANGELOG.md'), version, { first: true }) == null) return `its CHANGELOG.md doesn't begin with ${version} (a "## ${version}" heading first)`;
  if ((await show(repo, commit, 'release-key.pub'))?.trim() !== String(pub ?? '').trim()) return 'its release-key.pub isn\'t this key\'s public half, so installs pinning it would refuse the signature';
  return '';
}

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

// The hub's signed release, as /api/package names it: { version, commit, time, where } or null.
export async function lastOnHub(repo, hub, get = fetch) {
  const r = await get(`${new URL(hub).origin}/api/package`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${hub} answered ${r.status}`);
  const rel = (await r.json()).package?.release;
  if (!rel?.commit) return null;
  await git(repo, ['cat-file', '-e', `${rel.commit}^{commit}`]).catch(() => { throw new Error(`the hub's signed release ${rel.commit.slice(0, 7)} isn't in this repository`); });
  return { version: versionOf(await show(repo, rel.commit, 'package.json')), commit: rel.commit, time: rel.time ?? await timeOf(repo, rel.commit), where: 'the hub\'s signed release' };
}

// The newer of two signed releases (either may be null).
export const latest = (a, b) => (!a ? b : !b ? a : (b.version && a.version ? newer(b.version, a.version) : b.time > a.time) ? b : a);

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
