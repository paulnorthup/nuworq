import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hub, PERSON_CAN } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { fuzzy, marked, rank, commands, resultsHtml, confirmHtml } from '../web/launcher.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const stages = { ready: { label: 'Ready', court: 'queue' }, active: { label: 'Active', court: 'agents' }, done: { label: 'Done', court: null } };
const index = (extra = {}) => ({
  projects: [{ slug: 'nuworq', name: 'nuworq' }, { slug: 'site', name: 'nuworq-site' }],
  items: [
    { p: 'nuworq', n: 120, t: 'Phone menu for the rail', s: 'done', pr: 'soon' },
    { p: 'site', n: 120, t: 'Pricing page copy', s: 'ready', pr: 'soon' },
    { p: 'nuworq', n: 7, t: 'Fix 120 px clipping', s: 'active', pr: 'soon' },
    { p: 'site', n: 3, t: 'Login button', s: 'ready', pr: 'soon' },
    { p: 'nuworq', n: 4, t: 'Blog in banner', s: 'ready', pr: 'later' },
  ],
  needs: [], can: PERSON_CAN.owner, stages, ...extra,
});
const view = { project: { slug: 'nuworq', name: 'nuworq', autonomy: 'ask', parked: false, runner: false,
  autonomy_options: { ask: { label: 'Check with me' }, balanced: { label: 'Keep moving' }, full: { label: 'Run with it' } } },
  groups: [{ item: '#9', title: 'Billing', priority: 'soon' }] };

describe('the quick launcher (#290)', () => {
  test('fuzzy: letters in order, word starts and runs score higher, the matched letters are returned', () => {
    assert.equal(fuzzy('xyz', 'Phone menu'), null);
    assert.equal(fuzzy('unem', 'menu'), null, 'out of order does not match');
    const f = fuzzy('pm', 'Phone menu');
    assert.deepEqual(f.hits, [0, 6], 'it picks the word starts, not the first m it meets');
    assert.ok(fuzzy('menu', 'Phone menu').score > fuzzy('menu', 'make every new user').score, 'consecutive beats scattered');
    assert.ok(fuzzy('log', 'Add login').score > fuzzy('log', 'A blog').score, 'a word start beats the middle of a word');
    assert.equal(marked('Phone menu', f.hits, esc), '<mark>P</mark>hone <mark>m</mark>enu');
  });

  test("a number: this project's item first, then other projects' with the same number, then title matches", () => {
    const r = rank(index(), '120', { current: 'nuworq' });
    assert.deepEqual(r.slice(0, 3).map((x) => [x.slug, x.ref]), [['nuworq', '#120'], ['site', '#120'], ['nuworq', '#7']]);
    assert.equal(r[0].project, null, 'the current project goes unlabeled');
    assert.equal(r[1].project, 'nuworq-site', "another project's is labeled with its name");
    assert.deepEqual(rank(index(), '#120', { current: 'nuworq' })[0].ref, '#120');
    assert.deepEqual(r[0].run, { open: { slug: 'nuworq', item: '#120' } }, 'Enter opens its flyout');
  });

  test("words: the current project's matches first; on All projects every project ranks equally", () => {
    const here = rank(index(), 'log', { current: 'nuworq' }).filter((x) => x.kind === 'item');
    assert.deepEqual(here.map((x) => x.ref + x.slug), ['#4nuworq', '#3site']);
    const all = rank(index(), 'log', { current: null }).filter((x) => x.kind === 'item');
    assert.deepEqual(all.map((x) => x.ref + x.slug), ['#3site', '#4nuworq'], 'the better match leads when no project is current');
  });

  test('go places: every project and the workspace pages, by name', () => {
    const labels = commands({ index: index(), role: 'owner', billingOwner: true }).filter((c) => c.kind === 'go').map((c) => c.label);
    for (const l of ['nuworq', 'nuworq-site', 'All projects', 'Analytics', 'Workspace settings', 'Notifications', 'Connect an agent']) assert.ok(labels.includes(l), l);
    assert.ok(!commands({ index: index(), role: 'member' }).some((c) => c.label === 'Analytics'), 'analytics is for owners');
    assert.equal(rank(index(), 'site', { current: 'nuworq' }).find((c) => c.kind === 'go').run.go, '#/p/site');
  });

  test('changes say what will change and take a second Enter; depth, autonomy, park, staffing, milestone priority', () => {
    const c = commands({ index: index(), current: 'nuworq', view, zoom: '30s' });
    const set = c.filter((x) => x.kind === 'set');
    for (const s of set) assert.ok(s.confirm, `${s.label} confirms`);
    const auto = set.find((s) => s.label === 'Autonomy: Run with it');
    assert.equal(auto.confirm, 'Autonomy on nuworq: Check with me → Run with it. Agents are told.');
    assert.deepEqual(auto.run, { human: 'settings', slug: 'nuworq', body: { autonomy: 'full' }, msg: 'Autonomy changed; agents have been told' });
    for (const l of ['Depth 5m', 'Depth 30m', 'Park nuworq', 'Staffing on', '#9 Billing: priority now', '#9 Billing: priority later']) assert.ok(set.some((s) => s.label === l), l);
    assert.ok(!set.some((s) => s.label === 'Depth 30s' || s.label === 'Autonomy: Check with me' || s.label.endsWith('priority soon')), 'never the setting it already has');
    const html = confirmHtml(auto, { esc });
    assert.match(html, /Check with me → Run with it\. Agents are told\./);
    assert.match(html, /data-ln-apply/);
    assert.match(html, /data-ln-back/);
  });

  test('needs you: a one-step action confirms; one that needs words opens the item at its text box', () => {
    const needs = [
      { key: 'r', kind: 'review', item: '#5', headline: 'Login works', project: 'nuworq' },
      { key: 'p', kind: 'proposal', item: '#6', headline: 'Dark corners', project: 'site' },
      { key: 'q', kind: 'question', item: '#7', headline: 'Postgres or SQLite?', project: 'nuworq', question: 42 },
    ];
    const c = commands({ index: index({ needs }), current: 'nuworq' }).filter((x) => x.kind === 'needs');
    const accept = c.find((x) => x.label.startsWith('Accept #5'));
    assert.ok(accept.confirm);
    assert.deepEqual(accept.run, { human: 'accept', slug: 'nuworq', body: { item: '#5' }, msg: 'Accepted #5' });
    assert.deepEqual(c.find((x) => x.label.startsWith('Send #5 back')).run, { open: { slug: 'nuworq', item: '#5', focus: 'sendback' } });
    const approve = c.find((x) => x.label.startsWith('Approve #6'));
    assert.deepEqual(approve.run.body, { item: '#6', stage: 'ready' });
    assert.equal(approve.hint, 'Needs you · nuworq-site', "another project's entry says which");
    const answer = c.find((x) => x.label.startsWith('Answer #7'));
    assert.equal(answer.confirm, undefined);
    assert.deepEqual(answer.run, { open: { slug: 'nuworq', item: '#7', focus: 'ans-42' } });
  });

  test('with nothing typed: what needs you, then recently opened items', () => {
    const needs = [{ key: 'r', kind: 'review', item: '#5', headline: 'Login works', project: 'nuworq' }];
    const r = rank(index({ needs }), '', { current: 'nuworq', recent: [{ p: 'site', n: 3 }, { p: 'gone', n: 1 }] });
    assert.deepEqual(r.map((x) => x.kind), ['needs', 'needs', 'item']);
    assert.equal(r[2].ref, '#3');
    assert.equal(r[2].hint, 'Recent');
  });

  test('create: the typed text becomes a proposal or a steer in the open project, each confirmed, last in the list', () => {
    const r = rank(index(), 'Export to CSV', { current: 'nuworq' });
    const made = r.filter((x) => x.kind === 'create');
    assert.equal(made.length, 2);
    assert.deepEqual(r.slice(-2), made);
    assert.deepEqual(made[0].run, { human: 'create', slug: 'nuworq', body: { title: 'Export to CSV', stage: 'proposed' }, msg: 'Proposed: an agent shapes it next' });
    assert.deepEqual(made[1].run.body, { body: 'Export to CSV' });
    for (const m of made) assert.ok(m.confirm);
    assert.ok(!rank(index(), 'Export', { current: null }).some((x) => x.kind === 'create'), 'nothing to create into on All projects');
  });

  test("only what the viewer's role allows, and never removing or deleting anything", () => {
    const needs = [{ key: 'r', kind: 'review', item: '#5', headline: 'Login works', project: 'nuworq' }];
    const ops = (role) => commands({ index: index({ needs, can: PERSON_CAN[role] }), current: 'nuworq', view, role })
      .concat(rank(index({ needs, can: PERSON_CAN[role] }), 'words', { current: 'nuworq', view, role }))
      .map((c) => c.run.human).filter(Boolean);
    assert.deepEqual(ops('viewer'), [], 'a viewer can look and go places, nothing else');
    assert.deepEqual([...new Set(ops('member'))].sort(), ['create']);
    assert.ok(!ops('steward').includes('settings') && ops('steward').includes('accept') && ops('steward').includes('update'));
    for (const role of Object.keys(PERSON_CAN)) {
      for (const op of ops(role)) assert.ok(PERSON_CAN[role].includes(op), `${role} may ${op}`);
      assert.ok(!ops(role).some((op) => ['archive', 'delete', 'restore', 'remote'].includes(op)), role);
    }
    const all = commands({ index: index({ needs }), current: 'nuworq', view }).map((c) => c.label + JSON.stringify(c.run));
    assert.ok(!all.some((l) => /delete|archive|remove|logout|sign out/i.test(l)));
  });

  test('a stage pill per item, and the selected row marked', () => {
    const html = resultsHtml(rank(index(), '120', { current: 'nuworq' }), { sel: 1, stages, esc });
    assert.match(html, /<span class="stage-pill done">Done<\/span>/);
    assert.match(html, /<span class="stage-pill court-queue">Ready<\/span>/);
    assert.match(html, /class="ln-row on" role="option" aria-selected="true" data-ln="1"/);
    assert.match(resultsHtml([], { esc }), /Nothing matches/);
  });

  test('1,000 items: each keystroke ranks in well under 100 ms', () => {
    const words = ['login', 'billing', 'export', 'phone', 'menu', 'rail', 'review', 'stripe', 'webhook', 'agent'];
    const items = Array.from({ length: 1000 }, (_, i) => ({ p: i % 3 ? 'nuworq' : 'site', n: i + 1, s: 'ready', pr: 'soon',
      t: `${words[i % 10]} ${words[(i * 7) % 10]} when the ${words[(i * 3) % 10]} page loads on a slow phone` }));
    const ix = index({ items });
    const start = performance.now();
    const keys = ['b', 'bi', 'bil', 'bill', 'billi', 'billin', 'billing', '1', '12', '120'];
    for (const q of keys) rank(ix, q, { current: 'nuworq', view });
    const each = (performance.now() - start) / keys.length;
    assert.ok(each < 25, `${each.toFixed(1)} ms a keystroke on this machine (a phone is a few times slower)`);
  });

  test('GET /api/launcher: a light index of every project, what needs the viewer and what they may do; people only', async () => {
    const hub = new Hub();
    const auth = new Auth(hub.db);
    auth.addPerson('v', 'viewer');
    for (const slug of ['a', 'b']) {
      hub.tx(() => hub.project(slug, { create: true }));
      hub.humanOp(slug, 'create', { title: `Build ${slug}`, acceptance: 'x' });
    }
    hub.agentOp('a', 'claim', 'bot', { item: '#1' });
    hub.agentOp('a', 'submit', 'bot', { item: '#1', headline: 'Built', evidence: [{ label: 'tests pass' }] });
    const owner = auth.createToken('o', 'human'), v = auth.createToken('v-l', 'human', { person: 'v' }), bot = auth.createToken('bot', 'agent');
    const server = createServer(hub, { auth: 'required' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const get = (t) => fetch(`http://127.0.0.1:${server.address().port}/api/launcher`, { headers: { authorization: `Bearer ${t}` } }).then(async (r) => ({ status: r.status, json: await r.json() }));
    try {
      const { status, json } = await get(owner);
      assert.equal(status, 200);
      assert.deepEqual(json.projects.map((p) => p.slug).sort(), ['a', 'b']);
      assert.deepEqual(json.items.map((i) => `${i.p}#${i.n} ${i.s}`).sort(), ['a#1 verifying', 'b#1 ready']);
      assert.deepEqual(Object.keys(json.items[0]).sort(), ['n', 'p', 'pr', 's', 't'], 'light: no summaries or history');
      assert.ok(json.needs.some((n) => n.kind === 'review' && n.item === '#1' && n.project === 'a'));
      assert.deepEqual(json.can, PERSON_CAN.owner);
      assert.equal(json.stages.verifying.label, 'Verifying');
      assert.deepEqual((await get(v)).json.can, [], "a viewer's role allows nothing");
      assert.equal((await get(bot)).status, 403, 'not for agents');
    } finally { server.close(); }
  });

  test('wired in: ⌘K and the rail button open it, it has its own place in the page, and it is new', () => {
    const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
    const neu = readFileSync(new URL('../web/new.js', import.meta.url), 'utf8');
    assert.match(app, /class="rail-item rail-search" data-action="launcher" data-new="launcher"/);
    assert.match(app, /api\('\/api\/launcher'\)/);
    assert.match(html, /<div id="launcher" hidden><\/div>/);
    assert.match(neu, /launcher: '2026-10-31'/);
  });
});
