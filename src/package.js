// nuworq as an npm package of the commit this hub runs, served at /nuworq.tgz, so a machine installs it
// with `npm install -g https://<hub>/nuworq.tgz`: no registry, no account, no access to the repository.
// `git archive` of the hub's own checkout builds it (npm takes a tarball whose files sit under package/),
// with only what runs. Built once per commit, off the request path, and kept under dir.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const RUNS = ['bin', 'src', 'web', 'package.json', 'README.md', 'LICENSE'];

const run = (args) => new Promise((resolve, reject) => {
  execFile('git', args, { timeout: 60_000 }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(out)));
});

// The commit root is checked out at, or null when it isn't a git checkout (installed from a package).
export function commitOf(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
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
