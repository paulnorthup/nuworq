#!/usr/bin/env node
// Sign a release where the release key lives, never on the hub (docs/DEPLOY.md, "Signed releases"):
//   node scripts/sign-release.js keygen <dir>          a new key pair: <dir>/release-key.pem (keep it offline)
//                                                      and <dir>/release-key.pub (commit it at the repo root)
//   node scripts/sign-release.js sign <nuworq.tgz> <release-key.pem>   writes <nuworq.tgz>.sig
//   node scripts/sign-release.js release <hub> <release-key.pem> [<scp destination>]
//                                                      the package the hub serves now: fetched, checked, signed
//                                                      as ~/.nuworq/signatures/nuworq-<commit>.tgz.sig, and copied
//                                                      beside it with scp.
//                                                      Run it in a checkout of nuworq: the package must be a
//                                                      release, its version tagged vX.Y.Z on that commit (#400)
//   node scripts/sign-release.js watch <hub> <release-key.pem> <scp destination> [--install]
//                                                      every few minutes, sign each new vX.Y.Z tag on origin's main,
//                                                      built from GitHub (scripts/signer.js, #430). Run it in a checkout
//                                                      of nuworq. --install: as a service (LaunchAgent / systemd user
//                                                      unit), logging to ~/.nuworq/logs/signer.log; watch --uninstall
//                                                      stops and removes it
// The .sig goes beside the hub's package (nuworq-<commit>.tgz in its package folder); installs that pinned
// release-key.pub update only to a package it verifies (src/update.js).
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileInTarball, releaseOf, versionOf, changelogEntry } from '../src/update.js';

const signed = (bytes, key) => {
  const sig = sign(null, bytes, key);
  if (!verify(null, bytes, createPublicKey(key), sig)) throw new Error('the signature doesn\'t verify');
  return `${sig.toString('base64')}\n`;
};
const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === 'keygen' && a) {
  const pem = join(a, 'release-key.pem'), pub = join(a, 'release-key.pub');
  if (existsSync(pem)) throw new Error(`${pem} already exists; not overwriting a release key`);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(pem, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`Wrote ${pem} (private: keep it off the hub) and ${pub} (public: commit it at the repo root)`);
} else if (cmd === 'sign' && a && b) {
  writeFileSync(`${a}.sig`, signed(readFileSync(a), createPrivateKey(readFileSync(b))));
  console.log(`Wrote ${a}.sig`);
} else if (cmd === 'release' && a && b) {
  // Sign only what installs will take: the bytes the hub names, of the commit it names, pinning this key.
  const base = new URL(a).origin;
  const p = (await (await fetch(`${base}/api/package`)).json()).package;
  if (!p) throw new Error(`${base} serves no package of itself`);
  const bytes = Buffer.from(await (await fetch(`${base}/nuworq.tgz`)).arrayBuffer());
  const short = p.commit.slice(0, 7);
  if (createHash('sha256').update(bytes).digest('hex') !== p.sha256) throw new Error(`the download isn't the package ${base}/api/package names (the hub may have just moved on to a newer commit); run this again`);
  const rel = releaseOf(fileInTarball(bytes, 'src/commit.txt'));
  if (rel?.commit !== p.commit) throw new Error(`the package says it is ${rel?.commit.slice(0, 7) ?? 'no version'}, not ${short} as the hub says`);
  const key = createPrivateKey(readFileSync(b));
  const pub = createPublicKey(key).export({ type: 'spki', format: 'pem' }).trim();
  if (fileInTarball(bytes, 'release-key.pub')?.toString('utf8').trim() !== pub) {
    throw new Error(`${short} doesn't carry this key's release-key.pub, so installs would refuse it: commit release-key.pub to main and let the hub run it first`);
  }
  // A release is a version (#400): its package.json version, tagged vX.Y.Z on this very commit, with its
  // CHANGELOG.md entry first. The tag comes from origin (the hub tags a release once it lands), into the
  // checkout this runs in.
  const version = versionOf(fileInTarball(bytes, 'package.json'));
  if (!version) throw new Error(`${short}'s package.json has no version (X.Y.Z), so it isn't a release`);
  const tag = `v${version}`;
  try { execFileSync('git', ['fetch', '-q', 'origin', 'tag', tag], { stdio: 'ignore', timeout: 30_000 }); } catch {}
  let tagged = '';
  try { tagged = execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  if (!tagged) throw new Error(`${short} says it is ${version}, but there is no ${tag} tag (looked in this checkout and its origin): sign a release only once its item has landed and the hub tagged it`);
  if (!tagged.startsWith(p.commit) && !p.commit.startsWith(tagged)) throw new Error(`${tag} is ${tagged.slice(0, 7)}, not ${short} as the hub serves: wait until the hub runs ${tag}, then sign`);
  if (changelogEntry(fileInTarball(bytes, 'CHANGELOG.md'), version, { first: true }) == null) throw new Error(`${short}'s CHANGELOG.md doesn't begin with ${version} (a "## ${version}" heading first), so installs couldn't say what changed`);
  // Into a folder of its own, not the checkout it runs in, so a signature never ends up in a commit.
  const sigs = join(homedir(), '.nuworq', 'signatures');
  mkdirSync(sigs, { recursive: true });
  const file = join(sigs, `nuworq-${p.commit}.tgz.sig`);
  writeFileSync(file, signed(bytes, key));
  const made = rel.time ? `, made ${new Date(rel.time * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
  console.log(`Signed ${version} (${short}${made}): wrote ${file}`);
  if (!c) {
    console.log(`Put it beside the hub's package, e.g. scp ${file} <hub host>:/var/lib/nuworq/package/`);
  } else {
    execFileSync('scp', ['-q', file, c], { stdio: 'inherit' });
    const now = (await (await fetch(`${base}/api/package`)).json()).package;
    if (now?.commit !== p.commit) throw new Error(`copied, but ${base} runs ${now?.commit.slice(0, 7) ?? 'nothing'} now, not ${short}: sign that one instead`);
    if (!now.signed) throw new Error(`copied to ${c}, but ${base} doesn't serve it: is that its package folder (<data dir>/package/)?`);
    console.log(`${base} serves ${version} (${short}) signed: installs that pinned this key take it at their next check (at most 10 minutes after a nuworq command starts).`);
  }
} else if (cmd === 'watch' && (a === '--uninstall' || (a && b && c))) {
  await watchCmd();
} else {
  console.error('usage: sign-release.js keygen <dir> | sign <nuworq.tgz> <release-key.pem> | release <hub> <release-key.pem> [<scp destination>]\n'
    + '       | watch <hub> <release-key.pem> <scp destination> [--install] | watch --uninstall');
  process.exit(2);
}

// watch: the signer (scripts/signer.js), in the foreground, or installed as a service with --install.
async function watchCmd() {
  const args = process.argv.slice(3);
  const { resolve } = await import('node:path');
  const { homedir, userInfo } = await import('node:os');
  const { promisify } = await import('node:util');
  const { execFile } = await import('node:child_process');
  const svc = await import('../src/service.js');
  const { dataDir } = await import('../src/names.js');
  const { repoRoot, connected, createClient } = await import('../src/client.js');
  const signer = await import('./signer.js');
  const exec = (cmd, xs) => promisify(execFile)(cmd, xs);
  const where = { platform: process.platform, home: homedir(), uid: userInfo().uid, exec, ...svc.SIGNER };
  const self = resolve(import.meta.dirname, 'sign-release.js');
  if (args.includes('--uninstall')) {
    const r = await svc.uninstall(where);
    return console.log(r.removed ? `Removed the ${r.kind} ${r.file}: the signer has stopped. Signing by hand (release) still works.` : `No signer was installed (${r.file}).`);
  }
  const [hub, pem, dest] = args.filter((x) => !x.startsWith('--'));
  const repo = repoRoot(process.cwd());
  if (!repo) throw new Error('run watch in a checkout of nuworq: it builds each release from its origin (GitHub)');
  const key = createPrivateKey(readFileSync(pem)); // fails now, not in the log, when the key can't be read
  const log = join(dataDir(), 'logs', 'signer.log');
  if (args.includes('--install')) {
    const command = [svc.stableNode(process.execPath), self, 'watch', new URL(hub).origin, resolve(pem), dest];
    const r = await svc.install({ ...where, command, env: svc.serviceEnv(process.env), log, cwd: repo });
    if (!r.up) process.exitCode = 1;
    return console.log(`${r.up ? `Installed the release signer as a ${r.kind}, and it is up.` : `Installed the release signer as a ${r.kind}, but it isn't up after 10 seconds. Check on it with: ${r.status}`}
  Signs:   each new vX.Y.Z tag on main at ${repo}'s origin, for ${new URL(hub).origin}
  Wrote:   ${r.file}
  Log:     ${r.log}
  Remove:  node ${self} watch --uninstall`);
  }
  // A signed release is said on its release item, when this machine is connected to a hub (nuworq connect).
  const conn = connected();
  const comment = !conn ? undefined : async (r) => {
    const client = createClient({ url: conn.url, cwd: repo });
    const as = { agent: 'nuworq-signer' };
    const look = async (stage) => (await client.call('look', stage ? { stage } : {}, as)).board;
    const item = signer.releaseItem(await look(), r.version) ?? signer.releaseItem(await look('done'), r.version);
    await client.call('comment', { item: item ?? undefined, headline: `Signed v${r.version} (${r.short})` }, as);
  };
  const scp = (file, to) => exec('scp', ['-q', '-o', 'BatchMode=yes', file, to]);
  console.log(`Signing each new release tag for ${new URL(hub).origin} from ${repo}, every ${signer.EVERY / 60_000} minutes.`);
  await signer.watch({ repo, hub, key, dest, scp, comment, log: (l) => console.log(l), stateFile: join(dataDir(), 'signer.json') });
}
