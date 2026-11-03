#!/usr/bin/env node
// Releases are signed by the release workflow once the maintainer approves them (.github/workflows/release.yml, #813). This
// is the key's own tooling, run where the release key lives, never on the hub (docs/DEPLOY.md, "Signed releases"):
//   node scripts/sign-release.js keygen <dir>          a new key pair: <dir>/release-key.pem (keep it offline)
//                                                      and <dir>/release-key.pub (commit it at the repo root)
//   node scripts/sign-release.js sign <nuworq.tgz> <release-key.pem>   writes <nuworq.tgz>.sig
//   node scripts/sign-release.js release <vX.Y.Z> <release-key.pem> <hub>
//                                                      signing by hand, the fallback to the workflow (#815): in a
//                                                      checkout of nuworq, at a terminal. It checks origin's tag
//                                                      by the workflow's rules (scripts/release.js handCheck),
//                                                      shows its commit and changelog, and once you type the tag,
//                                                      builds the package from GitHub's copy as the hub does and
//                                                      writes it and its .sig to ~/.nuworq/signatures, with the
//                                                      commands that publish them as the tag's GitHub Release
// Installs that pinned release-key.pub update only to a package it verifies (src/update.js).
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
} else if (cmd === 'release' && a && b && c) {
  await releaseCmd(a, b, c);
} else {
  console.error('usage: sign-release.js keygen <dir> | sign <nuworq.tgz> <release-key.pem> | release <vX.Y.Z> <release-key.pem> <hub>');
  process.exit(2);
}

// release: a person signs one release by hand. Only at a terminal, and only after typing the tag back: an agent
// with a shell has no terminal to answer at. What gets signed is GitHub's build of the tag, never the hub's package.
async function releaseCmd(tag, pem, hub) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('release needs a person at a terminal: run it yourself, in a terminal on the machine that holds the release key');
  }
  const { repoRoot } = await import('../src/client.js');
  const { archive } = await import('../src/package.js');
  const { handCheck } = await import('./release.js');
  const repo = repoRoot(process.cwd());
  if (!repo) throw new Error('run release in a checkout of nuworq: it builds the release from its origin (GitHub)');
  const key = createPrivateKey(readFileSync(pem));
  const pub = createPublicKey(key).export({ type: 'spki', format: 'pem' });
  const r = await handCheck(repo, { tag, pub, hub });
  if (r.refusal) throw new Error(`not signed: ${r.refusal}`);
  console.log(`${tag} is ${r.commit}\n  ${r.subject}\n\nWhat it ships (its CHANGELOG.md entry):\n${r.changes.split('\n').map((l) => `  ${l}`).join('\n') || '  (none)'}\n`);
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`Type ${tag} to sign it, or anything else to stop: `)).trim();
  rl.close();
  if (typed !== tag) return console.log('Not signed. Nothing changed.');
  // Into a folder of its own, not the checkout it runs in, so a signature never ends up in a commit.
  const sigs = join(homedir(), '.nuworq', 'signatures');
  mkdirSync(sigs, { recursive: true });
  const file = join(sigs, `nuworq-${r.commit}.tgz`);
  await archive(repo, r.commit, file);
  writeFileSync(`${file}.sig`, signed(readFileSync(file), key));
  console.log(`Signed ${tag} (${r.commit.slice(0, 7)}): wrote ${file} and ${file}.sig. Publish them, in this checkout:
  gh release create ${tag} ${file} ${file}.sig --verify-tag --title ${tag} --notes "${tag}"
    (if ${tag} has a GitHub Release already: gh release upload ${tag} ${file} ${file}.sig --clobber)
  git push origin ${r.commit}:refs/heads/release
Check: within 10 minutes ${new URL(hub).origin}/api/package names ${r.commit.slice(0, 7)} as its release.`);
}
