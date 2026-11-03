import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// CI tests the minimum nuworq declares, and only that (#811): raising the minimum means changing both together.
test("CI runs one job named test, on the Node package.json's engines declares as the minimum", () => {
  const engines = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).engines.node;
  const min = engines.match(/^>=\s*(\d+)$/)?.[1];
  assert.ok(min, `engines.node is a plain minimum (">=N"), not "${engines}"`);
  const yml = readFileSync(join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
  const versions = [...yml.matchAll(/node-version:\s*(.+)/g)].map((m) => m[1].trim());
  assert.deepEqual(versions, [min], `the workflow's node-version is engines' ${min}, once`);
  assert.doesNotMatch(yml, /matrix/, 'no matrix');
  const jobs = [...yml.split(/^jobs:\n/m)[1].matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1]);
  assert.deepEqual(jobs, ['test'], "one job, named test: the check main's ruleset requires");
});
