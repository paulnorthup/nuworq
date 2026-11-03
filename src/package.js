// nuworq as an npm package of the commit this hub runs, served at /nuworq.tgz, so a machine installs it
// with `npm install -g https://<hub>/nuworq.tgz`: no registry, no account, no access to the repository.
// `git archive` of the hub's own checkout builds it (npm takes a tarball whose files sit under package/),
// with only what runs. Built once per commit, off the request path, and kept under dir.
import { execFile, execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileInTarball, releaseOf, versionOf, changelogEntry } from './update.js';

// release-key.pub: the public half of the key releases are signed with, pinned by every install (src/update.js).
const RUNS = ['bin', 'src', 'web', 'package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'release-key.pub'];

const run = (args) => new Promise((resolve, reject) => {
  execFile('git', args, { timeout: 60_000 }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(out)));
});

// Whether root is the top level of a git checkout of its own (#511). An npm install can sit inside someone else's
// repository (/opt/homebrew/lib/node_modules/nuworq is in Homebrew's clone), and git would answer for that one.
export function ownCheckout(root) {
  try {
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return !!top && realpathSync(top) === realpathSync(root);
  } catch { return false; }
}

// The commit root is checked out at, or null when it isn't a git checkout of its own (installed from a package).
export function commitOf(root) {
  if (!ownCheckout(root)) return null;
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

// The release signature for a package (base64 ed25519 over its bytes), made where the release key lives
// (the release workflow, or `nuworq release sign`) and put beside it in dir as <file>.sig. The hub never holds the key. null: unsigned.
export function signatureOf(b) {
  try { return readFileSync(`${b.file}.sig`, 'utf8').trim() || null; } catch { return null; }
}

// A package file's name in dir: nuworq-<full commit>.tgz. Nothing else there is ever served.
export const PACKAGE_NAME = /^nuworq-([0-9a-f]{40})\.tgz$/;

// The package of commit in dir, or null: { file, commit, sha256 }.
export function packageAt(dir, commit) {
  const file = join(dir, `nuworq-${commit}.tgz`);
  if (!PACKAGE_NAME.test(`nuworq-${commit}.tgz`) || !existsSync(file)) return null;
  try { return { file, commit, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }; } catch { return null; }
}

// The newest release in dir: of the packages with a .sig beside it that verifies against key (the release key
// the hub's own checkout pins), the one whose signed commit time is latest. { file, commit, sha256, time }, or
// null. The hub keeps every commit's package, so a release signed while it ran an older commit is still served
// after main moves on. Packages never change once built, so what was read of each is kept in seen.
export function newestSigned(dir, key, seen = new Map()) {
  if (!key) return null;
  let pub, names;
  try { pub = createPublicKey(key); names = readdirSync(dir); } catch { return null; }
  let best = null;
  for (const name of names) {
    const m = name.match(PACKAGE_NAME);
    if (!m) continue;
    const file = join(dir, name);
    const sig = signatureOf({ file });
    if (!sig) continue;
    const id = `${name} ${sig}`;
    if (!seen.has(id)) {
      let r = null;
      try {
        const bytes = readFileSync(file);
        const rel = releaseOf(fileInTarball(bytes, 'src/commit.txt'));
        if (verify(null, bytes, pub, Buffer.from(sig, 'base64')) && rel?.commit === m[1] && rel.time != null) {
          r = { file, commit: m[1], time: rel.time, sha256: createHash('sha256').update(bytes).digest('hex') };
        }
      } catch {}
      seen.set(id, r);
    }
    const r = seen.get(id);
    if (r && (!best || r.time > best.time)) best = r;
  }
  return best;
}

// Write the package of commit in root's repository to file: what the hub serves, and what the release workflow and
// signing by hand (src/releasesign.js) build from GitHub's copy to sign, so all get the same bytes. Rejects when git fails.
export async function archive(root, commit, file) {
  const listed = new Set((await run(['-C', root, 'ls-tree', '--name-only', commit])).split('\n'));
  const tmp = `${file}.${process.pid}`;
  rmSync(tmp, { force: true });
  await run(['-C', root, 'archive', '--format=tar.gz', '--prefix=package/', '-o', tmp, commit, '--', ...RUNS.filter((f) => listed.has(f))]);
  renameSync(tmp, file);
}

// The package of a release the hub never ran (#434): main can move past a release commit before the hub runs it
// (its tests failed there, or main moved twice between checks), and the hub serves a release's signature only beside its own package of it.
// So a commit with a vX.Y.Z tag in root's repository, on the history root runs, is built when asked for, with
// archive() as the running commit's is. Resolves { file, commit, sha256 }, or null when commit is no such release.
const building = new Map();
export async function releasePackage(root, dir, commit) {
  const known = packageAt(dir, commit);
  if (known) return known;
  try {
    const tags = await run(['-C', root, 'tag', '--points-at', commit]);
    if (!tags.split('\n').some((t) => /^v\d+\.\d+\.\d+$/.test(t.trim()))) return null;
    await run(['-C', root, 'merge-base', '--is-ancestor', commit, 'HEAD']);
  } catch { return null; }
  const file = join(dir, `nuworq-${commit}.tgz`);
  if (!building.has(file)) {
    mkdirSync(dir, { recursive: true });
    building.set(file, archive(root, commit, file).finally(() => building.delete(file)));
  }
  try { await building.get(file); } catch (e) {
    console.error(`nuworq: couldn't build the package of release ${commit.slice(0, 7)} (${e.message})`);
    return null;
  }
  return packageAt(dir, commit);
}

// Packages pile up, one per commit the hub ran, and /api/info reads every signed one (#525). Keep the running
// commit's, the newest `releases` signed ones, and anything from the last `graceMs` (a release that may still
// be waiting for its signature); remove the rest, with their signatures. Returns the names removed.
export function prunePackages(dir, current, { releases = 3, graceMs = 24 * 3600_000, now = Date.now() } = {}) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const pkgs = names.filter((n) => PACKAGE_NAME.test(n)).map((name) => {
    const file = join(dir, name);
    let mtime = 0;
    try { mtime = statSync(file).mtimeMs; } catch {}
    return { name, file, mtime, signed: existsSync(`${file}.sig`), commit: name.match(PACKAGE_NAME)[1] };
  });
  const keep = new Set(pkgs.filter((p) => p.signed).sort((a, b) => b.mtime - a.mtime).slice(0, releases).map((p) => p.name));
  const removed = [];
  for (const p of pkgs) {
    if (p.commit === current || keep.has(p.name) || now - p.mtime < graceMs) continue;
    for (const f of [p.file, `${p.file}.sig`]) rmSync(f, { force: true });
    removed.push(p.name);
  }
  return removed;
}

// Build (or find) the package of root's commit in dir. Resolves { file, sha256, commit }, or null when
// root isn't a git checkout. Never rejects: a failed build resolves null too, and says why on stderr.
export async function buildPackage(root, dir) {
  const commit = commitOf(root);
  if (!commit) return null;
  try {
    const file = join(dir, `nuworq-${commit}.tgz`);
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      await archive(root, commit, file);
    }
    prunePackages(dir, commit);
    return { file, commit, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
  } catch (e) {
    console.error(`nuworq: couldn't build the package at ${commit.slice(0, 7)} (${e.message}); /nuworq.tgz isn't served`);
    return null;
  }
}

// The rules every signer shares (#813): the release workflow (scripts/release.js) and signing by hand (`nuworq
// release sign`, src/releasesign.js). Here, in the package, so signing by hand runs them from a signed release.
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

// Why tag at commit mustn't be signed: '' when it may. main: a ref naming origin's main. pub: the release key's
// public half (PEM). last: the newest signed release, { version, commit, time, where } or null; where names it in a refusal.
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

// Signing by hand's checks: origin's tag and main, fetched under a namespace of its own so the checkout's branches
// and tags stay as they are, then the workflow's own rules against the hub's signed release. Never the hub's
// package: the caller builds GitHub's. Resolves { commit, subject, changes, refusal }; refusal is '' when tag may
// be signed. pub: the release key's public half (PEM).
export async function handCheck(repo, { tag, pub, hub, get = fetch }) {
  if (!TAG.test(tag ?? '')) return { refusal: `${tag} isn't a release tag (vX.Y.Z)` };
  const main = 'refs/hand-release/main';
  try {
    await git(repo, ['fetch', '-q', '--no-tags', 'origin', `+refs/heads/main:${main}`, `+refs/tags/${tag}:refs/hand-release/tags/${tag}`]);
  } catch (e) {
    return { refusal: `couldn't fetch origin's main and ${tag} (${e.message.split('\n')[0]}): sign a release only once the hub tagged it, in a checkout of nuworq whose origin is GitHub` };
  }
  const commit = (await git(repo, ['rev-parse', `refs/hand-release/tags/${tag}^{commit}`])).trim();
  const last = await lastOnHub(repo, hub, get);
  const refusal = await releaseRefusal(repo, { tag, commit, main, pub, last });
  const subject = (await git(repo, ['log', '-1', '--format=%s (%cd)', '--date=short', commit])).trim();
  const changes = changelogEntry(await show(repo, commit, 'CHANGELOG.md'), TAG.exec(tag)[1], { first: true }) ?? '';
  return { commit, subject, changes: changes.trim(), refusal };
}
