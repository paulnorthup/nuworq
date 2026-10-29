import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hub, normRemote } from '../src/core.js';
import { view, itemView } from '../src/insight.js';

// A project with two repositories. Bare repos play GitHub (acme/api and acme/web); agents work in
// their own clones; the hub keeps mirrors. checkout: the hub also has a clone of api as its path.
function twoRepos({ checkout = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-repos-')));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const bare = (name) => {
    const dir = join(root, 'github', 'acme', `${name}.git`);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '--bare', '-b', 'main');
    return dir;
  };
  const api = bare('api'), web = bare('web');
  const clone = (origin, name) => {
    const dir = join(root, name);
    git(root, 'clone', '-q', origin, dir);
    return dir;
  };
  for (const [origin, name] of [[api, 'seed-api'], [web, 'seed-web']]) {
    const seed = clone(origin, name);
    writeFileSync(join(seed, 'README'), `${name}\n`);
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'init');
    git(seed, 'push', '-q', 'origin', 'main');
  }
  const hub = new Hub({ clock: () => Date.UTC(2026, 9, 29, 9), repos: join(root, 'hub', 'repos') });
  hub.tx(() => hub.project('demo', { create: true }));
  hub.humanOp('demo', 'remote', { add: api });
  hub.humanOp('demo', 'remote', { add: web });
  if (checkout) hub.humanOp('demo', 'settings', { path: clone(api, 'hub-checkout') });
  const op = (agent, name, args = {}) => hub.agentOp('demo', name, agent, args);
  const build = (dir, branch, file) => {
    git(dir, 'fetch', '-q', 'origin');
    git(dir, 'switch', '-q', '-c', branch, 'origin/main');
    writeFileSync(join(dir, file), `${file}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', `add ${file}`);
  };
  const item = (n) => hub.item(hub.project('demo'), `#${n}`);
  return { hub, root, git, api, web, API: normRemote(api), WEB: normRemote(web), clone, op, build, item };
}

describe('each item names its repo', () => {
  test('propose and refine take repo in any form git accepts; it must be one of the project\'s', () => {
    const hub = new Hub({ clock: () => Date.UTC(2026, 9, 29, 9) });
    hub.tx(() => hub.project('demo', { create: true }));
    hub.humanOp('demo', 'remote', { add: 'github.com/acme/api' });
    hub.humanOp('demo', 'remote', { add: 'github.com/acme/web' });
    const op = (name, args) => hub.agentOp('demo', name, 'a1', args);
    const p = hub.project('demo');

    op('propose', { title: 'Web thing', repo: 'git@github.com:Acme/web.git' });
    assert.equal(hub.item(p, '#1').repo, 'github.com/acme/web');
    assert.throws(() => op('propose', { title: 'Elsewhere', repo: 'github.com/acme/other' }),
      (e) => /isn't one of demo's repositories/.test(e.message) && /github\.com\/acme\/api, github\.com\/acme\/web/.test(e.hint));
    assert.equal(hub.q('SELECT COUNT(*) AS n FROM items').get().n, 1, 'nothing created');

    op('propose', { title: 'No repo given' });
    assert.equal(hub.item(p, '#2').repo, '', 'stored as none');
    assert.equal(op('claim', { item: '#2' }).repo, 'github.com/acme/api', 'with several, no repo means the first, as before');
    op('refine', { item: '#1', repo: 'https://github.com/acme/api' });
    assert.equal(hub.item(p, '#1').repo, 'github.com/acme/api');
    assert.throws(() => op('refine', { item: '#1', repo: 'github.com/acme/nope' }), /isn't one of/);
  });

  test('in a one-repo project an item defaults to that repo', () => {
    const hub = new Hub({ clock: () => Date.UTC(2026, 9, 29, 9) });
    hub.tx(() => hub.project('demo', { create: true }));
    hub.humanOp('demo', 'remote', { add: 'github.com/acme/api' });
    hub.humanOp('demo', 'create', { title: 'Thing', acceptance: 'x' });
    assert.equal(hub.agentOp('demo', 'next', 'a1').repo, 'github.com/acme/api');
    assert.equal(view(hub, 'demo').all[0].repo, null, 'one repo: the UI shows none');
  });

  test('two repos, one item in each: each lands only when its own repo\'s main has it', () => {
    const { hub, git, api, web, API, WEB, clone, op, build, item } = twoRepos();
    hub.humanOp('demo', 'create', { title: 'Web page', acceptance: 'x', repo: web });
    hub.humanOp('demo', 'create', { title: 'Api endpoint', acceptance: 'x' });

    const j1 = op('a1', 'next');
    assert.equal(j1.item, '#1');
    assert.equal(j1.repo, WEB, "the claim names the item's repo");
    assert.match(j1.hint, new RegExp(`This is in ${WEB}`));
    assert.match(j1.hint, /git switch -c nuworq\/1-web-page origin\/main/);
    const j2 = op('a2', 'next');
    assert.equal(j2.repo, API);

    // a1 works in a clone of web; a2 in a clone of api.
    const macWeb = clone(web, 'mac-web'), macApi = clone(api, 'mac-api');
    build(macWeb, j1.branch, 'page');
    git(macWeb, 'push', '-q', 'origin', j1.branch);
    op('a1', 'submit', { item: '#1', headline: 'Page added' });
    const g1 = JSON.parse(hub.q(`SELECT data FROM events WHERE type = 'submitted' AND item_id = ?`).get(item(1).id).data).git;
    assert.equal(g1.branch, j1.branch, "git facts come from web's mirror");
    assert.deepEqual(g1.commits.map((c) => c.subject), ['add page']);

    build(macApi, j2.branch, 'endpoint');
    op('a2', 'submit', { item: '#2', headline: 'Endpoint added' });
    const g2 = JSON.parse(hub.q(`SELECT data FROM events WHERE type = 'submitted' AND item_id = ?`).get(item(2).id).data).git;
    assert.equal(g2.unpushed, j2.branch, "not on api's origin yet");
    git(macApi, 'push', '-q', 'origin', j2.branch);

    hub.humanOp('demo', 'accept', { item: '#1' });
    hub.humanOp('demo', 'accept', { item: '#2' });
    assert.equal(item(1).stage, 'landing');
    assert.equal(item(2).stage, 'landing');

    // #1's branch on api's main (and as a branch there) does not land it: it belongs in web.
    const apiMain = git(api, 'rev-parse', 'main');
    git(macWeb, 'push', '-q', api, j1.branch, `${j1.branch}:refs/heads/main`, '--force');
    const land1 = op('a1', 'next');
    assert.equal(land1.mode, 'land');
    assert.match(land1.hint, new RegExp(`This is in ${WEB}`));
    assert.throws(() => op('a1', 'submit', { item: '#1', headline: 'Landed' }), /main doesn't contain nuworq\/1-web-page yet/);
    git(api, 'update-ref', 'refs/heads/main', apiMain);
    git(api, 'update-ref', '-d', `refs/heads/${j1.branch}`);
    git(macWeb, 'push', '-q', 'origin', `${j1.branch}:main`);
    op('a1', 'submit', { item: '#1', headline: 'Landed' });
    assert.equal(item(1).stage, 'done');

    // #2 (no repo: the first, api): web's main having it would not count either; api's does.
    const land2 = op('a2', 'next');
    assert.equal(land2.mode, 'land');
    git(macApi, 'fetch', '-q', 'origin');
    git(macApi, 'rebase', '-q', 'origin/main');
    git(macApi, 'push', '-q', 'origin', `${j2.branch}:main`);
    git(macApi, 'push', '-q', 'origin', j2.branch, '--force-with-lease');
    op('a2', 'submit', { item: '#2', headline: 'Landed' });
    assert.equal(item(2).stage, 'done');

    const all = view(hub, 'demo').all;
    assert.deepEqual(all.map((i) => i.repo), ['acme/web', 'acme/api'], 'several repos: each item shows its own');
    assert.equal(itemView(hub, 'demo', '#1').repo, 'acme/web');
  });

  test('the hub\'s checkout is used only for items in its repo; others go through the mirror', () => {
    const { hub, WEB, op } = twoRepos({ checkout: true });
    hub.humanOp('demo', 'create', { title: 'Api thing', acceptance: 'x' });
    hub.humanOp('demo', 'create', { title: 'Web thing', acceptance: 'x', repo: WEB });
    const p = hub.project('demo');
    assert.equal(hub.repoFor(p, hub.item(p, '#1')).mode, 'local');
    assert.equal(hub.repoFor(p, hub.item(p, '#2')).mode, 'remote');
    const j1 = op('a1', 'next'), j2 = op('a2', 'next');
    assert.match(j1.hint, /git switch -c nuworq\/1-api-thing main/, 'local: cut from main in the checkout');
    assert.match(j2.hint, /git switch -c nuworq\/2-web-thing origin\/main/, 'web: cut from origin, pushed for review');
    assert.match(j2.hint, /git push origin nuworq\/2-web-thing/);
  });

  test('shaping in a multi-repo project says to split work per repo, with depends_on for the order', () => {
    const { hub, op } = twoRepos();
    op('a1', 'propose', { title: 'Feature across api and web' });
    const job = op('a1', 'next');
    assert.equal(job.mode, 'shape');
    assert.match(job.hint, /one sub-item per repository, with depends_on giving the order/);

    const one = new Hub({ clock: () => Date.UTC(2026, 9, 29, 9) });
    one.tx(() => one.project('solo', { create: true }));
    one.humanOp('solo', 'remote', { add: 'github.com/acme/api' });
    one.agentOp('solo', 'propose', 'a1', { title: 'Idea' });
    assert.doesNotMatch(one.agentOp('solo', 'next', 'a1').hint, /sub-item per repository/);
  });
});
