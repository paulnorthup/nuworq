// The release signer (#430): `node scripts/sign-release.js watch <hub> <release-key.pem> <scp destination>`, on the
// machine that holds the release key, as a service of its own (LaunchAgent or systemd user unit; agents never
// touch the key). Every few minutes it signs each vX.Y.Z tag on origin that the hub doesn't yet serve as its signed
// release, but only a release: the tagged commit is on main, its package.json says X.Y.Z, its CHANGELOG.md begins
// with that version, it pins this key's release-key.pub, and it is newer than the hub's signed release (never a
// rollback). It builds the package from GitHub's copy of the commit with git archive, as the hub does
// (src/package.js), signs those bytes, and copies the .sig beside the hub's package. So a signature means "a tagged
// release on GitHub's main, built from GitHub": the hub serves it only if its own package is those very bytes.
import { execFile } from 'node:child_process';
import { createHash, createPublicKey, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { archive } from '../src/package.js';
import { versionOf, changelogEntry } from '../src/update.js';

export const EVERY = 5 * 60_000;
const TAG = /^v(\d+\.\d+\.\d+)$/;
// Origin's main and tags, fetched under a namespace of the signer's own, so the checkout's own tags and
// origin/main are never touched (it may be someone's working checkout).
const MAIN = 'refs/signer/main';
const TAGS = 'refs/signer/tags';

const git = (repo, args) => new Promise((resolve, reject) => {
  execFile('git', ['-C', repo, ...args], { timeout: 120_000, maxBuffer: 16 << 20 }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(out)));
});
const show = (repo, commit, path) => git(repo, ['show', `${commit}:${path}`]).catch(() => null);

// a > b, as X.Y.Z versions.
export const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

// Origin's release tags, newest version first: [{ tag, version, commit }].
async function releaseTags(repo) {
  await git(repo, ['fetch', '-q', '--no-tags', '--prune', 'origin', `+refs/heads/main:${MAIN}`, `+refs/tags/*:${TAGS}/*`]);
  const out = await git(repo, ['for-each-ref', '--format=%(refname:strip=3) %(objecttype) %(objectname) %(*objecttype) %(*objectname)', TAGS]);
  return out.split('\n').flatMap((l) => {
    const [tag, type, id, ptype, pid] = l.trim().split(' ');
    const m = TAG.exec(tag ?? '');
    const commit = type === 'commit' ? id : ptype === 'commit' ? pid : null;
    return m && commit ? [{ tag, version: m[1], commit }] : [];
  }).sort((a, b) => (newer(a.version, b.version) ? -1 : 1));
}

const json = async (get, url) => {
  const r = await get(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.json();
};
// The hub's answer for a file: { status, etag, error }, without its body (only a refusal's error is read).
const head = async (get, url) => {
  const r = await get(url, { signal: AbortSignal.timeout(30_000) });
  let error = '';
  if (r.ok) await r.body?.cancel();
  else error = await r.json().then((j) => String(j?.error ?? ''), () => '');
  return { status: r.status, etag: String(r.headers.get('etag') ?? '').replace(/"/g, ''), error };
};

// One check. repo: a checkout whose origin is the project on GitHub. hub: its address. key: the release key
// (a KeyObject). dest: where scp puts the .sig (the hub's <data dir>/package/). scp(file, dest) copies it; it
// rejects when the copy fails. state: { alarms: { <commit>: why } }, kept across rounds and restarts: a release the
// hub ignored is never tried again. Resolves one result per tag, newest first: { tag, commit, outcome, reason },
// outcome is signed | done | refused | waiting | failed | alarm. comment(result) is told about each release signed.
export async function round({ repo, hub, key, dest, scp, fetch: get = fetch, state, comment = async () => {} }) {
  const base = new URL(hub).origin;
  const pub = createPublicKey(key).export({ type: 'spki', format: 'pem' }).trim();
  const tags = await releaseTags(repo);
  const pkg = (await json(get, `${base}/api/package`)).package;
  if (!pkg) throw new Error(`${base} serves no package of itself, so it has nothing to sign`);
  let release = pkg.release ?? null;
  let current = release ? versionOf(await show(repo, release.commit, 'package.json')) : null;
  const results = [];
  for (const t of tags) {
    const short = t.commit.slice(0, 7);
    const say = (outcome, reason) => results.push({ ...t, short, outcome, reason });
    if (release?.commit === t.commit) { say('done', `the hub serves it as its signed release`); continue; }
    const time = Number((await git(repo, ['log', '-1', '--format=%ct', t.commit])).trim());
    if (release && (time <= release.time || (current && !newer(t.version, current)))) {
      say('refused', `older than the hub's signed release${current ? ` v${current}` : ''} (${release.commit.slice(0, 7)}), and signing it would roll installs back`);
      continue;
    }
    if (state.alarms?.[t.commit]) { say('alarm', `not tried again: ${state.alarms[t.commit]}`); continue; }
    if (!(await git(repo, ['merge-base', '--is-ancestor', t.commit, MAIN]).then(() => true, () => false))) {
      say('refused', `${short} isn't on origin's main`); continue;
    }
    const said = versionOf(await show(repo, t.commit, 'package.json'));
    if (said !== t.version) { say('refused', `its package.json says ${said ?? 'no version'}, not ${t.version}`); continue; }
    if (changelogEntry(await show(repo, t.commit, 'CHANGELOG.md'), t.version, { first: true }) == null) {
      say('refused', `its CHANGELOG.md doesn't begin with ${t.version} (a "## ${t.version}" heading first)`); continue;
    }
    if ((await show(repo, t.commit, 'release-key.pub'))?.trim() !== pub) {
      say('refused', `its release-key.pub isn't this key's public half, so installs pinning it would refuse the signature`); continue;
    }
    const file = `nuworq-${t.commit}.tgz`;
    if ((await head(get, `${base}/${file}.sig`)).status === 200) { say('done', 'the hub already has a signature for it'); continue; }
    const served = await head(get, `${base}/${file}`);
    if (served.status === 404) {
      // Past it already (main moved on, or its tests failed there): the hub never runs it, so say what it does instead.
      const past = pkg.commit && !t.commit.startsWith(pkg.commit) && await git(repo, ['merge-base', '--is-ancestor', t.commit, pkg.commit]).then(() => true, () => false);
      say('waiting', past
        ? `the hub skipped ${short} (it runs ${pkg.commit.slice(0, 7)}, after it) and has no package of it${served.error ? ` ("${served.error}")` : ''}; a hub with #434 builds one once its checkout has the ${t.tag} tag, else sign it by hand. Trying again next round`
        : `the hub has no package of ${short} yet; it builds one when it runs that commit, or a later one with the ${t.tag} tag in its checkout`);
      continue;
    }
    if (served.status !== 200) { say('failed', `${base}/${file} answered ${served.status}; trying again next round`); continue; }
    const dir = mkdtempSync(join(tmpdir(), 'nuworq-signer-'));
    try {
      await archive(repo, t.commit, join(dir, file));
      let bytes = readFileSync(join(dir, file));
      const alarm = (why) => { state.alarms = { ...state.alarms, [t.commit]: why }; say('alarm', why); };
      // Another git (the hub's) may gzip the same archive differently. The files are what counts: a package
      // whose tar is byte for byte GitHub's build is signed as the hub has it, and anything else is an alarm.
      if (served.etag !== createHash('sha256').update(bytes).digest('hex')) {
        const theirs = Buffer.from(await (await get(`${base}/${file}`, { signal: AbortSignal.timeout(120_000) })).arrayBuffer());
        let same = false;
        try { same = gunzipSync(theirs).equals(gunzipSync(bytes)); } catch {}
        if (!same) {
          alarm(`the hub's package of ${short} (sha256 ${served.etag.slice(0, 12) || 'unknown'}) isn't GitHub's build of it: the hub would ignore the signature, so it wasn't copied`);
          continue;
        }
        bytes = theirs;
      }
      writeFileSync(join(dir, `${file}.sig`), `${sign(null, bytes, key).toString('base64')}\n`);
      try { await scp(join(dir, `${file}.sig`), dest); } catch (e) { say('failed', `scp to ${dest} failed (${e.message}); trying again next round`); continue; }
      const now = (await json(get, `${base}/api/package`)).package?.release;
      if (now?.commit !== t.commit) {
        alarm(`copied ${file}.sig to ${dest}, but the hub ignores it (its release is ${now?.commit?.slice(0, 7) ?? 'none'}): its package or the release-key.pub it runs differs from GitHub's, or ${dest} isn't its package folder`);
        continue;
      }
      say('signed', `signed v${t.version} (${short}): the hub serves it as its release`);
      release = now; current = t.version;
      await comment(results.at(-1)).catch(() => {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return results;
}

const readState = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };

// Run round every `every` ms, forever: one line per check result whose outcome changed (each refusal is said
// once, not every round), else one line that nothing did. log(line) gets each, stamped. A round that fails (git,
// the hub unreachable) is logged and the next one tries again.
export async function watch({ every = EVERY, log, stateFile, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), rounds = Infinity, ...opts }) {
  const said = new Map();
  const stamp = (s) => log(`${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${s}`);
  for (let n = 0; n < rounds; n++) {
    const state = readState(stateFile);
    try {
      const results = await round({ ...opts, state });
      let changed = 0;
      for (const r of results) {
        const line = `${r.outcome === 'alarm' ? 'ALARM ' : ''}${r.tag} (${r.short}): ${r.reason}`;
        if (said.get(r.tag) === line) continue;
        said.set(r.tag, line);
        stamp(line);
        changed++;
      }
      if (!changed) stamp(`checked ${results.length} release tag${results.length === 1 ? '' : 's'}: nothing new`);
    } catch (e) {
      stamp(`check failed: ${e.message}; trying again in ${Math.round(every / 60_000)} min`);
    }
    try { mkdirSync(dirname(stateFile), { recursive: true }); writeFileSync(stateFile, JSON.stringify(state)); } catch {}
    if (n + 1 < rounds) await sleep(every);
  }
}

// The release item a signed version came from, by its title ("Release vX.Y.Z…") on the board look returns.
export function releaseItem(board, version) {
  const lines = Object.values(board ?? {}).flat();
  const m = lines.map((l) => /^#(\d+)\b.*\bRelease v(\d+\.\d+\.\d+)\b/.exec(l)).find((x) => x?.[2] === version);
  return m ? `#${m[1]}` : null;
}
