// The package updates itself from the hub, but only to a version signed by the release key whose public
// half shipped in the installed package (release-key.pub). The hub's sha256 only proves the download isn't
// corrupted; the signature is what stops a compromised hub, tunnel or DNS from shipping code. Anything that
// doesn't verify keeps the current version and says why in plain words.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const CHECK_EVERY = 10 * 60_000;
const LOCK_STALE = 10 * 60_000;
const TIMEOUT_MS = 5_000;

// What a package says it was built from, in src/commit.txt (git archive fills it in, export-subst): the commit
// and its committer time (unix seconds). Inside a signed package the time is signed too, so it orders releases:
// an update must be newer than what runs. { commit, time } (time null in packages from before it), or null
// in a checkout (the placeholder is still there).
export function releaseOf(text) {
  const [commit, time] = String(text ?? '').trim().split(/\s+/);
  if (!/^[0-9a-f]{7,40}$/.test(commit ?? '')) return null;
  return { commit, time: /^\d+$/.test(time ?? '') ? Number(time) : null };
}
const running = (root) => { try { return releaseOf(readFileSync(join(root, 'src', 'commit.txt'), 'utf8')); } catch { return null; } };

// The commit an installed package was built from, or null.
export const runningCommit = (root) => running(root)?.commit ?? null;

const pinnedKey = (root) => {
  try { return readFileSync(join(root, 'release-key.pub'), 'utf8').trim(); } catch { return null; }
};
const loopback = (host) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);

// Why updating is off here, or null when it's on.
export function offReason({ root, hub, env = process.env }) {
  if (env.NUWORQ_NO_UPDATE === '1') return 'NUWORQ_NO_UPDATE=1 is set';
  if (existsSync(join(root, '.git'))) return `nuworq runs from a git checkout (${root}); update it with git`;
  if (!pinnedKey(root)) return 'this install has no pinned release key (release-key.pub), so it can\'t tell a real release from a forged one';
  let url;
  try { url = new URL(hub); } catch { return `the hub address "${hub}" isn't a URL`; }
  if (url.protocol !== 'https:' && !loopback(url.hostname)) return `the hub (${url.origin}) isn't https, and isn't on this machine`;
  return null;
}

// The one file inside a package tarball (npm's layout: package/<path>), or null.
export function fileInTarball(tgz, path) {
  const tar = gunzipSync(tgz);
  const want = `package/${path}`;
  for (let at = 0; at + 512 <= tar.length;) {
    const head = tar.subarray(at, at + 512);
    if (head.every((b) => b === 0)) break;
    const field = (from, len) => head.subarray(from, from + len).toString('utf8').replace(/\0.*$/s, '');
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    if (name === want && type === '0') return tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

// The version a package.json says (#400), or null.
export function versionOf(text) {
  let v = '';
  try { v = String(JSON.parse(String(text ?? '')).version ?? ''); } catch {}
  return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
}

// A release's entry in CHANGELOG.md (#400): the lines under its "## X.Y.Z" heading (a "v" and a date after it
// are fine), up to the next one. first: only when it is the first entry, as a release's own CHANGELOG has it.
// null when there is none.
const ENTRY = /^## v?(\d+\.\d+\.\d+)\b/;
export function changelogEntry(text, version, { first = false } = {}) {
  const lines = String(text ?? '').split('\n');
  const heads = lines.flatMap((l, i) => (ENTRY.test(l) ? [i] : []));
  const at = first ? heads.slice(0, 1).find((i) => ENTRY.exec(lines[i])[1] === version) : heads.find((i) => ENTRY.exec(lines[i])[1] === version);
  if (at == null) return null;
  const end = heads.find((i) => i > at) ?? lines.length;
  return lines.slice(at + 1, end).join('\n').trim();
}

// What a package says of its own version: { version, changes } (changes: its CHANGELOG entry as lines, for a
// terminal), from the tarball. Either may be null.
function versionIn(tgz) {
  let version = null, entry = null;
  try { version = versionOf(fileInTarball(tgz, 'package.json')); } catch {}
  try { entry = version && changelogEntry(fileInTarball(tgz, 'CHANGELOG.md'), version); } catch {}
  const changes = entry ? entry.split('\n').map((l) => l.replace(/\*\*(.+?)\*\*/g, '$1').trimEnd()).filter(Boolean) : null;
  return { version, changes };
}
const installedVersion = (root) => { try { return versionOf(readFileSync(join(root, 'package.json'), 'utf8')); } catch { return null; } };

const readState = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
const writeState = (file, s) => { try { writeFileSync(file, JSON.stringify(s)); } catch {} };

// One install at a time on this machine (parallel workers all start the CLI). A lock left by a crash
// stops counting after LOCK_STALE.
function lock(file, now) {
  try {
    if (existsSync(file) && now - statSync(file).mtimeMs > LOCK_STALE) rmSync(file, { force: true });
    closeSync(openSync(file, 'wx'));
    return () => rmSync(file, { force: true });
  } catch { return null; }
}

const npmInstall = (file) => new Promise((resolve) => {
  execFile('npm', ['install', '-g', file], { timeout: 120_000 }, (e, _out, err) => resolve(e ? String(err || e.message).trim().split('\n').pop() : null));
});

// Check the hub for a new version and install it if, and only if, it verifies. Never throws.
// Resolves { status, reason?, from?, to?, command? }: status is updated | current | off | skipped |
// unreachable | refused | failed. force: check now, however recently it last did (`nuworq update`).
// install(file): resolves null, or why it failed (injected by tests; npm install -g by default).
export async function update({ root, hub, dir, env = process.env, force = false, fetch: get = fetch, install = npmInstall, now = Date.now(), timeoutMs = TIMEOUT_MS }) {
  const off = offReason({ root, hub, env });
  if (off) return { status: 'off', reason: off };
  mkdirSync(dir, { recursive: true });
  const stateFile = join(dir, 'update.json');
  const state = readState(stateFile);
  if (!force && state.checked_at && now - state.checked_at < CHECK_EVERY) return { status: 'skipped', reason: 'checked in the last 10 minutes' };
  // Before asking: offline, a check every run would be a wait every run.
  writeState(stateFile, { ...state, checked_at: now });

  // The package lives at the hub's root, whichever workspace (/w/<slug>) this machine connected to.
  const base = new URL(hub).origin;
  const from = runningCommit(root);
  const ask = async (path) => {
    const res = await get(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
  };
  let pkg;
  try {
    // /api/package is public (#224). Hubs from before it name their package only in /api/info.
    let info = await ask('/api/package');
    if (info.status === 404) info = await ask('/api/info');
    if (info.status !== 200) return { status: 'unreachable', reason: `the hub at ${base} answered ${info.status} when asked which version it serves; carrying on with the installed version`, from };
    pkg = JSON.parse(info.body).package;
  } catch (e) {
    return { status: 'unreachable', reason: `the hub at ${base} didn't answer (${e.cause?.code ?? e.name}); carrying on with the installed version` };
  }
  if (!pkg?.commit || !pkg.sha256) return { status: 'current', reason: 'the hub serves no package of itself', from };
  // The newest signed release the hub keeps (#254), served by its commit, whichever commit the hub runs now.
  // A hub from before that names only the package of the commit it runs.
  const named = pkg.release?.commit && pkg.release.sha256 ? pkg.release : null;
  const to = String(named ? named.commit : pkg.commit);
  if (!/^[0-9a-f]{7,40}$/.test(to) || (named && to.length !== 40)) return { status: 'refused', reason: `the hub names its version "${to.slice(0, 40)}", which isn't a commit. Kept the installed version.`, from };
  if (from && (from.startsWith(to) || to.startsWith(from))) return { status: 'current', from };
  // With no signed release named, the running package isn't one until someone signs it (docs/DEPLOY.md, "Signed
  // releases"): nothing to fetch, nothing to say.
  if (!named && pkg.signed === false) return { status: 'current', reason: `the hub's ${to.slice(0, 7)} isn't a signed release yet`, from, to };
  // What the hub says of the release's time only saves a download; the signed package's own time decides.
  const mine = running(root);
  if (named && mine?.time != null && Number.isInteger(named.time) && named.time <= mine.time) return { status: 'current', reason: `the newest signed release, ${to.slice(0, 7)}, isn't newer`, from };
  const [tgzPath, sha256] = named ? [`/nuworq-${to}.tgz`, named.sha256] : ['/nuworq.tgz', pkg.sha256];

  const unlock = lock(join(dir, 'update.lock'), now);
  if (!unlock) return { status: 'skipped', reason: 'another nuworq on this machine is updating it now' };
  const refused = (reason) => ({ status: 'refused', reason: `${reason}. Kept the installed version.`, from, to });
  try {
    // Someone else installed it while this one was asking.
    if (readState(stateFile).installed === to) return { status: 'current', from, to };
    let tgz, sig;
    try {
      tgz = await ask(tgzPath);
      sig = await ask(`${tgzPath}.sig`);
    } catch (e) {
      return { status: 'unreachable', reason: `the download from ${base} broke off (${e.cause?.code ?? e.name}); carrying on with the installed version` };
    }
    if (tgz.status !== 200) return refused(`the hub answered ${tgz.status} for ${tgzPath}`);
    if (sig.status !== 200) return refused(`the hub serves no signature for ${to} (${tgzPath}.sig answered ${sig.status}), so it isn't a signed release`);
    if (createHash('sha256').update(tgz.body).digest('hex') !== sha256) return refused('the download doesn\'t match the sha256 the hub gave: it was changed or cut short on the way');
    const pinned = pinnedKey(root);
    let ok = false;
    try { ok = verify(null, tgz.body, createPublicKey(pinned), Buffer.from(sig.body.toString('utf8').trim(), 'base64')); } catch {}
    if (!ok) return refused(`the signature on ${to} isn't from the release key this install trusts`);
    let next = null;
    try { next = fileInTarball(tgz.body, 'release-key.pub')?.toString('utf8').trim() ?? null; } catch {}
    if (next !== pinned) return refused(`${to} carries ${next ? 'a different' : 'no'} release key; changing keys takes a reinstall by hand`);
    // Never backwards: a compromised hub could serve an old signed release with known bugs. The signed
    // package's own commit time must be later than the running one's.
    let rel = null;
    try { rel = releaseOf(fileInTarball(tgz.body, 'src/commit.txt')); } catch {}
    if (!rel || !(rel.commit.startsWith(to) || to.startsWith(rel.commit))) return refused(`the signed package says it is ${rel ? rel.commit.slice(0, 7) : 'no version'}, not ${to.slice(0, 7)} as the hub said`);
    if (mine?.time != null) {
      const when = (s) => new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ');
      if (rel.time == null) return refused(`${to.slice(0, 7)} doesn't say when it was made, so it can't be shown newer than the installed ${from.slice(0, 7)} (${when(mine.time)} UTC)`);
      if (rel.time <= mine.time) return refused(`${to.slice(0, 7)} (${when(rel.time)} UTC) isn't newer than the installed ${from.slice(0, 7)} (${when(mine.time)} UTC); updates never go back`);
    }

    const file = join(dir, `nuworq-${to}.tgz`);
    writeFileSync(file, tgz.body);
    const failed = await install(file);
    // By hand, the same verified file: downloading it again would skip the signature check.
    if (failed) return { status: 'failed', reason: `npm couldn't install it (${failed})`, from, to, command: `npm install -g ${file}` };
    writeState(stateFile, { ...readState(stateFile), installed: to });
    // The versions it moved between, and what changed in the new one (#400).
    const { version, changes } = versionIn(tgz.body);
    return { status: 'updated', from, to, from_version: installedVersion(root), to_version: version, changes };
  } finally { unlock(); }
}

// The one line `nuworq operator` prints when this CLI's listener is below the level the hub or the skill needs
// (#419), with the command that updates it; null when it is new enough.
export function staleListener({ root, have, need }) {
  if (!(need > have)) return null;
  const update = existsSync(join(root, '.git')) ? `git -C ${root} pull` : 'nuworq update';
  let version = runningCommit(root)?.slice(0, 7);
  try { version ??= JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; } catch {}
  return `nuworq: this nuworq${version ? ` (${version})` : ''} is older than the operator listener needs; update it: ${update}, then restart the listener.`;
}

// In words, for `nuworq update` and stderr.
export function describeUpdate(r) {
  const v = (c) => (c ? c.slice(0, 7) : 'an unknown version');
  if (r.status === 'updated') {
    // A release (#400): its version and its changelog lines; otherwise the commits.
    if (r.to_version && r.to_version !== r.from_version) {
      return `Updated nuworq ${r.from_version ?? v(r.from)} → ${r.to_version}. The next run uses it.${r.changes?.length ? `\n${r.changes.map((l) => `  ${l}`).join('\n')}` : ''}`;
    }
    return `Updated nuworq ${v(r.from)} → ${v(r.to)}. The next run uses it.`;
  }
  if (r.status === 'current') return `nuworq ${v(r.from)} is current${r.reason ? ` (${r.reason})` : ''}.`;
  if (r.status === 'off') return `Updates are off: ${r.reason}.`;
  if (r.status === 'failed') return `Didn't update to ${v(r.to)}: ${r.reason}. Run it yourself: ${r.command}`;
  if (r.status === 'refused') return `Didn't update to ${v(r.to)}: ${r.reason}`;
  return `Didn't update: ${r.reason}.`;
}
