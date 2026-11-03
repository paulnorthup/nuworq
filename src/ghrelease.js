// Signatures from GitHub Releases (#813): the release workflow (.github/workflows/release.yml) signs each release
// Paul approves and publishes it as the tag's GitHub Release, with nuworq-<commit>.tgz and its .sig as assets. The
// hub takes the .sig from there and serves the release as it served a .sig the Mac signer copied beside its package
// (src/package.js newestSigned): only when it verifies, against the release-key.pub the hub's own checkout pins,
// over the hub's own package of that commit. GitHub's runner may gzip the same archive differently from the hub's
// git; then the hub takes GitHub's package instead of its own, but only when its tar is the hub's byte for byte.
// Nothing here runs fetched code: a package is data the hub serves, and installs check the signature again.
import { execFileSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { PACKAGE_NAME, releasePackage, signatureOf } from './package.js';

export const CHECK_EVERY = 10 * 60_000;

// owner/repo of root's origin on GitHub, or null.
export function githubRepoOf(root) {
  let url = '';
  try { url = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

// The operator's question about a release whose .sig the hub ignored (r: a refused result of takeReleases). Not
// blocking: the hub keeps serving its last good release meanwhile.
export function releaseAlarm(repo, r, web = 'https://github.com') {
  const short = r.commit.slice(0, 7);
  return {
    to: 'operator',
    question: `The GitHub Release ${r.tag} (${short}) has a signature this hub ignores: ${r.reason}`,
    context: 'Installs keep the release they have. A release signed by the workflow should verify over the hub\'s own package of its commit, so this is what a tampered release, or a hub running another release-key.pub, looks like.',
    assumption: 'The hub keeps serving its last good signed release, and installs stay on it, until someone finds out why',
    steps: [
      { do: `Read the release workflow's run for ${r.tag}`, where: `${web}/${repo}/actions/workflows/release.yml`, check: `its check job shows commit ${r.commit} and the package sha256` },
      { do: 'Compare the hub\'s package of that commit with the release asset', where: `on the hub host: sha256sum <data dir>/package/nuworq-${r.commit}.tgz, and the asset at ${web}/${repo}/releases/tag/${r.tag}`, check: 'say which differs and why; don\'t copy a .sig by hand until you know' },
    ],
  };
}

const write = (file, bytes) => { writeFileSync(`${file}.${process.pid}`, bytes); renameSync(`${file}.${process.pid}`, file); };

// One look at GitHub's releases of repo (owner/repo). root: the hub's checkout (releases are built from it, as
// releasePackage builds a release the hub skipped). dir: the package folder. key: release-key.pub (PEM). api:
// GitHub's API. Resolves one result per release with a package: { tag, commit, outcome, reason }, outcome is taken
// (its .sig now sits beside the hub's package), had (it already did), waiting (the hub's checkout lacks the tag), or
// refused (the .sig doesn't verify over the hub's package: ignored, and worth an operator's look). Only the newest
// `newest` releases are looked at, and seen (kept across calls) remembers each signature asset already settled, so
// a release is fetched and built once, not every check.
export async function takeReleases({ root, dir, key, repo, api = 'https://api.github.com', web = 'https://github.com', get = fetch, seen = new Map(), newest = 3 }) {
  if (!key || !repo) return [];
  const pub = createPublicKey(key);
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'nuworq' };
  const r = await get(`${api}/repos/${repo}/releases?per_page=20`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`GitHub's releases of ${repo} answered ${r.status}`);
  // Assets come only from the repository's own release downloads, whatever the answer names.
  const bytesOf = async (url) => {
    if (!String(url).startsWith(`${web}/${repo}/releases/download/`)) throw new Error(`${url} isn't a release download of ${repo}`);
    const a = await get(url, { headers: { 'user-agent': 'nuworq' }, signal: AbortSignal.timeout(120_000) });
    if (!a.ok) throw new Error(`${url} answered ${a.status}`);
    return Buffer.from(await a.arrayBuffer());
  };
  const results = [];
  const releases = (await r.json()).filter((rel) => !rel.draft && /^v\d+\.\d+\.\d+$/.test(rel.tag_name ?? '')).slice(0, newest);
  for (const rel of releases) {
    const assets = rel.assets ?? [];
    const tgz = assets.find((a) => PACKAGE_NAME.test(a.name));
    const sigAsset = tgz && assets.find((a) => a.name === `${tgz.name}.sig`);
    if (!sigAsset) continue;
    const commit = tgz.name.match(PACKAGE_NAME)[1];
    const id = `${commit} ${sigAsset.id ?? sigAsset.browser_download_url}`;
    if (seen.has(id)) { results.push(seen.get(id)); continue; }
    const say = (outcome, reason) => {
      const x = { tag: rel.tag_name, commit, outcome, reason };
      if (outcome !== 'waiting') seen.set(id, { ...x, outcome: outcome === 'refused' ? 'refused' : 'had', reason: outcome === 'refused' ? reason : 'the hub already serves it signed' });
      results.push(x);
    };
    // Built from the hub's checkout, only for a commit with a vX.Y.Z tag on the history it runs.
    const own = await releasePackage(root, dir, commit);
    if (!own) { say('waiting', `the hub's checkout doesn't have ${rel.tag_name} at ${commit.slice(0, 7)} on the history it runs yet`); continue; }
    const sig = (await bytesOf(sigAsset.browser_download_url)).toString('utf8').trim();
    if (signatureOf(own) === sig) { say('had', 'the hub already serves it signed'); continue; }
    const signs = (bytes) => { try { return verify(null, bytes, pub, Buffer.from(sig, 'base64')); } catch { return false; } };
    const ours = readFileSync(own.file);
    if (signs(ours)) {
      writeFileSync(`${own.file}.sig`, `${sig}\n`);
      say('taken', 'its signature verifies over the hub\'s package');
      continue;
    }
    // Another gzip of the same files: take GitHub's package, when its tar is the hub's and the signature is over it.
    const theirs = await bytesOf(tgz.browser_download_url);
    let same = false;
    try { same = gunzipSync(theirs).equals(gunzipSync(ours)); } catch {}
    if (same && signs(theirs)) {
      write(own.file, theirs);
      writeFileSync(`${own.file}.sig`, `${sig}\n`);
      say('taken', 'its signature verifies over GitHub\'s package, whose files are the hub\'s build of it byte for byte');
      continue;
    }
    say('refused', same ? 'its .sig doesn\'t verify against this hub\'s release-key.pub' : `its package isn't the hub's build of ${commit.slice(0, 7)}, so its .sig is ignored`);
  }
  return results;
}
