// What an operator declares when nothing is typed after /nuworq:operator, and the rules that let its routine
// commands run without prompts (#494, src/operator.js). Commands are faked: run(cmd, args) answers from a table.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect, declared, rules, sshHost, applyRules, localOf, saveLocal } from '../src/operator.js';

// A machine whose commands answer as given: key "cmd arg…" → output (ok), or null (fails).
const machine = (answers) => {
  const ran = [];
  return { ran, run: async (cmd, args) => { const k = [cmd, ...args].join(' '); ran.push(k); const a = answers[k]; return a == null ? { ok: false, out: 'not found' } : { ok: true, out: a }; } };
};
const tags = (r) => Object.fromEntries(r.found.map((f) => [f.tag, f.ok]));
const REPO = 'gh api repos/acme/api --jq .permissions.admin';

describe('detection (#494)', () => {
  test('everything present: the OS, claude-cli, github-admin on every repo, browser, infra', async () => {
    const m = machine({ 'claude --version': '2.1.200 (Claude Code)\n', [REPO]: 'true\n', 'gh api repos/acme/web --jq .permissions.admin': 'true' });
    const r = await detect({ platform: 'darwin', run: m.run, chrome: true, repos: ['github.com/acme/api', 'github.com/acme/web'] });
    assert.deepEqual(r.has, ['operator', 'macos', 'claude-cli', 'github-admin', 'browser', 'infra']);
    assert.equal(declared(r.found), 'Operator: macos, claude-cli, github-admin (admin on acme/api, acme/web), browser, infra');
    assert.match(r.found.find((f) => f.tag === 'claude-cli').why, /claude runs \(2\.1\.200 \(Claude Code\)\)/);
  });

  test('each absent, with why', async () => {
    const m = machine({ [REPO]: 'false' });
    const r = await detect({ platform: 'linux', run: m.run, chrome: false, repos: ['github.com/acme/api'], local: { without_infra: true } });
    assert.deepEqual(tags(r), { linux: true, 'claude-cli': false, 'github-admin': false, browser: false, infra: false });
    assert.deepEqual(r.has, ['operator', 'linux']);
    assert.match(r.found.find((f) => f.tag === 'github-admin').why, /not admin on acme\/api/);
    assert.match(r.found.find((f) => f.tag === 'infra').why, /--without infra/);
    assert.equal(declared(r.found), 'Operator: linux');
  });

  test('github-admin needs admin on every repository, and gh signed in; no GitHub repository, none', async () => {
    const one = await detect({ run: machine({ [REPO]: 'true' }).run, repos: ['github.com/acme/api', 'github.com/acme/web'] });
    assert.equal(tags(one)['github-admin'], false, 'admin on one of two is not enough');
    assert.match(one.found.find((f) => f.tag === 'github-admin').why, /gh can't read acme\/web/);
    const none = await detect({ run: machine({}).run, repos: ['gitlab.com/acme/api'] });
    assert.match(none.found.find((f) => f.tag === 'github-admin').why, /no GitHub repository/);
  });

  test("infra: declared by default; with this machine's check, only while it passes", async () => {
    assert.equal(tags(await detect({ run: machine({}).run })).infra, true);
    const pass = machine({ '/bin/sh -c ssh -o BatchMode=yes vm true': '' });
    assert.equal(tags(await detect({ run: pass.run, local: { infra_check: 'ssh -o BatchMode=yes vm true' } })).infra, true);
    assert.ok(pass.ran.includes('/bin/sh -c ssh -o BatchMode=yes vm true'), 'it ran the local check');
    assert.equal(tags(await detect({ run: machine({}).run, local: { infra_check: 'ssh vm true' } })).infra, false);
  });

  test('the check is kept on this machine, readable only by its person', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nuworq-op-')), 'operator.json');
    assert.deepEqual(localOf(file), {});
    saveLocal(file, { infra_check: 'ssh vm true' });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(saveLocal(file, { without_infra: true }), { infra_check: 'ssh vm true', without_infra: true });
    assert.deepEqual(saveLocal(file, { infra_check: null, without_infra: null }), {});
  });
});

describe('the operator\'s permission rules (#494)', () => {
  test("routine commands allowed, destructive forms denied; ssh only to the infra check's host", () => {
    assert.equal(sshHost('ssh -o BatchMode=yes nuworq-vm true'), 'nuworq-vm');
    assert.equal(sshHost('ssh -i ~/.ssh/k root@box.lan uptime'), 'box.lan');
    assert.equal(sshHost('curl -sf https://x'), null);
    const r = rules({ host: 'nuworq-vm' });
    for (const a of ['Bash(nuworq:*)', 'Bash(git push:*)', 'Bash(git rebase:*)', 'Bash(gh pr:*)', 'Bash(gh run:*)', 'Bash(gh api:*)', 'Bash(ssh nuworq-vm:*)']) assert.ok(r.allow.includes(a), a);
    for (const d of ['Bash(git push --force:*)', 'Bash(git push * --delete*)', 'Bash(git branch -D:*)', 'Bash(git tag -d:*)', 'Bash(gh api * -X *)', 'Bash(gh api * -f *)', 'Bash(gh repo delete:*)']) assert.ok(r.deny.includes(d), d);
    assert.ok(!rules().allow.some((a) => a.startsWith('Bash(ssh')), 'no check: no ssh');
    assert.ok(!r.allow.some((a) => /^Bash\((rm|curl|sh|bash|python)/.test(a)), 'nothing else');
  });

  test('applied to a settings file and taken out again, leaving what was there', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nuworq-rules-')), '.claude', 'settings.local.json');
    const r = rules();
    assert.deepEqual(applyRules(file, r), { added: r.allow.length + r.deny.length, removed: 0 });
    assert.deepEqual(applyRules(file, r), { added: 0, removed: 0 }, 'twice is the same');
    applyRules(file, r, { off: true });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {});
    writeFileSync(file, '{ not json');
    assert.throws(() => applyRules(file, r), /isn't plain JSON/);
  });
});
