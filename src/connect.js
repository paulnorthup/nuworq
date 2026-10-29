// nuworq connect: register the nuworq MCP server with the agent tools installed on this machine, and
// remember exactly what was added, so disconnect removes that and nothing else. No token goes into
// any tool's config: the MCP server reads the saved connection (connect.json) itself.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';

const NAME = 'nuworq';

const onPath = (cmd, env) => (env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, cmd)));
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
const codexBlock = (bin) => `\n[mcp_servers.${NAME}]\ncommand = "node"\nargs = [${JSON.stringify(bin)}, "mcp"]\ndefault_tools_approval_mode = "approve"\n`;

// Each tool: where it keeps MCP servers, whether nuworq is there already, how to add and remove it.
// add() returns the record to keep (what disconnect needs), or a reason it was left alone.
const TOOLS = {
  claude: {
    label: 'Claude Code',
    where: () => 'claude mcp (user scope)',
    present: ({ env }) => onPath('claude', env),
    add({ bin, env }) {
      if (run('claude', ['mcp', 'get', NAME], env).ok) return { skip: `it already has a "${NAME}" MCP server` };
      const r = run('claude', ['mcp', 'add', '--scope', 'user', NAME, '--', 'node', bin, 'mcp'], env);
      if (!r.ok) return { skip: `claude mcp add failed: ${r.out.split('\n')[0]}` };
      return { record: {} };
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
      const block = codexBlock(ctx.bin);
      writeFileSync(file, text + (text.endsWith('\n') || !text ? '' : '\n') + block);
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
      const entry = { type: 'local', command: ['node', ctx.bin, 'mcp'], enabled: true };
      const createdMcp = !cfg.mcp;
      cfg.mcp = { ...(cfg.mcp ?? {}), [NAME]: entry };
      writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
      return { record: { file, entry, createdMcp } };
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

// Register with every installed tool that doesn't have nuworq yet. kept: records from an earlier
// connect, carried over so disconnect still removes them. Returns { added, lines }: the records to
// save, and one line per tool saying what happened.
export function registerMcp({ bin, home, env = process.env, kept = [] }) {
  const ctx = { bin, home, env };
  const added = [...kept];
  const lines = [];
  for (const [tool, t] of Object.entries(TOOLS)) {
    if (kept.some((k) => k.tool === tool)) { lines.push(`${t.label}: already set up by an earlier connect`); continue; }
    if (!t.present(ctx)) continue;
    const r = t.add(ctx);
    if (r.record) {
      added.push({ tool, ...r.record });
      lines.push(`${t.label}: added the ${NAME} MCP server (${t.where(ctx)})`);
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
