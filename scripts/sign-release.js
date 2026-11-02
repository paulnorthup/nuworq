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
//                                                      release, its version tagged vX.Y.Z on that commit (#400),
//                                                      on origin's main, approved (approve, below), and GitHub's
//                                                      own build of it, as the signer checks (#603)
//   node scripts/sign-release.js watch <hub> <release-key.pem> <scp destination> [--install]
//                                                      every few minutes, sign each new vX.Y.Z tag on origin's main
//                                                      that a person approved, built from GitHub (scripts/signer.js,
//                                                      #430). Run it in a checkout of nuworq. --install: as a service
//                                                      (LaunchAgent / systemd user unit), logging to
//                                                      ~/.nuworq/logs/signer.log; watch --uninstall stops and removes it
//   node scripts/sign-release.js approve <vX.Y.Z> <release-key.pem>
//                                                      approve one release for the signer (#473), at a terminal: it
//                                                      shows the tag's commit and changelog, and you type the tag
// The .sig goes beside the hub's package (nuworq-<commit>.tgz in its package folder); installs that pinned
// release-key.pub update only to a package it verifies (src/update.js).
// release, watch and approve load the release key, so they run only from a release a person approved (#756): the
// checkout this script is in must be at a vX.Y.Z commit approved with this key, with no local changes to its code.
// Agents land on main without a person, so a checkout brought up to main would otherwise run their code with the
// key loaded. Nothing from src/ is imported until that is checked.
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  approvedCode(b);
  const { fileInTarball, releaseOf, versionOf, changelogEntry } = await import('../src/update.js');
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
  // CHANGELOG.md entry first.
  const version = versionOf(fileInTarball(bytes, 'package.json'));
  if (!version) throw new Error(`${short}'s package.json has no version (X.Y.Z), so it isn't a release`);
  const tag = `v${version}`;
  if (changelogEntry(fileInTarball(bytes, 'CHANGELOG.md'), version, { first: true }) == null) throw new Error(`${short}'s CHANGELOG.md doesn't begin with ${version} (a "## ${version}" heading first), so installs couldn't say what changed`);
  // Everything above reads the hub's own package, which a compromised hub writes. So, as the signer does (#603):
  // origin's tag on this commit, on origin's main, approved here with this key, and the bytes GitHub's build of it.
  const { repoRoot } = await import('../src/client.js');
  const { handRefusal } = await import('./signer.js');
  const repo = repoRoot(process.cwd());
  if (!repo) throw new Error('run release in a checkout of nuworq: it checks the package against GitHub\'s build of the release tag');
  const refused = await handRefusal(repo, { tag, commit: p.commit, bytes, key, approvals: await approvalsDir() });
  if (refused) throw new Error(`not signed: ${refused}`);
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
  await watchCmd(a === '--uninstall' ? null : approvedCode(b));
} else if (cmd === 'approve' && a && b) {
  approvedCode(b);
  await approveCmd(a, b);
} else {
  console.error('usage: sign-release.js keygen <dir> | sign <nuworq.tgz> <release-key.pem> | release <hub> <release-key.pem> [<scp destination>]\n'
    + '       | watch <hub> <release-key.pem> <scp destination> [--install] | watch --uninstall | approve <vX.Y.Z> <release-key.pem>');
  process.exit(2);
}

// The code this script runs is a release a person approved here (#756), or it stops before the key is used: the
// checkout it lives in is at a commit an approval names (an approval of tag vX.Y.Z, signed with this key, kept in
// the approvals folder), and has no local changes to its code. Returns { repo, commit, tag }; throws, saying how
// to get back to an approved release, otherwise. Self-contained (node: modules only), as it runs before src/ is
// trusted; the approval's wording is scripts/signer.js's approvalText, which a test keeps the same.
function approvedCode(pem) {
  const here = fileURLToPath(new URL('..', import.meta.url));
  const git = (...args) => execFileSync('git', ['-C', here, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let repo, commit;
  try { repo = git('rev-parse', '--show-toplevel'); commit = git('rev-parse', 'HEAD'); } catch {
    throw new Error(`${here} isn't a git checkout, so the signer can't tell which release its code is: run it from a checkout of nuworq at a release you approved`);
  }
  const pub = createPublicKey(createPrivateKey(readFileSync(pem)));
  const nuworq = join(homedir(), '.nuworq');
  const dir = join(existsSync(nuworq) || !existsSync(join(homedir(), '.trellis')) ? nuworq : join(homedir(), '.trellis'), 'release-approvals');
  let names = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch {}
  const approved = names.flatMap((f) => {
    try {
      const x = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const ok = /^v\d+\.\d+\.\d+$/.test(x.tag) && verify(null, Buffer.from(`nuworq release approval: ${x.tag} ${x.commit}\n`), pub, Buffer.from(String(x.sig), 'base64'));
      return ok ? [{ tag: x.tag, commit: x.commit, at: Number(x.at) || 0 }] : [];
    } catch { return []; }
  }).sort((x, y) => y.at - x.at);
  const mine = approved.find((x) => x.commit === commit);
  const back = approved[0]
    ? `Check out the newest release you approved: git -C ${repo} checkout ${approved[0].commit.slice(0, 12)} (${approved[0].tag}), then run this again from there.`
    : `No approved release is recorded in ${dir}: check out the release tag you trust (git -C ${repo} checkout vX.Y.Z) and approve it from there with the code you signed it with, or ask whoever keeps the signer.`;
  if (!mine) throw new Error(`this checkout (${repo}) is at ${commit.slice(0, 7)}, not a release approved with this key, so its code doesn't get the release key (#756). ${back}`);
  const changed = git('status', '--porcelain', '--untracked-files=all', '--', 'scripts', 'src', 'bin', 'web', 'package.json');
  if (changed) throw new Error(`this checkout (${repo}) is at ${mine.tag}, but its code has local changes (${changed.split('\n').length} file(s) under scripts, src, bin or web), so it isn't the release you approved (#756). Discard them (git -C ${repo} stash, or checkout ${mine.tag} -- .), then run this again.`);
  return { repo, commit, tag: mine.tag };
}

// Where approvals are kept: beside the signer's state, signed with the key, so only its holder makes one.
async function approvalsDir() {
  const { dataDir } = await import('../src/names.js');
  return join(dataDir(), 'release-approvals');
}

// approve: a person says a release may be signed (#473). Only at a terminal, and only after typing the tag back:
// an agent with a shell has no terminal to answer at. The approval names the commit, so a tag moved later
// isn't approved.
async function approveCmd(tag, pem) {
  const { repoRoot } = await import('../src/client.js');
  const { proposedRelease, writeApproval } = await import('./signer.js');
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('approve needs a person at a terminal: run it yourself, in a terminal on the machine that holds the release key');
  }
  const repo = repoRoot(process.cwd());
  if (!repo) throw new Error('run approve in a checkout of nuworq: it reads the release tag from its origin (GitHub)');
  const key = createPrivateKey(readFileSync(pem));
  const r = await proposedRelease(repo, tag);
  if (!r) throw new Error(`origin has no release tag ${tag} (a vX.Y.Z tag): a release is tagged when its item lands`);
  console.log(`${r.tag} is ${r.commit}\n  ${r.subject}\n\nWhat it ships (its CHANGELOG.md entry):\n${r.changes.split('\n').map((l) => `  ${l}`).join('\n') || '  (none)'}\n`);
  if (r.refusal) console.log(`The signer will refuse it anyway: ${r.refusal}.\n`);
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`Type ${r.tag} to approve signing it, or anything else to stop: `)).trim();
  rl.close();
  if (typed !== r.tag) return console.log('Not approved. Nothing changed.');
  const dir = await approvalsDir();
  writeApproval(dir, key, r);
  console.log(`Approved ${r.tag} (${r.commit.slice(0, 7)}), kept in ${dir}. The signer signs it at its next round (within 5 minutes), and the plugin's release branch moves to it.`);
}

// watch: the signer (scripts/signer.js), in the foreground, or installed as a service with --install. code: the
// approved release this script runs as (approvedCode); the service is pinned to it.
async function watchCmd(code) {
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
    // Pinned to the approved release it was installed from (#756): moved off it, the service says so and waits.
    const command = signer.pinnedCommand({ ...code, command: [svc.stableNode(process.execPath), self, 'watch', new URL(hub).origin, resolve(pem), dest] });
    const r = await svc.install({ ...where, command, env: svc.serviceEnv(process.env), log, cwd: repo });
    if (!r.up) process.exitCode = 1;
    return console.log(`${r.up ? `Installed the release signer as a ${r.kind}, and it is up.` : `Installed the release signer as a ${r.kind}, but it isn't up after 10 seconds. Check on it with: ${r.status}`}
  Signs:   each new vX.Y.Z tag on main at ${repo}'s origin, for ${new URL(hub).origin}
  Runs:    ${code.tag} (${code.commit.slice(0, 7)}) only; to move it to a newer release, approve that release, check it out here, and install again
  Wrote:   ${r.file}
  Log:     ${r.log}
  Remove:  node ${self} watch --uninstall`);
  }
  // A signed release is said on its release item, when this machine is connected to a hub (nuworq connect).
  const conn = connected();
  const client = conn && createClient({ url: conn.url, cwd: repo });
  const as = { agent: 'nuworq-signer' };
  const itemOf = async (version) => {
    const look = async (stage) => (await client.call('look', stage ? { stage } : {}, as)).board;
    return signer.releaseItem(await look(), version) ?? signer.releaseItem(await look('done'), version) ?? undefined;
  };
  const comment = !conn ? undefined : async (r) => {
    await client.call('comment', { item: await itemOf(r.version), headline: `Signed v${r.version} (${r.short})` }, as);
  };
  // A release waiting for approval is a question to the human, so it shows under Needs you. Answering it on the
  // hub approves nothing: only the approve command, where the key is, does.
  const approvals = await approvalsDir();
  const ask = !conn ? undefined : async (r) => (await client.call('ask', {
    item: await itemOf(r.version), to: 'human', blocking: true,
    question: `Approve release ${r.tag} (${r.short})? It isn't signed, and reaches no one's machine, until you do`,
    context: `${r.tag} is tagged on main. The signer signs it, and moves the plugin's release branch to it, only once you approve it where the release key lives. Answering here doesn't approve it.`,
    steps: [
      { do: `Read what ${r.tag} ships`, where: `the release item, or CHANGELOG.md at ${r.short}`, check: 'you want all of it on people\'s machines' },
      { do: `Approve it on the machine that holds the release key, in a terminal`, where: `cd ${repo} && node scripts/sign-release.js approve ${r.tag} ${resolve(pem)}`, check: `it shows ${r.short} and its changelog; type ${r.tag} and it prints "Approved ${r.tag}"` },
      { do: 'Wait for the signer', where: join(dataDir(), 'logs', 'signer.log'), check: `within 5 minutes it logs "signed v${r.version}", the release item gets "Signed v${r.version} (${r.short})", and this question goes away. To not ship it, do nothing.` },
    ],
  }, as)).question;
  const withdraw = !conn ? undefined : (id, reason) => client.call('withdraw', { question: id, reason }, as);
  const scp = (file, to) => exec('scp', ['-q', '-o', 'BatchMode=yes', file, to]);
  console.log(`Signing each new release tag for ${new URL(hub).origin} from ${repo} once you approve it (approve <vX.Y.Z>), every ${signer.EVERY / 60_000} minutes.`);
  await signer.watch({ repo, hub, key, dest, scp, approvals, comment, ask, withdraw, log: (l) => console.log(l), stateFile: join(dataDir(), 'signer.json') });
}
