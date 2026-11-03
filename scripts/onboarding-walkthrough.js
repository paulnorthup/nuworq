#!/usr/bin/env node
// A stand-in for an observed onboarding (#116): an invited person goes from the invite link to a landed
// item, on a throwaway hub with login required, and every step is timed. The person acts through the same
// HTTP calls the web pages make (invite, Get started, + Project, approve a machine, add work, accept); their
// machine acts through the real CLI (connect, checkin, next, submit), with HOME in a temporary folder so
// nothing on this machine changes. GitHub isn't involved: the project's repository is a bare repo on disk.
// Prints one line per step, then the Get started checklist as the person last saw it.
//   node scripts/onboarding-walkthrough.js
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nuworq.js');
const dir = mkdtempSync(join(tmpdir(), 'nuworq-onboard-'));
const home = join(dir, 'home'), origin = join(dir, 'origin.git'), work = join(dir, 'work');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The repository: a bare origin with one commit on main, and the person's clone of it.
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
for (const [k, v] of [['user.name', 'Walkthrough'], ['user.email', 'walk@example.com'], ['commit.gpgsign', 'false']]) git(work, 'config', k, v);
writeFileSync(join(work, 'README.md'), '# demo\n');
git(work, 'add', '.'); git(work, 'commit', '-qm', 'start'); git(work, 'push', '-q', 'origin', 'main');

// The hub, as its owner runs it: login required, one owner who sends an invite.
const hub = new Hub({ file: join(dir, 'hub.db'), repos: join(dir, 'mirrors') });
const auth = new Auth(hub.db);
auth.addPerson('remy', 'owner');
const ownerToken = auth.createToken('remy-cli', 'human', { person: 'remy' });
const server = createServer(hub, { auth: 'required', sweepMs: 1_000 });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

let cookie = '';
async function http(method, path, body, { token } = {}) {
  const headers = { origin: url, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : cookie ? { cookie } : {}) };
  const r = await fetch(url + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(json)}`);
  return json;
}

// The person's machine: the CLI, run in their clone, with its own HOME and nothing from this session's env.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NUWORQ_')));
Object.assign(env, { HOME: home, NO_COLOR: '1' });
function cli(args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [BIN, ...args], { cwd: work, env });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; onLine?.(out); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`nuworq ${args.join(' ')} exited ${code}: ${err || out}`))));
  });
}

const steps = [];
let t0 = performance.now();
async function step(name, fn) {
  const start = performance.now();
  const note = await fn();
  steps.push({ name, ms: Math.round(performance.now() - start), note: note ?? '' });
  console.log(`${String(steps.length).padStart(2)}. ${name} (${((performance.now() - start) / 1000).toFixed(1)}s)${note ? `: ${note}` : ''}`);
}
const gsLine = (gs) => gs.steps.map((s) => `${s.done ? '✓' : '·'} ${s.key}`).join('  ');

try {
  const invite = await http('POST', '/api/invites', { role: 'steward' }, { token: ownerToken });
  const inviteToken = invite.link.split('#')[1];
  t0 = performance.now();

  await step('Open the invite link', async () => {
    const peek = await http('POST', '/api/invite/peek', { token: inviteToken });
    return `"You're invited to join as ${peek.role}${peek.invited_by ? `, by ${peek.invited_by}` : ''}"`;
  });
  await step('Pick a handle and join', async () => {
    const r = await http('POST', '/api/invite/accept', { token: inviteToken, handle: 'sam' });
    return `signed in as ${r.person} (${r.role}); session cookie set`;
  });
  let gs;
  await step('Land on All projects: Get started', async () => {
    gs = await http('GET', '/api/get-started');
    const next = gs.steps.find((s) => !s.done);
    return `${gsLine(gs)} | first undone: ${next.key} → ${JSON.stringify(next.action)}`;
  });
  let slug;
  await step('+ Project (name, and the repository it lives in)', async () => {
    const r = await http('POST', '/api/projects', { name: 'Demo', remote: origin, mission: 'A walkthrough project' });
    slug = r.slug;
    return `project ${slug}, remote linked`;
  });
  await step('Connect a machine: nuworq connect (device code, approved in the browser)', async () => {
    let approved = false;
    const done = cli(['connect', url, '--no-browser', '--no-mcp'], {
      onLine: (out) => {
        const code = out.match(/approve the code (\S+)/)?.[1];
        if (code && !approved) { approved = true; http('POST', '/api/device/approve', { user_code: code, approve: true }).catch((e) => console.error(e)); }
      },
    });
    const out = await done;
    return out.split('\n').find((l) => l.startsWith('Connected'))?.trim();
  });
  await step('Add work in the UI', async () => {
    const r = await http('POST', `/api/p/${slug}/human/create`, { title: 'Say hello in the README', acceptance: 'README.md has a line that says hello' });
    return `${r.item} ${r.stage ?? ''}`.trim();
  });
  let branch;
  await step('Agent: checkin and next (claims the item, learns its branch)', async () => {
    await cli(['checkin', '--as', 'sam-agent', '--client', 'walkthrough']);
    const out = await cli(['next', '--as', 'sam-agent']);
    branch = out.match(/nuworq\/1-[\w-]+/)?.[0];
    if (!branch) throw new Error(`no branch in: ${out}`);
    return `branch ${branch}`;
  });
  await step('Agent: does the work, pushes the branch, submits', async () => {
    git(work, 'fetch', '-q', 'origin');
    git(work, 'switch', '-q', '-c', branch, 'origin/main');
    writeFileSync(join(work, 'README.md'), '# demo\n\nhello\n');
    git(work, 'commit', '-qam', 'Say hello');
    git(work, 'push', '-q', 'origin', branch);
    await cli(['submit', '#1', 'README says hello', '--as', 'sam-agent', '--evidence', `commit ${git(work, 'rev-parse', '--short', 'HEAD')} on ${branch}`]);
    return 'submitted for review';
  });
  await step('Person: sees it under Needs you and accepts it', async () => {
    const v = await http('GET', `/api/p/${slug}/view`);
    const review = v.attention.find((a) => a.kind === 'review' && a.level === 'act');
    if (!review) throw new Error(`no review in needs you: ${JSON.stringify(v.attention.map((a) => [a.kind, a.level]))}`);
    await http('POST', `/api/p/${slug}/human/accept`, { item: '#1' });
    return `"${review.headline}" → accepted`;
  });
  await step('Agent: next is the land job: push to main, submit', async () => {
    const out = await cli(['next', '--as', 'sam-agent']);
    if (!/land/i.test(out)) throw new Error(`expected a land job: ${out}`);
    git(work, 'fetch', '-q', 'origin');
    git(work, 'rebase', '-q', 'origin/main');
    git(work, 'push', '-q', 'origin', `${branch}:main`);
    await cli(['submit', '#1', 'Landed on main', '--as', 'sam-agent']);
    return `main is ${git(work, 'rev-parse', '--short', 'origin/main')}`;
  });
  await step('Person: the item is done; Get started rechecks', async () => {
    const item = await http('GET', `/api/p/${slug}/items/1`);
    gs = await http('GET', '/api/get-started');
    return `#1 ${item.stage} | ${gsLine(gs)}`;
  });
  console.log(`\nInvite link to a landed item: ${((performance.now() - t0) / 1000).toFixed(1)}s, ${steps.length} steps.`);
  console.log(`Get started still open: ${gs.steps.filter((s) => !s.done).map((s) => `${s.key} (${s.label})`).join(', ') || 'none'}`);
} finally {
  server.close();
  hub.close?.();
  rmSync(dir, { recursive: true, force: true });
}
