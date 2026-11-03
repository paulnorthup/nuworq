// The CLI's help (#481), from one table of commands. A bare `nuworq` prints one screen of what a person does
// most; `nuworq help <command>` (or `nuworq <command> --help`) one command's usage, flags, environment and an
// example; `nuworq help all` every command, which docs/CLI.md is generated from (`nuworq help all --markdown`).
// The agent commands take what they do, and what their flags mean, from the protocol's OPS, so they can't drift.
import { readFileSync } from 'node:fs';
import { OPS } from './protocol.js';
import { POSITIONAL, usage as agentUsage, flags as agentFlags } from './agentargs.js';
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
      ['--no-mcp', "don't add the MCP server to Claude Code, Codex, opencode or pi"],
      ['--skills', 'without the nuworq plugin in Claude Code, write the server and skills without asking'],
      ['--off', 'the same as nuworq disconnect'],
      ['--yes', 'answer yes to each follow-up (install the plugin, remove old leftovers, staff this project, start an operator) without asking'],
      ['--no', 'answer no to each follow-up without asking'],
      ['--budget <usd>', 'with staffing: the daily cap for its workers', '20'],
      ['--pays <how>', "with staffing: how this machine pays for Claude, api or subscription, instead of asking; it sets the runner's caps"],
    ],
    env: [['NUWORQ_TOKEN', 'a token to use instead of signing in']],
    example: 'nuworq connect https://app.nuworq.com/w/acme',
    notes: [
      'You approve a code in the browser, and the hub is saved in ~/.nuworq/connect.json, which only you can read. The CLI, the MCP server and nuworq run use it from then on; NUWORQ_URL and NUWORQ_TOKEN still win.',
      'Claude Code without the nuworq plugin for your account: connect offers to install it first. With it, connect offers to remove what an earlier nuworq left beside it (old skills, a second server). Undo all of it with nuworq disconnect.',
      "Then, one at a time: staff the project this folder is a clone of with workers here (nuworq staff), and start an operator (operator --start). --yes or --no answers each without asking; with no terminal, it's no.",
      "Staffing asks how this machine pays for Claude, Enter taking what it detects (ANTHROPIC_API_KEY, or claude auth status). An API key: a cap per worker and a daily cap (--worker-usd, --max-usd). A subscription: minutes, not dollars (--max-minutes 60), and no daily budget on the hub, since its usage windows are the limit. --yes takes the detected answer with these values. Connect again to change them: nuworq run's start line names the caps and where they came from.",
    ],
  },
  {
    name: 'up', group: 'start', brief: 'bring it all up: a runner, and an operator per project',
    does: 'bring this machine\'s setup up: the runner with automatic workers, and an operator in its own terminal for each unparked project',
    usage: ['up [--dry-run]'],
    flags: [
      ['--dry-run', 'print what it would do, and the table, and do nothing'],
      ['--yes', 'staff the projects that aren\'t, without asking'],
      ['--no', "don't staff them, and don't ask again"],
      ['--budget <usd>', 'with staffing: the daily cap for their workers', '20'],
      ['--no-browser', "workers get no browser, and up remembers it"],
      ['--browser', 'workers get a browser again, after --no-browser'],
    ],
    example: 'nuworq up',
    notes: [
      'The runner: it installs nuworq run as a service with --workers auto --browser, restarts one that isn\'t running, lacks --workers auto or has the wrong browser setting, and leaves one that matches alone. Unstaffed projects that aren\'t parked: it asks once whether to staff them; a no is remembered.',
      "Workers come fully featured. On: --workers auto (as many as the CPUs and memory have room for) and --browser (a headless Chrome, so they can take UI work and look at it; with no Chrome here they go without, and the table says how to add it). Off: --can-read-keys, since codex, opencode and pi workers' shells could read this machine's keys; up's workers are Claude's, whose sandbox hides them.",
      'Operators: each unparked project with no operator on the hub gets Claude Code with /nuworq:operator in its clone here: in tmux when it is installed (the nuworq session, a window per project: tmux attach -t nuworq), else a Terminal or iTerm window on a Mac, else it prints the command. A project with no clone here is skipped, with where to clone it. Parked projects get none.',
      'Run it again any time: it starts only what is missing, and ends with a table of each project and the runner. nuworq down stops what it started.',
    ],
  },
  {
    name: 'run', group: 'start', brief: 'start workers: keep them on waiting work in your projects',
    does: 'keep up to N headless workers on waiting work in the projects you opted in',
    usage: ['run [flags]', 'run --sweep [--dry-run]', 'run --install [run flags]', 'run --uninstall'],
    flags: [
      ['--workers <n|auto>', 'workers at once; auto: one more only while the CPUs are under 80% busy (measured across all cores between polls) and 2 GB of memory is available (on macOS, free plus inactive) (at least one), and it says why when it holds', '1'],
      ['--max-workers <m>', 'with --workers auto: the most at once', 'half the cores'],
      ['--agent <name>', 'claude, codex, opencode or pi', 'claude'],
      ['--can-read-keys', "start codex, opencode or pi workers, whose shells can read this machine's keys (only Claude's sandbox hides them), on projects without a remote"],
      ['--model <m>', 'the model workers use; opencode and pi need <provider>/<model>'],
      ['--folder <path>', 'a folder workers may work in, added to ~/.nuworq/folders.json'],
      ['--until-idle', 'exit once no work is waiting, instead of waiting for more'],
      ['--staff <project>', 'staff that project first, the same switch as nuworq staff ("Staff it with nuworq run"); with none staffed, run says so and offers this clone\'s'],
      ['--max-runs <n>', 'stop after starting n workers'],
      ['--max-minutes <t>', 'stop a worker that runs past t minutes; 0: no limit'],
      ['--worker-usd <x>', 'stop a worker once it has spent $x so far (claude also gets --max-budget-usd x); 0: no cap'],
      ['--max-usd <x>', "stop starting workers once they've spent $x in all, running ones' spend so far included; 0: no cap (local models and unpriced codex models count nothing)"],
      ['--pays <how>', 'api or subscription: what connect set the caps for; the start line names it'],
      ['--land-usd <x>', 'the most one land job may spend; its worker is stopped there (0: no cap)', '2'],
      ['--poll <s>', 'the most seconds between looks; new work is heard at once', '30'],
      ['--has <tags>', 'what else this machine can do, e.g. browser,linux-vm'],
      ['--browser', 'each worker gets a headless Chrome (Claude only), as with worker --browser'],
      ['--agent-token <t>', 'the agent token workers get on a hub with login'],
      ['--proxy <url>', 'send workers through llm-proxy, as with worker --proxy'],
      ['--env <names>', "variables workers get from here, as with worker --env; an installed runner keeps their values"],
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
      ['NUWORQ_LLM_PROXY_KEY', 'a personal llm-proxy key, for opencode and pi with --model proxy/<model>'],
    ],
    example: 'nuworq run --workers 3 --agent claude',
    notes: [
      'Opt a project in with nuworq staff <project>, or on the hub (project Settings: "Staff it with nuworq run"). Workers work only in folders you chose on this machine: run asks in a terminal, and --folder adds one.',
      'Three workers in a row that fail, however long each ran, pause it (5m, then longer, up to 30m), and a project whose checkout can\'t be updated waits the same way while the others go on. Logs: ~/.nuworq/logs.',
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
    name: 'operator', group: 'start', brief: 'start an operator: Claude Code in a terminal (--start)',
    does: 'print the tags an operator session declares and the line that starts it (runs nothing)',
    usage: ['operator [--project p] [--has tags]', 'operator --start [--has tags]', 'operator --detect', 'operator --allow [--off]',
      'operator --without infra | --with infra | --infra-check <command>', 'operator --check <level>'],
    flags: [
      ['--project <p>', "the project, instead of this folder's"],
      ['--has <tags>', 'what the session can really do, instead of what was detected'],
      ['--start', 'open Claude Code here with that line already sent'],
      ['--detect', 'prove each tag on this machine and say what to declare, and why'],
      ['--allow', "let the operator's routine commands run without prompts, in this project's .claude/settings.local.json, after a yes; with --off, take those rules out"],
      ['--without infra', "this machine can't reach the project's live systems; --with infra undoes it"],
      ['--infra-check <c>', 'declare infra only while this command passes ("" clears it); only a person at a terminal changes it'],
      ['--check <level>', 'only the line saying this nuworq is too old for the operator listener (exit 1), or nothing'],
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
      ['--agent <name>', 'claude, codex, opencode or pi', 'claude'],
      ['--can-read-keys', "needed for codex, opencode or pi: their shell can read this machine's keys (only Claude's sandbox hides them), so they run only on projects without a remote"],
      ['--model <m>', 'the model; opencode and pi need <provider>/<model>, e.g. ollama/qwen3.8:27b-mtp-q4_K_M'],
      ['--project <p>', 'that project, instead of where the hub routes it'],
      ['--here', 'work in this folder, not its own worktree'],
      ['--as <name>', 'its name', 'the agent and 4 random hex digits'],
      ['--allow <tools>', 'more tools it may use without asking'],
      ['--has <tags>', 'what else this machine can do'],
      ['--browser', 'a headless Chrome (Playwright MCP, local pages only) to check UI work with; Claude only'],
      ['--proxy <url>', "go through llm-proxy: its LAN or tailnet address for claude and codex; opencode and pi with --model proxy/<model>"],
      ['--agent-token <t>', 'with --run on a hub with login: the agent token it gets (never your own)'],
      ['--env <names>', "variables it gets from this shell, e.g. DOCKER_HOST,VIRTUAL_ENV: it starts with only where things are and its model's key"],
      ['--env-secret <names>', 'the same for a name that looks like a key, token or password: its agent can read it'],
    ],
    env: [
      ['NUWORQ_AGENT_TOKEN', 'the agent token, instead of --agent-token'],
      ['NUWORQ_LLM_PROXY_URL', "llm-proxy's address, instead of --proxy"],
      ['NUWORQ_LLM_PROXY_TOKEN', "llm-proxy's owner token, for claude and codex"],
      ['NUWORQ_LLM_PROXY_KEY', 'a personal llm-proxy key, for opencode and pi'],
    ],
    example: 'nuworq worker --agent claude --run',
    notes: [
      'It works in its own git worktree, with a branch per item, and reports what this machine has (macos/linux, docker, gpu). Ollama is set up for opencode and pi for you. pi gets a config folder of its own (~/.nuworq/pi/<name>), so your pi extensions, skills, MCP servers and sign-ins stay out: give its provider key in the environment.',
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
      ['--workspace <name>', "with --follow --workspaces: where a red main is reported (default: the workspace whose project has this repository)"],
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
    usage: ['person add <handle> --role <role> [--email e]', 'person list', 'person set-role <handle> <role>', 'person remove <handle>', 'person forget <email> [--dry-run]'],
    flags: [
      ['--role <role>', 'owner, steward, member or viewer', 'member'],
      ['--email <e>', 'their email'],
      ['--name <n>', 'their name'],
      ['--workspace <name>', "that workspace's people"],
      ['--db <file>', 'the database'],
      ['--data-dir <d>', "forget: the hub's data folder"],
    ],
    example: 'nuworq person add bea --role steward --email bea@example.com',
    notes: [
      'Owners do everything; stewards steer, decide, answer and accept; members comment and propose; viewers read. remove revokes the tokens they held or minted.',
      "forget <email> answers a privacy request: it deletes that email's sign-in, sessions, workspace memberships and early-access request from the hub's directory (--data-dir), and their person row in every workspace, which ends their sign-ins there; it blanks their email on feedback they sent, and prints what it kept. --dry-run only lists them.",
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
      ['--powers <list>', 'what an agent token may do: shape, build, review; and operate, only by name, to act as an operator when no steward or owner minted it'],
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
    does: 'staff a project with nuworq run, with a daily cap, and install nuworq run here',
    usage: ['staff [<project>] [--budget 20]'],
    flags: [
      ['--project <p>', "the project, instead of this folder's"],
      ['--budget <usd>', 'the daily cap for its workers', '20'],
      ['--pays <how>', "how this machine pays for Claude, api or subscription, instead of asking; it sets the runner's caps"],
      ['--yes', "don't ask: take the defaults"],
      ['--no-browser', 'print the approval link instead of opening the browser'],
    ],
    example: 'nuworq staff nuworq --budget 20',
    notes: [
      'The way to staff a project from a terminal: it turns on the project\'s "Staff it with nuworq run" switch. nuworq run --staff <project> turns on the same switch, for a runner you start by hand.',
      'On a hub with logins, an owner approves it in the browser.',
    ],
  },
  {
    name: 'down', group: 'more',
    does: 'stop the operators nuworq up started (each signs itself off) and the runner service',
    usage: ['down'],
    example: 'nuworq down',
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
    name: 'release', group: 'more',
    does: 'sign a release by hand, the fallback to the release workflow',
    usage: ['release sign <vX.Y.Z> <release-key.pem> <hub>'],
    example: 'nuworq release sign v1.0.0 ~/keys/release-key.pem https://app.nuworq.com',
    notes: [
      'Run it in a checkout of nuworq whose origin is GitHub (for its git objects), with nuworq itself installed from a signed release. If the nuworq running it is a git checkout, it refuses before it reads the key: a checkout runs whatever landed on main.',
      "It signs only what the workflow would, shows the tag's commit and changelog, and signs once you type the tag. See docs/DEPLOY.md, \"Signing by hand\".",
    ],
  },
  {
    name: 'init', group: 'more',
    does: 'print the MCP setup for Claude Code, Codex, opencode, pi and other agents; --project pins this folder',
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

// The agent commands: their usage and flags come from OPS through src/agentargs.js (#521), so every parameter
// shows; here only an example each, and the older spellings still accepted.
const AGENT = {
  checkin: { env: [['NUWORQ_HAS', 'instead of --has']], example: 'nuworq checkin --as claude-1 --has docker,macos' },
  next: { flags: [['--peek', 'the same as --claim=false']], example: 'nuworq next --as claude-1' },
  claim: { example: 'nuworq claim 12 --as claude-1' },
  progress: { example: 'nuworq progress 12 "Parser done" --touching src/parse.js --as claude-1' },
  ask: {
    flags: [['--assume <a>', 'the same as --assumption'], ['--option <x>', 'one likely answer; repeat it for more']],
    example: 'nuworq ask 12 "Keep the old flag?" --assumption "yes, as an alias" --as claude-1',
  },
  answer: { example: 'nuworq answer 40 "Done: it is installed" --as operator-1' },
  withdraw: { example: 'nuworq withdraw 40 "The owner answered in chat" --as claude-1' },
  submit: { example: 'nuworq submit 12 "Parser handles tabs" --evidence "npm test: 48 passed" --as claude-1' },
  handoff: { example: 'nuworq handoff 12 "Parser half done; tests next" --as claude-1' },
  propose: { example: 'nuworq propose "Parse tabs in headers" --priority soon --as claude-1' },
  refine: { example: 'nuworq refine 12 --priority now --as claude-1' },
  review: { example: 'nuworq review 12 accept "Tests pass; matches done_means" --as claude-2' },
  comment: { example: 'nuworq comment 12 "Heads-up: parse.js moved" --as claude-1' },
  ack: { example: 'nuworq ack 7 "Switching to the smaller fix" --as claude-1' },
  learn: { example: 'nuworq learn "npm test needs Node 24: older ones lack node:sqlite" --as claude-1' },
  feedback: { example: 'nuworq feedback "next gave me an item I can\'t build" --as claude-1' },
  look: { example: 'nuworq look 12 --as claude-1' },
  retire: { example: 'nuworq retire 31 --reason "built into checkin" --as claude-1' },
  distill: { example: 'nuworq distill --direction "Agents come first: small responses|decision 3" --notes "12|Rebase, test, then push|keep" --as claude-1' },
  signoff: { example: 'nuworq signoff "Nothing left for me" --as claude-1' },
};
const AGENT_NOTE = 'Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url. Each <argument> can be given as its flag instead. "-" as a value reads it from stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag, repeated.';

// "e.g." doesn't end a sentence.
const firstSentence = (s) => String(s ?? '').replace(/^Optional\.\s*/, '').match(/^.*?(?<!\be\.g)\.(?=\s|$)/)?.[0].replace(/\.$/, '') ?? String(s ?? '');
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
// The tool definitions leave out what the guide already says, to stay small in an agent's context (#678); a
// person reading --help gets it here instead.
const PARAM_TEXT = {
  headline: 'one line, outcome first', summary: 'the 5-minute version: what, why, what next',
  detail: 'the 30-minute version: logs, reasoning, alternatives', model: 'your model id', status: 'a one-line status',
  response: 'how you are adjusting, one line', reason: 'why, one line', question: 'the question id', steer: 'the steer id',
  title: 'the new title', acceptance: 'what done means', item: 'the item, e.g. 12',
  // refine's, which its description covers at once ("Fields as propose's").
  parent: 'the item it is part of; "" makes it top-level', depends_on: 'replaces the dependency list',
  fixes: 'the landed item this repairs; "" clears it', breaking: 'who must act when it ships; "" clears it',
  precondition: "as propose's; {} clears it",
  needs: 'tags a taker must have; replaces the list', repo: 'the repository it lands in', size: 'small, or large: multi-step',
  direction: 'Direction today: at most 7 plain lines, each with its source ("decision 12", "note 7", "#468")',
  notes: 'a gist per decision and field note; for a note, recommend keep (default), retire or decide, why for retire or decide, and draft (the decision) for decide',
};
// A limit is the schema's maxLength (#678): --help says it in words.
const flagText = (param, schema) => {
  const text = schema.description ?? PARAM_TEXT[param] ?? (schema.enum ? `one of ${schema.enum.join(', ')}` : '');
  const max = schema.maxLength ?? schema.items?.maxLength;
  if (!max) return text;
  const limit = `at most ${max.toLocaleString('en-US')} characters${schema.items ? ' each' : ''}`;
  return text ? `${firstSentence(text)}, ${limit}` : limit;
};

for (const op of OPS) {
  const a = AGENT[op.name];
  if (!a) throw new Error(`help: no example for protocol op "${op.name}"`);
  const positional = new Set(POSITIONAL[op.name].map((s) => s.replace(/[?.]+$/, '')));
  COMMANDS.push({
    name: op.name, group: 'protocol', ...a,
    does: lower(firstSentence(op.description)),
    usage: [agentUsage(op.name)],
    flags: [...agentFlags(op.name).filter(([, param]) => !positional.has(param)).map(([f, param, schema]) => [f, lower(firstSentence(flagText(param, schema)))]), ...(a.flags ?? [])],
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

// Get going leads with the recommended setup (#489, #801): connect, then its three sessions in web/connect.js's order
// (a shaper: no command, but a line typed in the Claude Code app; workers on run; an operator), then the rest.
const SHAPER = { name: '/nuworq:shaper', brief: 'shape work with a shaper: type it in the Claude Code app' };
export const GET_GOING = ['connect', SHAPER.name, 'run', 'operator', 'up', 'status', 'update'];

// A bare `nuworq`: one screen.
export function bare({ width = 80, style = plain } = {}) {
  const s = styler(style);
  const out = [`${style.bold('nuworq')}${VERSION ? ` ${VERSION}` : ''}: a hub where agents do the work and people steer`, ''];
  // One column for every group, as wide as the widest name listed.
  const at = 2 + Math.max(...COMMANDS.filter((c) => c.brief).map((c) => (c.label ?? c.name).length)) + 4;
  for (const [g, title] of GROUPS) {
    const cmds = g === 'start' ? GET_GOING.map((n) => (n === SHAPER.name ? SHAPER : command(n)))
      : COMMANDS.filter((c) => c.group === g && !c.under);
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
