import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { skill, planSkill } from '../src/protocol.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'bin', 'nuworq.js');
const PLUGIN = join(ROOT, 'plugin');
const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const read = (...p) => readFileSync(join(...p), 'utf8');

// One Claude Code plugin: the MCP server and both skills (#97).
describe('the Claude Code plugin', () => {
  test('a manifest, the MCP server path-free, and both skills, nothing else', () => {
    assert.deepEqual(files(PLUGIN).map((f) => relative(PLUGIN, f)).sort(), ['.claude-plugin/plugin.json', '.mcp.json', 'skills/nuworq-plan/SKILL.md', 'skills/nuworq/SKILL.md']);
    const manifest = JSON.parse(read(PLUGIN, '.claude-plugin', 'plugin.json'));
    assert.equal(manifest.name, 'nuworq');
    assert.equal(manifest.version, JSON.parse(read(ROOT, 'package.json')).version);
    assert.match(manifest.description, /MCP server/);
    assert.deepEqual(JSON.parse(read(PLUGIN, '.mcp.json')), { mcpServers: { nuworq: { command: 'nuworq', args: ['mcp'] } } }, 'no folder path, no token');
    for (const name of ['nuworq', 'nuworq-plan']) assert.match(read(PLUGIN, 'skills', name, 'SKILL.md'), new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`));
    const market = JSON.parse(read(ROOT, '.claude-plugin', 'marketplace.json'));
    assert.deepEqual(market.plugins.map((p) => [p.name, p.source, p.version]), [['nuworq', './plugin', manifest.version]]);
  });

  // `nuworq skill` writes skill({ url }) for the hub this machine is connected to; the plugin serves any hub,
  // so it carries the same generators' output without one.
  test("its skills are `nuworq skill`'s generators, byte for byte, and the folder is what `nuworq skill --plugin` writes", () => {
    assert.equal(read(PLUGIN, 'skills', 'nuworq', 'SKILL.md'), skill());
    assert.equal(read(PLUGIN, 'skills', 'nuworq-plan', 'SKILL.md'), planSkill());
    const out = mkdtempSync(join(tmpdir(), 'nuworq-plugin-'));
    execFileSync(process.execPath, [BIN, 'skill', '--plugin', out]);
    for (const f of files(PLUGIN)) assert.equal(read(out, relative(PLUGIN, f)), read(f), `${relative(PLUGIN, f)} is stale: run nuworq skill --plugin`);
  });
});
