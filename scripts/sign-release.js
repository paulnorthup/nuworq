#!/usr/bin/env node
// Releases are signed by the release workflow once the maintainer approves them (.github/workflows/release.yml, #813). This
// is the key's own tooling, run where the release key lives, never on the hub (docs/DEPLOY.md, "Signed releases"):
//   node scripts/sign-release.js keygen <dir>          a new key pair: <dir>/release-key.pem (keep it offline)
//                                                      and <dir>/release-key.pub (commit it at the repo root)
//   node scripts/sign-release.js sign <nuworq.tgz> <release-key.pem>   writes <nuworq.tgz>.sig
//   node scripts/sign-release.js release <vX.Y.Z> <release-key.pem> <hub>
//                                                      signing by hand, the fallback to the workflow (#815): in a
//                                                      checkout of nuworq at the last signed release's tag, with
//                                                      nothing changed (#829), at a terminal. It checks origin's tag
//                                                      by the workflow's rules (scripts/release.js handCheck),
//                                                      shows its commit and changelog, and once you type the tag,
//                                                      builds the package from GitHub's copy as the hub does and
//                                                      writes it and its .sig to ~/.nuworq/signatures, with the
//                                                      commands that publish them as the tag's GitHub Release
// Installs that pinned release-key.pub update only to a package it verifies (src/update.js).
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const signed = (bytes, key) => {
  const sig = sign(null, bytes, key);
  if (!verify(null, bytes, createPublicKey(key), sig)) throw new Error('the signature doesn\'t verify');
  return `${sig.toString('base64')}\n`;
};
const [cmd, a, b, c] = process.argv.slice(2);
if (!process.argv[1] || import.meta.url !== pathToFileURL(process.argv[1]).href) {
  // imported (by its test): only checkoutRefusal, below
} else if (cmd === 'keygen' && a) {
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

// Why the checkout at root mustn't run release, with the key: '' when it may (#829). release loads the checkout's
// own modules, which agents can land on main, so it runs only the code of the last signed release: HEAD must be the
// commit the hub names as its signed release, origin must tag that commit vX.Y.Z (only the maintainer makes v* tags),
// and no tracked file may differ from it. Node's built-ins and git only: this runs before any repository module.
// get: fetch.
export async function checkoutRefusal(root, hub, get = fetch) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim();
  let head;
  try { head = git('rev-parse', 'HEAD'); } catch { return `${root} isn't a checkout of nuworq: clone it from GitHub and run release from there`; }
  let rel;
  try {
    const r = await get(`${new URL(hub).origin}/api/package`, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`it answered ${r.status}`);
    rel = (await r.json()).package?.release?.commit;
  } catch (e) {
    return `couldn't ask ${hub} for its signed release (${e.message}), so there's no telling which code to trust`;
  }
  if (!rel) return `${hub} has no signed release yet, so no release's code is known good: sign the first release with the release workflow`;
  let tags;
  try { tags = git('ls-remote', '--tags', 'origin', 'refs/tags/v*'); } catch (e) { return `couldn't list origin's tags (${e.message.split('\n')[0]})`; }
  // An annotated tag's ^{} line names its commit, and comes after the tag object's own line.
  const at = new Map(tags.split('\n').filter(Boolean).map((l) => l.split('\t')).map(([sha, ref]) => [ref.replace(/^refs\/tags\/|\^\{\}$/g, ''), sha]));
  const tag = [...at].find(([name, sha]) => /^v\d+\.\d+\.\d+$/.test(name) && sha === rel)?.[0];
  if (!tag) return `the hub's signed release ${rel.slice(0, 7)} has no vX.Y.Z tag on origin, so it isn't a release the maintainer tagged`;
  if (head !== rel) return `this checkout is at ${head.slice(0, 7)}, not the last signed release ${tag} (${rel.slice(0, 7)}), and its code would run with your key. Check that out, then run this again from it: git fetch origin tag ${tag} && git switch --detach ${tag}`;
  if (git('status', '--porcelain', '--untracked-files=no')) return `this checkout changes ${tag}'s files, and the changes would run with your key: git restore . (or git stash), then run this again`;
  return '';
}

// release: a person signs one release by hand. Only at a terminal, and only after typing the tag back: an agent
// with a shell has no terminal to answer at. What gets signed is GitHub's build of the tag, never the hub's package.
async function releaseCmd(tag, pem, hub) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('release needs a person at a terminal: run it yourself, in a terminal on the machine that holds the release key');
  }
  // The checkout this script runs from: the one whose modules it loads below, whatever the working directory.
  const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
  const refusal = await checkoutRefusal(repo, hub);
  if (refusal) throw new Error(`not signed, and the key wasn't read: ${refusal}`);
  const { archive } = await import('../src/package.js');
  const { handCheck } = await import('./release.js');
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
