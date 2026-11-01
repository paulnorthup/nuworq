// What "Connect an agent" tells someone to paste, from /api/info. Pure, so the UI and the tests share it.
// Shell commands never hold a placeholder: a shell reads <agent-token> as a redirect and fails with "no
// such file or directory". Every command is the installed `nuworq`, never a path into a checkout, and no
// config holds a token or an address: `nuworq connect` saves both, and `nuworq mcp` reads them.

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\])$/i;

// info: /api/info. page: the browser's location ({ protocol, host }), to correct a hub behind a TLS
// proxy that sees plain http. Returns the hub URL, whether it runs on this machine, and the commands.
export function connectCommands(info, page = null, slug = 'my-project') {
  const secure = (u) => (page?.protocol === 'https:' && u.startsWith('http://') && new URL(u).host === page.host ? `https:${u.slice(5)}` : u);
  const url = secure(String(info.url ?? '').replace(/\/+$/, ''));
  const local = LOOPBACK.test(new URL(url).hostname);
  // The hub serves the package of the commit it runs (#102): one install, from this hub, wherever it is.
  const pkg = info.package?.url ? secure(info.package.url) : null;
  return {
    url, local, secured: info.auth === 'required',
    install: pkg ? `npm install -g ${pkg}` : null,
    // One paste (#490): install from this hub, then connect, which goes on to ask about the rest of the setup.
    setup: pkg ? `npm install -g ${pkg} && nuworq connect ${url}` : `nuworq connect ${url}`,
    // Log in through the browser, save the token and the address, register nuworq with Claude Code and Codex.
    connect: `nuworq connect ${url}`,
    // Keep workers going wherever work is waiting, across projects; one worker on its own.
    run: 'nuworq run --workers 3 --agent claude',
    worker: 'nuworq worker --agent claude --run',
    // For Claude Code (#97, #432): the MCP server, /nuworq:shaper and /nuworq:operator as one plugin, as in the README.
    plugin: 'claude plugin marketplace add paulnorthup/nuworq\nclaude plugin install nuworq@nuworq',
    // By hand (what connect does for you): no token, no address, no path.
    claude: 'claude mcp add --scope user nuworq -- nuworq mcp',
    codex: '[mcp_servers.nuworq]\ncommand = "nuworq"\nargs = ["mcp"]\ndefault_tools_approval_mode = "approve"',
    mcp: 'command: nuworq\nargs: ["mcp"]',
    guide: `nuworq guide --project ${slug}`,
  };
}

// The commands meant for a shell, for checking: none may hold a placeholder.
export const shellCommands = (c) => [c.setup, c.install, c.connect, c.run, c.worker, c.plugin, c.claude, c.guide].filter(Boolean);
