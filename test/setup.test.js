// What nuworq connect asks once it is connected (#490): src/setup.js with scripted answers, the hub's staffing
// request (POST /api/staff, approved like a device login), and connect itself with no terminal.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, realpathSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { answerer, budgetOf, chooseProject, finishSetup, BUDGET } from '../src/setup.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));

// A person at the terminal who gives these answers in order; asked: every prompt they saw.
function person(...answers) {
  const asked = [];
  return { asked, ask: async (q) => { asked.push(q); if (!answers.length) throw new Error(`asked more than scripted: ${q}`); return answers.shift(); } };
}
// The actions, recording what ran and in what order alongside what was said.
function machine({ staffFails = false } = {}) {
  const log = [];
  return {
    log,
    say: (l) => log.push(`say ${l}`),
    actions: {
      staff: async (p, usd) => { if (staffFails) throw Object.assign(new Error("a member can't staff projects"), { hint: 'Ask an owner' }); log.push(`staff ${p.slug} ${usd}`); return [`Staffed ${p.slug}`]; },
      installRunner: async () => { log.push('install runner'); return []; },
      startOperator: async () => { log.push('start operator'); },
    },
  };
}
const ran = (log) => log.filter((l) => !l.startsWith('say '));
const said = (log) => log.filter((l) => l.startsWith('say ')).map((l) => l.slice(4)).join('\n');
const app = { slug: 'app', name: 'App', remotes: ['github.com/acme/app'] };

describe('connect asks one question at a time (#490)', () => {
  test('a yes or no is what was typed; Enter is the default; --yes and --no never ask', async () => {
    const p = person('y', 'NO', '', '', 'yes');
    const yes = answerer('ask', p.ask);
    assert.deepEqual([await yes('A?'), await yes('B?'), await yes('C?'), await yes('D?', { def: true }), await yes('E?')], [true, false, false, true, true]);
    assert.deepEqual(p.asked, ['A? [y/N] ', 'B? [y/N] ', 'C? [y/N] ', 'D? [Y/n] ', 'E? [y/N] ']);
    const never = async () => { throw new Error('asked'); };
    assert.equal(await answerer('yes', never)('A?'), true);
    assert.equal(await answerer('no', never)('A?', { def: true }), false);
  });

  test('the daily cap shows its default, takes what is typed, and asks again once for a number', async () => {
    assert.equal(await budgetOf('ask', person('').ask), BUDGET);
    assert.equal(await budgetOf('ask', person('35').ask), 35);
    assert.equal(await budgetOf('ask', person('$12.50').ask), 12.5);
    const p = person('lots', '8');
    assert.equal(await budgetOf('ask', p.ask), 8);
    assert.deepEqual(p.asked, [`Daily spending cap for its workers, in dollars [${BUDGET}]: `, `Daily spending cap for its workers, in dollars [${BUDGET}]: `]);
    assert.equal(await budgetOf('yes', null), BUDGET, '--yes takes the default');
    assert.equal(await budgetOf('ask', null, '50'), 50, '--budget answers it');
  });

  test('the project is the one this folder is a clone of; elsewhere it asks which, and says where to clone it', async () => {
    const projects = [app, { slug: 'web', name: 'Web', remotes: ['github.com/acme/web'] }, { slug: 'old', remotes: [], parked: true }];
    const base = { projects, remote: 'github.com/acme/app', root: '/src/app', mode: 'ask', say: () => {} };
    assert.deepEqual(await chooseProject({ ...base, ask: null }), { project: app, folder: '/src/app' });
    assert.deepEqual(await chooseProject({ ...base, projects: [{ slug: 'here', path: '/src/app', remotes: [] }], remote: '', ask: null }), { project: { slug: 'here', path: '/src/app', remotes: [] }, folder: '/src/app' }, 'a hub on this machine: its folder');
    assert.equal((await chooseProject({ ...base, named: 'web', ask: null })).folder, null, '--project names another: not cloned here');
    const lines = [];
    const p = person('2');
    const r = await chooseProject({ ...base, remote: 'github.com/acme/other', ask: p.ask, say: (l) => lines.push(l) });
    assert.deepEqual(r, { project: projects[1], folder: null });
    assert.deepEqual(lines, ['This folder is no clone of a project on the hub. Which project is this machine for?', '  1. App', '  2. Web'], 'parked projects are not offered');
    assert.match((await chooseProject({ ...base, remote: '', mode: 'no', ask: null })).none, /pass --project/);
    assert.match((await chooseProject({ ...base, projects: [], ask: null })).none, /no projects yet/);
  });

  test('yes to each: staffed with the cap, the runner installed, and the operator started last, after the shaper line', async () => {
    const m = machine();
    const p = person('y', '', 'y');
    const r = await finishSetup({ mode: 'ask', ask: p.ask, say: m.say, project: app, folder: '/src/app', plugin: true, actions: m.actions });
    assert.deepEqual(r, { staffed: true, operator: true });
    assert.deepEqual(ran(m.log), ['staff app 20', 'install runner', 'start operator']);
    assert.match(p.asked[0], /^Staff App with workers on this machine\? .*background service.*spend on your Claude account, up to a daily cap/);
    assert.match(p.asked[2], /^Start an operator now\? It opens Claude Code in \/src\/app with \/nuworq:operator: .*uses your Claude account/);
    assert.match(m.log.at(-2), /^say Last, to plan work with a shaper: open \/src\/app in the Claude Code app and type \/nuworq:shaper\.$/);
  });

  test('no to each: nothing runs, and each no prints the command for later', async () => {
    const m = machine();
    const r = await finishSetup({ mode: 'ask', ask: person('n', '').ask, say: m.say, project: app, folder: '/src/app', plugin: false, actions: m.actions });
    assert.deepEqual(r, { staffed: false, operator: false });
    assert.deepEqual(ran(m.log), []);
    assert.match(said(m.log), /Later: nuworq staff app {3}\(in \/src\/app\)\nLater: nuworq operator --start {3}\(in \/src\/app\)\nLast, to plan work with a shaper: .* type \/nuworq-shaper\./, 'without the plugin, the skills go by /nuworq-…');
  });

  test('with no terminal (or --no) it asks nothing and does nothing; --yes does it all without asking', async () => {
    const never = async (q) => { throw new Error(`asked: ${q}`); };
    const off = machine();
    assert.deepEqual(await finishSetup({ mode: 'no', ask: never, say: off.say, project: app, folder: '/src/app', actions: off.actions }), { staffed: false, operator: false });
    assert.deepEqual(ran(off.log), []);
    const on = machine();
    assert.deepEqual(await finishSetup({ mode: 'yes', ask: never, say: on.say, project: app, folder: '/src/app', budget: '15', actions: on.actions }), { staffed: true, operator: true });
    assert.deepEqual(ran(on.log), ['staff app 15', 'install runner', 'start operator']);
  });

  test('not cloned here: it says how to clone, and the operator waits for the clone', async () => {
    const m = machine();
    const p = person('n');
    await finishSetup({ mode: 'ask', ask: p.ask, say: m.say, project: app, folder: null, clone: 'git clone https://github.com/acme/app.git /src/app', actions: m.actions });
    assert.equal(p.asked.length, 1, 'only the staffing question');
    assert.match(said(m.log), /^App isn't cloned on this machine\. Clone it with: git clone https:\/\/github\.com\/acme\/app\.git \/src\/app\n/);
    assert.match(said(m.log), /Once it's cloned: cd into it and run nuworq operator --start/);
  });

  test("staffing that's refused says why and how to try later, and installs nothing", async () => {
    const m = machine({ staffFails: true });
    await finishSetup({ mode: 'ask', ask: person('y', '', 'n').ask, say: m.say, project: app, folder: '/src/app', actions: m.actions });
    assert.deepEqual(ran(m.log), []);
    assert.match(said(m.log), /Couldn't staff App: a member can't staff projects \(Ask an owner\)\nLater: nuworq staff app --budget 20/);
  });
});

function request(port, method, path, { headers = {}, body } = {}) {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('a machine asks to staff a project (POST /api/staff, #490)', () => {
  let ctx;
  before(async () => {
    const hub = new Hub();
    const server = createServer(hub, { auth: 'required' });
    const auth = server.auth;
    auth.addPerson('own', 'owner');
    auth.addPerson('bea', 'member');
    const tok = {
      own: auth.createToken('own-l', 'human', { person: 'own' }),
      bea: auth.createToken('bea-l', 'human', { person: 'bea' }),
      bot: auth.createToken('bea@laptop', 'agent', { mintedBy: 'bea' }),
      other: auth.createToken('other', 'agent', { projects: ['other'] }),
    };
    hub.tx(() => { hub.project('demo', { create: true }); hub.project('other', { create: true }); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    ctx = { hub, tok, server, port: server.address().port };
  });
  after(() => { ctx.server.close(); ctx.server.closeAllConnections(); });
  const call = (method, path, who, body) => request(ctx.port, method, path, { headers: who ? { authorization: `Bearer ${ctx.tok[who]}` } : {}, body });

  test("the machine's token asks; only an owner's approval staffs it, with the budget asked for, and mints no token", async () => {
    assert.equal((await call('POST', '/api/staff', 'other', { project: 'demo', budget: 20 })).status, 403, "a token that can't reach the project");
    assert.equal((await call('POST', '/api/staff', 'bot', { project: 'demo', budget: 0 })).status, 400, 'a budget of dollars, more than 0');
    const d = (await call('POST', '/api/staff', 'bot', { project: 'demo', budget: 12.5, machine: 'laptop' })).json;
    assert.match(d.verify_url_complete, /\/device\.html\?code=[A-Z]{4}-[A-Z]{4}$/);
    assert.equal(ctx.hub.project('demo').runner, 0, 'asking changes nothing');
    assert.equal((await call('POST', '/api/device/poll', null, { device_code: d.device_code })).json.status, 'pending');

    const peek = await call('POST', '/api/device/peek', 'bea', { user_code: d.user_code });
    assert.deepEqual(peek.json.staff, { project: 'demo', name: 'demo', budget: 12.5, token: 'bea@laptop' });
    const member = await call('POST', '/api/device/approve', 'bea', { user_code: d.user_code });
    assert.equal(member.status, 403);
    assert.match(member.json.error, /a member can't staff projects/);

    const ok = await call('POST', '/api/device/approve', 'own', { user_code: d.user_code });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.approved, true);
    const p = ctx.hub.project('demo');
    assert.deepEqual([p.runner, p.run_budget], [1, 12.5]);
    const polled = (await call('POST', '/api/device/poll', null, { device_code: d.device_code })).json;
    assert.equal(polled.status, 'approved');
    assert.equal(polled.token, undefined, 'no token comes back');
  });

  test("a person's own token staffs it at once if their role may, else not at all", async () => {
    assert.equal((await call('POST', '/api/staff', 'bea', { project: 'other', budget: 5 })).status, 403);
    assert.deepEqual((await call('POST', '/api/staff', 'own', { project: 'other', budget: 5 })).json, { ok: true, staffed: true });
    assert.deepEqual([ctx.hub.project('other').runner, ctx.hub.project('other').run_budget], [1, 5]);
  });
});

test('a hub without logins staffs it at once', async () => {
  const hub = new Hub();
  hub.tx(() => hub.project('demo', { create: true }));
  const server = createServer(hub, {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await request(server.address().port, 'POST', '/api/staff', { body: { project: 'demo', budget: 20 } });
    assert.deepEqual(r.json, { ok: true, staffed: true });
    assert.deepEqual([hub.project('demo').runner, hub.project('demo').run_budget], [1, 20]);
  } finally { server.close(); server.closeAllConnections(); }
});

test('connect with no terminal asks nothing, staffs nothing, and prints the commands for later', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-setup-')));
  const clone = join(home, 'app');
  execFileSync('git', ['init', '-q', clone]);
  execFileSync('git', ['-C', clone, 'remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  const hub = new Hub();
  hub.tx(() => hub.project('app', { create: true }));
  hub.humanOp('app', 'settings', { name: 'App', path: clone }); // the folder it lives in, as on a hub on this machine
  const server = createServer(hub, {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NUWORQ|TRELLIS)_/.test(k))), HOME: home, PATH: '/usr/bin:/bin' };
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, 'connect', `http://127.0.0.1:${server.address().port}`], { env, cwd: clone });
      let stdout = '', stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end();
    });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stderr, '', 'no prompt was shown');
    assert.match(out.stdout, /Later: nuworq staff app {3}\(in /);
    assert.match(out.stdout, /Later: nuworq operator --start/);
    assert.match(out.stdout, /Last, to plan work with a shaper: open .* in the Claude Code app and type \/nuworq-shaper\./);
    assert.equal(hub.project('app').runner, 0, 'not opted in');
    assert.ok(!existsSync(join(home, 'Library', 'LaunchAgents')) || !readdirSync(join(home, 'Library', 'LaunchAgents')).length, 'no service installed');
  } finally { server.close(); server.closeAllConnections(); }
});
