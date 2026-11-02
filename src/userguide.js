// The getting-started guide (#381, #383), served at /guide to anyone, signed in or not. This file is its source:
// it ships with the hub, so the guide always describes the version that's running.
//
// Writing it: each step is what a new person does, in Get started's order (src/getstarted.js), under the same
// key and, where Get started has the step, the same title (test/userguide.test.js holds them together). A step
// says what to do by hand first (`hand`), then what nuworq can do for you and what that changes (`auto`), or
// that nothing can (`none`), then how you see it worked (`check`).
// Inline marks, so tests can find what the guide names: `nuworq connect` is a command, **Accept** is a label
// in nuworq's own screens (other sites' labels go in "quotes", never bold), /early-access is a page of the hub
// (a bare path starting a word; files are written ~/… so they never read as one), and a line that is only `…`
// is a command to copy. test/guidefresh.test.js fails when a `nuworq …` command or flag isn't in the CLI's help,
// a **label** isn't in any web/ file, or a /path isn't served by src/server.js.
// An item that changes what a new person does updates this file in the same change.
// The setup that works (#489) is one step whose sessions are web/connect.js's SETUP, each a part with its own id,
// so Get started's Start workers, Start an operator and Shape work with a shaper link straight to it.
import { SETUP, SETUP_LEAD, setupLine } from '../web/connect.js';
import { commandParts } from '../web/commands.js';

export const SETUP_TITLE = 'The setup that works';

// A session's lines in the guide's marks: what it does, where and why, then its commands, each to copy.
export const sessionLines = (s) => [setupLine(s),
  ...commandParts(s.how).map((x) => (x.cmd ? `\`${x.cmd}\`` : `${x.text.charAt(0).toUpperCase()}${x.text.slice(1)}:`))];

export const STEPS = [
  {
    key: 'signin', title: 'Sign in with GitHub', glance: 'Open nuworq and sign in with your GitHub account.',
    hand: [
      'Open nuworq (for example https://app.nuworq.com) and click **Sign in with GitHub**. GitHub asks you to authorize nuworq: approve it, and GitHub sends you back.',
      'Making a workspace takes early access while nuworq is new. Without it, ask at /early-access with your email and GitHub handle; you get a link when you\'re in.',
      'Running your own hub instead? `nuworq serve` starts one on this machine, which needs no sign-in: skip to Add a project.',
    ],
    none: 'Signing in is yours to do: nothing can do it for you.',
    check: 'You\'re back on nuworq, and it shows your workspaces or asks you to name one.',
  },
  {
    key: 'org', title: 'Create your workspace', glance: 'Name it; its address comes from the name.',
    hand: [
      'Type a **Name** (for example Acme). The **Address** is suggested from it and checked as you type; change it if you like. Click **Create workspace**.',
      'Already in one? Your workspaces are listed on the same page, and **New workspace** makes another.',
    ],
    none: 'Only you can name it, so this step stays by hand.',
    check: 'You\'re in the workspace: its name is at the top of the left rail (on a phone, under **Menu**), and the page says "Step 2 of 3 · your first project".',
  },
  {
    key: 'project', title: 'Add a project', glance: 'A mission, and the repositories agents work in.',
    hand: [
      'In a new workspace the first project\'s form is already open. Anywhere else, click **+ Project** in Get started or **+ New project** in the rail (on a phone, under **Menu**).',
      'Give it a **Name**, a **Mission** (one or two lines on what it\'s for: the north star every agent reads first), and its repositories, one per line, like github.com/acme/api. Click **Create project**.',
      'Once the GitHub App is installed, **New project** lists the repositories it can reach: pick one instead of typing it.',
    ],
    auto: 'An agent that checks in to a project name the hub doesn\'t know yet creates that project for you. Give it a mission afterwards, in the project\'s header.',
    check: 'The project is in the rail, and its board opens.',
  },
  {
    key: 'repo', title: 'Link a project to its repository', glance: 'So agents know where its code lives.',
    hand: [
      'Skip this if you listed a repository when you made the project.',
      'Otherwise open the project, click **+ repo** in its header, type the repository (github.com/acme/api) and save. Every clone of it, on any machine, then reaches this project.',
    ],
    auto: 'An agent that checks in from a clone of the repository links it for you: the hub reads the clone\'s git remote. Nothing else changes.',
    check: 'The repository shows in the project\'s header.',
  },
  {
    key: 'github', title: 'Connect GitHub', glance: 'Install the nuworq GitHub App on the repositories agents push to.',
    hand: [
      'Click **Install the GitHub App** in Get started, or in **Connect an agent** under GitHub App. GitHub asks where to install it: choose "Only select repositories", pick the project\'s repository, and click "Install". GitHub sends you back to nuworq.',
      'What it allows: workers push their branches and open pull requests with a token that lasts an hour and reaches one repository. No one hands out a personal access token.',
      'On your own hub with no app yet, an owner clicks **Create the GitHub App** first. GitHub makes the app from nuworq\'s settings, then asks where to install it, as above.',
    ],
    none: 'GitHub asks you to choose the repositories yourself, so this stays by hand.',
    check: 'Get started ticks Connect GitHub off, and **Connect an agent** says the app is installed.',
  },
  {
    key: 'machine', title: 'Install and connect your machine', glance: 'One paste, once per machine.',
    hand: [
      'You need Node 24 or newer: `node --version` tells you. Missing or older? Install the current LTS from nodejs.org, or on a Mac with Homebrew run `brew install node`, then open a new terminal.',
      'Open **Connect an agent** in the rail (on a phone, under **Menu**). Its first block is this hub\'s command, ready to copy. Paste it in a terminal, in a clone of the project\'s repository: `npm install -g <the package address it shows> && nuworq connect <your workspace\'s address>`. It installs nuworq from the hub, so it\'s the same version as the hub and keeps itself up to date.',
      'A browser tab opens with a code: check it matches the one in your terminal, and approve it.',
      'To register nuworq with your agent tools yourself, connect with `nuworq connect <address> --no-mcp` instead, then for Claude Code:',
      '`claude mcp add --scope user nuworq -- nuworq mcp`',
      'Codex, opencode, pi and other MCP clients are under **Connect an agent** at depth 30m. For pi (1.4 or newer): `pi mcp add nuworq --exposure direct -- nuworq mcp`.',
    ],
    auto: '`nuworq connect` without `--no-mcp` also registers nuworq with Claude Code, Codex, opencode and pi where they\'re installed. It saves this machine\'s token in ~/.nuworq/connect.json, which only you can read. `nuworq disconnect` revokes the token and undoes all of it. Then it asks, one question at a time: install the Claude Code plugin, staff the project with workers on this machine (up to a daily cap you set; an owner approves it in the browser), and start an operator. Each says what it does and costs, and a no prints the command for later: `nuworq staff` or `nuworq operator --start`. It ends with how to plan work with a shaper. From then on, and after any restart, `nuworq up` is the one command: it keeps the runner going with automatic workers, asks once to staff projects that aren\'t, and opens an operator in its own terminal (tmux when you have it) for each project that isn\'t parked. Run it again any time: it starts only what\'s missing and ends with a table of each project. `nuworq down` stops what it started.',
    check: 'The terminal says the machine is connected, and Get started ticks Install and connect your machine off.',
  },
  {
    key: 'setup', title: SETUP_TITLE, glance: 'Workers on `nuworq run`, an operator in a terminal, a shaper in the Claude Code app.',
    sessions: SETUP,
    hand: [
      SETUP_LEAD,
      'Add workers and an operator once there\'s work for them. The operator and the shaper are Claude Code with the nuworq plugin, which `nuworq connect` offers to install (or see Start an agent, below). Workers work only on the projects you let them staff: connect asks, or open the project, then **Settings**, and switch on **Staff it with nuworq run**.',
    ],
    auto: '`nuworq up` starts the first two for every project that isn\'t parked, in one go: the runner as a service with automatic workers, and an operator in its own terminal (tmux when you have it). Run it again after any restart: it starts only what\'s missing. `nuworq down` stops what it started. `nuworq operator --start` opens one operator here, with its routine commands allowed; `nuworq run --uninstall` removes the service.',
    check: 'Workers and an operator show on the project\'s board, and Get started ticks off Start workers, Start an operator and Shape work with a shaper.',
  },
  {
    key: 'agent', title: 'Start an agent', glance: 'Beyond the setup that works: one agent beside you, or workers by hand.',
    hand: [
      'Start with The setup that works, above. These are the other ways.',
      'Beside you: install the Claude Code plugin once (two commands), open Claude Code in a clone of the project\'s repository, and say "Work on <project> using nuworq". It checks in, takes the most useful item, and you watch and steer it in your session.',
      '`claude plugin marketplace add paulnorthup/nuworq#release`',
      '`claude plugin install nuworq@nuworq --scope user`',
      'In Claude Code\'s `/plugin` menu, pick the option for you (all projects), not one for this repository only: then every project gets `/nuworq:shaper` and `/nuworq:operator`.',
      'Workers by hand, in a terminal, until Ctrl-C stops them. One worker, wherever work is waiting:',
      '`nuworq worker --agent claude --run`',
      'Or up to three on the projects you let it staff (the board also offers **Let nuworq run staff this project**). Workers cost money: `nuworq run --max-usd 5` stops launching more once they\'ve spent $5.',
      '`nuworq run --workers 3 --agent claude`',
      'Workers can run on other agents too: `--agent codex`, or `--agent opencode` or `--agent pi` with a model as <provider>/<model> (`--model ollama/qwen3.8:27b-mtp-q4_K_M` runs a local Ollama model at no cost). opencode and pi have no sandbox, so their workers run only on projects without a remote. A pi worker gets a config folder of its own: your pi extensions, skills and sign-ins stay out, so give its provider key in the environment (e.g. ANTHROPIC_API_KEY).',
    ],
    auto: '`nuworq run --install` installs the runner as a service (a LaunchAgent on macOS, a systemd user unit on Linux), so workers keep going after you close the terminal or restart. When nuworq updates, it moves onto the new version by itself once its workers finish. It adds that one service; its log is ~/.nuworq/logs/run.log. `nuworq run --uninstall` removes it.',
    check: 'The agent shows on the project\'s board, on an item or checked in.',
  },
  {
    key: 'plan', title: 'Plan the first work', glance: 'Plan it with a shaper, or write it on the board yourself.',
    hand: [
      'On the project\'s board, tap **+ Work**, write what should be true when it\'s done (for example "Users can reset their password"), and tap **Propose**.',
      'Already know exactly what done means? Tap **+ What done means, context, priority**, fill it in, and tap **Add to Ready** to put it straight into the queue. **Waits on** there holds it until a URL answers or a person replies.',
      'From any shell, one item at a time:',
      '`nuworq propose "Exports retry when storage times out" --acceptance "A timed-out export retries 3 times, then fails with a clear error"`',
      'Proposals are shaped into ready work by agents, or wait for your OK, depending on the project\'s autonomy (below).',
    ],
    auto: 'The shaper from The setup that works, above: in the Claude Code app, type `/nuworq:shaper` and say what you want and why. It reads the project, asks a few questions, recommends a milestone and its parts, and proposes them, each with what done means, once you say so. You decide; it never decides for you.',
    check: 'The items are on the board, under Proposed or Ready.',
  },
  {
    key: 'needs', title: 'Answer what Needs you', glance: 'Questions and finished work wait for you in one place.',
    hand: [
      '**Needs you**, at the top of the home and of each project, lists what only you can do. Healthy work never shows up there.',
      'A question: pick an option, or type an answer. Finished work to check: read its evidence, then **Accept**, or **Send back** with what\'s missing (the next agent starts from it). A step for you to do: it lists each one, where to do it and how to check it.',
    ],
    auto: 'Under **Run with it**, agents review each other\'s work, so far less waits for you (see Autonomy). Notifications tell you when something new arrives, so you don\'t have to watch.',
    check: 'The card leaves Needs you, and the item moves on.',
  },
  {
    key: 'landed', title: 'Watch your first item land', glance: 'Accepted work goes onto main by itself.',
    hand: [
      'Once work is accepted, an agent rebases its branch onto main, runs the checks and lands it. Click **Open the board** in Get started and watch the item reach Done.',
    ],
    auto: 'Landing needs nothing from you. Where the project uses pull requests, the hub opens one that merges itself once checks pass.',
    check: 'The item is Done, its commit is on main, and Get started is all ticked off.',
  },
];

// The essentials, once you're going: one short section each.
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
    // Not "operator": that id is The setup that works' Start an operator, which Get started's How? opens (#592).
    key: 'the-operator', title: 'The operator', glance: 'An attended agent with your permissions, for what workers can\'t do.',
    body: [
      'Workers can\'t touch live infrastructure, sign releases or administer GitHub. An operator is a Claude Code session you start and watch: it answers workers\' questions to the operator, reviews and lands work, and runs the steps on real systems. It asks you only what only you can do.',
      'Start it as in The setup that works: Claude Code in a terminal of its own. `nuworq operator --project <project>` prints the `/nuworq:operator` line to paste into Claude Code in the project\'s folder; it runs nothing itself.',
    ],
  },
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// `code` and **label**, after escaping; a line that is only `…` is a command to copy.
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
const command = (s) => s.match(/^`([^`]+)`$/)?.[1];
const para = (s) => {
  const cmd = command(s);
  return cmd ? `<div class="copyable"><pre>${esc(cmd)}</pre><button type="button" data-copy="${esc(cmd)}">Copy</button></div>` : `<p>${inline(s)}</p>`;
};

// Every command, label and app path the guide names, for tests that keep it true.
export function mentions() {
  const text = [...STEPS.flatMap((s) => [s.glance, ...s.hand, ...(s.sessions ?? []).flatMap(sessionLines), s.auto, s.none, s.check]),
    ...ESSENTIALS.flatMap((e) => [e.glance, ...e.body])].filter(Boolean);
  const all = (re) => [...new Set(text.flatMap((t) => [...t.matchAll(re)].map((m) => m[1])))];
  return { commands: all(/`([^`]+)`/g), labels: all(/\*\*([^*]+)\*\*/g), paths: all(/(?:^|[\s(])(\/[a-z][\w-]*(?:\/[\w-]+)*)/g) };
}

// version: e.g. "v0.2.0 · c3a3008". base: the app's address on this host ('' or /w/<workspace>).
export function guidePage({ version = '', base = '', logo = '', favicon = '' } = {}) {
  const step = (s, n) => `<li><details id="${s.key}"><summary><span class="n">${n}</span><span class="t"><b>${esc(s.title)}</b><span class="g">${inline(s.glance)}</span></span></summary>
    <div class="body">${s.sessions ? `${s.hand.map(para).join('')}${s.sessions.map((x, k) => `<h4 id="${x.key}">${k + 1}. ${esc(x.title)}</h4>${sessionLines(x).map(para).join('')}`).join('')}`
      : `<h4>By hand</h4>${s.hand.map(para).join('')}`}
    <h4>${s.auto ? 'Or let nuworq do it' : 'Can nuworq do it for you?'}</h4>${para(s.auto ?? s.none)}
    <h4>How you know it worked</h4>${para(s.check)}</div></details></li>`;
  const essential = (e) => `<li><details id="${e.key}"><summary><span class="t"><b>${esc(e.title)}</b><span class="g">${inline(e.glance)}</span></span></summary>
    <div class="body">${e.body.map(para).join('')}</div></details></li>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><script src="${base}/theme.js"></script><meta name="viewport" content="width=device-width, initial-scale=1">
<title>nuworq · Getting started</title>${favicon ? `<link rel="icon" href="${favicon}">` : ''}<link rel="stylesheet" href="${base}/style.css"><link rel="stylesheet" href="${base}/guide.css"></head>
<body><main class="guide">
<header><div class="brand">${logo}<span>nuworq</span></div><a class="btn primary small" href="${base}/">Open nuworq</a></header>
<h1>Getting started</h1>
<p class="lead">From nothing to your first landed item. Tap a step for exactly what to click or type, and how to see it worked.</p>
${version ? `<p class="version">This guide describes nuworq ${esc(version)}, the version this hub runs.</p>` : ''}
<ol class="guide-steps">${STEPS.map((s, i) => step(s, i + 1)).join('')}</ol>
<h2>Once you're going</h2>
<ul class="guide-steps essentials">${ESSENTIALS.map(essential).join('')}</ul>
</main><script type="module" src="${base}/guide.js"></script></body></html>`;
}
