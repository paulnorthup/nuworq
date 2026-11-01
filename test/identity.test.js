// Who someone is comes only from how they signed in (#470): an email an owner types is a hint, never an identity.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';
import { Auth } from '../src/auth.js';
import { openDb } from '../src/db.js';
import { addChannel, ownerChannels } from '../src/notify.js';
import { Hub } from '../src/core.js';

const PAUL = 'paul@example.com';
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

describe('a typed email makes no membership', () => {
  // Paul owns the hub and signed in to his own workspace. Mallory signed up for hers, then types Paul's email.
  async function setup() {
    const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-id-')), plans: true, owners: [PAUL] });
    const dir = spaces.directory;
    spaces.create('pauls');
    new Auth(spaces.get('pauls').db).addPerson('paul', 'owner', { email: PAUL, verified: true });
    dir.identify(PAUL, 'github');
    dir.join(PAUL, 'pauls');
    addChannel(spaces.get('pauls').db, 'webhook', 'http://127.0.0.1:1/paul', Date.now(), { person: '@paul' });
    spaces.create('evil');
    const evil = new Auth(spaces.get('evil').db);
    evil.addPerson('mallory', 'owner', { email: 'mallory@evil.test', verified: true });
    dir.identify('mallory@evil.test', 'github');
    dir.join('mallory@evil.test', 'evil', { created: true });
    const token = evil.createToken('mallory-web', 'human', { person: 'mallory' });
    const server = createServer(spaces, { earlyAccess: { owners: [PAUL], verify: async () => true } });
    const base = `http://127.0.0.1:${await listen(server)}/w/evil`;
    const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { spaces, dir, evil, server, post };
  }

  test("an owner adding a person with the hub owner's email gets neither the unlimited plan nor the owners' pushes", async () => {
    const { spaces, dir, server, post } = await setup();
    try {
      assert.equal(spaces.planOf('evil'), 'free');
      assert.equal((await post('/api/people', { handle: 'boss', role: 'owner', email: PAUL })).status, 200);
      assert.equal((await post('/api/notify', { kind: 'webhook', url: 'http://127.0.0.1:1/sink', person: '@boss' })).status, 200);
      assert.equal(spaces.planOf('evil'), 'free', 'the plan still follows only Paul\'s own sign-ins');
      assert.deepEqual(dir.orgsOf(dir.identity(PAUL), spaces).map((m) => m.workspace), ['pauls']);
      assert.deepEqual(ownerChannels(spaces, [PAUL]).map(({ c }) => c.url), ['http://127.0.0.1:1/paul'], 'applicants\' details reach only Paul\'s channel');
    } finally { server.close(); spaces.close(); }
  });

  test('accepting an invite link to that email makes no membership either', async () => {
    const { spaces, dir, evil, server } = await setup();
    try {
      const inv = evil.createInvite('owner', { email: PAUL, by: '@mallory' });
      const port = server.address().port;
      const r = await fetch(`http://127.0.0.1:${port}/w/evil/api/invite/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: inv.token, handle: 'boss' }) });
      assert.equal(r.status, 200);
      assert.equal(spaces.planOf('evil'), 'free');
      assert.deepEqual(dir.orgsOf(dir.identity(PAUL), spaces).map((m) => m.workspace), ['pauls']);
    } finally { server.close(); spaces.close(); }
  });

  test('a stale membership left after typing counts only with a person who signed in there', async () => {
    const { spaces, dir, evil, server } = await setup();
    try {
      evil.addPerson('boss', 'owner', { email: PAUL });
      dir.join(PAUL, 'evil'); // as the hub did before #470
      assert.equal(spaces.planOf('evil'), 'free');
      assert.deepEqual(ownerChannels(spaces, [PAUL]).map(({ c }) => c.url), ['http://127.0.0.1:1/paul']);
    } finally { server.close(); spaces.close(); }
  });
});

describe('a role typed before its person signed in', () => {
  const auth = () => {
    const a = new Auth(new Hub().db);
    a.addPerson('own', 'owner', { email: 'own@acme.test', verified: true });
    return a;
  };

  test('comes in as a viewer until an owner confirms it', () => {
    const a = auth();
    a.addPerson('bea', 'steward', { email: 'bea@acme.test' });
    const r = a.signInByEmail('bea@acme.test', 'github');
    assert.deepEqual([r.person.handle, r.person.role, r.held, r.joined], ['bea', 'viewer', 'steward', true]);
    assert.equal(a.person('bea').role, 'viewer');
    assert.ok(a.person('bea').verified_at, 'the email is theirs now');
    a.setRole('bea', 'steward');
    const again = a.signInByEmail('bea@acme.test', 'github');
    assert.deepEqual([again.person.role, again.held, again.joined], ['steward', undefined, false]);
  });

  test('an invite bound to the email gives its role, to the typed person', () => {
    const a = auth();
    a.addPerson('bea', 'owner', { email: 'bea@acme.test' });
    a.createInvite('member', { email: 'bea@acme.test', by: '@own' });
    const r = a.signInByEmail('bea@acme.test', 'google');
    assert.deepEqual([r.person.handle, r.person.role, r.invitedBy, r.held], ['bea', 'member', '@own', undefined]);
    assert.equal(a.listPeople().length, 2, 'no second person for the same email');
  });

  test('an invite link they accepted keeps its role when they later sign in with its email', () => {
    const a = auth();
    const inv = a.createInvite('steward', { email: 'cy@acme.test' });
    a.acceptInvite(inv.token, 'cy');
    const r = a.signInByEmail('cy@acme.test', 'github');
    assert.deepEqual([r.person.handle, r.person.role, r.held, r.joined], ['cy', 'steward', undefined, false]);
  });

  test('a host-vouched person (person add on the command line) signs in with their role', () => {
    const a = auth();
    a.addPerson('dee', 'steward', { email: 'dee@acme.test', verified: true });
    assert.equal(a.signInByEmail('dee@acme.test', 'github').person.role, 'steward');
  });
});

test('people from before #470 keep their email as theirs only if they already have a login', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'nuworq-id-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE people (id INTEGER PRIMARY KEY, handle TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE tokens (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, role TEXT NOT NULL, hash BLOB NOT NULL, prefix TEXT NOT NULL, created_at INTEGER NOT NULL, person_id INTEGER);
    INSERT INTO people (handle, email, role, created_at) VALUES ('ann', 'ann@x.test', 'owner', 5), ('typed', 'boss@x.test', 'owner', 6);
    INSERT INTO tokens (name, role, hash, prefix, created_at, person_id) VALUES ('ann-github', 'human', x'00', 'nwq_xxxx', 5, 1);`);
  old.close();
  const db = openDb(file);
  assert.deepEqual(db.prepare('SELECT handle, verified_at FROM people ORDER BY id').all().map((p) => [p.handle, p.verified_at]), [['ann', 5], ['typed', null]]);
  db.close();
});
