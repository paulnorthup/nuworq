import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { skill, shaperSkill, operatorSkill } from '../src/protocol.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'bin', 'nuworq.js');
const PLUGIN = join(ROOT, 'plugin');
const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const read = (...p) => readFileSync(join(...p), 'utf8');

// One Claude Code plugin: the MCP server, the skills (#97) and the operator's listener (#284).
describe('the Claude Code plugin', () => {
  test('a manifest, the MCP server path-free, the three skills and the monitor, nothing else', () => {
    assert.deepEqual(files(PLUGIN).map((f) => relative(PLUGIN, f)).sort(), ['.claude-plugin/plugin.json', '.mcp.json', 'monitors/monitors.json', 'skills/nuworq/SKILL.md', 'skills/operator/SKILL.md', 'skills/shaper/SKILL.md']);
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
    for (const name of ['nuworq', 'shaper', 'operator']) assert.match(read(PLUGIN, 'skills', name, 'SKILL.md'), new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n(?:[a-z-]+: .+\\n)*---\\n`));
    const market = JSON.parse(read(ROOT, '.claude-plugin', 'marketplace.json'));
    assert.ok(market.metadata.description, '`claude plugin validate` warns without a marketplace description');
    assert.ok(market.plugins.every((p) => !('version' in p)), 'nor in the marketplace entry');
  });

  // #473: "./plugin" followed main, so every commit there reached people's machines with no release and no person.
  test('installs from the release branch the signer moves, never from main', async () => {
    const market = JSON.parse(read(ROOT, '.claude-plugin', 'marketplace.json'));
    assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [['nuworq', { source: 'git-subdir', url: 'paulnorthup/nuworq', path: 'plugin', ref: 'release' }]],
      'even a marketplace added at main takes the plugin from the release branch');
    const { RELEASE_BRANCH } = await import('../scripts/signer.js');
    assert.equal(RELEASE_BRANCH, 'release', 'the branch the signer moves to each signed release');
    const { PLUGIN_INSTALL } = await import('../src/connect.js');
    const { connectCommands } = await import('../web/connect.js');
    assert.deepEqual(PLUGIN_INSTALL[0], ['plugin', 'marketplace', 'add', 'paulnorthup/nuworq#release'], 'connect adds the marketplace at the release branch');
    assert.match(connectCommands({ url: 'https://app.nuworq.com' }).plugin, /^claude plugin marketplace add paulnorthup\/nuworq#release\n/);
    for (const doc of ['README.md', join('docs', 'DEPLOY.md'), join('src', 'userguide.js')]) {
      assert.doesNotMatch(read(ROOT, doc), /marketplace add paulnorthup\/nuworq(?!#release)/, `${doc} adds the marketplace at the release branch`);
    }
  });

  // #432: Claude Code shows a plugin skill as /<plugin>:<name> unless its frontmatter says user-invocable: false.
  test('a person sees exactly /nuworq:shaper and /nuworq:operator; the worker skill loads on its own', () => {
    const skills = readdirSync(join(PLUGIN, 'skills')).map((dir) => ({ dir, text: read(PLUGIN, 'skills', dir, 'SKILL.md') }));
    const front = (text) => Object.fromEntries(text.split('\n---\n')[0].split('\n').slice(1).map((l) => l.split(/: (.*)/s).slice(0, 2)));
    const menu = skills.filter((s) => front(s.text)['user-invocable'] !== 'false').map((s) => `/nuworq:${front(s.text).name}`).sort();
    assert.deepEqual(menu, ['/nuworq:operator', '/nuworq:shaper']);
    for (const s of skills) assert.equal(front(s.text).name, s.dir, 'the name is the folder');
    assert.equal(front(read(PLUGIN, 'skills', 'nuworq', 'SKILL.md'))['disable-model-invocation'], undefined, 'the worker skill still loads when a session is asked to work on nuworq');
    assert.equal(front(read(PLUGIN, 'skills', 'operator', 'SKILL.md'))['disable-model-invocation'], 'true', 'only a person starts an operator');
    assert.equal(JSON.parse(read(PLUGIN, 'monitors', 'monitors.json'))[0].when, 'on-skill-invoke:nuworq:operator');
  });

  test('nothing still calls the shaper nuworq-plan, or the operator /nuworq:nuworq-operator', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
      .filter((f) => f && /\.(js|md|json)$/.test(f) && f !== 'CHANGELOG.md' && !f.startsWith('test/'));
    const stale = tracked.filter((f) => { try { return /nuworq-plan|nuworq:nuworq-/.test(read(ROOT, f)); } catch { return false; } });
    assert.deepEqual(stale, [], 'the CHANGELOG keeps its history; everything else uses shaper and operator');
  });

  // `nuworq skill` writes skill({ url }) for the hub this machine is connected to; the plugin serves any hub,
  // so it carries the same generators' output without one.
  test("its skills are `nuworq skill`'s generators, byte for byte, and the folder is what `nuworq skill --plugin` writes", () => {
    assert.equal(read(PLUGIN, 'skills', 'nuworq', 'SKILL.md'), skill());
    assert.equal(read(PLUGIN, 'skills', 'shaper', 'SKILL.md'), shaperSkill());
    assert.equal(read(PLUGIN, 'skills', 'operator', 'SKILL.md'), operatorSkill());
    const out = mkdtempSync(join(tmpdir(), 'nuworq-plugin-'));
    execFileSync(process.execPath, [BIN, 'skill', '--plugin', out]);
    for (const f of files(PLUGIN)) assert.equal(read(out, relative(PLUGIN, f)), read(f), `${relative(PLUGIN, f)} is stale: run nuworq skill --plugin`);
  });
});
