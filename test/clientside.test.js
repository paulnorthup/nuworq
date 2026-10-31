import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// #257: on Node 22 node:sqlite is experimental, and loading it prints an ExperimentalWarning on stderr. The CLI's
// client side (every command's static imports, the MCP server, git's credential helper) needs no database, so it
// must not load it: otherwise every git push through the helper shows the warning.
test("the CLI's client side doesn't load node:sqlite", () => {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    for (const m of ['./src/client.js', './src/protocol.js', './src/names.js', './src/update.js', './src/mcp.js', './src/text.js']) await import(m);
    console.log(process.moduleLoadList.filter((m) => /sqlite/.test(m)).join(',') || 'none');`], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(out.trim(), 'none');
});
