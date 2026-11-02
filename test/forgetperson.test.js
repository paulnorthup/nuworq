import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Workspaces } from '../src/workspaces.js';
import { Auth } from '../src/auth.js';

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

// ann is a member of acme and beta, signed in to acme; bob owns both. Returns their Auths and ann's acme session.
function inWorkspaces() {
  const { dir, spaces, d } = setup();
  const auth = {};
  for (const s of ['acme', 'beta']) {
    spaces.create(s);
    auth[s] = new Auth(spaces.get(s).db);
    auth[s].addPerson('bob', 'owner', { email: 'bob@example.test', verified: true });
  }
  // creating a workspace forgets what its name held before (#749), so the memberships are made again
  d.join('ann@example.test', 'acme'); d.join('ann@example.test', 'beta'); d.join('bob@example.test', 'acme');
  auth.acme.addPerson('ann', 'member', { email: 'ann@example.test', verified: true });
  auth.beta.addPerson('annie', 'steward', { email: 'Ann@example.test' }); // typed by an owner, never signed in
  const { sid } = auth.acme.signInByEmail('ann@example.test', 'github');
  const bobSid = auth.acme.signInByEmail('bob@example.test', 'google').sid;
  auth.acme.createInvite('member', { email: 'ann@example.test', by: 'bob' });
  return { dir, spaces, d, auth, sid, bobSid };
}

test("forgetting a person ends their workspace sign-ins and removes their row there; signing in again isn't let back in", () => {
  const { spaces, d, auth, sid, bobSid } = inWorkspaces();
  d.setPlan('acme', 'team', 'ann@example.test');
  assert.ok(auth.acme.verifySession(sid));
  const dry = spaces.forgetPerson('ann@example.test', { dryRun: true });
  assert.deepEqual([dry.people, dry.invites, dry.last_owner, dry.decisions], [['acme:@ann', 'beta:@annie'], 1, [], 1]);
  assert.ok(auth.acme.verifySession(sid), 'a dry run ends nothing');

  const f = spaces.forgetPerson('ann@example.test');
  assert.deepEqual(f.people, ['acme:@ann', 'beta:@annie']);
  assert.equal(auth.acme.verifySession(sid), null);
  assert.equal(auth.acme.person('ann'), null);
  assert.equal(auth.beta.person('annie'), null);
  assert.equal(auth.acme.signInByEmail('ann@example.test', 'github'), null, 'no row and no open invite lets her back in');
  assert.equal(spaces.get('acme').db.prepare("SELECT COUNT(*) AS n FROM invites WHERE email = 'ann@example.test'").get().n, 0);
  assert.equal(d.db.prepare("SELECT set_by FROM plans WHERE workspace = 'acme'").get().set_by, '');
  // bob is untouched
  assert.ok(auth.acme.verifySession(bobSid));
  assert.equal(auth.beta.person('bob').email, 'bob@example.test');
  spaces.close();
});

test("a workspace's last owner isn't forgotten until it has another owner or is removed", () => {
  const { spaces, auth } = inWorkspaces();
  auth.beta.removePerson('annie');
  auth.beta.addPerson('ann', 'owner', { email: 'ann@example.test', verified: true });
  auth.beta.setRole('bob', 'member');
  assert.deepEqual(spaces.forgetPerson('ann@example.test', { dryRun: true }).last_owner, ['beta']);
  assert.throws(() => spaces.forgetPerson('ann@example.test'), /last owner of beta, so nothing was forgotten/);
  assert.ok(auth.acme.person('ann'), 'nothing changed anywhere');
  assert.ok(spaces.directory.identity('ann@example.test'));
  spaces.remove('beta');
  assert.deepEqual(spaces.forgetPerson('ann@example.test').people, ['acme:@ann']);
  spaces.close();
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
  const { dir, spaces, d } = inWorkspaces();
  d.giveFeedback({ kind: 'person', sender: '@ann', email: 'ann@example.test', workspace: 'acme', text: 'the board is slow' });
  spaces.close();
  const run = (...a) => spawnSync(process.execPath, [BIN, 'person', 'forget', 'ann@example.test', '--data-dir', dir, ...a], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  const dry = run('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Would remove: 1 sign-in identity, 2 hub sessions, 2 workspace memberships \(acme, beta\), 1 early-access request/);
  assert.match(dry.stdout, /Would remove: 2 workspace people \(acme:@ann, beta:@annie\), with their sign-ins there, and would revoke 1 open invite/);
  assert.match(dry.stdout, /Nothing was changed/);
  const real = run();
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /Removed: 1 sign-in identity, 2 hub sessions/);
  assert.match(real.stdout, /Removed: 2 workspace people \(acme:@ann, beta:@annie\)/);
  assert.match(real.stdout, /Blanked the email on 1 piece of feedback they sent and 0 decisions/);
  assert.match(real.stdout, /Kept: their handle on items, comments and history in each workspace.*\n.*Stripe billing records/);
  assert.match(run('--dry-run').stdout, /Would remove: 0 sign-in identities, 0 hub sessions.*\n.*0 workspace people/);
  const owner = spawnSync(process.execPath, [BIN, 'person', 'forget', 'bob@example.test', '--data-dir', dir], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(owner.status, 1);
  assert.match(owner.stderr, /error: bob@example.test is the last owner of acme, beta, so nothing was forgotten\nhint: Remove that workspace/);
  assert.doesNotMatch(owner.stderr, /at .*workspaces\.js/, 'no stack trace');
});
