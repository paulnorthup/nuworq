// What "Connect an agent" tells someone to paste, from /api/info. Pure, so the UI and the tests share it.
// Shell commands never hold a placeholder: a shell reads <agent-token> as a redirect and fails with "no
// such file or directory". Every command is the installed `nuworq`, never a path into a checkout, and no
// config holds a token or an address: `nuworq connect` saves both, and `nuworq mcp` reads them.

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\])$/i;

// The first install's signature check (#473): node -e '<VERIFY>' <file> <key>, where key is release-key.pub's
// base64 line. It exits 1 unless <file>.sig is the release key's signature over <file>. No arrows or pipes, so
// it pastes into any shell.
export const VERIFY = 'const c=require("crypto"),f=require("fs"),[t,k]=process.argv.slice(1);'
  + 'if(!c.verify(null,f.readFileSync(t),{key:Buffer.from(k,"base64"),format:"der",type:"spki"},Buffer.from(f.readFileSync(t+".sig","utf8"),"base64")))'
  + '{console.error(t+" is NOT signed by the nuworq release key: do not install it");process.exit(1)}console.log(t+": signature verified")';
// Download the newest signed release from base, check its signature against key, and only then install it.
export const verifiedInstall = (base, key) => [
  `curl -fsSLO ${base}/nuworq-release.tgz -O ${base}/nuworq-release.tgz.sig`,
  `node -e '${VERIFY}' nuworq-release.tgz ${key}`,
  'npm install -g ./nuworq-release.tgz',
].join('\n');

// info: /api/info. page: the browser's location ({ protocol, host }), to correct a hub behind a TLS
// proxy that sees plain http. Returns the hub URL, whether it runs on this machine, and the commands.
export function connectCommands(info, page = null, slug = 'my-project') {
  const secure = (u) => (page?.protocol === 'https:' && u.startsWith('http://') && new URL(u).host === page.host ? `https:${u.slice(5)}` : u);
  const url = secure(String(info.url ?? '').replace(/\/+$/, ''));
  const local = LOOPBACK.test(new URL(url).hostname);
  // The hub serves the package of the commit it runs (#102): one install, from this hub, wherever it is. With a
  // signed release, that release, its signature checked before it installs (#473).
  const pkg = info.package?.url ? secure(info.package.url) : null;
  const key = info.package?.release?.key;
  return {
    url, local, secured: info.auth === 'required',
    install: pkg && key ? verifiedInstall(pkg.replace(/\/nuworq\.tgz$/, ''), key) : pkg ? `npm install -g ${pkg}` : null,
    verified: !!(pkg && key),
    // One paste (#490): install from this hub, then connect, which goes on to ask about the rest of the setup. A
    // signed release's lines are joined with && (#473), so a signature that doesn't verify stops it before npm runs.
    setup: pkg && key ? `${verifiedInstall(pkg.replace(/\/nuworq\.tgz$/, ''), key).split('\n').join(' && ')} && nuworq connect ${url}`
      : pkg ? `npm install -g ${pkg} && nuworq connect ${url}` : `nuworq connect ${url}`,
    // Log in through the browser, save the token and the address, register nuworq with Claude Code and Codex.
    connect: `nuworq connect ${url}`,
    // Keep workers going wherever work is waiting, across projects; one worker on its own.
    run: 'nuworq run --workers 3 --agent claude',
    worker: 'nuworq worker --agent claude --run',
    // For Claude Code (#97, #432): the MCP server, /nuworq:shaper and /nuworq:operator as one plugin, as in the README.
    // At its release branch (#473): the plugin changes only with a release Paul approved and the signer signed.
    plugin: 'claude plugin marketplace add paulnorthup/nuworq#release\nclaude plugin install nuworq@nuworq',
    // By hand (what connect does for you): no token, no address, no path.
    claude: 'claude mcp add --scope user nuworq -- nuworq mcp',
    codex: '[mcp_servers.nuworq]\ncommand = "nuworq"\nargs = ["mcp"]\ndefault_tools_approval_mode = "approve"',
    mcp: 'command: nuworq\nargs: ["mcp"]',
    guide: `nuworq guide --project ${slug}`,
  };
}

// The commands meant for a shell, for checking: none may hold a placeholder.
export const shellCommands = (c) => [c.setup, c.install, c.connect, c.run, c.worker, c.plugin, c.claude, c.guide].filter(Boolean);
