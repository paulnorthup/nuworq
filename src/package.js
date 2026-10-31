// nuworq as an npm package of the commit this hub runs, served at /nuworq.tgz, so a machine installs it
// with `npm install -g https://<hub>/nuworq.tgz`: no registry, no account, no access to the repository.
// `git archive` of the hub's own checkout builds it (npm takes a tarball whose files sit under package/),
// with only what runs. Built once per commit, off the request path, and kept under dir.
import { execFile, execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileInTarball, releaseOf } from './update.js';

// release-key.pub: the public half of the key releases are signed with, pinned by every install (src/update.js).
const RUNS = ['bin', 'src', 'web', 'package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'release-key.pub'];

const run = (args) => new Promise((resolve, reject) => {
  execFile('git', args, { timeout: 60_000 }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(out)));
});

// The commit root is checked out at, or null when it isn't a git checkout (installed from a package).
export function commitOf(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

// The release signature for a package (base64 ed25519 over its bytes), made where the release key lives
// (scripts/sign-release.js) and put beside it in dir as <file>.sig. The hub never holds the key. null: unsigned.
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

// Build (or find) the package of root's commit in dir. Resolves { file, sha256, commit }, or null when
// root isn't a git checkout. Never rejects: a failed build resolves null too, and says why on stderr.
export async function buildPackage(root, dir) {
  const commit = commitOf(root);
  if (!commit) return null;
  try {
    const file = join(dir, `nuworq-${commit}.tgz`);
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      const listed = new Set((await run(['-C', root, 'ls-tree', '--name-only', commit])).split('\n'));
      const tmp = `${file}.${process.pid}`;
      rmSync(tmp, { force: true });
      await run(['-C', root, 'archive', '--format=tar.gz', '--prefix=package/', '-o', tmp, commit, '--', ...RUNS.filter((f) => listed.has(f))]);
      renameSync(tmp, file);
    }
    return { file, commit, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
  } catch (e) {
    console.error(`nuworq: couldn't build the package at ${commit.slice(0, 7)} (${e.message}); /nuworq.tgz isn't served`);
    return null;
  }
}
