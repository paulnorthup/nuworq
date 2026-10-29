// What "Connect an agent" tells someone to paste, from /api/info. Pure, so the UI and the tests share it.
// Shell commands never hold a placeholder: a shell reads <agent-token> as a redirect and fails with "no
// such file or directory". A hub on another machine is reached through `nuworq connect`, which logs in
// through the browser and registers the MCP server itself; its own file paths mean nothing here.

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\])$/i;

// info: /api/info. page: the browser's location ({ protocol, host }), to correct a hub behind a TLS
// proxy that sees plain http. Returns the hub URL, whether it runs on this machine, and the commands.
export function connectCommands(info, page = null, slug = 'my-project') {
  const secure = (u) => (page?.protocol === 'https:' && u.startsWith('http://') && new URL(u).host === page.host ? `https:${u.slice(5)}` : u);
  const url = secure(String(info.url ?? '').replace(/\/+$/, ''));
  const local = LOOPBACK.test(new URL(url).hostname);
  const secured = info.auth === 'required';
  // A hub that serves its own package (#102) is two lines from anywhere: install it, then connect.
  const pkg = !local && info.package?.url ? secure(info.package.url) : null;
  // Here: the hub's own copy of nuworq. Installed: `nuworq` on PATH. Else: a clone in ~/nuworq (tilde unquoted, so the shell expands it).
  const bin = local ? `"${info.bin}"` : '~/nuworq/bin/nuworq.js';
  const configBin = local ? info.bin : '/path/to/nuworq/bin/nuworq.js'; // for config files, where nothing expands ~
  const run = (args) => (pkg ? `nuworq ${args}` : `node ${bin} ${args}`);
  const [command, args] = pkg ? ['nuworq', '"mcp"'] : ['node', `"${configBin}", "mcp"`];
  const token = secured ? 'paste-an-agent-token-here' : '';
  const env = url === 'http://127.0.0.1:4747' ? '' : ` -e NUWORQ_URL=${url}`;
  return {
    url, local, secured,
    // Get nuworq on this machine: the hub's package, or from an older hub a clone (when it knows where it came from).
    install: pkg ? `npm install -g ${pkg}` : null,
    clone: local || pkg || !info.source ? null : `git clone https://${info.source}.git ~/nuworq`,
    // A token by hand, on the hub's host: one per agent, so each can be revoked alone.
    token: secured ? 'node bin/nuworq.js token create my-agent --role agent' : null,
    // Log in through the browser, save the token, register Claude Code and Codex. Needed whenever there is a token.
    connect: local && !secured ? null : run(`connect ${url}`),
    worker: `${run('worker --agent claude --run')}\n${run('worker --agent codex --run')}`,
    // By hand, only where no token is needed (connect does it otherwise).
    claude: local && !secured ? `claude mcp add --scope user nuworq${env} -- node ${bin} mcp` : null,
    codex: `[mcp_servers.nuworq]\ncommand = "${command}"\nargs = [${args}]\nenv = { NUWORQ_URL = "${url}"${token ? `, NUWORQ_TOKEN = "${token}"` : ''} }`,
    mcp: `command: ${command}\nargs: [${args}]\nenv: NUWORQ_URL=${url}${token ? `  NUWORQ_TOKEN=${token}` : ''}`,
    guide: run(`guide --project ${slug}`),
  };
}

// The commands meant for a shell, for checking: none may hold a placeholder.
export const shellCommands = (c) => [c.install, c.clone, c.token, c.connect, c.worker, c.claude, c.guide].filter(Boolean);
