// nuworq connect: register the nuworq MCP server with the agent tools installed on this machine, and
// remember exactly what was added, so disconnect removes that and nothing else. No token goes into
// any tool's config: the MCP server reads the saved connection (connect.json) itself.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, rmdirSync, realpathSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { skill, planSkill } from './protocol.js';

const NAME = 'nuworq';
const SKILLS = { [NAME]: skill, [`${NAME}-plan`]: planSkill };

const which = (cmd, env) => (env.PATH ?? '').split(delimiter).map((d) => d && join(d, cmd)).find((f) => f && existsSync(f)) ?? null;
const onPath = (cmd, env) => !!which(cmd, env);
const real = (f) => { try { return realpathSync(f); } catch { return f; } };

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
const run = (cmd, args, env) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { env, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }) };
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
  // The nuworq skills (generated from the protocol; see skill() and planSkill() in src/protocol.js).
  // Rewritten on every connect, so they follow the hub's tools; disconnect removes them.
  skill: {
    label: 'Claude Code skill',
    refresh: true,
    where: ({ home }) => join(home, '.claude', 'skills'),
    present: ({ env }) => onPath('claude', env),
    add(ctx) {
      const files = Object.entries(SKILLS).map(([name, make]) => {
        const file = join(TOOLS.skill.where(ctx), name, 'SKILL.md');
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, make({ url: ctx.url }));
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
};

// The nuworq Claude Code plugin (plugin/, see src/plugin.js) brings the MCP server and both skills
// itself. Claude Code lists installed plugins as "<plugin>@<marketplace>" in installed_plugins.json.
const CLAUDE_TOOLS = ['claude', 'skill'];
export function pluginInstalled(home) {
  try {
    const { plugins = {} } = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    return Object.entries(plugins).some(([key, installs]) => key.startsWith(`${NAME}@`) && [].concat(installs).length > 0);
  } catch {
    return false;
  }
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
  const plugin = pluginInstalled(home);
  if (plugin) {
    const old = kept.filter((k) => CLAUDE_TOOLS.includes(k.tool));
    for (const rec of old) TOOLS[rec.tool].remove(ctx, rec);
    added = added.filter((k) => !CLAUDE_TOOLS.includes(k.tool));
    lines.push(`Claude Code: left to the ${NAME} plugin, which brings the MCP server and both skills${old.length ? '; removed what an earlier connect added' : ''}`);
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
      lines.push(tool === 'skill' ? `${t.label}: wrote the ${Object.keys(SKILLS).join(' and ')} skills (${t.where(ctx)})`: `${t.label}: added the ${NAME} MCP server (${t.where(ctx)})`);
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
