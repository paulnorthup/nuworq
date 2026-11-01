// The CLI's help (#481), from one table of commands. A bare `nuworq` prints one screen of what a person does
// most; `nuworq help <command>` (or `nuworq <command> --help`) one command's usage, flags, environment and an
// example; `nuworq help all` every command, which docs/CLI.md is generated from (`nuworq help all --markdown`).
// The agent commands take what they do, and what their flags mean, from the protocol's OPS, so they can't drift.
import { readFileSync } from 'node:fs';
import { OPS } from './protocol.js';
import { DEFAULT_URL } from './client.js';

const VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return ''; } })();

// The bare screen's groups, in order. "protocol" and "more" are listed by name on a line each.
export const GROUPS = [
  ['start', 'Get going'],
  ['agents', 'Work with agents'],
  ['hub', 'Run a hub'],
  ['protocol', 'For agents (through MCP)'],
  ['more', 'Also'],
];

// A flag's meaning from OPS: the param's description, without "Optional." and only its first sentence.
const P = (param) => ({ param });

// Every command main() dispatches. label: how the bare screen names it (default: its name); brief: its line there;
// under: listed on another command's line. flags: [flag, what it does, default?]; env: [variable, what it's for].
export const COMMANDS = [
  {
    name: 'connect', group: 'start', label: 'connect <hub>', brief: 'use a hub from this machine (signs you in)',
    does: 'use a hub from this machine: sign in, save it, and give your agent tools its MCP server',
    usage: ['connect <url> [flags]', 'connect <workspace> --hub <url> [flags]'],
    flags: [
      ['--hub <url>', 'the hub, when you give a workspace name'],
      ['--token <t>', 'use this token instead of signing in through the browser; - reads one line (hidden)'],
      ['--no-browser', "print the sign-in link and code instead of opening the browser"],
      ['--no-mcp', "don't add the MCP server to Claude Code, Codex or opencode"],
      ['--skills', 'without the nuworq plugin in Claude Code, write the server and skills without asking'],
      ['--off', 'the same as nuworq disconnect'],
      ['--yes', 'answer yes to each follow-up (staff this project, start an operator) without asking'],
      ['--no', 'answer no to each follow-up without asking'],
      ['--budget <usd>', 'with staffing: the daily cap for its workers', '20'],
    ],
    env: [['NUWORQ_TOKEN', 'a token to use instead of signing in']],
    example: 'nuworq connect https://app.nuworq.com/w/acme',
    notes: [
      'You approve a code in the browser, and the hub is saved in ~/.nuworq/connect.json, which only you can read. The CLI, the MCP server and nuworq run use it from then on; NUWORQ_URL and NUWORQ_TOKEN still win.',
      'Claude Code without the nuworq plugin: connect offers to install it first. Undo all of it with nuworq disconnect.',
      "Then, one at a time: staff the project this folder is a clone of with workers here (nuworq staff), and start an operator (operator --start). --yes or --no answers each without asking; with no terminal, it's no.",
    ],
  },
  {
    name: 'run', group: 'start', brief: 'keep workers on waiting work in your projects',
    does: 'keep up to N headless workers on waiting work in the projects you opted in',
    usage: ['run [flags]', 'run --sweep [--dry-run]', 'run --install [run flags]', 'run --uninstall'],
    flags: [
      ['--workers <n|auto>', 'workers at once; auto: one more only while the 1-minute load is under 80% of the cores and 2 GB of memory is free (at least one), and it says why when it holds', '1'],
      ['--max-workers <m>', 'with --workers auto: the most at once', 'half the cores'],
      ['--agent <name>', 'claude, codex or opencode', 'claude'],
      ['--model <m>', 'the model workers use; opencode needs <provider>/<model>'],
      ['--folder <path>', 'a folder workers may work in, added to ~/.nuworq/folders.json'],
      ['--until-idle', 'exit once no work is waiting, instead of waiting for more'],
      ['--staff <project>', 'let nuworq run staff that project first (its "Staff it with nuworq run" switch); with none staffed, run says so and offers this clone\'s'],
      ['--max-runs <n>', 'stop after starting n workers'],
      ['--max-minutes <t>', 'stop after t minutes'],
      ['--max-usd <x>', "stop starting workers once their reported spend reaches x (codex and local models report none)"],
      ['--poll <s>', 'seconds between looks at the hub', '30'],
      ['--has <tags>', 'what else this machine can do, e.g. browser,linux-vm'],
      ['--browser', 'each worker gets a headless Chrome (Claude only), as with worker --browser'],
      ['--agent-token <t>', 'the agent token workers get on a hub with login'],
      ['--proxy <url>', 'send workers through llm-proxy, as with worker --proxy'],
      ['--sweep', 'remove leftovers now (the runner does it weekly)'],
      ['--dry-run', 'with --sweep: list what would go'],
      ['--install', 'run it as a service that survives closed terminals and reboots'],
      ['--uninstall', 'stop and remove that service'],
    ],
    env: [
      ['NUWORQ_AGENT_TOKEN', 'the agent token workers get, instead of --agent-token'],
      ['NUWORQ_REPOS', 'more folders holding checkouts, offered when it asks which folders to use'],
      ['NUWORQ_LLM_PROXY_URL', "llm-proxy's address, instead of --proxy"],
      ['NUWORQ_LLM_PROXY_TOKEN', "llm-proxy's owner token, for Claude and Codex workers with --proxy"],
      ['NUWORQ_LLM_PROXY_KEY', 'a personal llm-proxy key, for opencode with --model proxy/<model>'],
    ],
    example: 'nuworq run --workers 3 --agent claude',
    notes: [
      'Opt a project in on the hub (project Settings: "Staff it with nuworq run"). Workers work only in folders you chose on this machine: run asks in a terminal, and --folder adds one.',
      'Workers that keep failing pause it (5m, then longer, up to 30m), and a project whose checkout can\'t be updated waits the same way while the others go on. Logs: ~/.nuworq/logs.',
      "A worker's worktree is removed when it exits, unless it holds uncommitted changes or commits on no branch (then it says where). Its branch goes too once its item is done or dropped and on origin.",
      '--sweep removes worktrees and nuworq/* branches of done or dropped items, idle worktrees with no branch, and stale worktree records. Never your checkout, never uncommitted or unpushed work.',
      '--install makes a LaunchAgent (macOS) or systemd user unit (Linux); installing again replaces it. Install from a checkout: it runs there and finds the ones beside it. Log: ~/.nuworq/logs/run.log.',
    ],
  },
  {
    name: 'status', group: 'start', brief: "what needs you, in 30 seconds",
    does: "the 30-second view: what needs you, and who's working on what",
    usage: ['status [--all]'],
    flags: [['--all', 'one line for every project'], ['--project <p>', 'that project, instead of this folder\'s']],
    example: 'nuworq status',
  },
  {
    name: 'update', group: 'start', brief: 'install the newest signed nuworq',
    does: "install the hub's newer nuworq now, if it is signed by the release key this install pinned",
    usage: ['update'],
    env: [['NUWORQ_NO_UPDATE', '1: no command checks for updates by itself']],
    example: 'nuworq update',
    notes: [
      'Otherwise, or offline, it keeps this version and says why. Every command checks by itself at most every 10 minutes; after one updates it in the background, the next command says once what changed.',
    ],
  },
  {
    name: 'operator', group: 'agents', brief: 'the line that starts an operator session',
    does: 'print the tags an operator session declares and the line that starts it (runs nothing)',
    usage: ['operator [--project p] [--has tags]', 'operator --start [--has tags]', 'operator --check <level>'],
    flags: [
      ['--project <p>', "the project, instead of this folder's"],
      ['--has <tags>', 'what the session can really do, instead of what was detected'],
      ['--check <level>', 'only the line saying this nuworq is too old for the operator listener (exit 1), or nothing'],
      ['--start', 'open Claude Code here with that line already sent'],
    ],
    example: 'nuworq operator --has macos,browser,claude-cli,infra',
    notes: [
      "Paste the line into Claude Code in the project's folder. Operator tags: claude-cli, infra (the project's live infrastructure: servers and VMs, DNS, cloud accounts, deploys), github-admin, browser.",
    ],
  },
  {
    name: 'worker', group: 'agents', brief: 'start one headless worker now',
    does: 'start one headless worker where work is waiting (the hub routes it)',
    usage: ['worker [flags]'],
    flags: [
      ['--run', 'start it; without --run it prints the command'],
      ['--agent <name>', 'claude, codex or opencode', 'claude'],
      ['--model <m>', 'the model; opencode needs <provider>/<model>, e.g. ollama/qwen3.8:27b-mtp-q4_K_M'],
      ['--project <p>', 'that project, instead of where the hub routes it'],
      ['--here', 'work in this folder, not its own worktree'],
      ['--as <name>', 'its name', 'the agent and 4 random hex digits'],
      ['--allow <tools>', 'more tools it may use without asking'],
      ['--has <tags>', 'what else this machine can do'],
      ['--browser', 'a headless Chrome (Playwright MCP, local pages only) to check UI work with; Claude only'],
      ['--proxy <url>', "go through llm-proxy: its LAN or tailnet address for claude and codex; opencode with --model proxy/<model>"],
      ['--agent-token <t>', 'with --run on a hub with login: the agent token it gets (never your own)'],
    ],
    env: [
      ['NUWORQ_AGENT_TOKEN', 'the agent token, instead of --agent-token'],
      ['NUWORQ_LLM_PROXY_URL', "llm-proxy's address, instead of --proxy"],
      ['NUWORQ_LLM_PROXY_TOKEN', "llm-proxy's owner token, for claude and codex"],
      ['NUWORQ_LLM_PROXY_KEY', 'a personal llm-proxy key, for opencode'],
    ],
    example: 'nuworq worker --agent claude --run',
    notes: [
      'It works in its own git worktree, with a branch per item, and reports what this machine has (macos/linux, docker, gpu). Ollama is set up for opencode for you.',
    ],
  },
  {
    name: 'serve', group: 'hub', brief: 'run the hub and web app',
    does: 'run the hub and its web app',
    usage: ['serve [flags]', 'serve --workspaces [flags]'],
    flags: [
      ['--port <n>', 'the port', '4747'],
      ['--host <h>', 'the address to listen on', '127.0.0.1'],
      ['--db <file>', 'the database', '~/.nuworq/nuworq.db'],
      ['--demo', 'demo data, in memory'],
      ['--auth', 'require login on loopback too'],
      ['--trust-proxy', 'trust X-Forwarded-* from your proxy'],
      ['--public-url <u>', "the hub's address as people reach it, for links"],
      ['--follow', 'keep the hub on the latest main that passes its tests'],
      ['--workspaces', 'one process, many workspaces (one database each); login always required'],
      ['--data-dir <d>', 'where workspaces, backups and mirrors live'],
      ['--base-domain <d>', 'serve workspaces at <name>.<d> as well as /w/<name>/'],
      ['--workspace-cap <n>', 'workspaces one signed-in person may create'],
      ['--early-access', 'making a workspace takes an approved request'],
      ['--owners <emails>', "the hub's owners, who decide early-access requests"],
      ['--admin-host <host>', "with --public-url: the owners' dashboard, where requests are decided"],
      ['--feedback-project <ws>/<p>', 'with --admin-host: approved feedback about nuworq is proposed there'],
      ['--plans', 'limit workspaces by plan'],
    ],
    env: [
      ['NUWORQ_HOST, NUWORQ_PORT', 'instead of --host and --port'],
      ['NUWORQ_DB, NUWORQ_DATA_DIR', 'instead of --db and --data-dir'],
      ['NUWORQ_PUBLIC_URL', 'instead of --public-url'],
      ['NUWORQ_HUB_OWNERS', 'instead of --owners'],
      ['NUWORQ_BASE_DOMAIN', 'instead of --base-domain'],
      ['NUWORQ_WORKSPACE_CAP', 'instead of --workspace-cap'],
      ['NUWORQ_ADMIN_HOST', 'instead of --admin-host'],
      ['NUWORQ_FEEDBACK_PROJECT', 'instead of --feedback-project'],
      ['NUWORQ_PLANS', '1: instead of --plans'],
      ['NUWORQ_TURNSTILE_SITEKEY', "the early-access form's spam check"],
      ['NUWORQ_TURNSTILE_SECRET', 'checks it'],
      ['NUWORQ_LLM_PROXY_URL', 'measured usage for agents that go through llm-proxy (not with --workspaces)'],
      ['NUWORQ_LLM_PROXY_KEY', 'its read-only key'],
      ['NUWORQ_LLM_PROXY_ACCESS_ID', 'behind Cloudflare Access: its service token id'],
      ['NUWORQ_LLM_PROXY_ACCESS_SECRET', 'and secret'],
    ],
    example: 'nuworq serve --demo',
    notes: [
      'On loopback it needs no login. Any other host (or --auth) requires tokens: make one with nuworq token create. With --workspaces, each workspace is at <name>.<base-domain> or /w/<name>/.',
      "Agents label llm-proxy traffic x-client-name: nuworq/<project>/<agent>, which is how the hub's key finds it. Deploying on a VM or the internet: docs/DEPLOY.md.",
    ],
  },
  {
    name: 'workspace', group: 'hub', brief: 'create, list and adopt workspaces',
    does: 'manage the workspaces of a hub run with --workspaces (on the hub host)',
    usage: ['workspace create <name>', 'workspace list', 'workspace remove <name>', 'workspace adopt <name> [--db file]', 'workspace bind-installation <id> <workspace>', 'workspace plan <name> <free|unlimited>'],
    flags: [
      ['--data-dir <d>', 'the hub\'s data folder'],
      ['--db <file>', "adopt: the single hub's database"],
      ['--owners <emails>', "the hub's owners"],
    ],
    env: [['NUWORQ_DATA_DIR', 'instead of --data-dir'], ['NUWORQ_HUB_OWNERS', 'instead of --owners']],
    example: 'nuworq workspace adopt main --db /var/lib/nuworq/nuworq.db',
    notes: [
      "adopt turns a single hub's database into a workspace and keeps a copy. Tokens saved with the hub's root address keep working there, and its GitHub App's installations are bound to it.",
      'bind-installation: GitHub App deliveries for installation <id> reach <workspace>. plan: the host\'s override, unlimited or free.',
    ],
  },
  {
    name: 'person', group: 'hub', label: 'person, invite', brief: "who's in, and their roles",
    does: 'add, list and remove the people of a hub (on the hub host)',
    usage: ['person add <handle> --role <role> [--email e]', 'person list', 'person set-role <handle> <role>', 'person remove <handle>'],
    flags: [
      ['--role <role>', 'owner, steward, member or viewer', 'member'],
      ['--email <e>', 'their email'],
      ['--name <n>', 'their name'],
      ['--workspace <name>', "that workspace's people"],
      ['--db <file>', 'the database'],
    ],
    example: 'nuworq person add bea --role steward --email bea@example.com',
    notes: [
      'Owners do everything; stewards steer, decide, answer and accept; members comment and propose; viewers read. remove revokes the tokens they held or minted.',
    ],
  },
  {
    name: 'invite', group: 'hub', under: 'person',
    does: 'make a single-use, 7-day link that adds a person with a role (on the hub host)',
    usage: ['invite create --role <role> [--email e] [--by <owner>]', 'invite list', 'invite revoke <id>'],
    flags: [
      ['--role <role>', 'owner, steward, member or viewer', 'member'],
      ['--email <e>', 'who it is for'],
      ['--by <owner>', 'who it is from'],
      ['--public-url <u>', "the hub's address, for the link"],
      ['--workspace <name>', "that workspace's invites"],
    ],
    env: [['NUWORQ_PUBLIC_URL', 'instead of --public-url']],
    example: 'nuworq invite create --role member --email ann@example.com',
  },
  {
    name: 'token', group: 'hub', brief: 'agent and human tokens',
    does: 'create, list and revoke tokens (on the hub host)',
    usage: ['token create <name> --role human|agent [flags]', 'token list', 'token revoke <name|id>'],
    flags: [
      ['--role <role>', 'human or agent', 'agent'],
      ['--project <a,b>', 'limit an agent token to those projects'],
      ['--person <handle>', 'the person a human token acts as', 'one named like the token, created as owner'],
      ['--powers <list>', 'what an agent token may do: shape, build, review'],
      ['--minted-by <handle>', 'who answers for an agent token'],
      ['--runner [name]', "a runner's token, which names the runner"],
      ['--workspace <name>', "that workspace's tokens"],
      ['--db <file>', 'the database'],
    ],
    example: 'nuworq token create box --role agent --project acme',
    notes: ['A new token is shown only once. Revoking one logs out its sessions.'],
  },
  {
    name: 'notify', group: 'hub', brief: 'push channels for "needs you"',
    does: 'push one batched message when something new needs you (on the hub host)',
    usage: ['notify add ntfy|slack|webhook <url> [--person bea]', 'notify list', 'notify remove <id>', 'notify test'],
    flags: [
      ['--person <handle>', "a channel for that person: only what they own"],
      ['--public-url <u>', "the hub's address, for links in test messages"],
      ['--workspace <name>', "that workspace's channels"],
    ],
    env: [['NUWORQ_PUBLIC_URL', "the hub's address, for links in push messages"]],
    example: 'nuworq notify add ntfy https://ntfy.sh/my-topic',
  },
  {
    name: 'staff', group: 'more',
    does: 'turn on staffing for a project, with a daily cap, and install nuworq run here',
    usage: ['staff [<project>] [--budget 20]'],
    flags: [
      ['--project <p>', "the project, instead of this folder's"],
      ['--budget <usd>', 'the daily cap for its workers', '20'],
      ['--yes', "don't ask: take the defaults"],
      ['--no-browser', 'print the approval link instead of opening the browser'],
    ],
    example: 'nuworq staff nuworq --budget 20',
    notes: ['On a hub with logins, an owner approves it in the browser.'],
  },
  {
    name: 'disconnect', group: 'more',
    does: 'revoke the token connect saved, remove what connect added, and forget the hub',
    usage: ['disconnect'],
    example: 'nuworq disconnect',
  },
  {
    name: 'changes', group: 'more',
    does: "this version's changelog lines again",
    usage: ['changes'],
    example: 'nuworq changes',
  },
  {
    name: 'init', group: 'more',
    does: 'print the MCP setup for Claude Code, Codex, opencode and other agents; --project pins this folder',
    usage: ['init [--project p] [--force]'],
    flags: [['--project <p>', 'write .nuworq.json, pinning this folder to that project'], ['--force', 'overwrite an existing .nuworq.json']],
    example: 'nuworq init',
  },
  {
    name: 'skill', group: 'more',
    does: 'write the nuworq, nuworq-shaper and nuworq-operator skills for Claude, or the Claude Code plugin (connect does this for you)',
    usage: ['skill [--dir d]', 'skill --plugin [dir]'],
    flags: [['--dir <d>', 'where the skills go', '~/.claude/skills'], ['--plugin [dir]', 'write the plugin (MCP server, skills, listener) instead', 'plugin/']],
    example: 'nuworq skill',
  },
  {
    name: 'guide', group: 'more',
    does: 'the agent guide',
    usage: ['guide [--via cli|tools]'],
    flags: [['--via <how>', 'cli (shell commands) or tools (MCP)', 'cli']],
    example: 'nuworq guide',
  },
  {
    name: 'prompt', group: 'more',
    does: 'just the worker prompt text, for other agents',
    usage: ['prompt [--as name]'],
    flags: [['--as <name>', 'the name it tells the agent to use']],
    example: 'nuworq prompt --as worker-1',
  },
  {
    name: 'tools', group: 'more',
    does: 'the tool schemas, for agents without MCP',
    usage: ['tools [--format mcp|openai|anthropic] [--prefix p]'],
    flags: [['--format <f>', 'mcp, openai or anthropic', 'mcp'], ['--prefix <p>', 'put before every tool name']],
    example: 'nuworq tools --format openai',
  },
  {
    name: 'mcp', group: 'more',
    does: 'run the stdio MCP server (one per agent session)',
    usage: ['mcp'],
    env: [
      ['NUWORQ_AGENT', 'the agent\'s name'],
      ['NUWORQ_MODEL', 'its model'],
      ['NUWORQ_TOKEN_FILE', 'a file holding its token (how a runner\'s workers get theirs)'],
    ],
    example: 'claude mcp add --scope user nuworq -- nuworq mcp',
  },
  {
    name: 'wait', group: 'more',
    does: 'block until there is something for an operator, and print one line',
    usage: ['wait --operator [--follow] [--as name] [--project p | --all-projects]'],
    flags: [
      ['--operator', 'wait as an operator (the only kind that waits)'],
      ['--follow', 'keep waiting: one line per event'],
      ['--as <name>', "the operator", "the Claude Code session that started it"],
      ['--project <p>', "that project, instead of this folder's"],
      ['--all-projects', "every project, not only this folder's"],
      ['--timeout <ms>', 'how long one wait may take'],
    ],
    example: 'nuworq wait --operator --follow',
    notes: [
      'Something for an operator is its work, a question to it, an answer, or steering. Without --as it wakes the operator of the Claude Code session that started it, else the operators that checked in with this token.',
    ],
  },
  {
    name: 'git-credential', group: 'more',
    does: "git's credential helper: a one-repo, one-hour GitHub token for the item <name> holds",
    usage: ['git-credential get --as <name>', 'git-credential get --project <p>'],
    flags: [['--as <name>', 'the agent whose item it is'], ['--project <p>', "a read-only token for that project's repository"]],
    env: [['NUWORQ_TOKEN_FILE', 'a file holding the agent token']],
    example: 'git -c credential.helper="!nuworq git-credential --as w1" push',
    notes: ["From the hub's GitHub App. Workers set it up themselves."],
  },
  {
    name: 'seed', group: 'more',
    does: "add the nuworq roadmap project to your hub's database",
    usage: ['seed [--db file]'],
    flags: [['--db <file>', 'the database']],
    example: 'nuworq seed',
  },
  {
    name: 'help', group: null,
    does: 'this help',
    usage: ['help', 'help <command>', 'help all [--markdown]'],
    flags: [['--markdown', 'with all: as docs/CLI.md']],
    example: 'nuworq help run',
  },
];

// The agent commands, from the CLI's side: usage and flags. What they do comes from OPS.
const AGENT = {
  checkin: { usage: ['checkin [--model m] [--client c] [--has tags]'], flags: [['--model <m>', P('model')], ['--client <c>', P('client')], ['--has <tags>', P('has')], ['--status <s>', P('status')]], env: [['NUWORQ_HAS', 'instead of --has']], example: 'nuworq checkin --as claude-1 --has docker,macos' },
  next: { usage: ['next [--peek]'], flags: [['--peek', 'look without claiming']], example: 'nuworq next --as claude-1' },
  claim: { usage: ['claim <item> [--touching paths]'], flags: [['--touching <a,b>', P('touching')]], example: 'nuworq claim 12 --as claude-1' },
  progress: { usage: ['progress <item> [headline] [--touching paths]'], flags: [['--touching <a,b>', P('touching')]], example: 'nuworq progress 12 "Parser done" --touching src/parse.js --as claude-1' },
  ask: {
    usage: ['ask [<item>] <question> [flags]', 'ask <question> --escalates <question-id> --evidence "label|url"...'],
    flags: [['--assume <a>', P('assumption')], ['--option <x>', 'a likely answer; repeat it for more'], ['--blocking', P('blocking')], ['--to <who>', 'human, reporter or operator'], ['--context <c>', P('context')], ['--escalates <id>', P('escalates')], ['--evidence <label|url>', 'what you checked; repeat it for more']],
    example: 'nuworq ask 12 "Keep the old flag?" --assume "yes, as an alias" --as claude-1',
  },
  answer: { usage: ['answer <question-id> <answer>'], example: 'nuworq answer 40 "Done: it is installed" --as operator-1' },
  withdraw: { usage: ['withdraw <question-id> <reason>'], example: 'nuworq withdraw 40 "Paul answered in chat" --as claude-1' },
  submit: { usage: ['submit <item> <headline> [--evidence "label|url"]...'], flags: [['--evidence <label|url>', 'proof it meets done_means; repeat it for more'], ['--acceptance <a>', P('acceptance')]], example: 'nuworq submit 12 "Parser handles tabs" --evidence "npm test: 48 passed" --as claude-1' },
  handoff: { usage: ['handoff <item> <headline>'], example: 'nuworq handoff 12 "Parser half done; tests next" --as claude-1' },
  propose: {
    usage: ['propose <title> [flags]'],
    flags: [['--acceptance <a>', P('acceptance')], ['--priority <p>', 'now, soon or later'], ['--parent <item>', P('parent')], ['--depends-on <#1,#2>', P('depends_on')], ['--needs <tags>', P('needs')], ['--size <s>', 'small or large'], ['--repo <r>', P('repo')]],
    example: 'nuworq propose "Parse tabs in headers" --priority soon --as claude-1',
  },
  refine: {
    usage: ['refine <item> [flags]'],
    flags: [['--title <t>', P('title')], ['--acceptance <a>', P('acceptance')], ['--priority <p>', 'now, soon or later'], ['--depends-on <#1,#2>', P('depends_on')], ['--needs <tags>', P('needs')], ['--size <s>', 'small or large'], ['--repo <r>', P('repo')], ['--drop <question-id>', P('drop')]],
    example: 'nuworq refine 12 --priority now --as claude-1',
  },
  review: { usage: ['review <item> <accept|reject> <headline> [--attempt n|agent]'], flags: [['--attempt <n|agent>', P('attempt')]], example: 'nuworq review 12 accept "Tests pass; matches done_means" --as claude-2' },
  comment: { usage: ['comment [<item>] <headline>'], example: 'nuworq comment 12 "Heads-up: parse.js moved" --as claude-1' },
  ack: { usage: ['ack <steer-id> [response]'], example: 'nuworq ack 7 "Switching to the smaller fix" --as claude-1' },
  feedback: { usage: ['feedback <what happened> [--item i]'], flags: [['--item <i>', P('item')]], example: 'nuworq feedback "next gave me an item I can\'t build" --as claude-1' },
  look: { usage: ['look [<item>] [--stage s] [--notes all]'], flags: [['--stage <s>', 'one stage of the board'], ['--notes all', P('notes')]], example: 'nuworq look 12 --as claude-1' },
  retire: { usage: ['retire <note-id>... --reason r [--into <note-id>]'], flags: [['--reason <r>', P('reason')], ['--into <note-id>', P('into')]], example: 'nuworq retire 31 --reason "built into checkin" --as claude-1' },
  signoff: { usage: ['signoff [headline]'], example: 'nuworq signoff "Nothing left for me" --as claude-1' },
};
const AGENT_NOTE = 'Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url. --summary and --detail add the 5- and 30-minute versions ("-" reads one from stdin).';

const firstSentence = (s) => String(s ?? '').replace(/^Optional\.\s*/, '').match(/^.*?\.(?=\s|$)/)?.[0].replace(/\.$/, '') ?? String(s ?? '');
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

for (const [name, a] of Object.entries(AGENT)) {
  const op = OPS.find((o) => o.name === name);
  if (!op) throw new Error(`help: no protocol op "${name}"`);
  COMMANDS.push({
    name, group: 'protocol', ...a,
    does: lower(firstSentence(op.description)),
    flags: (a.flags ?? []).map(([f, d, def]) => [f, typeof d === 'string' ? d : lower(firstSentence(op.params?.[d.param]?.description ?? (() => { throw new Error(`help: ${name} has no param "${d.param}"`); })())), def]),
    notes: [...(a.notes ?? []), AGENT_NOTE],
  });
}

// Read by every command.
const COMMON_ENV = [
  ['NUWORQ_URL', `the hub (default ${DEFAULT_URL}, or the one you connected to)`],
  ['NUWORQ_TOKEN', 'a token for a hub that requires login'],
  ['NUWORQ_PROJECT', "the project, instead of this folder's"],
  ['NUWORQ_AGENT', 'the agent name, instead of --as'],
  ['NUWORQ_MODEL', 'the model an agent reports'],
  ['NUWORQ_DB', 'the database, on the hub host'],
  ['NUWORQ_NO_UPDATE', '1: no command checks for updates by itself'],
];

export const command = (name) => COMMANDS.find((c) => c.name === name) ?? null;

// The nearest command name, for "did you mean": within 3 edits.
export function nearest(word) {
  const d = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cur = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
      }
    }
    return row[b.length];
  };
  let best = null;
  for (const c of COMMANDS) {
    const n = d(String(word).toLowerCase(), c.name);
    if (n <= 3 && (!best || n < best.n)) best = { name: c.name, n };
  }
  return best?.name ?? null;
}

// ── rendering ──

const plain = { bold: (s) => s, dim: (s) => s };

// Words wrapped to width, every line after the first indented by hang (the first by first).
export function wrap(text, width, { first = '', hang = first } = {}) {
  const out = [];
  let line = first;
  let empty = true;
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    if (!empty && line.length + 1 + w.length > width) { out.push(line); line = hang + w; } else { line += (empty ? '' : ' ') + w; }
    empty = false;
  }
  out.push(line);
  return out;
}

// Two columns: a name, and what it is, wrapped under itself. A name too wide for the column gets its own line.
function columns(rows, width, { indent = 2, max = 26, at } = {}) {
  const col = at ?? Math.min(max, Math.max(...rows.map(([n]) => n.length))) + indent + 2;
  const out = [];
  for (const [n, text] of rows) {
    const head = ' '.repeat(indent) + n;
    if (head.length + 2 > col) out.push(head, ...wrap(text, width, { first: ' '.repeat(col) }));
    else out.push(...wrap(text, width, { first: head.padEnd(col), hang: ' '.repeat(col) }));
  }
  return out;
}

// Placeholders dim, command names bold: applied after wrapping, so widths stay true.
const styler = (style) => (line, names = []) => {
  let s = line.replace(/<[^>\s][^>]*>/g, (m) => style.dim(m));
  for (const n of names) s = s.replace(new RegExp(`(^|\\s)(${n.replace(/[-]/g, '\\-')})(?=\\s|,|$)`), (m, a, b) => `${a}${style.bold(b)}`);
  return s;
};

// A bare `nuworq`: one screen.
export function bare({ width = 80, style = plain } = {}) {
  const s = styler(style);
  const out = [`${style.bold('nuworq')}${VERSION ? ` ${VERSION}` : ''}: a hub where agents do the work and people steer`, ''];
  // One column for every group, as wide as the widest name listed.
  const at = 2 + Math.max(...COMMANDS.filter((c) => c.brief).map((c) => (c.label ?? c.name).length)) + 4;
  for (const [g, title] of GROUPS) {
    const cmds = COMMANDS.filter((c) => c.group === g && !c.under);
    if (!cmds.length) continue;
    if (g === 'protocol' || g === 'more') {
      out.push(...wrap(`${title}: ${cmds.map((c) => c.name).join(', ')}`, width, { hang: '  ' }), '');
      continue;
    }
    out.push(style.bold(title));
    for (const line of columns(cmds.map((c) => [c.label ?? c.name, c.brief]), width, { at })) out.push(s(line, cmds.map((c) => c.name)));
    out.push('');
  }
  out.push(...columns([['nuworq help <command>', 'flags, examples and environment for one'], ['nuworq help all', 'the full reference']], width, { indent: 0, at: 24 }).map((l) => s(l)));
  return out.join('\n');
}

// One command's help.
export function commandHelp(name, { width = 80, style = plain } = {}) {
  const c = command(name);
  if (!c) return null;
  const s = styler(style);
  const out = [...wrap(`nuworq ${c.name}: ${c.does}`, width, { hang: '  ' }).map((l, i) => (i ? l : l.replace(`nuworq ${c.name}`, style.bold(`nuworq ${c.name}`)))), ''];
  out.push(style.bold('Usage'));
  for (const u of c.usage) out.push(...wrap(`nuworq ${u}`, width, { first: '  ', hang: '      ' }).map((l) => s(l, [c.name])));
  if (c.flags?.length) {
    out.push('', style.bold('Flags'));
    out.push(...columns(c.flags.map(([f, d, def]) => [f, def ? `${d} (default: ${def})` : d]), width).map((l) => s(l)));
  }
  if (c.env?.length) {
    out.push('', style.bold('Environment'));
    out.push(...columns(c.env, width).map((l) => s(l)));
  }
  out.push('', style.bold('Example'), ...wrap(c.example, width, { first: '  ', hang: '      ' }));
  for (const n of c.notes ?? []) out.push('', ...wrap(n, width).map((l) => s(l)));
  return out.join('\n');
}

// Every command, grouped as on the bare screen, then the environment every command reads.
export function reference({ width = 80, style = plain, markdown = false } = {}) {
  const groups = [...GROUPS, [null, 'Help']];
  if (markdown) {
    const out = ['# nuworq command reference', '', 'Generated from src/help.js with `nuworq help all --markdown > docs/CLI.md`; test/help.test.js fails when it is out of date. A bare `nuworq` prints the one-screen version, and `nuworq help <command>` one command.', ''];
    for (const [g, title] of groups) {
      out.push(`## ${title}`, '');
      for (const c of COMMANDS.filter((x) => x.group === g)) out.push(`### nuworq ${c.name}`, '', '```text', commandHelp(c.name, { width: 80 }), '```', '');
    }
    out.push('## Environment', '', 'Every command reads these.', '', '```text', ...columns(COMMON_ENV, 80), '```', '', 'Deploying on a VM or the internet: [DEPLOY.md](DEPLOY.md).', '');
    return out.join('\n');
  }
  const rule = style.dim('─'.repeat(Math.min(width, 80)));
  const out = [bare({ width, style })];
  for (const [g] of groups) for (const c of COMMANDS.filter((x) => x.group === g)) out.push(rule, commandHelp(c.name, { width, style }));
  out.push(rule, style.bold('Environment (every command)'), ...columns(COMMON_ENV, width).map((l) => styler(style)(l)), '', 'Deploying on a VM or the internet: docs/DEPLOY.md');
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n');
}
