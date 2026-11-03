import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The first-item walk (#685, docs/evals/setup.md) stays walkable: the script exits 0 only when no step got stuck.
test('a first item goes from + Work to done on a hint-following worker, its tests named before it starts', () => {
  const script = fileURLToPath(new URL('../scripts/first-item-walkthrough.js', import.meta.url));
  const out = execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /Tell workers how to test → Worker commands/);
  assert.match(out, /No step got stuck: \d+ steps, the first item is on origin's main\./);
});
