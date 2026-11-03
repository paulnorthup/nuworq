// What "Connect an agent" tells someone to paste, from /api/info. Pure, so the UI and the tests share it.
// Shell commands never hold a placeholder: a shell reads <agent-token> as a redirect and fails with "no
// such file or directory". Every command is the installed `nuworq`, never a path into a checkout, and no
// config holds a token or an address: `nuworq connect` saves both, and `nuworq mcp` reads them.

import { commandBlocks } from './copy.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LOOPBACK =/^(localhost|127(\.\d+){3}|\[::1\])$/i;

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
    // Log in through the browser, save the token and the address, register nuworq with the agent tools installed.
    connect: `nuworq connect ${url}`,
    // Then the one command (#559): the runner with automatic workers, and an operator per unparked project. Again any time.
    up: 'nuworq up',
    // Keep workers going wherever work is waiting, across projects; one worker on its own.
    run: 'nuworq run --workers 3 --agent claude',
    worker: 'nuworq worker --agent claude --run',
    // For Claude Code (#97, #432): the MCP server, /nuworq:shaper and /nuworq:operator as one plugin, as in docs/USAGE.md.
    // At its release branch (#473): the plugin changes only with a release Paul approved and the signer signed.
    plugin: 'claude plugin marketplace add paulnorthup/nuworq#release\nclaude plugin install nuworq@nuworq --scope user',
    // By hand (what connect does for you): no token, no address, no path.
    claude: 'claude mcp add --scope user nuworq -- nuworq mcp',
    codex: '[mcp_servers.nuworq]\ncommand = "nuworq"\nargs = ["mcp"]\ndefault_tools_approval_mode = "approve"',
    mcp: 'command: nuworq\nargs: ["mcp"]',
    // pi (1.4+, #495): its own CLI registers the server; its workers take a <provider>/<model>.
    pi: 'pi mcp add nuworq --exposure direct -- nuworq mcp',
    piWorker: 'nuworq worker --agent pi --model ollama/qwen3.8:27b-mtp-q4_K_M --can-read-keys --run',
    guide: `nuworq guide --project ${slug}`,
  };
}

// The recommended setup (#489, #801): how nuworq itself is built, and what every place that says how to get going offers
// first, in this order and these words: the guide, Get started, Connect an agent, docs/USAGE.md and the CLI's bare
// screen (test/setup.test.js holds them together). says is what it is, in short sentences (setupLine); how is
// what to type, with each command to copy in backticks.
export const SETUP = [
  {
    key: 'shaper', title: 'Shape work with a shaper',
    says: ['A shaper is Claude Code in the Claude Code app.',
      'You tell it what you want and why; it talks it through, recommends milestones and their parts, and proposes them once you agree.',
      'You decide; it never decides for you.',
      'It\'s the session you read and talk in, and the app is made for reading and talking.'],
    how: 'Open the project\'s folder in the Claude Code app\'s Code tab, then type `/nuworq:shaper` (or "/nuworq-shaper" without the plugin)',
  },
  {
    key: 'workers', title: 'Start workers',
    says: ['Workers build, review and land the work.',
      'They run in the background with no window, each in its own copy of your repository, so they never touch your files.',
      'They work only on the projects you let them.',
      'As a service they keep going after you close the terminal, and after a restart.'],
    how: 'In a clone of the project, run `nuworq run --install --workers auto`',
  },
  {
    key: 'operator', title: 'Start an operator',
    says: ['An operator is Claude Code in a terminal, acting with your access.',
      'It does the work workers aren\'t allowed to do.',
      'It answers the questions workers send it, lands their work, and runs the steps on real systems.',
      'It asks you only for what it can\'t do itself.',
      'In its own terminal, it never interrupts your conversation with the shaper.'],
    // nuworq up first (#797), then by hand. Without the plugin (declined, or no access to the repository yet), connect
    // writes it as /nuworq-operator (#492). byHand: the guide's by-hand part, which follows its own nuworq up (#801).
    how: '`nuworq up` starts one for each project that doesn\'t have one yet. Or, in the project\'s folder, run `claude`, then type `/nuworq:operator` (or "/nuworq-operator" without the plugin)',
    byHand: 'In the project\'s folder, run `claude`, then type `/nuworq:operator` (or "/nuworq-operator" without the plugin)',
  },
];
// One session in short sentences, in backtick marks.
export const setupLine = (s) => s.says.join(' ');
export const SETUP_LEAD = 'Three sessions, each where it works best. It\'s how nuworq itself is built. Starting with just a shaper is fine.';

// The sessions as Connect an agent shows them, each with what to type and a Copy per command.
export const setupSection = () => `<section><h3><span data-new="setup-that-works">Recommended setup</span></h3>
  <p class="lead">${esc(SETUP_LEAD)}</p>
  ${SETUP.map((s, k) => `<h4>${k + 1}. ${esc(s.title)}</h4><p class="lead">${esc(setupLine(s)).replace(/`([^`]+)`/g, '<code>$1</code>')}</p>${commandBlocks(s.how)}`).join('')}</section>`;

// The commands meant for a shell, for checking: none may hold a placeholder.
export const shellCommands = (c) => [c.setup, c.install, c.connect, c.up, c.run, c.worker, c.plugin, c.claude, c.pi, c.piWorker, c.guide].filter(Boolean);
