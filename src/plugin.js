// nuworq as one Claude Code plugin: the MCP server and both skills, generated (nuworq skill --plugin) so
// its skills are byte for byte what `nuworq skill` writes and can't drift from the protocol. The plugin
// serves any hub, so its skills name none; the MCP server finds the hub and token in connect.json.
// It starts the server as `nuworq mcp` (the installed package, #101): Claude Code copies a plugin into its
// own cache, so a path back into this checkout wouldn't survive the install.
import { skill, planSkill } from './protocol.js';

// { relative path: contents } for the plugin folder.
export function pluginFiles({ version }) {
  const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
  return {
    '.claude-plugin/plugin.json': json({
      name: 'nuworq',
      version,
      description: 'nuworq: claim, build, review and land work on a nuworq hub. The nuworq MCP server plus the nuworq and nuworq-plan skills.',
      homepage: 'https://nuworq.com',
      license: 'MIT',
    }),
    '.mcp.json': json({ mcpServers: { nuworq: { command: 'nuworq', args: ['mcp'] } } }),
    'skills/nuworq/SKILL.md': skill(),
    'skills/nuworq-plan/SKILL.md': planSkill(),
  };
}

// The marketplace that lists it (.claude-plugin/marketplace.json at the repository root), so
// `claude plugin marketplace add <repo>` then `claude plugin install nuworq@nuworq` installs it.
export function marketplace({ version }) {
  return `${JSON.stringify({
    name: 'nuworq',
    owner: { name: 'nuworq' },
    plugins: [{ name: 'nuworq', source: './plugin', version, description: 'The nuworq MCP server and the nuworq and nuworq-plan skills.' }],
  }, null, 2)}\n`;
}
