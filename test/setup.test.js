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
import { answerer, budgetOf, chooseProject, finishSetup, detectPays, paysOf, BUDGET, WORKER_USD, SUB_MINUTES } from '../src/setup.js';
import { runCaps, capsLine } from '../src/runner.js';
import { setCaps } from '../src/up.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));

// A person at the terminal who gives these answers in order; asked: every prompt they saw.
function person(...answers) {
  const asked = [];
  return { asked, ask: async (q) => { asked.push(q); if (!answers.length) throw new Error(`asked more than scripted: ${q}`); return answers.shift(); } };
}
// The actions, recording what ran and in what order alongside what was said.
function machine({ staffFails = false, installed = null } = {}) {
  const log = [];
  return {
    log,
    say: (l) => log.push(`say ${l}`),
    actions: {
      staff: async (p, usd) => { if (staffFails) throw Object.assign(new Error("a member can't staff projects"), { hint: 'Ask an owner' }); log.push(`staff ${p.slug} ${usd}`); return [`Staffed ${p.slug}`]; },
      installed: async () => installed,
      installRunner: async (args, had) => { log.push(`${had ? 'reinstall' : 'install'} runner ${args.join(' ')}`); return []; },
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
    const p = person('y', '', '', '', 'y');
    const r = await finishSetup({ mode: 'ask', ask: p.ask, say: m.say, project: app, folder: '/src/app', plugin: true, actions: m.actions });
    assert.deepEqual(r, { staffed: true, operator: true });
    assert.deepEqual(ran(m.log), ['staff app 20', 'install runner --pays api --max-minutes 90 --worker-usd 10 --max-usd 20', 'start operator']);
    assert.match(p.asked[0], /^Staff App with workers on this machine\? .*background service.*spend on your Claude account, up to the caps you set next/);
    assert.match(p.asked[4], /^Start an operator now\? It opens Claude Code in \/src\/app with \/nuworq:operator: .*uses your Claude account/);
    assert.match(m.log.at(-3), /^say Last, to plan work with a shaper: open \/src\/app in the Claude Code app and type \/nuworq:shaper\.$/);
    assert.match(m.log.at(-2), /^say From now on, and after any restart: nuworq up /, 'then the one command (#559)');
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
    assert.deepEqual(ran(on.log), ['staff app 15', 'install runner --pays api --max-minutes 90 --worker-usd 10 --max-usd 15', 'start operator']);
    assert.match(said(on.log), /^Took an API key \(nothing said otherwise\) with the suggested caps; connect again at a terminal to change them\.$/m, '--yes says what it took');
  });

  test('not cloned here: it says how to clone, and the operator waits for the clone', async () => {
    const m = machine();
    const p = person('n');
    await finishSetup({ mode: 'ask', ask: p.ask, say: m.say, project: app, folder: null, clone: 'git clone https://github.com/acme/app.git /src/app', actions: m.actions });
    assert.equal(p.asked.length, 1, 'only the staffing question');
    assert.match(said(m.log), /^App isn't cloned on this machine\. Clone it with: git clone https:\/\/github\.com\/acme\/app\.git \/src\/app\n/);
    assert.match(said(m.log), /Once it's cloned: cd into it and run nuworq operator --start/);
  });

  test('a project already staffed is not asked about again: connect says so, with the command for this machine (#643)', async () => {
    const m = machine();
    const p = person('n');
    const r = await finishSetup({ mode: 'ask', ask: p.ask, say: m.say, project: { ...app, runner: true }, folder: '/src/app', actions: m.actions });
    assert.deepEqual(p.asked.map((q) => q.split('?')[0]), ['Start an operator now'], 'only the operator question');
    assert.deepEqual(ran(m.log), [], 'nothing staffed or installed');
    assert.equal(r.staffed, false);
    assert.match(said(m.log), /^App is already staffed: nuworq run starts its workers\. To run them on this machine too: nuworq run --install {3}\(in \/src\/app\)$/m);
    const on = machine();
    await finishSetup({ mode: 'yes', ask: null, say: on.say, project: { ...app, runner: true }, folder: '/src/app', actions: on.actions });
    assert.deepEqual(ran(on.log), ['start operator'], '--yes doesn\'t staff it twice');
  });

  test("staffing that's refused says why and how to try later, and installs nothing", async () => {
    const m = machine({ staffFails: true });
    await finishSetup({ mode: 'ask', ask: person('y', '', '', '', 'n').ask, say: m.say, project: app, folder: '/src/app', actions: m.actions });
    assert.deepEqual(ran(m.log), []);
    assert.match(said(m.log), /Couldn't staff App: a member can't staff projects \(Ask an owner\)\nLater: nuworq staff app --budget 20/);
  });
});

describe('connect asks how this machine pays for Claude, and sets the caps to fit (#776)', () => {
  const Q = /^How does this machine pay for Claude: a subscription \(Pro\/Max\) or an API key\? /;

  test('it detects an API key from ANTHROPIC_API_KEY, else reads claude auth status', () => {
    assert.deepEqual(detectPays({ env: { ANTHROPIC_API_KEY: 'sk-x' }, auth: '{"subscriptionType":"max"}' }), { pays: 'api', why: 'ANTHROPIC_API_KEY is set' });
    assert.deepEqual(detectPays({ auth: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }) }), { pays: 'subscription', why: 'claude is signed in to Claude Max' });
    assert.equal(detectPays({ auth: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }) }).pays, 'api');
    assert.equal(detectPays({ auth: 'Logged in with an API key' }).pays, 'api');
    assert.equal(detectPays({ auth: 'Logged in to claude.ai (Pro)' }).pays, 'subscription');
    assert.equal(detectPays({ auth: JSON.stringify({ loggedIn: false }) }), null);
    assert.equal(detectPays({}), null, 'no claude, no key: nothing detected');
  });

  test('an API key: Enter takes the detected answer, then a daily cap and a per-worker cap, written as --worker-usd and --max-usd', async () => {
    const p = person('', '30', '');
    const r = await paysOf('ask', p.ask, { pays: 'api', why: 'ANTHROPIC_API_KEY is set' });
    assert.match(p.asked[0], Q);
    assert.match(p.asked[0], /\[s\/a, Enter: API key \(ANTHROPIC_API_KEY is set\)\] $/, 'the prompt shows what it detected');
    assert.deepEqual(p.asked.slice(1), [`Daily spending cap for its workers, in dollars [${BUDGET}]: `, `Cap for each worker, in dollars [${WORKER_USD}]: `]);
    assert.equal(r.usd, 30, 'the daily cap is the hub budget too');
    assert.deepEqual(r.args, ['--pays', 'api', '--max-minutes', '90', '--worker-usd', '10', '--max-usd', '30']);
    assert.match(r.lines.join('\n'), /every run spends money: each worker stops at \$10 or 90 minutes, and the runner at \$30 in all/);
    const typed = await paysOf('ask', person('a', '', '$4').ask, { pays: 'subscription', why: 'x' });
    assert.deepEqual(typed.args.slice(-4), ['--worker-usd', '4', '--max-usd', '20'], 'typing a overrides the detected subscription');
  });

  test('a subscription: no dollar caps and no dollar question; --max-minutes, and why', async () => {
    const p = person('both?', 's');
    const r = await paysOf('ask', p.ask, null);
    assert.match(p.asked[0], /\[s\/a, Enter: API key\] $/, 'nothing detected: Enter is the cautious answer');
    assert.equal(p.asked.length, 2, 'an unclear answer is asked again once; then no dollar questions');
    assert.deepEqual(r.args, ['--pays', 'subscription', '--max-minutes', String(SUB_MINUTES), '--worker-usd', '0']);
    assert.ok(!r.args.includes('--max-usd'));
    assert.match(r.lines.join('\n'), /usage windows are the limit, not dollars: each worker stops after 60 minutes, with no dollar cap and no daily budget on the hub/);
    assert.equal(r.usd, null, 'no hub budget either: claude reports a cost even on a subscription');
    const kept = await paysOf('yes', null, null, { pays: 'subscription', budget: '40' });
    assert.equal(kept.usd, 40, '--budget still asks for one');
    assert.match(kept.lines.join('\n'), /the hub stops starting them after \$40 a day/, 'and says so');
    const sub = await paysOf('ask', person('').ask, { pays: 'subscription', why: 'claude is signed in to Claude Pro' });
    assert.equal(sub.pays, 'subscription', 'Enter takes the detected subscription');
  });

  test('--yes and non-interactive take the detected answer with the suggested values, and say so; --pays answers it', async () => {
    const never = async (q) => { throw new Error(`asked: ${q}`); };
    const sub = await paysOf('yes', never, { pays: 'subscription', why: 'claude is signed in to Claude Max' });
    assert.deepEqual(sub.args, ['--pays', 'subscription', '--max-minutes', '60', '--worker-usd', '0']);
    assert.match(sub.lines[0], /^Took a subscription \(claude is signed in to Claude Max\) with the suggested caps; connect again at a terminal to change them\.$/);
    const api = await paysOf('yes', never, { pays: 'api', why: 'ANTHROPIC_API_KEY is set' });
    assert.deepEqual(api.args, ['--pays', 'api', '--max-minutes', '90', '--worker-usd', String(WORKER_USD), '--max-usd', String(BUDGET)]);
    const named = await paysOf('ask', person('', '').ask, { pays: 'subscription', why: 'x' }, { pays: 'api' });
    assert.equal(named.pays, 'api', '--pays answers the question: only the dollar caps are asked');
  });

  test('connecting again to a staffed project with a runner here asks only how it pays, and replaces its caps', async () => {
    const m = machine({ installed: { args: ['--workers', 'auto', '--max-minutes', '90', '--worker-usd', '25'], cwd: '/src' } });
    const p = person('s', 'n');
    await finishSetup({ mode: 'ask', ask: p.ask, say: m.say, project: { ...app, runner: true, run_budget: 20 }, folder: '/src/app', actions: m.actions });
    assert.match(p.asked[0], Q);
    assert.deepEqual(ran(m.log), ['staff app null', 'reinstall runner --pays subscription --max-minutes 60 --worker-usd 0'], "the hub's daily budget is cleared too");
    const same = machine({ installed: { args: [] } });
    await finishSetup({ mode: 'ask', ask: person('a', '', '', 'n').ask, say: same.say, project: { ...app, runner: true, run_budget: 20 }, folder: '/src/app', actions: same.actions });
    assert.deepEqual(ran(same.log), ['reinstall runner --pays api --max-minutes 90 --worker-usd 10 --max-usd 20'], 'a hub budget that already fits is left alone');
    assert.match(said(m.log), /^App is already staffed, and this machine's runner starts its workers\.$/m);
    const off = machine({ installed: { args: [] } });
    await finishSetup({ mode: 'no', ask: null, say: off.say, project: { ...app, runner: true }, folder: '/src/app', actions: off.actions });
    assert.deepEqual(ran(off.log), [], 'with no terminal it changes nothing');
    assert.deepEqual(setCaps(['--workers', 'auto', '--max-minutes', '90', '--worker-usd=25', '--pays', 'api', '--max-usd', '9'], ['--pays', 'subscription', '--max-minutes', '60', '--worker-usd', '0']),
      ['--workers', 'auto', '--pays', 'subscription', '--max-minutes', '60', '--worker-usd', '0'], 'its other flags stay; old caps go');
  });

  test("the runner's start line names the caps in force and where they came from", () => {
    assert.equal(capsLine(runCaps({})), 'no caps (none set: nuworq connect sets them)', 'no defaults since #795');
    assert.equal(capsLine(runCaps({ pays: 'subscription', 'max-minutes': '60', 'worker-usd': '0' })), 'each stops at 60m, no dollar cap (caps: set by connect for a subscription)');
    assert.equal(capsLine(runCaps({ pays: 'api', 'max-minutes': '90', 'worker-usd': '10', 'max-usd': '20' })), 'each stops at 90m or $10; $20 in all (caps: set by connect for an API key)');
    assert.equal(capsLine(runCaps({ 'worker-usd': '5' })), 'each stops at $5 (caps: from its flags)');
    assert.throws(() => runCaps({ pays: 'credit' }), /--pays expects api or subscription/);
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
    // A subscription (#776): budget null staffs it with no daily budget, also clearing one already set.
    assert.deepEqual((await call('POST', '/api/staff', 'own', { project: 'other', budget: null })).json, { ok: true, staffed: true });
    assert.deepEqual([ctx.hub.project('other').runner, ctx.hub.project('other').run_budget], [1, null]);
    assert.deepEqual(ctx.hub.staffing(ctx.hub.project('other')).budget, null, 'no budget for runners to stop on');
  });
});

test('a hub without logins staffs it at once, for its person (#900)', async () => {
  const hub = new Hub();
  hub.tx(() => hub.project('demo', { create: true }));
  const server = createServer(hub, {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const anon = await request(server.address().port, 'POST', '/api/staff', { body: { project: 'demo', budget: 20 } });
    assert.equal(anon.status, 403, 'without the key, nobody staffs');
    const r = await request(server.address().port, 'POST', '/api/staff', { headers: { authorization: `Bearer ${server.personKey}` }, body: { project: 'demo', budget: 20 } });
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
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NUWORQ_/.test(k))), HOME: home, PATH: '/usr/bin:/bin' };
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
