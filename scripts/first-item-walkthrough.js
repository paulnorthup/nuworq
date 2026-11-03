#!/usr/bin/env node
// A newcomer's first item, from + Work to done (#685, docs/evals/setup.md): a throwaway hub whose project links a
// bare origin by its address, as + Project does, and a worker that does only what the hub's hints say, command for
// command. The repository has no package.json or other file workers know how to test, as a new project may not:
// Get started asks for Worker commands first, so the first build is told what to run instead of to ask for it.
// Prints one line per step with what the hub said; exits 1 when a step doesn't do what the walk expects.
//   node scripts/first-item-walkthrough.js
// Not walked here: a real Claude worker, operator and shaper on a throwaway workspace of the live hub. That walk is
// an operator's (docs/evals/setup.md, "Not walked, to rerun").
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { getStarted, facts } from '../src/getstarted.js';

const dir = mkdtempSync(join(tmpdir(), 'nuworq-first-item-'));
const origin = join(dir, 'origin.git');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Walkthrough', '-c', 'user.email=walk@example.com', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const clone = (name) => { git(dir, 'clone', '-q', origin, name); return join(dir, name); };

execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
const seed = clone('seed');
writeFileSync(join(seed, 'README.md'), '# demo\n');
git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'start'); git(seed, 'push', '-q', 'origin', 'main');

const hub = new Hub({ repos: join(dir, 'hub', 'repos') });
const failed = [];
let n = 0;
const step = (who, what, said, ok = true) => {
  n += 1;
  console.log(`${String(n).padStart(2)}. ${who}: ${what}${said ? `\n    hub: ${said.replace(/\s+/g, ' ').slice(0, 400)}` : ''}${ok ? '' : '\n    STUCK'}`);
  if (!ok) failed.push(`${n}. ${what}`);
};
const op = (agent, name, args = {}) => hub.agentOp('demo', name, agent, args);

// The person: + Project with its repository, then what Get started asks next.
const p = hub.tx(() => hub.project('demo', { create: true }));
hub.addRemote(p, origin, 'you');
const gs = getStarted(facts(hub)).steps.find((s) => s.key === 'worker-commands');
step('the person', '+ Project, linked to its repository; Get started next', gs && `${gs.label} → ${gs.action.label}`, !!gs);
hub.humanOp('demo', 'settings', { worker_commands: 'make test' });
step('the person', 'Worker commands: make test', '', !getStarted(facts(hub)).steps.some((s) => s.key === 'worker-commands'));

hub.humanOp('demo', 'create', { title: 'Add a greeting', acceptance: 'GREETING exists and says hello' });
step('the person', '+ Work: "Add a greeting"');

op('w1', 'checkin');
const job = op('w1', 'next');
// Of its hint, the sentence on tests: the one a newcomer's first build used to be stuck at.
step('a worker', 'checkin, next', `a work job on ${job.branch}. ${job.hint.match(/(Run tests with|This project has no test command)[^.]*\./)?.[0] ?? job.hint}`,job.mode === 'work' && /make test/.test(job.hint) && !/Ask to: "operator" to run the tests/.test(job.hint));

// The worker follows the hint: its own clone, the branch from origin/main, one commit, pushed.
const mac = clone('worker');
git(mac, 'fetch', '-q', 'origin');
git(mac, 'switch', '-q', '--no-track', '-c', job.branch, 'origin/main');
writeFileSync(join(mac, 'GREETING'), 'hello\n');
git(mac, 'add', '.'); git(mac, 'commit', '-qm', 'GREETING says hello');
git(mac, 'push', '-q', 'origin', job.branch);
const sub = op('w1', 'submit', { item: '#1', headline: 'GREETING says hello', evidence: [{ label: `make test, branch ${job.branch}` }] });
step('the worker', 'commit, push the branch, submit', sub.hint ?? sub.headline, hub.item(p, '#1').stage === 'verifying');

hub.humanOp('demo', 'accept', { item: '#1' });
step('the person', 'Accept', '', hub.item(p, '#1').stage === 'landing');

const land = op('w1', 'next');
step('the worker', 'next', land.hint, land.mode === 'land');
git(mac, 'fetch', '-q', 'origin');
git(mac, 'rebase', '-q', 'origin/main');
git(mac, 'push', '-q', 'origin', `${job.branch}:main`);
git(mac, 'push', '-q', 'origin', job.branch, '--force-with-lease');
const done = op('w1', 'submit', { item: '#1', headline: 'Landed' });
const onMain = existsSync(join(clone('check'), 'GREETING'));
step('the worker', 'land: rebase, push to main, submit', done.hint ?? done.headline, hub.item(p, '#1').stage === 'done' && onMain);

rmSync(dir, { recursive: true, force: true });
console.log(failed.length ? `\nStuck at ${failed.length}: ${failed.join('; ')}` : `\nNo step got stuck: ${n} steps, the first item is on origin's main.`);
process.exit(failed.length ? 1 : 0);
