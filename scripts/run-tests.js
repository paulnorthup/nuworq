#!/usr/bin/env node
// npm test: node --test, passing any arguments on (npm test -- test/foo.test.js). NUWORQ_TEST_CONCURRENCY caps
// how many test files run at once: workers get 2, so a machine full of them isn't saturated. It is a variable
// of its own because Node refuses --test-concurrency in NODE_OPTIONS. (Not named test.js: node --test would
// take this file for a test.)
import { spawnSync } from 'node:child_process';

const n = Number.parseInt(process.env.NUWORQ_TEST_CONCURRENCY ?? '', 10);
const r = spawnSync(process.execPath, ['--test', ...(n > 0 ? [`--test-concurrency=${n}`] : []), ...process.argv.slice(2)], { stdio: 'inherit' });
if (r.signal) process.kill(process.pid, r.signal);
process.exit(r.status ?? 1);
