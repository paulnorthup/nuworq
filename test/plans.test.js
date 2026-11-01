import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';
import { Auth } from '../src/auth.js';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const PAUL = 'paul@paulnorthup.com';
const fresh = (opts = {}) => new Workspaces({ dir: realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-plans-'))), plans: true, owners: [PAUL], ...opts });

// A workspace hub with one project and n ready items, made by someone who signed up (so Free), or by
// the host on the command line (by: null).
function org(spaces, name, n = 3, by = `owner@${name}.test`) {
  spaces.create(name);
  if (by) {
    spaces.directory.identify(by, 'github');
    spaces.directory.join(by, name, { created: true });
  }
  const hub = spaces.get(name);
  hub.tx(() => hub.project('app', { create: true }));
  for (let i = 1; i <= n; i++) hub.humanOp('app', 'create', { title: `Item ${i}`, acceptance: 'x' });
  return { hub, op: (agent, name2, args = {}) => hub.agentOp('app', name2, agent, args) };
}

// Plans (#113): Free runs one agent at a time, enforced where work is claimed.
describe('plan limits', () => {
  test('Free: a second agent claiming at the same time is refused with an upgrade hint; the first carries on', () => {
    const spaces = fresh();
    const { hub, op } = org(spaces, 'acme');
    try {
      assert.equal(spaces.planOf('acme'), 'free');
      op('a1', 'checkin');
      assert.equal(op('a1', 'next').mode, 'work');
      op('a2', 'checkin');
      assert.throws(() => op('a2', 'next'), (e) => e.status === 402 && /Free plan runs 1 agent at a time/.test(e.message) && /upgrade/i.test(e.hint));
      assert.throws(() => op('a2', 'claim', { item: '#2' }), (e) => e.status === 402);
      assert.equal(op('a2', 'next', { claim: false }).mode, 'work', 'peeking claims nothing, so it is allowed');
      op('a1', 'progress', { item: '#1', headline: 'Going' });

      // Shaping is a claim too: refused while a1 works.
      hub.humanOp('app', 'create', { title: 'An idea', stage: 'proposed' });
      op('a1', 'submit', { item: '#1', headline: 'Done' });
      assert.equal(op('a1', 'next').mode, 'work', 'the working agent may take its next job');
      assert.throws(() => op('a2', 'next'), (e) => e.status === 402, 'still one agent at a time');
      op('a1', 'handoff', { item: '#2', headline: 'Out' });
      const j = op('a2', 'next');
      assert.ok(['work', 'shape'].includes(j.mode), 'once a1 holds nothing, a2 may work');
      assert.equal(hub.item(hub.project('app'), j.item).holder, 'a2');
    } finally { spaces.close(); }
  });

  test('the hub owner sets an organization unlimited; the host-made ones and the owner\'s always are', () => {
    const spaces = fresh();
    try {
      const { op } = org(spaces, 'acme');
      spaces.setPlan('acme', 'unlimited', 'host');
      for (const a of ['a1', 'a2', 'a3']) { op(a, 'checkin'); assert.equal(op(a, 'next').mode, 'work'); }

      org(spaces, 'made-by-host', 1, null);
      assert.equal(spaces.planOf('made-by-host'), 'unlimited', 'nuworq workspace create on the host');
      spaces.setPlan('made-by-host', 'free');
      assert.equal(spaces.planOf('made-by-host'), 'free', 'unless the owner says otherwise');

      // Paul's organization: free by default, but he belongs to it, so it is never limited.
      const { op: pop } = org(spaces, 'pauls');
      new Auth(spaces.get('pauls').db).addPerson('paul', 'owner', { email: PAUL, verified: true });
      spaces.directory.identify(PAUL, 'github');
      spaces.directory.join(PAUL, 'pauls', { created: true });
      assert.equal(spaces.planOf('pauls'), 'unlimited');
      for (const a of ['b1', 'b2']) { pop(a, 'checkin'); assert.equal(pop(a, 'next').mode, 'work'); }
    } finally { spaces.close(); }
  });

  test('plans off (the default): nothing is limited', () => {
    const spaces = fresh({ plans: false });
    try {
      const { op } = org(spaces, 'acme');
      assert.equal(spaces.planOf('acme'), 'unlimited');
      for (const a of ['a1', 'a2']) { op(a, 'checkin'); assert.equal(op(a, 'next').mode, 'work'); }
      assert.equal(new Workspaces({ dir: spaces.dir }).plans, false, 'off unless the host turns it on');
    } finally { spaces.close(); }
  });

  test('a repository belongs to one free organization', () => {
    const spaces = fresh();
    try {
      const { hub: a } = org(spaces, 'acme', 0);
      const { hub: b, op } = org(spaces, 'beta', 0);
      a.addRemote(a.project('app'), 'github.com/acme/api', 'you');
      assert.throws(() => b.addRemote(b.project('app'), 'git@github.com:acme/api.git', 'you'), (e) => e.status === 402 && /already in the free workspace acme/.test(e.message));
      // An agent checking in from a clone of it: the checkin goes on, the repository stays unlinked in beta.
      assert.ok(b.agentOp('app', 'checkin', 'x', {}, { remote: 'github.com/acme/api' }));
      assert.deepEqual(b.remotesOf(b.project('app')), []);
      spaces.setPlan('beta', 'unlimited');
      b.addRemote(b.project('app'), 'github.com/acme/api', 'you');
      assert.deepEqual(b.remotesOf(b.project('app')), ['github.com/acme/api'], 'a paid organization may share it');
      void op;
    } finally { spaces.close(); }
  });

  test('one free organization per signed-in account', async () => {
    const spaces = fresh();
    const server = createServer(spaces);
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}`;
    try {
      const signIn = (email) => `nuworq_id=${spaces.directory.createSession(spaces.directory.identify(email, 'github').id)}`;
      const create = (cookie, name) => fetch(`${url}/api/orgs`, { method: 'POST', headers: { cookie, origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      const bob = signIn('bob@example.com');
      assert.equal((await create(bob, 'bobs')).status, 200);
      const second = await create(bob, 'bobs-two');
      assert.equal(second.status, 402);
      assert.match((await second.json()).error, /already have a free workspace \(bobs\)/);
      spaces.setPlan('bobs', 'unlimited');
      assert.equal((await create(bob, 'bobs-two')).status, 200, 'with the first one upgraded, one free one is allowed again');
      const paul = signIn(PAUL);
      assert.equal((await create(paul, 'p-one')).status, 200);
      assert.equal((await create(paul, 'p-two')).status, 200, "the owner's organizations are never free, so never counted");
    } finally {
      server.close();
      spaces.close();
    }
  });
});
