// nuworq as one Claude Code plugin: the MCP server, the three skills and the operator's listener, generated
// (nuworq skill --plugin) so its skills are byte for byte what `nuworq skill` writes and can't drift from the
// protocol. The plugin serves any hub, so its skills name none; the MCP server finds the hub and token in connect.json.
// It starts the server as `nuworq mcp` (the installed package, #101): Claude Code copies a plugin into its
// own cache, so a path back into this checkout wouldn't survive the install.
import { skill, shaperSkill, operatorSkill, OPERATOR_WAIT, PLUGIN_SKILLS } from './protocol.js';

// The operator's listener (#284): a monitor that starts only when a person invokes the operator skill,
// so worker and ordinary sessions never listen. What it prints reaches the idle session and starts a turn;
// between lines it is one open request to the hub and no model calls.
// Claude Code matches `when` against the skill's name as dispatched, and a plugin skill dispatches as
// <plugin>:<dir> (#328), so /nuworq:operator matches it and a copy in ~/.claude/skills never does.
// Entries keep exactly these four keys; Claude Code rejects an unknown one and then loads none of the plugin.
export const MONITORS = [{
  name: 'nuworq-operator-listener',
  command: OPERATOR_WAIT,
  description: 'nuworq operator listener',
  when: `on-skill-invoke:nuworq:${PLUGIN_SKILLS.operator}`,
}];

const WHAT = 'The nuworq MCP server, the /nuworq:shaper and /nuworq:operator commands, the skill workers load on their own, and the operator\'s listener.';

// Where the plugin installs from (#473): the release branch, which the release workflow (.github/workflows/release.yml)
// moves to each release the maintainer approved and it signed. Never main: a commit there alone changes nothing on anyone's machine.
// The marketplace is added at that branch too, so the entry below is read from a release as well.
export const REPO = 'paulnorthup/nuworq';
export const RELEASE_BRANCH = 'release';
export const MARKETPLACE = `${REPO}#${RELEASE_BRANCH}`;

// { relative path: contents } for the plugin folder.
// No version, here or in the marketplace entry (#364): Claude Code then takes it from the installed commit, so
// every release is an update. A pinned "version" kept everyone on the cached copy until it changed.
export function pluginFiles() {
  const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
  return {
    '.claude-plugin/plugin.json': json({
      name: 'nuworq',
      description: `nuworq: claim, build, review and land work on a nuworq hub. ${WHAT}`,
      author: { name: 'nuworq', url: 'https://nuworq.com' },
      homepage: 'https://nuworq.com',
      license: 'MIT',
    }),
    '.mcp.json': json({ mcpServers: { nuworq: { command: 'nuworq', args: ['mcp'] } } }),
    'monitors/monitors.json': json(MONITORS),
    [`skills/${PLUGIN_SKILLS.worker}/SKILL.md`]: skill(),
    [`skills/${PLUGIN_SKILLS.shaper}/SKILL.md`]: shaperSkill(),
    [`skills/${PLUGIN_SKILLS.operator}/SKILL.md`]: operatorSkill(),
  };
}

// The marketplace that lists it (.claude-plugin/marketplace.json at the repository root), so
// `claude plugin marketplace add <MARKETPLACE>` then `claude plugin install nuworq@nuworq --scope user` installs it.
// The plugin's source is the release branch's plugin/ folder, not "./plugin": a marketplace added before #473
// follows main, and this way it too gets the plugin only from a release.
export function marketplace() {
  return `${JSON.stringify({
    name: 'nuworq',
    owner: { name: 'nuworq' },
    metadata: { description: 'The Claude Code plugin for nuworq, the work hub where AI agents claim, build, review and land work.' },
    plugins: [{ name: 'nuworq', source: { source: 'git-subdir', url: REPO, path: 'plugin', ref: RELEASE_BRANCH }, description: WHAT }],
  }, null, 2)}\n`;
}
