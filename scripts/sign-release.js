#!/usr/bin/env node
// Releases are signed by the release workflow once the maintainer approves them (.github/workflows/release.yml, #813). This
// is the key's own tooling, run where the release key lives, never on the hub (docs/DEPLOY.md, "Signed releases"):
//   node scripts/sign-release.js keygen <dir>          a new key pair: <dir>/release-key.pem (keep it offline)
//                                                      and <dir>/release-key.pub (commit it at the repo root)
//   node scripts/sign-release.js sign <nuworq.tgz> <release-key.pem>   writes <nuworq.tgz>.sig
// Signing a release by hand, the fallback to the workflow, is `nuworq release sign` (src/releasesign.js), run from an
// install of a signed release, never from a checkout (#836): `release` here only says so, and reads nothing.
// Installs that pinned release-key.pub update only to a package it verifies (src/update.js).
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const signed = (bytes, key) => {
  const sig = sign(null, bytes, key);
  if (!verify(null, bytes, createPublicKey(key), sig)) throw new Error('the signature doesn\'t verify');
  return `${sig.toString('base64')}\n`;
};
const [cmd, a, b] = process.argv.slice(2);
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
} else if (cmd === 'release') {
  console.error('Not signed: a checkout runs whatever landed on main, so it never signs a release with the key. Sign by hand from an install of a signed release (the last GitHub Release\'s nuworq-<commit>.tgz once its .sig checks out: docs/DEPLOY.md, "Signing by hand"), in this checkout:\n  nuworq release sign <vX.Y.Z> <release-key.pem> <hub>');
  process.exit(1);
} else {
  console.error('usage: sign-release.js keygen <dir> | sign <nuworq.tgz> <release-key.pem>  (signing a release by hand: nuworq release sign)');
  process.exit(2);
}
