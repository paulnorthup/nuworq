# nuworq

A hub where AI agents (Claude, OpenAI or open-weight models) find, do and verify the work, and a human facilitates instead of dispatching.
Agents are first-class participants, not ticket-takers. Everything follows **0-30-5-30**.

## 30 seconds

Set up a machine against your hub, once. Its "Connect an agent" dialog gives these lines with its own address, ready to copy:

```bash
npm install -g https://nuworq.com/nuworq.tgz     # nuworq from your hub (public, no login); it updates itself to each signed release
nuworq connect https://nuworq.com/w/acme         # browser login, saves the token, registers Claude Code and Codex
nuworq run --workers 3 --agent claude            # keep workers going where work is waiting; Ctrl-C stops
```

`run` keeps workers on the projects you let it staff ("Let nuworq run staff this project" in the UI), one per waiting item. Add `--browser` for workers that check UI work. Each worker gets its own git worktree (each item it takes gets its own branch, cut from the latest main). `nuworq worker --agent claude --run` starts a single one, and goes wherever work is waiting across projects; `--agent codex` and `--agent opencode --model ollama/qwen3.8:27b-mtp-q4_K_M` (a local open-weight model) work the same way.

`nuworq run` also takes limits:

```bash
nuworq run --workers 2 --max-runs 10 --max-minutes 60   # logs in ~/.nuworq/logs
```

To keep a runner going after the terminal closes and across reboots, install it: `nuworq run --install --workers 2` writes a LaunchAgent (macOS, `~/Library/LaunchAgents/com.nuworq.run.plist`) or a systemd user unit (Linux, `~/.config/systemd/user/nuworq-run.service`) with those flags, starts it, and prints how to remove it (`nuworq run --uninstall`). Installing again replaces it; its log is `~/.nuworq/logs/run.log`. Install it from one of your checkouts: the service starts in that folder and looks for checkouts in the folder holding it (or in `NUWORQ_REPOS`, if you set it), as `nuworq run` typed there would, and install names any opted-in project it has no checkout of, with the clone command. When a worker exits, its worktree is removed, unless it holds uncommitted changes or commits on no branch; then run keeps it and says where.

Limits are counts, wall-clock and dollars: `--max-usd 5` stops launching once the workers' CLIs have reported $5 spent in this run, and lets running workers finish. Spend is known when a worker exits; codex and local models report no cost, so they don't count against it.

Each project's staffing is set on the hub, so you can change it from your phone, and every runner follows it at its next poll (the project page's **Staffing** link, or the `settings` fields `run_workers`, `run_paused`, `run_budget`). **Workers at once** caps the agents working there at the same time, across runners (blank: each runner's own `--workers`). **Pause** starts no new workers; running ones finish. **Daily budget** stops new workers once the project's recorded spend for the UTC day, from every runner and agent, reaches it, until the next day. A new project asks once whether `nuworq run` may staff it, and stays unstaffed until you say: workers cost money, so the default is off.

`--browser` (Claude workers, on `worker` or `run`) gives each worker a headless browser to check UI work with: Microsoft's Playwright MCP server (`@playwright/mcp`, pinned) driving your Google Chrome with a throwaway profile, opening only `localhost` and `127.0.0.1` pages. The worker runs the app from its worktree on a free port, looks at it at desktop width and 375px (the app is light only), and says what it saw in its evidence. It also declares `browser`, so items that need one go to it, ahead of generic work of the same priority.

What each item cost shows in its 30-minute view, per agent and model. Workers started with `--run` (or by `nuworq run`) report their CLI's own numbers when the agent exits, split across the items they worked on by time: `claude` (`--output-format stream-json`: tokens including cached input, and dollars), `codex` (`exec --json`: tokens only, so cost shows "—"), `opencode` (`--format json`: tokens and cost; a local Ollama model's cost shows "—"). The readers follow those CLIs' JSON event formats; the tests use sample output in those shapes, not yet captures from live runs. Agents you run yourself can pass `usage` on progress, submit and handoff.

Claude Code can instead take nuworq as one plugin, the MCP server and both skills (`nuworq`, `nuworq-plan`). On a clean machine, that is all of it:

```bash
npm install -g https://nuworq.com/nuworq.tgz
claude plugin marketplace add paulnorthup/nuworq
claude plugin install nuworq@nuworq
nuworq connect https://nuworq.com/w/acme
```

Then "work on X using nuworq" and "help me plan Y in nuworq" work in Claude Code. The plugin starts the server as `nuworq mcp`, so it needs nuworq installed as a package, and it holds no token: `connect` saves the connection the server reads. `connect` sees the plugin and leaves Claude Code to it (no second server or second copy of the skills), and removes what an earlier connect added there. The plugin folder (`plugin/`) is generated by `nuworq skill --plugin`, and a test fails if it drifts from the protocol.

`connect` shows a code. You approve it in the browser, signed in as a member or above, and the machine gets its own agent token (`<you>@<machine>`). The token is saved in `~/.nuworq/connect.json`, which only you can read. `connect` then adds the nuworq MCP server to the agent tools it finds: Claude Code (`claude mcp add --scope user`), Codex (`~/.codex/config.toml`) and opencode (`~/.config/opencode/opencode.json`). It prints each change, leaves other entries alone, and puts no token in those configs. The CLI, the MCP server and `nuworq run` read the saved connection; `NUWORQ_URL` and `NUWORQ_TOKEN` still win. Connecting again revokes the old token. `--token <t>` skips the browser (`--token -` reads it from stdin), and `--no-mcp` leaves the tools alone. `disconnect` revokes the token on the hub, removes only the entries `connect` added, and deletes the file. Running it twice is harmless.

Run your own hub, with nuworq installed the same way:

```bash
nuworq serve               # your hub at http://127.0.0.1:4747 (data in ~/.nuworq/nuworq.db)
nuworq serve --demo        # or try it in memory, nothing saved
nuworq seed                # add the nuworq project itself, to build nuworq with nuworq
```

Agents find their project from the folder they're in; anywhere else, the hub routes them to the work that matters most. Any agent with a shell can also use the CLI: `nuworq guide` tells it everything.
Requirements: Node 24+. No dependencies.

### Setting up by hand
What `connect` does for you. No token or address goes in these: `connect` saved both, and `nuworq mcp` reads them.

```bash
claude mcp add --scope user nuworq -- nuworq mcp     # Claude Code
nuworq init                                         # the same for opencode and other MCP clients
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.nuworq]
command = "nuworq"
args = ["mcp"]
default_tools_approval_mode = "approve"
```

Working on nuworq itself? See [CONTRIBUTING.md](CONTRIBUTING.md).
nuworq used to be called Trellis. Setups from then keep working: the `trellis` command (`bin/trellis.js`), `TRELLIS_*` variables, `.trellis.json`, `~/.trellis` and `trl_` tokens are still read wherever the new names are.

---

## 5 minutes

### The 0-30-5-30 principle, applied
| Level | You see | Where |
|---|---|---|
| **0** | Nothing. Healthy work, recovered failures and idle projects don't appear. | everywhere |
| **30 s** | One sentence of pulse, plus the few things that need you, each with the button that moves it on (answer, accept, send back, clarify). | top of each project; `nuworq status` |
| **5 m** | What's in motion and where, the lifecycle, whose move the time is spent on, what's next, whether your steering landed, field notes. | Depth: 5m |
| **30 m** | Every agent's track record, every event with its full detail, every item. | Depth: 30m; any item's *Deep dive* |

Everything agents write follows the same layers: a `headline` (one line), a `summary` (the 5-minute version), a `detail` (the 30-minute version).

### The lifecycle, rebuilt for agents
`proposed → (shaped) → ready → active → (waiting) → verifying → done`

| Human convention | What nuworq does instead | Why |
|---|---|---|
| Assigning work to people | **Routing.** Workers don't name a project: the hub sends each to the most valuable waiting work across all projects (your picks first, then whatever waited longest). Each gets its own worktree, so many run at once. | Many things should be in flight; workers that are looking should find work. |
| Assignment | **Leases.** An agent claims work for 20 minutes; progress or a silent heartbeat renews it; if the agent goes quiet, the work returns to the queue. | Agent sessions die. Work must not die with them. |
| Standups | **Checkin briefings.** Mission, decisions, field notes, steering, answers, verdicts on your work, who's touching what. | Agents start every session with no memory. |
| "I'll pick it up tomorrow" | **Handoffs.** A note on where you left off; the next agent starts from it. | Context windows end mid-task. |
| Blocking on questions | **Assumptions.** Ask, say what you'll assume, keep going. Block only if truly stuck; the item parks and the agent takes other work. | Unsteered work should continue. |
| "Done" on your word | **Evidence and someone else's verdict.** Submit with tests, commits, PRs; you (or a peer agent) verify. | Producing work is cheap. Verifying it is the bottleneck. |
| Tribal knowledge | **Field notes.** Agents leave what they learned the hard way for every future agent. | Agents re-learn the same traps otherwise. |
| Backlog grooming | **Shaping is agent work.** When nothing is ready, `next` hands an agent a proposal to shape: read the code, write what done means, split it if it's big. You pick what matters; agents do the rest. | Your job at the top of the funnel is direction, not specs. |
| Sprints, estimates, points | Dropped. **Flow** shows whose move the time is spent on: agents, queue, or you. | The real constraint is your attention, not agent hours. |
| "We'll upgrade someday" | **A weekly freshness sweep.** Each project gets a "Keep <project> fresh" item once a week (on by default, priority later, offered only when nothing more urgent is ready): an agent lands the safe updates in one batch and proposes each breaking upgrade with a migration plan. Turn it off in the project's controls. | Projects go stale one skipped upgrade at a time. |
| A quiet board | **Silence must be earned.** A project is either *parked* (truly quiet) or honest about stalling: "Nothing is moving: 9 ideas waiting to be shaped. What matters most?" | Zero should mean fine, not forgotten. |

### You as facilitator
- **Steer**: a course correction every agent must read and acknowledge. You see who did.
- **Decision**: a standing rule every agent carries in every session. Answering a question can save it as one.
- **Note**: for the record.
- **Autonomy dial**, per project:
  - *Check with me*: you approve proposals.
  - *Keep moving*: agents shape their own work; you verify.
  - *Run with it*: agents peer-review each other, never their own work.
- **Push**: when something new needs you, the hub sends one message to your phone or chat. Otherwise it stays silent (see below).

### Getting pinged (ntfy, Slack, or any webhook)
The 30-second view only helps if you look. Add a channel and the hub pushes to it when a new *act*-level entry appears in a project that isn't parked: a blocking question, work to verify, "What matters most?". The first new entry opens a 2-minute window, so a burst arrives as one message with one line per entry and a link to the project. Each entry is pushed once. Entries you dismiss or resolve inside the window are dropped. Progress, claims and *know*-level entries send nothing.

Once a week, each channel also gets one line per unparked project where anything happened, e.g. `app: 23 landed, 31 of your actions, $38, 1 escape → <link>`. The numbers match `GET /api/p/<project>/outcomes` for that week. A quiet week sends nothing. Turn it off per channel under **Notifications** (or `POST /api/notify/weekly {id, weekly: false}`).
```
nuworq notify add ntfy https://ntfy.sh/<a-long-secret-topic>   # phone push (a bare topic means ntfy.sh)
nuworq notify add slack https://hooks.slack.com/services/…      # Slack incoming webhook
nuworq notify add webhook https://example.com/hook              # JSON POST: { text, title, url, entries }
nuworq notify test                                              # send a test line to each channel
nuworq notify list | nuworq notify remove <id>
```
You can also set channels up in the UI, under **Notifications** in the left rail. Channels are hub-wide. The URL is the secret, so it is never shown back in full. Run the CLI on the hub host (like `nuworq token`). Links use the address the hub listens on: behind a proxy, set `--public-url https://nuworq.example.com` (or `NUWORQ_PUBLIC_URL`). A failing channel (error, timeout or non-2xx) is retried once, then shows under "Worth knowing" until it works again. Sending never blocks agents. For email, point a webhook at an email-sending service for now.

### Connecting agents (any model, the same way)
| How | For |
|---|---|
| MCP server (`nuworq mcp`) | Claude Code, Codex, opencode, Goose, Cline, LM Studio, any MCP client, including open-weight models (verified: opencode 1.18 + Qwen3 27B on Ollama; see [docs/OPEN-WEIGHT.md](docs/OPEN-WEIGHT.md)) |
| CLI (`nuworq checkin --as name …`) | Any agent with a shell |
| HTTP + tool schemas (`/api/tools?format=openai\|anthropic\|mcp`) | Your own agent loop |
| Headless worker | `nuworq worker --agent claude\|codex\|opencode --run`, from anywhere: the hub routes it to the most valuable waiting work, in its own git worktree (each item gets its own branch, cut from the latest main), with a scoped tool allowlist |
| Runner | `nuworq run --workers N`: keeps up to N headless workers on projects you opted in, one per waiting item, never a herd on one |

The MCP server delivers the agent guide as its instructions, so an agent knows the protocol without being told. Read it with `nuworq guide`, or at `/agents.md`.

### Operators (so "Needs you" is only decisions)
Much of what used to reach you needed a capable session, not a decision: running `claude`, the project's live infrastructure, GitHub admin, a real browser. An **operator** does that: an attended Claude Code session in the project folder, running with your permissions and safety checks.
- It checks in with `has: ["operator", …]` plus the capabilities it really has: `claude-cli`, `infra`, `github-admin`, `browser`. `infra` is the live infrastructure of the project the session checked in to: servers and VMs, DNS, cloud accounts and deploys. Items whose `needs` include `operator`, `claude-cli`, `infra` or `github-admin` are offered only to it. (`nuworq-infra` and `homelab-vm`, the old names, are still accepted and stored as `infra`.)
- Agents ask questions about running things, permissions or verifying on real infrastructure with `to: "operator"`; the operator answers them instead of you.
- It escalates to you only when its own safety check needs your approval (risky or irreversible actions, product judgment): one precise question, with the evidence attached.
- If work needs an operator capability and no operator connected in the last day, "Worth knowing" tells you to start one.

Keep one running by opening Claude Code in the project folder (the terminal or the desktop app's Code tab) and typing:
```
/nuworq-operator <your capabilities>
```
`nuworq operator --project <project>` prints that line with this machine's capabilities filled in (`--has a,b` to choose them yourself). With the plugin it is also `/nuworq:nuworq-operator`.

No /loop. The session works until nothing waits, then goes idle and spends nothing. The skill starts a listener, `nuworq wait --operator --follow`: the plugin's monitor, or the Monitor tool when none is running (the skill checks with `pgrep`). It holds one open request to the hub, and each new operator item, operator question, or answer to the operator's own question prints a line ("nuworq: operator work waiting (#219). Run next.") that starts a turn on its own. Lines carry ids and kinds only, never text other agents wrote. It listens to the project of the folder it runs in (`--project p` names another, `--all-projects` takes every one), and it skips answers a checkin already delivered. Only a person invokes the skill, so worker sessions never listen.

The plugin's monitor starts only in Claude Code 2.1.105 or newer, in an interactive session (not `claude -p`), with the workspace trusted. If no "nuworq operator listener" appears, `claude --debug` shows why; the skill starts one with the Monitor tool meanwhile.

---

## 30 minutes

### Architecture
```
bin/nuworq.js      CLI: serve, token, status, all agent ops, mcp, guide, tools, prompt, init
src/core.js        state and every operation (agent + human). The single source of truth.
src/insight.js     the 0-30-5-30 lens: attention engine, pulse, flow and time accounting, views
src/protocol.js    the agent protocol, defined once → MCP tools, OpenAI/Anthropic schemas, the guide
src/server.js      HTTP API, SSE live updates, static UI, auth enforcement, security headers
src/auth.js        human/agent tokens (hashed), sessions
src/notify.js      push channels (ntfy, Slack, webhook): new act-level entries, batched, each sent once
src/github.js      signed GitHub webhook: PRs link to items, CI results per head commit
src/mcp.js         stdio MCP server (one process per agent session) → HTTP
src/client.js      hub/project/token resolution for CLI and MCP
src/names.js       the new names, and the old Trellis ones still read (env, config file, data folder)
src/runner.js      nuworq run: which workers to start (pure plan) and the supervising loop
src/usage.js       tokens and cost: reading them from agent CLIs' JSON output, splitting a run across items
src/llmproxy.js    measured usage from llm-proxy (NUWORQ_LLM_PROXY_URL/_KEY) for each agent's lease windows; supersedes reported
scripts/           live-opencode.mjs: an open-weight model works one item against a throwaway hub
src/seed.js        the demo, replayed through real operations on a moved clock
web/               the UI: no framework, one delegated event handler
deploy/, docs/     Dockerfile, compose, systemd unit, Caddyfile, DEPLOY.md
```
Storage is one SQLite file (Node's built-in `node:sqlite`, WAL). Every stage change is recorded in `transitions`; every event is layered text in `events`.

### The agent protocol (15 operations)
`checkin` · `next` · `claim` · `progress` · `ask` · `submit` · `handoff` · `propose` · `refine` · `review` · `comment` · `ack` · `learn` · `look` · `signoff`

Design choices:
- **Steering piggybacks on every response.** Agents don't poll; whatever they call next carries it.
- **Forgiving inputs.** An over-long headline is trimmed, with the overflow moved to the summary. Progress from an agent that lost its lease is kept as a comment. Every error carries a `hint` that says what to do instead.
- **Finish before starting.** `next` prefers peer reviews (in *Run with it*), then priority (effective priority: an item ranks at least as high as its milestone (or any item it is part of) and as any open item waiting on it, e.g. "now (from #110)"; its own priority stays as set), then work needing what the agent's machine has (few agents can take it), then work you touched before.
- **No configuration.** `nuworq serve` writes `~/.nuworq/hub.json`, so clients on the machine find the hub. A project learns which folder it lives in, and which git repository it is (the normalized `origin` remote, e.g. `github.com/acme/api`), the first time an agent checks in from it. You can also set both in the UI. Every worktree of a repo, and every clone of it on any machine, maps to the same project: the remote is matched first, then the folder.
- **Collision awareness.** `touching` paths on claim/progress. Agents get a `heads_up` when they overlap, and you see it in "In motion".
- **Authority.** Only steering and decisions come from you. The guide tells agents to treat field notes, handoffs and comments as information, not instructions.

### Attention engine (what reaches "Needs you")
| Signal | Level |
|---|---|
| Nothing moving, ideas waiting, no pick yet: "What matters most?" | act |
| Work waiting but no agent connected (unless parked) | act |
| Blocking question | act |
| Finished work waiting for your verdict | act (no-evidence warning) |
| CI failing on a PR for work in Verifying (GitHub webhook) | act |
| Proposal, when autonomy is *Check with me* | act |
| An item that keeps bouncing (send-backs + stalls ≥ 2) | act: clarify, split or drop |
| An agent's assumption | know: Confirm / Override (an override becomes steering) |
| New agent proposals | know |
| Steering nobody acknowledged | know |
| Agents out of work (everything left waits on you) | know |
| A push channel is failing | know |
| Healthy work, recovered stalls | 0 |

### API
For other tools, the published contract is [docs/API.md](docs/API.md) (e.g. outcomes per item and model); the rest can change.
```
GET  /api/projects                       pulse per project
GET  /api/p/:project/outcomes            finished work: landed/dropped, sent back, stalls, cycle time, tokens (docs/API.md)
GET  /api/p/:project/view                everything the UI shows
GET  /api/p/:project/items/:n            one item, lifecycle, timeline
POST /api/p/:project/agent/:op           agent operations (header x-nuworq-agent: <name>)
POST /api/p/:project/human/:action       answer, confirm, accept, sendback, steer, decide, comment,
                                         create, update, retire, unretire, dismiss, seen, settings
GET  /api/route[?runner=1]               where work is waiting, per project (runner: opted-in only, with holders)
GET  /api/claims?agent=<name>&since=<ms> how many jobs a worker took since then (runner: did a quick exit do anything?)
POST /api/runner                         nuworq run's state, every poll: { name, machine, running, workers,
                                         skipping: [{project, reason, until?}], paused: {until, reason}|null,
                                         spent, poll_seconds, stopped? }. Agent tokens may post it; a runner
                                         token's name wins. Bookkeeping, not presence. Silent for 3 polls: down.
GET  /api/tools?format=mcp|openai|anthropic
GET  /agents.md?project=<p>&via=tools|cli
GET  /api/stream                         server-sent events
GET  /api/notify | POST /api/notify {kind,url} | POST /api/notify/remove {id} | POST /api/notify/weekly {id,weekly} | POST /api/notify/test
                                         push channels (human only; URLs come back masked)
POST /api/hooks/github/:project          GitHub webhook (signed with the project's secret; see docs/DEPLOY.md)
```

### Security
Loopback is open. Anything else needs tokens: *human* tokens log in to the UI, *agent* tokens can only do agent operations. People can also sign in with GitHub or Google when the hub host sets them up (`NUWORQ_GITHUB_CLIENT_ID`/`_SECRET`, `NUWORQ_GOOGLE_CLIENT_ID`/`_SECRET`): a verified email that matches a person, or an invite to that email, gets in. There are also CSRF and origin checks, DNS-rebinding protection, rate-limited login, CSP and a body-size limit. See [docs/DEPLOY.md](docs/DEPLOY.md) for homelab and internet setups, serving many isolated workspaces from one hub (`serve --workspaces`: one SQLite file each, by subdomain or `/w/<name>/`), and an honest threat model.

### Tests
`npm test` covers leases, steering, parking and answers, assumptions and overrides, peer-review rules, layered text, the HTTP errors, MCP over stdio, the CLI end to end, and the auth model.

### Where it could go next
What's next lives on the hub, as proposals in the `nuworq` project, not in this file (it went stale here: races, routing by fit, git and PR links, cost per item and phone push all exist now).
