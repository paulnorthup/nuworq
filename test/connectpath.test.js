import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, chmodSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { registerMcp, unregisterMcp, launcher } from '../src/connect.js';

// A machine where nuworq is installed as a package: <prefix>/bin/nuworq → <prefix>/lib/node_modules/nuworq/bin/nuworq.js,
// as npm -g lays it out, with Claude Code (a stub that logs its calls), Codex and opencode configs.
function machine({ onPath = true, oldClaude = null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-connectpath-')));
  const pkgBin = join(root, 'lib', 'node_modules', 'nuworq', 'bin', 'nuworq.js');
  mkdirSync(join(pkgBin, '..'), { recursive: true });
  writeFileSync(pkgBin, '#!/usr/bin/env node\n');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  if (onPath) symlinkSync(pkgBin, join(bin, 'nuworq'));
  const calls = join(root, 'claude-calls');
  // `claude mcp get nuworq` answers with oldClaude (an entry in the old form) when given, else "not found".
  const getOut = join(root, 'claude-get');
  if (oldClaude) writeFileSync(getOut, oldClaude);
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\nif [ "$2" = get ]; then [ -f ${JSON.stringify(getOut)} ] && cat ${JSON.stringify(getOut)} && exit 0; exit 1; fi\n[ "$2" = remove ] && rm -f ${JSON.stringify(getOut)}\nexit 0\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  const home = join(root, 'home');
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  const codex = join(home, '.codex', 'config.toml');
  const opencode = join(home, '.config', 'opencode', 'opencode.json');
  writeFileSync(codex, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n');
  writeFileSync(opencode, '{}\n');
  const env = { PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`, HOME: home };
  return {
    root, pkgBin, home, env, codex, opencode,
    claude: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []),
  };
}

describe('connect registers nuworq without folder paths', () => {
  test('installed as a package: every tool gets `nuworq mcp`, and no config holds a path', () => {
    const m = machine();
    assert.deepEqual(launcher(m.pkgBin, m.env), { command: 'nuworq', args: ['mcp'] });
    const r = registerMcp({ bin: m.pkgBin, home: m.home, env: m.env });
    assert.deepEqual(r.added.map((a) => a.tool), ['claude', 'codex', 'opencode', 'skill']);
    assert.deepEqual(m.claude(), ['mcp get nuworq', 'mcp get nuworq', 'mcp add --scope user nuworq -- nuworq mcp'], 'an old entry to upgrade? none; one to add');
    const codex = readFileSync(m.codex, 'utf8');
    assert.match(codex, /\[mcp_servers\.nuworq\]\ncommand = "nuworq"\nargs = \["mcp"\]\ndefault_tools_approval_mode = "approve"\n/);
    assert.deepEqual(JSON.parse(readFileSync(m.opencode, 'utf8')).mcp.nuworq.command, ['nuworq', 'mcp']);
    for (const f of [m.codex, m.opencode]) assert.ok(!readFileSync(f, 'utf8').includes(m.root), `${f} holds no path`);
    // Disconnect still removes exactly what was written.
    unregisterMcp({ home: m.home, env: m.env, added: r.added });
    assert.equal(readFileSync(m.codex, 'utf8'), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n');
    assert.deepEqual(JSON.parse(readFileSync(m.opencode, 'utf8')), {});
  });

  test("a checkout that isn't on PATH keeps node <bin> mcp, and says why", () => {
    const m = machine({ onPath: false });
    const r = registerMcp({ bin: m.pkgBin, home: m.home, env: m.env });
    assert.match(r.lines[0], /Tools start nuworq by its path: nuworq isn't on PATH/);
    assert.deepEqual(m.claude().at(-1), `mcp add --scope user nuworq -- node ${m.pkgBin} mcp`);
    assert.match(readFileSync(m.codex, 'utf8'), new RegExp(`command = "node"\\nargs = \\[${JSON.stringify(m.pkgBin).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}, "mcp"\\]`));
    // Another copy on PATH is not this one: still by path.
    const other = machine();
    assert.match(launcher(join(m.root, 'lib', 'node_modules', 'nuworq', 'bin', 'nuworq.js'), other.env).why, /is another copy/);
  });

  test('old node <path> entries become path-free, keeping their other settings; unrelated entries stay', () => {
    const old = '/Users/me/nuworq/bin/nuworq.js';
    const m = machine({ oldClaude: `nuworq:\n  Scope: User config\n  Status: ✓ Connected\n  Type: stdio\n  Command: node\n  Args: ${old} mcp\n  Environment:\n    NUWORQ_URL=https://hub.test\n` });
    const section = `[mcp_servers.nuworq]\ncommand = "node"\nargs = ["${old}", "mcp"]\ndefault_tools_approval_mode = "approve"\nenv = { NUWORQ_URL = "https://hub.test" }\n`;
    writeFileSync(m.codex, `model = "gpt-5"\n\n${section}\n[mcp_servers.other]\ncommand = "other"\n`);
    writeFileSync(m.opencode, JSON.stringify({ mcp: { nuworq: { type: 'local', command: ['node', old, 'mcp'], enabled: true, environment: { NUWORQ_URL: 'https://hub.test' } }, other: { type: 'local', command: ['x'] } } }));
    const kept = [{ tool: 'codex', file: m.codex, block: `\n${section}` }];
    const r = registerMcp({ bin: m.pkgBin, home: m.home, env: m.env, kept });

    assert.deepEqual(m.claude(), ['mcp get nuworq', 'mcp remove --scope user nuworq', 'mcp add --scope user -e NUWORQ_URL=https://hub.test nuworq -- nuworq mcp']);
    const codex = readFileSync(m.codex, 'utf8');
    assert.equal(codex, `model = "gpt-5"\n\n[mcp_servers.nuworq]\ncommand = "nuworq"\nargs = ["mcp"]\ndefault_tools_approval_mode = "approve"\nenv = { NUWORQ_URL = "https://hub.test" }\n\n[mcp_servers.other]\ncommand = "other"\n`);
    const oc = JSON.parse(readFileSync(m.opencode, 'utf8')).mcp;
    assert.deepEqual(oc.nuworq, { type: 'local', command: ['nuworq', 'mcp'], enabled: true, environment: { NUWORQ_URL: 'https://hub.test' } });
    assert.deepEqual(oc.other, { type: 'local', command: ['x'] });

    // Codex was connect's own: its record follows the new text, so disconnect removes it. The hand-written ones stay theirs.
    assert.deepEqual(r.added.map((a) => a.tool), ['codex', 'skill']);
    unregisterMcp({ home: m.home, env: m.env, added: r.added });
    assert.ok(!readFileSync(m.codex, 'utf8').includes('[mcp_servers.nuworq]'));
    assert.ok(JSON.parse(readFileSync(m.opencode, 'utf8')).mcp.nuworq, 'opencode was written by hand: left alone');
  });
});
