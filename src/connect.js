// nuworq connect: register the nuworq MCP server with the agent tools installed on this machine, and
// remember exactly what was added, so disconnect removes that and nothing else. No token goes into
// any tool's config: the MCP server reads the saved connection (connect.json) itself.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, rmdirSync, realpathSync } from 'node:fs';
import { join, dirname, basename, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { userSkills } from './protocol.js';
import { MARKETPLACE, REPO, RELEASE_BRANCH } from './plugin.js';

const NAME = 'nuworq';
// How a person installs the plugin, and the `claude` arguments connect runs when they say yes (#432): the
// marketplace at its release branch (#473), installed for the account (#496), so every project gets it, not only
// the folder it was installed from.
export const PLUGIN_INSTALL = [['plugin', 'marketplace', 'add', MARKETPLACE], ['plugin', 'install', `${NAME}@${NAME}`, '--scope', 'user']];

const which = (cmd, env) => (env.PATH ?? '').split(delimiter).map((d) => d && join(d, cmd)).find((f) => f && existsSync(f)) ?? null;
const onPath = (cmd, env) => !!which(cmd, env);
const real = (f) => { try { return realpathSync(f); } catch { return f; } };
const list = (names) => names.join(', ').replace(/, ([^,]+)$/, ' and $1');

// How the tools start the MCP server: `nuworq mcp` when the nuworq on PATH is this very copy (installed
// as a package), so their configs hold no folder paths and keep working when it updates; otherwise
// `node <bin> mcp`, with why.
export function launcher(bin, env = process.env) {
  const found = which(NAME, env);
  if (found && real(found) === real(bin)) return { command: NAME, args: ['mcp'] };
  return {
    command: 'node', args: [bin, 'mcp'],
    why: found ? `the nuworq on PATH (${found}) is another copy, so tools start this one by its path` : "nuworq isn't on PATH (this is a checkout, not an installed package), so tools start it by its path",
  };
}

// An entry an earlier connect wrote the old way: node <…/nuworq.js> mcp.
const oldForm = (command, args) => command === 'node' && args.length === 2 && /nuworq\.js$/.test(args[0]) && args[1] === 'mcp';
const run = (cmd, args, env, cwd) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { env, cwd, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message };
  }
};

// The Codex block, exactly as written: disconnect removes this text and only this text.
// Codex asks before every MCP tool call unless told otherwise, and a headless session (codex exec) has
// nobody to answer, so the call is cancelled. nuworq's own tools are approved; nothing else is.
const tomlArgs = (args) => `[${args.map((a) => JSON.stringify(a)).join(', ')}]`;
const codexBlock = (l) => `\n[mcp_servers.${NAME}]\ncommand = ${JSON.stringify(l.command)}\nargs = ${tomlArgs(l.args)}\ndefault_tools_approval_mode = "approve"\n`;
// nuworq's table in a Codex config: its header and every line up to the next table.
const codexSection = (text) => text.match(new RegExp(`^\\[mcp_servers\\.${NAME}\\]\\n(?:(?!\\[).*(?:\\n|$))*`, 'm'))?.[0] ?? null;

// Each tool: where it keeps MCP servers, whether nuworq is there already, how to add and remove it.
// add() returns the record to keep (what disconnect needs), or a reason it was left alone.
const TOOLS = {
  // The nuworq skills (generated from the protocol; see userSkills() in src/protocol.js), only for a Claude Code
  // without the plugin. Rewritten on every connect, so they follow the hub's tools; disconnect removes them.
  skill: {
    label: 'Claude Code skill',
    refresh: true,
    where: ({ home }) => join(home, '.claude', 'skills'),
    present: ({ env }) => onPath('claude', env),
    add(ctx) {
      const files = Object.entries(userSkills({ url: ctx.url })).map(([name, text]) => {
        const file = join(TOOLS.skill.where(ctx), name, 'SKILL.md');
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
        return file;
      });
      return { record: { files } };
    },
    remove(ctx, rec) {
      // An older connect recorded just the one skill, as { file }.
      for (const file of rec.files ?? [rec.file]) {
        rmSync(file, { force: true });
        try { rmdirSync(dirname(file)); } catch { /* not empty: something else lives there */ }
      }
      return null;
    },
  },
  claude: {
    label: 'Claude Code',
    where: () => 'claude mcp (user scope)',
    present: ({ env }) => onPath('claude', env),
    add({ launch, env }) {
      if (run('claude', ['mcp', 'get', NAME], env).ok) return { skip: `it already has a "${NAME}" MCP server` };
      const r = run('claude', ['mcp', 'add', '--scope', 'user', NAME, '--', launch.command, ...launch.args], env);
      if (!r.ok) return { skip: `claude mcp add failed: ${r.out.split('\n')[0]}` };
      return { record: {} };
    },
    // `claude mcp get` prints Command:, Args: and the Environment: lines; an old-form entry is re-added
    // path-free with the same environment.
    upgrade({ launch, env }) {
      const got = run('claude', ['mcp', 'get', NAME], env);
      if (!got.ok) return null;
      const command = got.out.match(/^\s*Command:\s*(\S+)/m)?.[1] ?? '';
      const args = (got.out.match(/^\s*Args:\s*(.*)$/m)?.[1] ?? '').trim().split(/\s+/);
      if (!oldForm(command, args)) return null;
      const vars = [...(got.out.split(/^\s*Environment:\s*$/m)[1] ?? '').matchAll(/^\s+([A-Za-z_][A-Za-z0-9_]*=.*)$/gm)].map((m) => m[1].trim());
      run('claude', ['mcp', 'remove', '--scope', 'user', NAME], env);
      const r = run('claude', ['mcp', 'add', '--scope', 'user', ...vars.flatMap((v) => ['-e', v]), NAME, '--', launch.command, ...launch.args], env);
      return r.ok ? { record: {} } : { skip: `claude mcp add failed: ${r.out.split('\n')[0]}` };
    },
    remove({ env }) {
      const r = run('claude', ['mcp', 'remove', '--scope', 'user', NAME], env);
      return r.ok || /not found|no .*server/i.test(r.out) ? null : `claude mcp remove failed: ${r.out.split('\n')[0]}`;
    },
  },
  codex: {
    label: 'Codex',
    where: ({ home }) => join(home, '.codex', 'config.toml'),
    present: (ctx) => existsSync(TOOLS.codex.where(ctx)),
    add(ctx) {
      const file = TOOLS.codex.where(ctx);
      const text = readFileSync(file, 'utf8');
      if (new RegExp(`^\\[mcp_servers\\.${NAME}\\]`, 'm').test(text)) return { skip: `it already has [mcp_servers.${NAME}]` };
      const block = codexBlock(ctx.launch);
      writeFileSync(file, text + (text.endsWith('\n') || !text ? '' : '\n') + block);
      return { record: { file, block } };
    },
    // Only the command and args lines change; the table's other keys stay as they are.
    upgrade(ctx) {
      const file = TOOLS.codex.where(ctx);
      const text = readFileSync(file, 'utf8');
      const sec = codexSection(text);
      const command = sec?.match(/^command\s*=\s*"([^"]*)"\s*$/m)?.[1];
      const args = sec?.match(/^args\s*=\s*\[(.*)\]\s*$/m)?.[1].split(',').map((a) => a.trim().replace(/^"|"$/g, ''));
      if (!sec || !command || !args || !oldForm(command, args)) return null;
      const block = sec.replace(/^command\s*=.*$/m, `command = ${JSON.stringify(ctx.launch.command)}`).replace(/^args\s*=.*$/m, `args = ${tomlArgs(ctx.launch.args)}`);
      writeFileSync(file, text.replace(sec, block));
      return { record: { file, block } };
    },
    remove(ctx, rec) {
      if (!existsSync(rec.file)) return null;
      const text = readFileSync(rec.file, 'utf8');
      if (text.includes(rec.block)) writeFileSync(rec.file, text.replace(rec.block, ''));
      return null;
    },
  },
  opencode: {
    label: 'opencode',
    where: ({ home }) => join(home, '.config', 'opencode', 'opencode.json'),
    present: (ctx) => existsSync(TOOLS.opencode.where(ctx)),
    add(ctx) {
      const file = TOOLS.opencode.where(ctx);
      let cfg;
      try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch { return { skip: `${file} isn't plain JSON (comments?); add it by hand: nuworq init shows how` }; }
      if (cfg.mcp?.[NAME]) return { skip: `it already has mcp.${NAME}` };
      const entry = { type: 'local', command: [ctx.launch.command, ...ctx.launch.args], enabled: true };
      const createdMcp = !cfg.mcp;
      cfg.mcp = { ...(cfg.mcp ?? {}), [NAME]: entry };
      writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
      return { record: { file, entry, createdMcp } };
    },
    upgrade(ctx) {
      const file = TOOLS.opencode.where(ctx);
      let cfg;
      try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
      const cur = cfg.mcp?.[NAME];
      if (!Array.isArray(cur?.command) || !oldForm(cur.command[0], cur.command.slice(1))) return null;
      const entry = { ...cur, command: [ctx.launch.command, ...ctx.launch.args] };
      cfg.mcp[NAME] = entry;
      writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
      return { record: { file, entry, createdMcp: false } };
    },
    remove(ctx, rec) {
      if (!existsSync(rec.file)) return null;
      let cfg;
      try { cfg = JSON.parse(readFileSync(rec.file, 'utf8')); } catch { return `${rec.file} isn't plain JSON any more; remove mcp.${NAME} by hand`; }
      // Only what connect wrote: an entry someone has changed since is theirs now.
      if (!cfg.mcp?.[NAME] || JSON.stringify(cfg.mcp[NAME]) !== JSON.stringify(rec.entry)) return null;
      delete cfg.mcp[NAME];
      if (rec.createdMcp && !Object.keys(cfg.mcp).length) delete cfg.mcp;
      writeFileSync(rec.file, JSON.stringify(cfg, null, 2) + '\n');
      return null;
    },
  },
  // pi (1.4+) has MCP built in, kept in mcp.json in its agent folder (PI_CODING_AGENT_DIR, else ~/.pi/agent). Its own
  // CLI writes the entry. Direct exposure: nuworq's tools are declared to the model as they are, not behind codemode.
  pi: {
    label: 'pi',
    where: ({ home, env }) => join(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), 'mcp.json'),
    present: ({ env }) => onPath('pi', env),
    add(ctx) {
      let cfg = {};
      try { cfg = JSON.parse(readFileSync(TOOLS.pi.where(ctx), 'utf8')); } catch { /* none yet */ }
      if (cfg.mcpServers?.[NAME]) return { skip: `it already has a "${NAME}" MCP server` };
      const r = run('pi', ['mcp', 'add', NAME, '--exposure', 'direct', '--', ctx.launch.command, ...ctx.launch.args], ctx.env);
      if (!r.ok) return { skip: `pi mcp add failed: ${r.out.split('\n')[0]}` };
      return { record: {} };
    },
    remove({ env }) {
      const r = run('pi', ['mcp', 'remove', NAME], env);
      return r.ok || /no .*server named/i.test(r.out) ? null : `pi mcp remove failed: ${r.out.split('\n')[0]}`;
    },
  },
};

// The nuworq Claude Code plugin (plugin/, see src/plugin.js) brings the MCP server and the skills
// itself. Claude Code lists installed plugins as "<plugin>@<marketplace>" in installed_plugins.json.
const CLAUDE_TOOLS = ['claude', 'skill'];
export const claudeCode = (env = process.env) => onPath('claude', env);
// Install the plugin with Claude Code's own CLI. Returns null, or what went wrong in one line.
export function installPlugin(env = process.env) {
  for (const args of PLUGIN_INSTALL) {
    const r = run('claude', args, env);
    // Adding a marketplace that is already there isn't a failure.
    if (!r.ok && !/already/i.test(r.out)) return `claude ${args.join(' ')} failed: ${r.out.split('\n')[0]}`;
  }
  return null;
}
// Where Claude Code has the plugin (#496): { account, folders }. account: an install it applies to every project
// (user or managed scope; an entry from before scopes had none, and was the account's). folders: the projects an
// install for some folders only covers (local or project scope), which other projects don't get.
// installs: each of those folder installs with its scope, { scope, projectPath } (#608: what a repin puts back).
export function pluginScopes(home) {
  const out = { account: false, folders: [], installs: [] };
  try {
    const { plugins = {} } = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [key, installs] of Object.entries(plugins)) {
      if (!key.startsWith(`${NAME}@`)) continue;
      for (const i of [].concat(installs)) {
        if (!i || typeof i !== 'object') continue;
        if (!i.scope || i.scope === 'user' || i.scope === 'managed') out.account = true;
        else if (i.projectPath && !out.folders.includes(i.projectPath)) {
          out.folders.push(i.projectPath);
          out.installs.push({ scope: i.scope, projectPath: i.projectPath });
        }
      }
    }
  } catch { /* no plugins file: none installed */ }
  return out;
}
// The plugin covers Claude Code only when it's installed for the account.
export const pluginInstalled = (home) => pluginScopes(home).account;

// A nuworq marketplace added before #473 (#608) follows GitHub's default branch, so `claude plugin update` reads its
// plugin entry from main, where agents land without a release. Its source as Claude Code recorded it in
// known_marketplaces.json, when it is nuworq's repository at any branch but the release one; else null. A marketplace
// from a folder, or another repository, is the person's own and stays.
export function staleMarketplace(home) {
  try {
    const src = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'known_marketplaces.json'), 'utf8'))?.[NAME]?.source;
    if (!src || !['github', 'git'].includes(src.source)) return null;
    const [repo, ref = src.ref] = String(src.repo ?? src.url ?? '').replace(/\.git$/, '').split('#');
    if (!repo.endsWith(REPO)) return null;
    return ref === RELEASE_BRANCH ? null : src;
  } catch { return null; } // no marketplaces file: nothing added
}
// What moves it onto the release branch: remove it and add it again at MARKETPLACE, then install the plugin again
// everywhere it was, since removing a marketplace uninstalls its plugins in every scope: for the account if it was,
// and in each folder it was installed for (in that folder, with its scope), skipping folders that are gone.
// [{ args, cwd? }].
export function REPIN(home) {
  const steps = [{ args: ['plugin', 'marketplace', 'remove', NAME] }, { args: PLUGIN_INSTALL[0] }];
  const { account, installs } = pluginScopes(home);
  if (account) steps.push({ args: PLUGIN_INSTALL[1] });
  for (const i of installs) {
    if (existsSync(i.projectPath)) steps.push({ args: ['plugin', 'install', `${NAME}@${NAME}`, '--scope', i.scope], cwd: i.projectPath });
  }
  return steps;
}
// The steps as a person types them.
export const repinCommands = (home) => REPIN(home).map((s) => `${s.cwd ? `(cd ${JSON.stringify(s.cwd)} && ` : ''}claude ${s.args.join(' ')}${s.cwd ? ')' : ''}`).join(' && ');
// Run REPIN; null, or what went wrong in one line.
export function repinMarketplace(home, env = process.env) {
  for (const s of REPIN(home)) {
    const r = run('claude', s.args, env, s.cwd);
    if (!r.ok && !(s.args[2] === 'add' && /already/i.test(r.out))) return `claude ${s.args.join(' ')}${s.cwd ? ` (in ${s.cwd})` : ''} failed: ${r.out.split('\n')[0]}`;
  }
  return null;
}

// What an earlier nuworq left in Claude Code beside an account-wide plugin (#496), recorded or not: skill folders
// in ~/.claude/skills whose SKILL.md carries the generated line, and a user-scope MCP server named nuworq that
// starts nuworq. A folder without that line, or a server that starts something else, is the person's and stays.
// skip: SKILL.md files and tools ('claude') connect already takes back from its own record.
export const LEFTOVER_SKILLS = [NAME, `${NAME}-plan`, `${NAME}-shaper`, `${NAME}-operator`];
const GENERATED = /Generated by `nuworq skill`/;
const startsNuworq = (s) => {
  const args = Array.isArray(s?.args) ? s.args : [];
  return (s?.command === NAME && args[0] === 'mcp') || (s?.command === 'node' && /(^|[/\\])nuworq(\.js)?$/.test(args[0] ?? '') && args[1] === 'mcp');
};
export function leftovers(home, { skip = [] } = {}) {
  const skills = LEFTOVER_SKILLS.map((name) => join(home, '.claude', 'skills', name)).filter((dir) => {
    const file = join(dir, 'SKILL.md');
    if (skip.includes(file)) return false;
    try { return GENERATED.test(readFileSync(file, 'utf8')); } catch { return false; }
  });
  let mcp = false;
  // Claude Code keeps user-scope MCP servers in ~/.claude.json, under mcpServers (projects' own are under projects).
  try { mcp = !skip.includes('claude') && startsNuworq(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers?.[NAME]); } catch { /* none */ }
  return { skills, mcp };
}
// The commands that remove them, for a person to run when there's no one to ask.
export const leftoverCommands = ({ skills, mcp }) => [...skills.map((d) => `rm -r ${JSON.stringify(d)}`), ...(mcp ? [`claude mcp remove --scope user ${NAME}`] : [])];
// Remove them. Returns one line per thing that couldn't go.
export function removeLeftovers({ skills, mcp }, env = process.env) {
  const problems = [];
  for (const dir of skills) {
    try { rmSync(dir, { recursive: true, force: true }); } catch (e) { problems.push(`couldn't remove ${dir}: ${e.message}`); }
  }
  if (mcp) {
    const r = run('claude', ['mcp', 'remove', '--scope', 'user', NAME], env);
    if (!r.ok && !/not found|no .*server/i.test(r.out)) problems.push(`claude mcp remove failed: ${r.out.split('\n')[0]}`);
  }
  return problems;
}

// Register with every installed tool that doesn't have nuworq yet. kept: records from an earlier
// connect, carried over so disconnect still removes them. Returns { added, lines }: the records to
// save, and one line per tool saying what happened. url: the hub, which the skill points at.
export function registerMcp({ bin, home, env = process.env, kept = [], url = '' }) {
  const launch = launcher(bin, env);
  const ctx = { bin, home, env, url, launch };
  let added = kept.filter((k) => !TOOLS[k.tool]?.refresh);
  const lines = launch.why ? [`Tools start nuworq by its path: ${launch.why}`] : [];
  // With the plugin, Claude Code is the plugin's: a second server and second copies of the skills
  // would only compete with it, so what an earlier connect added there goes.
  const scopes = pluginScopes(home), plugin = scopes.account;
  const skillsOf = (recs) => recs.filter((k) => k.tool === 'skill').flatMap((k) => k.files ?? [k.file]).map((f) => basename(dirname(f)));
  if (plugin) {
    const old = kept.filter((k) => CLAUDE_TOOLS.includes(k.tool));
    for (const rec of old) TOOLS[rec.tool].remove(ctx, rec);
    added = added.filter((k) => !CLAUDE_TOOLS.includes(k.tool));
    const gone = [old.some((k) => k.tool === 'claude') && 'its MCP server', skillsOf(old).length && `the ${list(skillsOf(old))} skills in ${TOOLS.skill.where(ctx)}`].filter(Boolean);
    lines.push(`Claude Code: left to the ${NAME} plugin, which brings the MCP server and the /${NAME}:shaper and /${NAME}:operator commands${gone.length ? `; removed what an earlier connect added: ${gone.join(' and ')}` : ''}`);
    // Installs for single folders (a worker's worktree among them) stay: nuworq run turns plugins off for workers anyway.
    const n = scopes.folders.length;
    if (n) lines.push(`Claude Code: left the plugin's ${n} install${n > 1 ? 's' : ''} for single folders alone (workers turn plugins off there)`);
  } else {
    // Skills an earlier connect wrote under names this one no longer uses (the planning skill before #432) go.
    const now = new Set(Object.keys(userSkills()));
    const stale = kept.filter((k) => k.tool === 'skill').flatMap((k) => k.files ?? [k.file]).filter((f) => !now.has(basename(dirname(f))));
    if (stale.length) {
      TOOLS.skill.remove(ctx, { files: stale });
      lines.push(`${TOOLS.skill.label}: removed the old ${list(stale.map((f) => basename(dirname(f))))} skill${stale.length > 1 ? 's' : ''} (${TOOLS.skill.where(ctx)})`);
    }
  }
  // What is rewritten every time comes last, so the record reads the same after each connect.
  for (const [tool, t] of Object.entries(TOOLS).sort(([, a], [, b]) => !!a.refresh - !!b.refresh)) {
    if (plugin && CLAUDE_TOOLS.includes(tool)) continue;
    // An entry in the old node <path> form becomes path-free, whoever wrote it; its other settings stay.
    const up = t.upgrade && t.present(ctx) && launch.command === NAME ? t.upgrade(ctx) : null;
    if (up?.record) {
      // Recorded for disconnect only if an earlier connect wrote it; one written by hand stays the person's.
      const k = added.findIndex((a) => a.tool === tool);
      if (k >= 0) added[k] = { ...added[k], ...up.record, ...('createdMcp' in added[k] ? { createdMcp: added[k].createdMcp } : {}) };
      lines.push(`${t.label}: now starts it as \`${NAME} mcp\`, without a folder path (${t.where(ctx)})`);
      continue;
    }
    if (up?.skip) { lines.push(`${t.label}: left alone, ${up.skip}`); continue; }
    if (!t.refresh && kept.some((k) => k.tool === tool)) { lines.push(`${t.label}: already set up by an earlier connect`); continue; }
    if (!t.present(ctx)) continue;
    const r = t.add(ctx);
    if (r.record) {
      added.push({ tool, ...r.record });
      lines.push(tool === 'skill' ? `${t.label}: wrote the ${list(Object.keys(userSkills()))} skills (${t.where(ctx)})`: `${t.label}: added the ${NAME} MCP server (${t.where(ctx)})`);
    } else {
      lines.push(`${t.label}: left alone, ${r.skip}`);
    }
  }
  return { added, lines };
}

// Undo exactly what registerMcp recorded. Returns one line per tool.
export function unregisterMcp({ home, env = process.env, added = [] }) {
  const ctx = { home, env };
  return added.filter((rec) => TOOLS[rec.tool]).map((rec) => {
    const t = TOOLS[rec.tool];
    const problem = t.remove(ctx, rec);
    return problem ? `${t.label}: ${problem}` : `${t.label}: removed the ${NAME} MCP server (${t.where(ctx)})`;
  });
}
