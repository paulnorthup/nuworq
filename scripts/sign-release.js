#!/usr/bin/env node
// Sign a release where the release key lives, never on the hub (docs/DEPLOY.md, "Signed releases"):
//   node scripts/sign-release.js keygen <dir>          a new key pair: <dir>/release-key.pem (keep it offline)
//                                                      and <dir>/release-key.pub (commit it at the repo root)
//   node scripts/sign-release.js sign <nuworq.tgz> <release-key.pem>   writes <nuworq.tgz>.sig
//   node scripts/sign-release.js release <hub> <release-key.pem> [<scp destination>]
//                                                      the package the hub serves now: fetched, checked, signed
//                                                      as nuworq-<commit>.tgz.sig, and copied beside it with scp.
//                                                      Run it in a checkout of nuworq: the package must be a
//                                                      release, its version tagged vX.Y.Z on that commit (#400)
// The .sig goes beside the hub's package (nuworq-<commit>.tgz in its package folder); installs that pinned
// release-key.pub update only to a package it verifies (src/update.js).
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
  const file = `nuworq-${p.commit}.tgz.sig`;
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
} else {
  console.error('usage: sign-release.js keygen <dir> | sign <nuworq.tgz> <release-key.pem> | release <hub> <release-key.pem> [<scp destination>]');
  process.exit(2);
}
