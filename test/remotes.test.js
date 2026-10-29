import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hub, normRemote } from '../src/core.js';
import { view } from '../src/insight.js';
import { repoRemote, repoRoot } from '../src/client.js';

function setup() {
  const hub = new Hub({ clock: () => Date.UTC(2026, 9, 1, 9) });
  const op = (slug, o, agent, args = {}, where = {}) => hub.agentOp(slug, o, agent, args, where);
  return { hub, op };
}

describe('projects are found by git remote', () => {
  test('every form of the same remote normalizes to host/owner/repo', () => {
    for (const r of ['git@github.com:Acme/api.git', 'ssh://git@github.com:22/acme/api', 'https://user@github.com/acme/api.git', 'https://github.com/acme/api/', 'github.com/acme/api']) {
      assert.equal(normRemote(r), 'github.com/acme/api', r);
    }
    assert.equal(normRemote(''), '');
    assert.equal(normRemote('/srv/git/api.git'), '/srv/git/api', 'a local bare repo stays a path');
  });

  test('a named checkin from a clone teaches the project its remote; any clone anywhere then finds it', () => {
    const { hub, op } = setup();
    op('api', 'checkin', 'a', {}, { root: '/home/paul/api', remote: 'git@github.com:acme/api.git' });
    assert.deepEqual(hub.remotesOf(hub.project('api')), ['github.com/acme/api']);
    assert.match(view(hub, 'api').activity.find((e) => e.type === 'remote').headline, /api is the repository github\.com\/acme\/api/);
    hub.humanOp('api', 'create', { title: 'Do it', acceptance: 'x' });
    // another machine, unrelated path, no project named
    const brief = op('', 'checkin', 'b', {}, { root: '/other/machine/api', remote: 'https://github.com/acme/api' });
    assert.equal(brief.project, 'api');
    assert.equal(brief.routed, undefined, 'found, not routed');
    assert.equal(brief.workspace, '/other/machine/api', 'its own clone is the right place to work');
    const next = op('', 'next', 'b', {}, { root: '/other/machine/api', remote: 'https://github.com/acme/api' });
    assert.equal(next.item, '#1');
    assert.equal(next.workspace, '/other/machine/api');
    // naming the project from that clone gets no "you are in the wrong folder" warning either
    assert.equal(op('api', 'checkin', 'c', {}, { root: '/third/place', remote: 'github.com/acme/api' }).workspace, '/third/place');
  });

  test('without a remote, path matching works as before', () => {
    const { hub, op } = setup();
    op('lantern', 'checkin', 'a', {}, { root: '/code/lantern' });
    assert.deepEqual(hub.remotesOf(hub.project('lantern')), []);
    assert.equal(op('', 'checkin', 'b', {}, { root: '/code/lantern/src' }).project, 'lantern');
    assert.match(op('lantern', 'checkin', 'c', {}, { root: '/elsewhere' }).workspace, /lives in \/code\/lantern, but you are in \/elsewhere/);
  });

  test('one repository maps to one project', () => {
    const { hub, op } = setup();
    op('api', 'checkin', 'a', {}, { root: '/x/api', remote: 'github.com/acme/api' });
    // naming another project from the same clone doesn't steal the remote
    op('other', 'checkin', 'a', {}, { root: '/x/api', remote: 'github.com/acme/api' });
    assert.deepEqual(hub.remotesOf(hub.project('other')), []);
    assert.throws(() => hub.humanOp('other', 'remote', { add: 'git@github.com:acme/api.git' }), (e) => /already belongs to api/.test(e.message) && /Remove it from api first/.test(e.hint));
    hub.humanOp('other', 'remote', { add: 'https://github.com/acme/api-fork' });
    assert.deepEqual(view(hub, 'other').project.remotes, ['github.com/acme/api-fork']);
    hub.humanOp('api', 'remote', { remove: 'https://github.com/acme/api.git' });
    assert.deepEqual(hub.remotesOf(hub.project('api')), []);
    assert.throws(() => hub.humanOp('api', 'remote', { remove: 'github.com/acme/api' }), /has no remote/);
    assert.throws(() => hub.humanOp('api', 'remote', { add: '  ' }), /a remote is required/);
  });

  test('the client reads the remote from git; a worktree reports the same remote and root', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-remote-')));
    const repo = join(dir, 'api');
    const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'remote', 'add', 'origin', 'git@github.com:Acme/api.git');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', join(dir, 'wt'));
    assert.equal(repoRemote(repo), 'github.com/acme/api');
    assert.equal(repoRemote(join(dir, 'wt')), 'github.com/acme/api');
    assert.equal(repoRoot(join(dir, 'wt')), repo);
    assert.equal(repoRemote(dir), '', 'not a repo: no remote');
    const { hub, op } = setup();
    op('api', 'checkin', 'a', {}, { root: repoRoot(repo), remote: repoRemote(repo) });
    assert.equal(op('', 'checkin', 'b', {}, { root: repoRoot(join(dir, 'wt')), remote: repoRemote(join(dir, 'wt')) }).project, 'api');
  });
});
