#!/usr/bin/env node
// Releases are signed on GitHub Actions (#813): .github/workflows/release.yml runs this on each pushed vX.Y.Z tag.
//   node scripts/release.js check <vX.Y.Z> <out dir>
//       the `check` job, unprivileged: refuses a tag that isn't a release (releaseRefusal, below), builds its package
//       exactly as the hub does (src/package.js archive) into <out dir>, writes the changelog entry beside it as
//       notes.md, and says on the job summary what Paul approves: the version, commit, changelog entry, and whether
//       the workflow or any file it runs changed since the last signed release.
//   node scripts/release.js sign <vX.Y.Z> <out dir> <sha256>
//       the `sign` job, once Paul approved it in the `release` environment: the same checks with the key's own public
//       half, the same build (it must be <sha256>, what `check` showed), signed with the key in RELEASE_KEY (PEM), and
//       verified against release-key.pub before <out dir>/nuworq-<commit>.tgz.sig is written. The key is never printed.
// Both read the last signed release from this repository's GitHub Releases (GITHUB_API_URL, GITHUB_REPOSITORY,
// GITHUB_TOKEN) and, when NUWORQ_HUB names one, the hub's: a release must be newer than either.
import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { archive } from '../src/package.js';
import { versionOf, changelogEntry } from '../src/update.js';

export const TAG = /^v(\d+\.\d+\.\d+)$/;
export const WORKFLOW = '.github/workflows/release.yml';

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

// What the release workflow runs at commit: its workflow file, this script and every module it imports, followed
// through relative imports. Paths from the repository's root.
export async function filesRun(repo, commit) {
  const seen = new Set([WORKFLOW]);
  const todo = ['scripts/release.js'];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const text = await show(repo, commit, f);
    for (const [, spec] of String(text ?? '').matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)) todo.push(normalize(join(dirname(f), spec)));
  }
  return [...seen].sort();
}

// What changed in those files between the last signed release and commit: the paths, or null with no last release.
export async function runsChanged(repo, last, commit) {
  if (!last) return null;
  const files = await filesRun(repo, commit);
  const out = await git(repo, ['diff', '--name-only', last.commit, commit, '--', ...files]);
  return out.split('\n').filter(Boolean);
}

// The job summary: what Paul reads before he approves.
export function summary({ tag, commit, sha256, changes, last, changed, compare, refusal }) {
  const lines = [`## ${refusal ? 'Not a release' : 'Release'} ${tag}`, ''];
  if (refusal) return [...lines, `${tag} (${commit.slice(0, 7)}) won't be signed: ${refusal}. No one is asked to approve it.`, ''].join('\n');
  lines.push(`Commit: \`${commit}\``, `Package sha256: \`${sha256}\``, '');
  lines.push(last ? `Last signed release: v${last.version ?? '?'} (\`${last.commit.slice(0, 7)}\`)` : 'Last signed release: none found', '');
  if (changed == null) lines.push('**The release workflow and the code it runs:** no signed release to compare with, so read them at this commit.');
  else if (!changed.length) lines.push(`**The release workflow and the code it runs are unchanged** since v${last.version ?? last.commit.slice(0, 7)}.`);
  else lines.push(`**The release workflow or the code it runs changed** since v${last.version ?? last.commit.slice(0, 7)}: ${changed.map((f) => `\`${f}\``).join(', ')}. [Read the diff](${compare}) before you approve: this run signs with the code at ${tag}.`);
  lines.push('', '### What it ships', '', changes || '(no changelog entry)', '', 'Approve the `sign` job (Review deployments → release) to sign it, publish this GitHub Release and move the `release` branch. To not ship it, reject it or do nothing.', '');
  return lines.join('\n');
}

// Everything check and sign share: the tag's commit, the last signed release, and the refusal against the key
// pubOf(last) names.
async function prepare(repo, tag, pubOf, env) {
  const commit = (await git(repo, ['rev-parse', `${tag}^{commit}`])).trim();
  const slug = env.GITHUB_REPOSITORY;
  const onGitHub = slug ? await lastOnGitHub(repo, { api: env.GITHUB_API_URL || 'https://api.github.com', slug, token: env.GITHUB_TOKEN, skip: tag }) : null;
  const onHub = env.NUWORQ_HUB ? await lastOnHub(repo, env.NUWORQ_HUB) : null;
  const last = latest(onGitHub, onHub);
  const refusal = await releaseRefusal(repo, { tag, commit, main: 'refs/remotes/origin/main', pub: await pubOf(last), last });
  return { commit, last, refusal, slug };
}

async function build(repo, commit, out) {
  mkdirSync(out, { recursive: true });
  const file = join(out, `nuworq-${commit}.tgz`);
  await archive(repo, commit, file);
  const bytes = readFileSync(file);
  return { file, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function main([cmd, tag, out, want], env = process.env) {
  const repo = process.cwd();
  const say = (key, value) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
  if (cmd === 'check' && tag && out) {
    // No key here: the tag must pin the key the last signed release pinned (else main's), so one that swaps
    // release-key.pub is refused before anyone is asked. sign checks it again against the key itself.
    const pinned = async (last) => (await show(repo, last?.commit ?? 'refs/remotes/origin/main', 'release-key.pub')) ?? '';
    const { commit, last, slug, refusal } = await prepare(repo, tag, pinned, env);
    const write = (text) => { console.log(text); if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`); };
    if (refusal) { write(summary({ tag, commit, refusal })); process.exitCode = 1; return; }
    const { sha256 } = await build(repo, commit, out);
    const version = TAG.exec(tag)[1];
    const changes = changelogEntry(await show(repo, commit, 'CHANGELOG.md'), version, { first: true }) ?? '';
    writeFileSync(join(out, 'notes.md'), `${changes.trim()}\n`);
    const changed = await runsChanged(repo, last, commit);
    const compare = last && slug ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${slug}/compare/${last.commit}...${commit}` : '';
    write(summary({ tag, commit, sha256, changes: changes.trim(), last, changed, compare }));
    say('version', version); say('commit', commit); say('sha256', sha256);
  } else if (cmd === 'sign' && tag && out && want) {
    if (!env.RELEASE_KEY) throw new Error('RELEASE_KEY is empty: the `release` environment has no release key secret');
    const key = createPrivateKey(env.RELEASE_KEY);
    const pub = createPublicKey(key).export({ type: 'spki', format: 'pem' });
    const { commit, refusal } = await prepare(repo, tag, async () => pub, env);
    if (refusal) throw new Error(`not signed: ${refusal}`);
    const { file, bytes, sha256 } = await build(repo, commit, out);
    if (sha256 !== want) throw new Error(`not signed: this build of ${commit.slice(0, 7)} is sha256 ${sha256}, not ${want} as the check job showed`);
    const sig = sign(null, bytes, key);
    const pinnedPub = createPublicKey((await show(repo, commit, 'release-key.pub')) ?? '');
    if (!verify(null, bytes, pinnedPub, sig)) throw new Error('not signed: the signature doesn\'t verify against release-key.pub');
    writeFileSync(`${file}.sig`, `${sig.toString('base64')}\n`);
    console.log(`Signed ${tag} (${commit.slice(0, 7)}, sha256 ${sha256}): ${file}.sig verifies against release-key.pub`);
  } else {
    console.error('usage: release.js check <vX.Y.Z> <out dir> | sign <vX.Y.Z> <out dir> <sha256>');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
