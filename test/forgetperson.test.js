import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Workspaces } from '../src/workspaces.js';

const BIN = new URL('../bin/nuworq.js', import.meta.url).pathname;
const count = (d, sql, ...a) => d.db.prepare(sql).get(...a).n;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'nuworq-forget-'));
  const spaces = new Workspaces({ dir: join(dir, 'workspaces') });
  const d = spaces.directory;
  const ann = d.identify('ann@example.test', 'github'), bob = d.identify('bob@example.test', 'google');
  const annSid = d.createSession(ann.id), bobSid = d.createSession(bob.id);
  d.createSession(ann.id, 'admin');
  d.join('ann@example.test', 'acme'); d.join('ann@example.test', 'beta', { created: true }); d.join('bob@example.test', 'acme');
  d.request({ email: 'ann@example.test', building: 'rockets', github: 'ann' });
  d.request({ email: 'bob@example.test', building: 'boats' });
  return { dir, spaces, d, annSid, bobSid };
}

test("forgetting a person removes their identity, sessions, memberships and request; nobody else's", () => {
  const { d, annSid, bobSid } = setup();
  // ann sent feedback, and as one of the hub's owners decided bob's feedback and his request
  const annSaid = d.giveFeedback({ kind: 'person', sender: '@ann', email: 'Ann@example.test', workspace: 'acme', text: 'the board is slow' });
  const bobSaid = d.giveFeedback({ kind: 'person', sender: '@bob', email: 'bob@example.test', workspace: 'acme', text: 'dark mode please' });
  d.decideFeedback(bobSaid.id, { approve: false, by: 'ann@example.test', note: 'later' });
  d.decide(d.db.prepare("SELECT id FROM access_requests WHERE email = 'bob@example.test'").get().id, true, 'ann@example.test');
  const dry = d.forgetPerson(' Ann@Example.test ', { dryRun: true });
  assert.deepEqual(dry, { identities: 1, sessions: 2, memberships: ['acme', 'beta'], access_requests: 1, grants: 0, feedback: 1, decisions: 2 });
  assert.equal(d.feedbackById(annSaid.id).email, 'ann@example.test', 'a dry run blanks nothing');
  assert.ok(d.identity('ann@example.test'), 'a dry run deletes nothing');
  assert.ok(d.verifySession(annSid));

  assert.deepEqual(d.forgetPerson('ann@example.test'), dry);
  assert.equal(d.identity('ann@example.test'), null);
  assert.equal(d.verifySession(annSid), null);
  assert.equal(count(d, 'SELECT COUNT(*) AS n FROM hub_sessions'), 1);
  assert.equal(count(d, "SELECT COUNT(*) AS n FROM access_requests WHERE email = 'ann@example.test'"), 0);
  assert.equal(count(d, 'SELECT COUNT(*) AS n FROM memberships'), 1);

  assert.equal(d.verifySession(bobSid).email, 'bob@example.test');
  assert.equal(count(d, "SELECT COUNT(*) AS n FROM access_requests WHERE email = 'bob@example.test'"), 1);
  // her feedback keeps its words under her handle, without her email; her decisions stand, unsigned; bob's is his
  const kept = d.feedbackById(annSaid.id);
  assert.deepEqual([kept.sender, kept.text, kept.email], ['@ann', 'the board is slow', '']);
  assert.equal(count(d, "SELECT COUNT(*) AS n FROM feedback WHERE email = 'ann@example.test' OR decided_by = 'ann@example.test'"), 0);
  assert.equal(count(d, "SELECT COUNT(*) AS n FROM access_requests WHERE decided_by = 'ann@example.test'"), 0);
  assert.deepEqual(['email', 'state', 'note'].map((k) => d.feedbackById(bobSaid.id)[k]), ['bob@example.test', 'declined', 'later']);
  assert.equal(d.db.prepare("SELECT state FROM access_requests WHERE email = 'bob@example.test'").get().state, 'approved');

  // signing in again starts clean: a new identity, no memberships, no old sessions
  const again = d.identify('ann@example.test', 'github');
  assert.equal(count(d, 'SELECT COUNT(*) AS n FROM memberships WHERE identity_id = ?', again.id), 0);
  assert.equal(count(d, 'SELECT COUNT(*) AS n FROM hub_sessions WHERE identity_id = ?', again.id), 0);
  assert.deepEqual(d.forgetPerson('nobody@example.test'), { identities: 0, sessions: 0, memberships: [], access_requests: 0, grants: 0, feedback: 0, decisions: 0 });
});

test('a granted request goes with its grant', () => {
  const { d } = setup();
  const ann = d.identity('ann@example.test');
  const { code } = d.decide(d.db.prepare("SELECT id FROM access_requests WHERE email = 'ann@example.test'").get().id, true, 'owner');
  assert.equal(d.useGrant(code, ann, 'beta'), true);
  assert.equal(d.forgetPerson('ann@example.test').grants, 1);
  assert.equal(count(d, 'SELECT COUNT(*) AS n FROM org_grants'), 0);
});

test('nuworq person forget: --dry-run lists, the real run deletes and names what it keeps', () => {
  const { dir, d } = setup();
  d.giveFeedback({ kind: 'person', sender: '@ann', email: 'ann@example.test', workspace: 'acme', text: 'the board is slow' });
  d.close();
  const run = (...a) => spawnSync(process.execPath, [BIN, 'person', 'forget', 'ann@example.test', '--data-dir', dir, ...a], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  const dry = run('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Would remove: 1 sign-in identity, 2 sessions, 2 workspace memberships \(acme, beta\), 1 early-access request/);
  assert.match(dry.stdout, /Nothing was changed/);
  const real = run();
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /Removed: 1 sign-in identity, 2 sessions/);
  assert.match(real.stdout, /Blanked the email on 1 piece of feedback they sent and 0 decisions/);
  assert.match(real.stdout, /Kept: the words of that feedback, under their handle.*Stripe billing records/);
  assert.match(run('--dry-run').stdout, /Would remove: 0 sign-in identities, 0 sessions/);
});
