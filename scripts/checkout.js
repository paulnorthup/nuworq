// Signing by hand's first check (#829), apart from scripts/sign-release.js so its test imports it without running that
// CLI. Node's built-ins and git only: release runs it before it loads any other repository module or reads the key.
import { execFileSync } from 'node:child_process';

// Why the checkout at root mustn't run release, with the key: '' when it may. release loads the checkout's own
// modules, which agents can land on main, so it runs only the code of the last signed release: HEAD must be the
// commit the hub names as its signed release, origin must tag that commit vX.Y.Z (only the maintainer makes v* tags),
// and no tracked file may differ from it. A safety net, not a guarantee: a checkout at main runs main's copy of this
// check, which landed code could change, so the maintainer switches to the tag before running release (docs/DEPLOY.md).
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
