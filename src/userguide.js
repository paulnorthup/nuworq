// The getting-started guide (#381, #383), served at /guide to anyone, signed in or not. This file is its source:
// it ships with the hub, so the guide always describes the version that's running.
//
// Writing it: each step is what a new person does, in Get started's order (src/getstarted.js), under the same
// key and, where Get started has the step, the same title (test/userguide.test.js holds them together). A step
// opens with the simplest way that works (`hand`), then the other ways, then how you see it worked (`check`).
// Reference that isn't a step lives in ESSENTIALS, under "Once you're going". Say each term once, plainly, the
// first time a newcomer meets it; say "click", never "tap"; where a step needs another section, link it
// ([Autonomy](#autonomy)) instead of naming it with "above" or "below" (#801).
// Inline marks, so tests can find what the guide names: `nuworq connect` is a command, **Accept** is a label
// in nuworq's own screens (other sites' labels go in "quotes", never bold), /early-access is a page of the hub
// (a bare path starting a word; files are written ~/… so they never read as one), and a line that is only `…`
// is a command to copy. test/guidefresh.test.js fails when a `nuworq …` command or flag isn't in the CLI's help,
// a **label** isn't in any web/ file, or a /path isn't served by src/server.js.
// An item that changes what a new person does updates this file in the same change.
// The recommended setup (#489) is web/connect.js's SETUP: its sessions are parts with their own ids, in the steps
// that start them, so Get started's Shape work with a shaper, Start workers and Start an operator link straight to them.
// A step with one part doesn't number it; a step with byHand shows each part's by-hand form, after its own nuworq up.
import { SETUP, setupLine } from '../web/connect.js';
import { commandParts } from '../web/commands.js';

export const SETUP_TITLE = 'Recommended setup';

// A session's lines in the guide's marks: what it does, where and why, then its commands, each to copy.
// Words that lead into a command end in a colon; a note after the last one (#646) doesn't. byHand: the form
// without nuworq up, where it is said already (#801).
export const sessionLines = (s, byHand = false) => {
  const parts = commandParts((byHand && s.byHand) || s.how);
  return [setupLine(s), ...parts.map((x, i) => (x.cmd ? `\`${x.cmd}\``
    : `${x.text.charAt(0).toUpperCase()}${x.text.slice(1)}${parts.slice(i + 1).some((y) => y.cmd) ? ':' : ''}`))];
};

const session = (key) => SETUP.filter((s) => s.key === key);

export const STEPS = [
  {
    key: 'signin', title: 'Sign in with GitHub', glance: 'Open nuworq and sign in with your GitHub account.',
    hand: [
      'Open nuworq (for example https://app.nuworq.com) and click **Sign in with GitHub**. GitHub asks you to authorize nuworq: approve it, and GitHub sends you back.',
      'Making a workspace takes early access while nuworq is new. Without it, ask at /early-access with your email and GitHub handle; you get a link when you\'re in.',
      'Running your own hub instead? `nuworq serve` starts one on this machine, which needs no sign-in: skip to [Add a project](#project).',
    ],
    check: 'You\'re back on nuworq, and it shows your workspaces or asks you to name one.',
  },
  {
    key: 'org', title: 'Create your workspace', glance: 'Name it; its address comes from the name.',
    hand: [
      'Type a **Name** (for example Acme). The **Address** is suggested from it and checked as you type; change it if you like. Click **Create workspace**.',
      'Already in one? Your workspaces are listed on the same page, and **New workspace** makes another.',
    ],
    check: 'You\'re in the workspace: its name is at the top of the left rail (on a phone, under **Menu**), and the page says "Step 2 of 3 · your first project".',
  },
  {
    key: 'project', title: 'Add a project', glance: 'A mission, and the repository agents work in.',
    hand: [
      'In a new workspace the first project\'s form is already open. Anywhere else, click **+ Project** in Get started or in the rail (on a phone, under **Menu**).',
      'Give it a **Name**, a **Mission** (one or two lines on what it\'s for: the north star every agent reads first), and its repository, like github.com/acme/api. Click **Create project**.',
      'Once the GitHub App is installed, **+ Project** lists the repositories it can reach: pick one instead of typing it.',
      'Left the repository out? Open the project, click **+ repo** in its header, type the repository and save. Agents working in any clone of it, on any machine, then work on this project.',
      'Or let an agent do both: if one checks in under a project name that doesn\'t exist yet, nuworq creates the project, and links the repository from the clone\'s git remote. Give the project a mission afterwards, in its header.',
    ],
    check: 'The project is in the rail, its board opens, and the repository shows in its header.',
  },
  {
    key: 'github', title: 'Connect GitHub', glance: 'Install the nuworq GitHub App on the repositories agents push to.',
    hand: [
      'Click **Install the GitHub App** in Get started, or in **Connect an agent** under GitHub App. GitHub asks where to install it: choose "Only select repositories", pick the project\'s repository, and click "Install". GitHub sends you back to nuworq.',
      'What it allows: workers push their branches and open pull requests with a token that lasts an hour and reaches one repository. No one hands out a personal access token.',
      'On your own hub with no app yet, an owner clicks **Create the GitHub App** first. GitHub makes the app from nuworq\'s settings, then asks where to install it, the same way.',
    ],
    check: 'Get started ticks Connect GitHub off, and **Connect an agent** says the app is installed.',
  },
  {
    key: 'machine', title: 'Install and connect your machine', glance: 'One paste, once per machine.',
    hand: [
      'You need Node 24 or newer: `node --version` tells you. Missing or older? Install the current LTS from nodejs.org, or on a Mac with Homebrew run `brew install node`, then open a new terminal.',
      'Open **Connect an agent** in the rail (on a phone, under **Menu**). Its first block is this hub\'s command, ready to copy. Paste it in a terminal, in a clone of the project\'s repository: `npm install -g <the package address it shows> && nuworq connect <your workspace\'s address>`. It installs nuworq from the hub, so it\'s the same version as the hub and keeps itself up to date.',
      'A browser tab opens with a code: check it matches the one in your terminal, and approve it.',
      '`nuworq connect` then sets up this machine:',
      'It saves the machine\'s token in ~/.nuworq/connect.json, which only you can read.',
      'It adds nuworq to Claude Code, Codex, opencode and pi, where they\'re installed.',
      'It asks, one question at a time, whether to install the Claude Code plugin, let workers on this machine take the project\'s work, and start an operator. Each says what it does and costs, and a no prints the command for later: `nuworq staff` or `nuworq operator --start`.',
      'Letting workers take the work asks whether this machine pays for Claude with a subscription or an API key, and sets the limits to fit: minutes on a subscription, a per-worker and a daily dollar limit on an API key. An owner approves it in the browser.',
      'It ends with how to plan work with a shaper. `nuworq disconnect` revokes the token and undoes all of it.',
      'After a restart, run `nuworq up`.',
      'To add nuworq to your agent tools yourself, connect with `nuworq connect <address> --no-mcp` instead, then for Claude Code:',
      '`claude mcp add --scope user nuworq -- nuworq mcp`',
      'For Codex, opencode and other MCP clients, set **Depth** (at the top of each page) to 30m, then open **Connect an agent**: it lists their settings. For pi (1.4 or newer): `pi mcp add nuworq --exposure direct -- nuworq mcp`.',
    ],
    check: 'The terminal says the machine is connected, and Get started ticks Install and connect your machine off.',
  },
  {
    key: 'plan', title: 'Plan the first work with a shaper', glance: 'Talk it through in the Claude Code app, or write it on the board yourself.',
    hand: [
      'Start with a shaper: it plans the work with you, and workers then do it.',
    ],
    sessions: session('shaper'),
    then: [
      'It needs the nuworq plugin, which `nuworq connect` offers to install; the plugin\'s two commands are under [Other ways to run agents](#other-ways).',
      'Or write the work yourself. On the project\'s board, click **+ Work**, write what should be true when it\'s done (for example "Users can reset their password"), and click **Propose**.',
      'Already know exactly what done means? Click **+ What done means, context, priority**, fill it in, and click **Add to Ready** to put it straight into the queue. **Waits on** there holds the item until a web address (a URL) answers or a person replies.',
      'From any shell, one item at a time:',
      '`nuworq propose "Exports retry when storage times out" --acceptance "A timed-out export retries 3 times, then fails with a clear error"`',
      'Proposals are shaped into ready work by agents, or wait for your OK, depending on the project\'s autonomy: [Autonomy](#autonomy) explains the three settings.',
    ],
    check: 'The items are on the board, under Proposed or Ready, and Get started ticks off Shape work with a shaper.',
  },
  {
    key: 'start', title: 'Start workers and an operator', glance: 'One command starts both.',
    hand: [
      'In a clone of the project, run:',
      '`nuworq up`',
      'It keeps the runner (the program that starts workers) going as a service, with workers started as work arrives.',
      'It opens an operator in its own terminal for each project that isn\'t parked (**Park** in a project\'s Settings pauses one). With tmux installed, a terminal that keeps running after you close its window, the operators run there: `tmux attach -t nuworq` shows them.',
      'Run `nuworq up` again after any restart: it starts only what\'s missing, and ends with a table of each project. `nuworq down` stops what it started.',
      'Workers work only on the projects you let them. `nuworq connect` asks, or open the project, then **Settings**, and switch on **Staff it with nuworq run**, which lets workers on your machine take that project\'s work.',
      'Or start each by hand:',
    ],
    sessions: SETUP.filter((s) => s.key !== 'shaper'), byHand: true,
    then: [
      '`nuworq operator --start` opens one operator here and allows the commands it needs every day: git and the project\'s checks. `nuworq run --uninstall` removes the workers\' service.',
      'More ways to run agents, and what workers may run, are under Once you\'re going: [Other ways to run agents](#other-ways) and [What workers may run](#worker-commands).',
    ],
    check: 'Workers and an operator show on the project\'s board, and Get started ticks off Start workers and Start an operator.',
  },
  {
    key: 'needs', title: 'Answer what Needs you', glance: 'Questions and finished work wait for you in one place.',
    hand: [
      '**Needs you**, at the top of the home and of each project, lists what only you can do. Healthy work never shows up there.',
      'A question: pick an option, or type an answer. Finished work to check: read its evidence, then **Accept**, or **Send back** with what\'s missing (the next agent starts from it). A step for you to do: it lists each one, where to do it and how to check it.',
      'An agent names a question by its number, such as "question 207"? Each question shows its number beside its item, as Q207. Press ⌘K (Ctrl K elsewhere) and type `q207`: it opens that question, whether it is still open or already answered.',
      'Under **Run with it**, agents review each other\'s work, so far less waits for you: see [Autonomy](#autonomy). Notifications tell you when something new arrives, so you don\'t have to watch.',
    ],
    check: 'The card leaves Needs you, and the item moves on.',
  },
  {
    key: 'landed', title: 'Watch your first item land', glance: 'Accepted work goes onto main by itself.',
    hand: [
      'Once work is accepted, an agent rebases its branch onto main, runs the checks and lands it. Click **Open the board** in Get started and watch the item reach Done.',
      'Landing needs nothing from you. Where the project uses pull requests, the hub opens one that merges itself once checks pass.',
    ],
    check: 'The item is Done, its commit is on main, and Get started is all ticked off.',
  },
];

// Once you're going: one short section each.
export const ESSENTIALS = [
  {
    key: 'autonomy', title: 'Autonomy', glance: 'How far agents go without you.',
    body: [
      'In a project\'s header (at depth 5m or 30m), **Autonomy** has three settings. **Check with me**: agents\' proposals wait for your OK, and you verify all finished work. **Keep moving**: agents shape and start their own proposals, and you verify finished work. **Run with it**: agents also review each other\'s work (never their own); you get the digest and step in when you choose.',
      'Agents are told at once when it changes.',
    ],
  },
  {
    key: 'depth', title: 'Depth', glance: '30 seconds, 5 minutes or 30 minutes.',
    body: [
      '**Depth** at the top of each page picks how much you see: 30s shows only what needs you and whether work flows; 5m adds what\'s in flight and why; 30m is the whole story. Keys 1, 2 and 3 switch it.',
    ],
  },
  {
    key: 'notifications', title: 'Notifications', glance: 'One message when something new needs you.',
    body: [
      'Open **Notifications** in the rail (on a phone, under **Menu**). Pick ntfy, Slack or webhook, paste its address, and click **Add**; **Send a test** checks it. Messages are batched over two minutes, and healthy work sends nothing. Each channel also gets a weekly line per busy project; turn it off with **Weekly line**.',
    ],
  },
  {
    // Not "operator": that id is Start an operator's part of the Start workers and an operator step, which Get started's How? opens (#592).
    key: 'the-operator', title: 'The operator', glance: 'A Claude Code session you keep open, for the work workers aren\'t allowed to do.',
    body: [
      'Workers run on their own, so they can\'t change live servers, sign releases or change GitHub settings. The operator can: it\'s Claude Code in a terminal you can see, acting with your access. It answers the questions workers send it, lands their work, and runs the steps on real systems. It asks you only for what it can\'t do itself, like approving a release.',
      '`nuworq up` starts one for each of your projects that doesn\'t have one yet. To start one yourself, open a terminal in the project\'s folder, run `claude`, then type `/nuworq:operator` (`/nuworq-operator` if you didn\'t install the plugin).',
    ],
  },
  {
    key: 'other-ways', title: 'Other ways to run agents', glance: 'A session in your own Claude Code, workers by hand, a service, Codex, opencode and pi.',
    body: [
      'A session in your own Claude Code: install the plugin once (two commands), open Claude Code in a clone of the project\'s repository, and say "Work on <project> using nuworq". It checks in, takes the most useful item, and you watch and steer it in your session.',
      '`claude plugin marketplace add paulnorthup/nuworq#release`',
      '`claude plugin install nuworq@nuworq --scope user`',
      'In Claude Code\'s `/plugin` menu, pick the option for you (all projects), not one for this repository only: then every project gets `/nuworq:shaper` and `/nuworq:operator`.',
      'Workers by hand, in a terminal, until Ctrl-C stops them. One worker, wherever work is waiting:',
      '`nuworq worker --agent claude --run`',
      'Or up to three on the projects you let them work on (the board also offers **Staff it with nuworq run**). Workers cost money: `nuworq run --max-usd 5` stops launching more once they\'ve spent $5.',
      '`nuworq run --workers 3 --agent claude`',
      'The same runner as a service, so workers keep going after you close the terminal or restart: `nuworq run --install` sets it up (a LaunchAgent on macOS, a systemd user unit on Linux). When nuworq updates, the service moves onto the new version by itself once its workers finish. It adds that one service; its log is ~/.nuworq/logs/run.log. `nuworq run --uninstall` removes it.',
      'Workers can run on other agents too: `--agent codex`, or `--agent opencode` or `--agent pi` with a model as <provider>/<model> (`--model ollama/qwen3.8:27b-mtp-q4_K_M` runs a local Ollama model at no cost). Only Claude workers are kept from your machine\'s keys, so these start only with `--can-read-keys`, and only on projects without a remote: Codex\'s sandbox (its limit on what a program may touch) limits writes and network, not reads, and opencode and pi have no sandbox. A pi worker gets a config folder of its own: your pi extensions, skills and sign-ins stay out, so give its provider key in the environment (e.g. ANTHROPIC_API_KEY).',
    ],
  },
  {
    key: 'worker-commands', title: 'What workers may run', glance: 'The commands workers run without asking, and how to add more.',
    body: [
      'Workers run git, and the project\'s checks, without asking: `npm test`, `npm ci` and the package.json scripts named test, lint, check, typecheck or build (`test:unit` too), `pytest`, and `cargo` and `go` test and build.',
      'They never run `npm install`, a deploy, release or publish script, or an interpreter like `node` on its own: each could run anything.',
      'To add a command, e.g. `npm run e2e` or `make test`: open the project\'s **Settings**, find **Worker commands**, and type one per line. Workers started from then on may run it, with any arguments.',
    ],
  },
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// `code`, **label** and [text](#section) links, after escaping; a line that is only `…` is a command to copy.
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/\[([^\]]+)\]\(#([\w-]+)\)/g, '<a href="#$2">$1</a>');
const command = (s) => s.match(/^`([^`]+)`$/)?.[1];
const para = (s) => {
  const cmd = command(s);
  return cmd ? `<div class="copyable"><pre>${esc(cmd)}</pre><button type="button" data-copy="${esc(cmd)}">Copy</button></div>` : `<p>${inline(s)}</p>`;
};

// Every command, label and app path the guide names, for tests that keep it true.
export function mentions() {
  const text = [...STEPS.flatMap((s) => [s.glance, ...s.hand, ...(s.sessions ?? []).flatMap((x) => sessionLines(x, s.byHand)), ...(s.then ?? []), s.check]),
    ...ESSENTIALS.flatMap((e) => [e.glance, ...e.body])].filter(Boolean);
  const all = (re) => [...new Set(text.flatMap((t) => [...t.matchAll(re)].map((m) => m[1])))];
  return { commands: all(/`([^`]+)`/g), labels: all(/\*\*([^*]+)\*\*/g), paths: all(/(?:^|[\s(])(\/[a-z][\w-]*(?:\/[\w-]+)*)/g) };
}

// version: e.g. "v0.2.0 · c3a3008". base: the app's address on this host ('' or /w/<workspace>).
export function guidePage({ version = '', base = '', logo = '', favicon = '' } = {}) {
  const part = (s) => (x, k) => `<h4 id="${x.key}">${s.sessions.length > 1 ? `${k + 1}. ` : ''}${esc(x.title)}</h4>${sessionLines(x, s.byHand).map(para).join('')}`;
  const step = (s, n) => `<li><details id="${s.key}"><summary><span class="n">${n}</span><span class="t"><b>${esc(s.title)}</b><span class="g">${inline(s.glance)}</span></span></summary>
    <div class="body">${s.hand.map(para).join('')}${(s.sessions ?? []).map(part(s)).join('')}${(s.then ?? []).map(para).join('')}
    <h4>How you know it worked</h4>${para(s.check)}</div></details></li>`;
  const essential = (e) => `<li><details id="${e.key}"><summary><span class="t"><b>${esc(e.title)}</b><span class="g">${inline(e.glance)}</span></span></summary>
    <div class="body">${e.body.map(para).join('')}</div></details></li>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><script src="${base}/theme.js"></script><meta name="viewport" content="width=device-width, initial-scale=1">
<title>nuworq · Getting started</title>${favicon ? `<link rel="icon" href="${favicon}">` : ''}<link rel="stylesheet" href="${base}/style.css"><link rel="stylesheet" href="${base}/guide.css"></head>
<body><main class="guide">
<header><div class="brand">${logo}<span>nuworq</span></div><a class="btn primary small" href="${base}/">Open nuworq</a></header>
<h1>Getting started</h1>
<p class="lead">From nothing to your first landed item. Click a step for exactly what to click or type, and how to see it worked.</p>
${version ? `<p class="version">This guide describes nuworq ${esc(version)}, the version this hub runs.</p>` : ''}
<ol class="guide-steps">${STEPS.map((s, i) => step(s, i + 1)).join('')}</ol>
<h2>Once you're going</h2>
<ul class="guide-steps essentials">${ESSENTIALS.map(essential).join('')}</ul>
</main><script type="module" src="${base}/guide.js"></script></body></html>`;
}
