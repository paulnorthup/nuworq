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

// The commit an installed package was built from: git archive fills src/commit.txt in (export-subst).
// null in a checkout (the placeholder is still there) or a package from before this file.
export function runningCommit(root) {
  try {
    const c = readFileSync(join(root, 'src', 'commit.txt'), 'utf8').trim();
    return /^[0-9a-f]{7,40}$/.test(c) ? c : null;
  } catch { return null; }
}

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

  const base = hub.replace(/\/+$/, '');
  const from = runningCommit(root);
  const ask = async (path) => {
    const res = await get(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
  };
  let pkg;
  try {
    const info = await ask('/api/info');
    pkg = info.status === 200 ? JSON.parse(info.body).package : null;
  } catch (e) {
    return { status: 'unreachable', reason: `the hub at ${base} didn't answer (${e.cause?.code ?? e.name}); carrying on with the installed version` };
  }
  if (!pkg?.commit || !pkg.sha256) return { status: 'current', reason: 'the hub serves no package of itself', from };
  const to = String(pkg.commit);
  if (!/^[0-9a-f]{7,40}$/.test(to)) return { status: 'refused', reason: `the hub names its version "${to.slice(0, 40)}", which isn't a commit. Kept the installed version.`, from };
  if (from && (from.startsWith(to) || to.startsWith(from))) return { status: 'current', from };

  const unlock = lock(join(dir, 'update.lock'), now);
  if (!unlock) return { status: 'skipped', reason: 'another nuworq on this machine is updating it now' };
  const refused = (reason) => ({ status: 'refused', reason: `${reason}. Kept the installed version.`, from, to });
  try {
    // Someone else installed it while this one was asking.
    if (readState(stateFile).installed === to) return { status: 'current', from, to };
    let tgz, sig;
    try {
      tgz = await ask('/nuworq.tgz');
      sig = await ask('/nuworq.tgz.sig');
    } catch (e) {
      return { status: 'unreachable', reason: `the download from ${base} broke off (${e.cause?.code ?? e.name}); carrying on with the installed version` };
    }
    if (tgz.status !== 200) return refused(`the hub answered ${tgz.status} for /nuworq.tgz`);
    if (sig.status !== 200) return refused(`the hub serves no signature for ${to} (/nuworq.tgz.sig answered ${sig.status}), so it isn't a signed release`);
    if (createHash('sha256').update(tgz.body).digest('hex') !== pkg.sha256) return refused('the download doesn\'t match the sha256 the hub gave: it was changed or cut short on the way');
    const pinned = pinnedKey(root);
    let ok = false;
    try { ok = verify(null, tgz.body, createPublicKey(pinned), Buffer.from(sig.body.toString('utf8').trim(), 'base64')); } catch {}
    if (!ok) return refused(`the signature on ${to} isn't from the release key this install trusts`);
    let next = null;
    try { next = fileInTarball(tgz.body, 'release-key.pub')?.toString('utf8').trim() ?? null; } catch {}
    if (next !== pinned) return refused(`${to} carries ${next ? 'a different' : 'no'} release key; changing keys takes a reinstall by hand`);

    const file = join(dir, `nuworq-${to}.tgz`);
    writeFileSync(file, tgz.body);
    const failed = await install(file);
    if (failed) return { status: 'failed', reason: `npm couldn't install it (${failed})`, from, to, command: `npm install -g ${base}/nuworq.tgz` };
    writeState(stateFile, { ...readState(stateFile), installed: to });
    return { status: 'updated', from, to };
  } finally { unlock(); }
}

// In words, for `nuworq update` and stderr.
export function describeUpdate(r) {
  const v = (c) => (c ? c.slice(0, 7) : 'an unknown version');
  if (r.status === 'updated') return `Updated nuworq ${v(r.from)} → ${v(r.to)}. The next run uses it.`;
  if (r.status === 'current') return `nuworq ${v(r.from)} is current${r.reason ? ` (${r.reason})` : ''}.`;
  if (r.status === 'off') return `Updates are off: ${r.reason}.`;
  if (r.status === 'failed') return `Didn't update to ${v(r.to)}: ${r.reason}. Run it yourself: ${r.command}`;
  if (r.status === 'refused') return `Didn't update to ${v(r.to)}: ${r.reason}`;
  return `Didn't update: ${r.reason}.`;
}
