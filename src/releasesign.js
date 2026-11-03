// Signing a release by hand, the fallback to the release workflow (#815): `nuworq release sign <vX.Y.Z>
// <release-key.pem> <hub>`, run by a person at a terminal, in a checkout of nuworq whose origin is GitHub.
// The code that holds the key must itself be a release the key signed (#836). A checkout runs whatever landed on
// main, and agents land on main, so from a checkout it refuses before it reads the key file. It can't tell a signed
// release from the hub's unsigned package of main, so docs/DEPLOY.md has the person install the last GitHub Release's
// package after checking its signature. The checkout is only where it
// fetches origin's tag and main and builds the package with git archive: none of its code runs.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { archive, handCheck, ownCheckout } from './package.js';
import { runningCommit } from './update.js';

const INSTALL = 'Install the last release\'s nuworq-<commit>.tgz from its GitHub Release once its .sig checks out (docs/DEPLOY.md, "Signing by hand"), with npm install -g <that file>, and run nuworq release sign again';

// Why the nuworq at root mustn't sign by hand: '' when it may, an installed package built from a commit.
export function installRefusal(root) {
  if (existsSync(join(root, '.git')) || ownCheckout(root)) {
    return `this nuworq runs from a git checkout (${root}), whose code is whatever landed on main, so it never touches the release key. ${INSTALL}`;
  }
  if (!runningCommit(root)) return `this nuworq (${root}) doesn't say which commit it was built from, so it isn't a signed release. ${INSTALL}`;
  return '';
}

export const signed = (bytes, key) => {
  const sig = sign(null, bytes, key);
  if (!verify(null, bytes, createPublicKey(key), sig)) throw new Error('the signature doesn\'t verify');
  return `${sig.toString('base64')}\n`;
};

// root: the nuworq this runs from. repo: the checkout it builds from. tty: whether a person is at a terminal.
// ask(question): the answer typed. get: fetch. out: where the package and its .sig go.
export async function signByHand({ root, repo, tag, pem, hub, tty, ask, get = fetch, out = join(homedir(), '.nuworq', 'signatures'), say = console.log }) {
  const refusal = installRefusal(root);
  if (refusal) throw new Error(`not signed: ${refusal}`);
  // Only at a terminal, and only after typing the tag back: an agent with a shell has no terminal to answer at.
  if (!tty) throw new Error('release sign needs a person at a terminal: run it yourself, in a terminal on the machine that holds the release key');
  if (!repo) throw new Error('run release sign in a checkout of nuworq: it builds the release from its origin (GitHub)');
  const key = createPrivateKey(readFileSync(pem));
  const pub = createPublicKey(key).export({ type: 'spki', format: 'pem' });
  // What runs here is a release this key signed only if it pins this key.
  let pinned = null;
  try { pinned = readFileSync(join(root, 'release-key.pub'), 'utf8').trim(); } catch {}
  if (pinned !== pub.trim()) throw new Error(`not signed: this nuworq (${root}) pins ${pinned ? 'another' : 'no'} release key, so it isn't a release this key signed`);
  const r = await handCheck(repo, { tag, pub, hub, get });
  if (r.refusal) throw new Error(`not signed: ${r.refusal}`);
  say(`${tag} is ${r.commit}\n  ${r.subject}\n\nWhat it ships (its CHANGELOG.md entry):\n${r.changes.split('\n').map((l) => `  ${l}`).join('\n') || '  (none)'}\n`);
  const typed = String(await ask(`Type ${tag} to sign it, or anything else to stop: `)).trim();
  if (typed !== tag) return say('Not signed. Nothing changed.');
  // Into a folder of its own, not the checkout, so a signature never ends up in a commit.
  mkdirSync(out, { recursive: true });
  const file = join(out, `nuworq-${r.commit}.tgz`);
  await archive(repo, r.commit, file);
  writeFileSync(`${file}.sig`, signed(readFileSync(file), key));
  say(`Signed ${tag} (${r.commit.slice(0, 7)}): wrote ${file} and ${file}.sig. Publish them, in the checkout:
  gh release create ${tag} ${file} ${file}.sig --verify-tag --title ${tag} --notes "${tag}"
    (if ${tag} has a GitHub Release already: gh release upload ${tag} ${file} ${file}.sig --clobber)
  git push origin ${r.commit}:refs/heads/release
Check: within 10 minutes ${new URL(hub).origin}/api/package names ${r.commit.slice(0, 7)} as its release.`);
}
