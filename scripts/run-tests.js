#!/usr/bin/env node
// npm test: node --test, passing any arguments on (npm test -- test/foo.test.js). NUWORQ_TEST_CONCURRENCY caps
// how many test files run at once: workers get 2, so a machine full of them isn't saturated. It is a variable
// of its own because Node refuses --test-concurrency in NODE_OPTIONS. (Not named test.js: node --test would
// take this file for a test.)
//
// Every run gets its own temporary folder, removed when the run ends: tests make git repositories and hubs
// there, and on the server, where /tmp lives in RAM, leftovers from hundreds of runs filled its memory and
// took the hub down (2026-10-29). Each test also gets a time limit (NUWORQ_TEST_TIMEOUT, default 2 minutes),
// so one that hangs fails instead of holding up CI, a worker, or the server's move to a new commit.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const n = Number.parseInt(process.env.NUWORQ_TEST_CONCURRENCY ?? '', 10);
const timeout = Number.parseInt(process.env.NUWORQ_TEST_TIMEOUT ?? '', 10) || 120_000;
const tmp = mkdtempSync(join(tmpdir(), 'nuworq-tests-'));
const r = spawnSync(process.execPath, ['--test', `--test-timeout=${timeout}`, ...(n > 0 ? [`--test-concurrency=${n}`] : []), ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
});
rmSync(tmp, { recursive: true, force: true });
if (r.signal) process.kill(process.pid, r.signal);
process.exit(r.status ?? 1);
