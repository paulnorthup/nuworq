import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { skill, planSkill, operatorSkill } from '../src/protocol.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'bin', 'nuworq.js');
const PLUGIN = join(ROOT, 'plugin');
const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const read = (...p) => readFileSync(join(...p), 'utf8');

// One Claude Code plugin: the MCP server, the skills (#97) and the operator's listener (#284).
describe('the Claude Code plugin', () => {
  test('a manifest, the MCP server path-free, the three skills and the monitor, nothing else', () => {
    assert.deepEqual(files(PLUGIN).map((f) => relative(PLUGIN, f)).sort(), ['.claude-plugin/plugin.json', '.mcp.json', 'monitors/monitors.json', 'skills/nuworq-operator/SKILL.md', 'skills/nuworq-plan/SKILL.md', 'skills/nuworq/SKILL.md']);
    const monitors = JSON.parse(read(PLUGIN, 'monitors', 'monitors.json'));
    assert.ok(Array.isArray(monitors), 'monitors.json is a bare array');
    for (const m of monitors) assert.deepEqual(Object.keys(m).sort(), ['command', 'description', 'name', 'when'], 'strict entries: an unknown key keeps the plugin from loading');
    assert.ok(monitors.every((m) => m.when.startsWith('on-skill-invoke:')), 'no monitor starts in every session');
    const manifest = JSON.parse(read(PLUGIN, '.claude-plugin', 'plugin.json'));
    assert.equal(manifest.name, 'nuworq');
    assert.ok(!('version' in manifest), 'no pinned version: Claude Code takes it from the commit, so `claude plugin update` finds new ones (#364)');
    assert.match(manifest.description, /MCP server/);
    assert.equal(manifest.author.name, 'nuworq', '`claude plugin validate` warns without an author');
    assert.deepEqual(JSON.parse(read(PLUGIN, '.mcp.json')), { mcpServers: { nuworq: { command: 'nuworq', args: ['mcp'] } } }, 'no folder path, no token');
    for (const name of ['nuworq', 'nuworq-plan', 'nuworq-operator']) assert.match(read(PLUGIN, 'skills', name, 'SKILL.md'), new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n(?:[a-z-]+: .+\\n)*---\\n`));
    const market = JSON.parse(read(ROOT, '.claude-plugin', 'marketplace.json'));
    assert.ok(market.metadata.description, '`claude plugin validate` warns without a marketplace description');
    assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [['nuworq', './plugin']]);
    assert.ok(market.plugins.every((p) => !('version' in p)), 'nor in the marketplace entry');
  });

  // `nuworq skill` writes skill({ url }) for the hub this machine is connected to; the plugin serves any hub,
  // so it carries the same generators' output without one.
  test("its skills are `nuworq skill`'s generators, byte for byte, and the folder is what `nuworq skill --plugin` writes", () => {
    assert.equal(read(PLUGIN, 'skills', 'nuworq', 'SKILL.md'), skill());
    assert.equal(read(PLUGIN, 'skills', 'nuworq-plan', 'SKILL.md'), planSkill());
    assert.equal(read(PLUGIN, 'skills', 'nuworq-operator', 'SKILL.md'), operatorSkill());
    const out = mkdtempSync(join(tmpdir(), 'nuworq-plugin-'));
    execFileSync(process.execPath, [BIN, 'skill', '--plugin', out]);
    for (const f of files(PLUGIN)) assert.equal(read(out, relative(PLUGIN, f)), read(f), `${relative(PLUGIN, f)} is stale: run nuworq skill --plugin`);
  });
});
