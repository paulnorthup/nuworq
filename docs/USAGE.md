# Using nuworq

Everything about setting up and running nuworq, in 0-30-5-30 layers: the 30-second setup, then the 5-minute picture. The step-by-step version for a newcomer is the [getting-started guide](https://app.nuworq.com/guide); how nuworq is built is in [ARCHITECTURE.md](ARCHITECTURE.md).

## 30 seconds

Set up a machine against your hub, once. Its "Connect an agent" dialog gives these lines with its own address, ready to copy. First install nuworq: the newest signed release from the hub (public, no login), with its signature checked against nuworq's release key before anything installs:

```bash
curl -fsSLO https://app.nuworq.com/nuworq-release.tgz -O https://app.nuworq.com/nuworq-release.tgz.sig
node -e 'const c=require("crypto"),f=require("fs"),[t,k]=process.argv.slice(1);if(!c.verify(null,f.readFileSync(t),{key:Buffer.from(k,"base64"),format:"der",type:"spki"},Buffer.from(f.readFileSync(t+".sig","utf8"),"base64"))){console.error(t+" is NOT signed by the nuworq release key: do not install it");process.exit(1)}console.log(t+": signature verified")' nuworq-release.tgz MCowBQYDK2VwAyEAJQ7A3vdaH6Jw6uMtk0RZ/FqXzHXAI2lGQ6HILx1Z14w=
npm install -g ./nuworq-release.tgz
```

The last word of the second line is the release key (`release-key.pub` in this repository). If the check says NOT signed, stop: don't run the third line. From then on the install pins that key and updates itself only to releases signed with it. Then:

```bash
nuworq connect https://nuworq.com/w/acme         # browser login, saves the token, registers Claude Code and Codex
```

### Recommended setup

Three sessions, each where it works best. It's how nuworq itself is built. Starting with just a shaper is fine. Add workers and an operator once there's work for them. The operator and the shaper are Claude Code with the nuworq plugin (below), which `connect` offers to install.

1. **Shape work with a shaper.** A shaper is Claude Code in the Claude Code app. You tell it what you want and why; it talks it through, recommends milestones and their parts, and proposes them once you agree. You decide; it never decides for you. It's the session you read and talk in, and the app is made for reading and talking. Open the project's folder in the Claude Code app's Code tab, then type `/nuworq:shaper`.

2. **Start workers.** Workers build, review and land the work. They run in the background with no window, each in its own copy of your repository, so they never touch your files. They work only on the projects you let them. As a service they keep going after you close the terminal, and after a restart. In a clone of the project, run:

   ```bash
   nuworq run --install --workers auto
   ```

3. **Start an operator.** An operator is Claude Code in a terminal, acting with your access. It does the work workers aren't allowed to do. It answers the questions workers send it, lands their work, and runs the steps on real systems. It asks you only for what it can't do itself. In its own terminal, it never interrupts your conversation with the shaper. `nuworq up` starts one for each project that doesn't have one yet. Or, in the project's folder, run `claude`, then type `/nuworq:operator` (`nuworq operator --start` does both).

`nuworq run --workers 3 --agent claude` keeps workers going in this terminal instead, until Ctrl-C. Or, after connecting, one command brings it all up and keeps it up: `nuworq up` makes sure one runner runs here as a service with `--workers auto --browser` (installed if there is none, restarted if its flags differ; `--no-browser` leaves the browser out, and is remembered), asks once whether workers may take the work of each project they aren't on yet (a no is remembered), and opens an operator (Claude Code with `/nuworq:operator`) in its own terminal for each project that isn't parked (paused in its Settings) and has none: in tmux, a terminal that keeps running after you close its window, when it is installed (`tmux attach -t nuworq`, a window per project), else a Terminal or iTerm window on a Mac, else it prints the commands. A project with no clone here is skipped, with where to clone it. Run it again any time, after a restart too: it starts only what is missing, and ends with a table of each project, its operator and the runner. `nuworq up --dry-run` prints that table and does nothing; `nuworq down` stops the operators it started and the runner service.

`run` keeps workers on the projects you let it staff ("Staff it with nuworq run" in the UI, or `nuworq staff <project>`), one per waiting item. Add `--browser` for workers that check UI work. Each worker gets its own git worktree (each item it takes gets its own branch, cut from the latest main). `nuworq worker --agent claude --run` starts a single one, and goes wherever work is waiting across projects; `--agent codex`, `--agent opencode --model ollama/qwen3.8:27b-mtp-q4_K_M` and `--agent pi --model ollama/qwen3.8:27b-mtp-q4_K_M` (a local open-weight model) work the same way, with `--can-read-keys`: only Claude workers are kept from your machine's keys. Codex's sandbox limits writes and network, not reads, and opencode and pi have no sandbox, so their workers also run only on projects without a remote. Workers run git and the project's checks (`npm test`, `npm ci`, its test, lint and build scripts, `pytest`, `cargo test`, `go test`); add other commands in the project's Settings, under Worker commands. A pi worker gets a config folder of its own (`~/.nuworq/pi/<worker>`), so none of your pi extensions, skills, MCP servers or sign-ins follow it in: give its provider key in the environment.

`nuworq run` also takes limits:

```bash
nuworq run --workers 2 --max-runs 10 --max-minutes 60   # logs in ~/.nuworq/logs
```

To keep a runner going after the terminal closes and across reboots, install it: `nuworq run --install --workers 2` writes a LaunchAgent (macOS, `~/Library/LaunchAgents/com.nuworq.run.plist`) or a systemd user unit (Linux, `~/.config/systemd/user/nuworq-run.service`) with those flags, starts it, and prints how to remove it (`nuworq run --uninstall`). Installing again replaces it; its log is `~/.nuworq/logs/run.log`. Install it from one of your checkouts: the service starts in that folder and looks for checkouts in the folder holding it (or in `NUWORQ_REPOS`, if you set it), as `nuworq run` typed there would, and install names any opted-in project it has no checkout of, with the clone command. When a worker exits, its worktree is removed, unless it holds uncommitted changes or commits on no branch; then run keeps it and says where. Its branch goes too once its item is done or dropped and all of it has landed: it is on origin, its item's pull request merged, or main has each of its commits' changes (`git cherry`, so a branch rebased before landing still goes). The hub deletes a landed item's branch on GitHub. Once a week run sweeps up the rest: worktrees and `nuworq/*` branches of finished items, worktrees with no branch left idle a day, and stale worktree records, never your own checkout or uncommitted or unlanded work (it names the commits main lacks). It first runs `git worktree repair`, so worktrees made before the checkout was moved are judged like the rest; one git still can't read is only reported, by its path. `nuworq run --sweep` does it now; add `--dry-run` to only list what would go.

Limits are counts, wall-clock and dollars: `--max-usd 5` stops launching once the workers' CLIs have reported $5 spent in this run, and lets running workers finish. Spend is known when a worker exits; codex and local models report no cost, so they don't count against it. A land job runs as a worker of its own with a short brief and a dollar cap, `--land-usd` ($2 unless set; `0` for none): Claude stops itself there, and the runner stops other agents once what they report passes it.

Each project's staffing is set on the hub, so you can change it from your phone, and every runner follows it at its next poll (the project page's **Staffing** link, or the `settings` fields `run_workers`, `run_paused`, `run_budget`). **Workers at once** caps the agents working there at the same time, across runners (blank: each runner's own `--workers`). **Pause** starts no new workers; running ones finish. **Daily budget** stops new workers once the project's recorded spend for the UTC day, from every runner and agent, reaches it, until the next day: workers already running take no new items then, only reviews of work already submitted. Turning staffing on sets it to $20 when none is set. A new project asks once whether `nuworq run` may staff it, and stays unstaffed until you say: workers cost money, so the default is off.

Claude workers ignore your own MCP servers and plugins: they load only the servers the runner gives them (nuworq, plus Playwright with `--browser`), every plugin installed on the machine is turned off for them, and no skills or slash commands load (not even those in `~/.claude/skills`, such as a `nuworq-operator` connect wrote there). A plugin or server of yours would otherwise follow into every worker's worktree, adding its tools and skills to each worker's context and, for the nuworq plugin, a second, unscoped nuworq identity beside the worker's own.

`--browser` (Claude workers, on `worker` or `run`) gives each worker a headless browser to check UI work with: Microsoft's Playwright MCP server (`@playwright/mcp`, pinned) driving your Google Chrome with a throwaway profile, opening only `localhost` and `127.0.0.1` pages. The worker runs the app from its worktree on a free port, looks at it at desktop width and 375px (the app is light only), and says what it saw in its evidence. It also declares `browser`, so items that need one go to it, ahead of generic work of the same priority.

What each item cost shows in its 30-minute view, per agent and model. Workers started with `--run` (or by `nuworq run`) report their CLI's own numbers when the agent exits, split across the items they worked on by time: `claude` (`--output-format stream-json`: tokens including cached input, and dollars), `codex` (`exec --json`: tokens only, so cost shows "—"), `opencode` (`--format json`: tokens and cost; a local Ollama model's cost shows "—"), `pi` (`--mode json`: tokens and cost from each assistant message; a local model's cost shows "—"). The readers follow those CLIs' JSON event formats; the tests use sample output in those shapes, not yet captures from live runs. Agents you run yourself can pass `usage` on progress, submit and handoff.

Claude Code takes nuworq best as one plugin: the MCP server, two commands a person types (`/nuworq:shaper` to shape work with you, `/nuworq:operator` to start an operator), and the skill an agent loads on its own when asked to work on nuworq, which stays out of the slash menu. On a clean machine, after installing nuworq as above, that is all of it:

```bash
claude plugin marketplace add paulnorthup/nuworq#release
claude plugin install nuworq@nuworq --scope user
```

Then connect with `nuworq connect https://nuworq.com/w/acme`, as above.

Then "work on X using nuworq" and "help me plan Y in nuworq" work in Claude Code. The plugin starts the server as `nuworq mcp`, so it needs nuworq installed as a package, and it holds no token: `connect` saves the connection the server reads. `connect` sees the plugin and leaves Claude Code to it (no second server or second copy of the skills), and removes what an earlier connect added there. It counts the plugin only when it is installed for your account: an install for some folders only gets the offer of the account-wide one. Beside the plugin, it also offers to remove the generated nuworq skills and a user-scope nuworq MCP server that an earlier nuworq left, recorded or not (`--yes` removes them without asking). Without the plugin, `connect` offers to install it; only if you decline (or pass `--skills`, or there's no terminal to ask at) does it add the server and write the skills into `~/.claude/skills` as `nuworq`, `nuworq-shaper` and `nuworq-operator`. The plugin folder (`plugin/`) is generated by `nuworq skill --plugin`, and a test fails if it drifts from the protocol.

The plugin installs from the `release` branch, never from `main`. Only the release signer moves that branch, to each release the maintainer approved and it signed (docs/DEPLOY.md, "Signed releases"), so a commit on `main` alone changes nothing on your machine. The marketplace entry points there too (`git-subdir`, ref `release`), so a marketplace added before this, without `#release`, also gets the plugin only from a release. It still reads that entry from `main`, though, so add it again with `#release` (`claude plugin marketplace remove nuworq`, then the two lines above) to stop following `main` at all. The plugin carries no version number, so each release is a new version to Claude Code. To update it:

```bash
claude plugin marketplace update nuworq
claude plugin update nuworq@nuworq   # add --scope local if you installed it that way
```

Then start a new Claude Code session, or run `/reload-plugins` in the one you have.

`connect` shows a code. You approve it in the browser, signed in as a member or above, and the machine gets its own agent token (`<you>@<machine>`). The token is saved in `~/.nuworq/connect.json`, which only you can read. `connect` then adds the nuworq MCP server to the agent tools it finds: Claude Code (`claude mcp add --scope user`), Codex (`~/.codex/config.toml`) opencode (`~/.config/opencode/opencode.json`) and pi (`pi mcp add nuworq --exposure direct`, in `~/.pi/agent/mcp.json`). It prints each change, leaves other entries alone, and puts no token in those configs. The CLI, the MCP server and `nuworq run` read the saved connection; `NUWORQ_URL` and `NUWORQ_TOKEN` still win. Connecting again revokes the old token. `--token <t>` skips the browser (`--token -` reads it from stdin), and `--no-mcp` leaves the tools alone. `disconnect` revokes the token on the hub, removes only the entries `connect` added, and deletes the file. Running it twice is harmless.

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
pi mcp add nuworq --exposure direct -- nuworq mcp   # pi 1.4+
nuworq init                                         # the same for opencode and other MCP clients
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.nuworq]
command = "nuworq"
args = ["mcp"]
default_tools_approval_mode = "approve"
```

Working on nuworq itself? See [CONTRIBUTING.md](../CONTRIBUTING.md).

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
`proposed → (shaped) → ready → (outside) → active → (waiting) → verifying → landing → done`, or `dropped` from any of them

`outside` waits on a fact outside the hub, `waiting` on a person's answer, `landing` is accepted work going onto main, and `done` means it is on main.

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
| MCP server (`nuworq mcp`) | Claude Code, Codex, opencode, pi, Goose, Cline, LM Studio, any MCP client, including open-weight models (verified: opencode 1.18 + Qwen3 27B on Ollama; see [OPEN-WEIGHT.md](OPEN-WEIGHT.md)) |
| CLI (`nuworq checkin --as name …`) | Any agent with a shell |
| HTTP + tool schemas (`/api/tools?format=openai\|anthropic\|mcp`) | Your own agent loop |
| Headless worker | `nuworq worker --agent claude\|codex\|opencode\|pi --run`, from anywhere: the hub routes it to the most valuable waiting work, in its own git worktree (each item gets its own branch, cut from the latest main), with a scoped tool allowlist |
| Runner | `nuworq run --workers N`: keeps up to N headless workers on projects you opted in, one per waiting item, never a herd on one |

The MCP server delivers the agent guide as its instructions, so an agent knows the protocol without being told. Read it with `nuworq guide`, or at `/agents.md`.

### Operators (so "Needs you" is only decisions)
Much of what used to reach you needed a capable session, not a decision: running `claude`, the project's live infrastructure, GitHub admin, a real browser. An **operator** does that: a Claude Code session you keep open in the project folder, acting with your access and safety checks.
- It checks in with `has: ["operator", …]` plus the capabilities it really has: `claude-cli`, `infra`, `github-admin`, `browser`. `infra` is the live infrastructure of the project the session checked in to: servers and VMs, DNS, cloud accounts and deploys. Items whose `needs` include `operator`, `claude-cli`, `infra` or `github-admin` are offered only to it. (`nuworq-infra` and `homelab-vm`, the old names, are still accepted and stored as `infra`.)
- Agents ask questions about running things, permissions or verifying on real infrastructure with `to: "operator"`; the operator answers them instead of you.
- It escalates to you only when its own safety check needs your approval (risky or irreversible actions, product judgment): one precise question, with the evidence attached.
- If work needs an operator capability and no operator connected in the last day, "Worth knowing" tells you to start one.

Keep one running by opening Claude Code in the project folder (the terminal or the desktop app's Code tab) and typing:
```
/nuworq:operator
```
Capabilities are optional. Left out, the session runs `nuworq operator --detect`, which proves each one on this machine: the OS, `claude-cli` when `claude` runs, `github-admin` when `gh` is admin on every repository of the project, `browser` when Chrome or Chromium is installed, and `infra` unless you set `--without infra` (or `--infra-check "<command>"`: then only while that check passes; it stays on this machine, and only you change it, at your terminal: --detect runs it). Its first line says what it declared and why. Typed capabilities (`/nuworq:operator macos,infra`, or `nuworq operator --has a,b`) replace the detection. Without the plugin it is `/nuworq-operator`.

`nuworq operator --start` opens Claude Code here with that line sent, and lets the operator's routine commands run without prompts: `nuworq`'s agent operations, `--detect`, `--check`, the listener and the guide, git, gh for reading, pull requests, runs and GET api calls, and ssh to the infra check's host. Force-pushes, deleting branches or tags, git options that run a program or write a file, other `nuworq` commands and gh writes still ask. For a session you start yourself, `nuworq operator --allow` adds the same rules to the project's `.claude/settings.local.json` after a yes, and `--allow --off` removes them.

No /loop. The session works until nothing waits, then goes idle and spends nothing. The skill starts a listener, `nuworq wait --operator --follow`: the plugin's monitor, or the Monitor tool when none is running (the skill checks with `pgrep`). It wakes only the session that started it: the MCP server and the listener both tell the hub which Claude Code session they belong to (hashed), so two operator sessions on one token don't wake each other. It holds one open request to the hub, and each new operator item, operator question, or answer to the operator's own question prints a line ("nuworq: operator work waiting (#219). Run next.") that starts a turn on its own. Lines carry ids and kinds only, never text other agents wrote. It listens to the project of the folder it runs in (`--project p` names another, `--all-projects` takes every one), and it skips answers a checkin already delivered. Only a person invokes the skill, so worker sessions never listen.

The plugin's monitor starts only in Claude Code 2.1.105 or newer, in an interactive session (not `claude -p`), with the workspace trusted. If no "nuworq operator listener" appears, `claude --debug` shows why; the skill starts one with the Monitor tool meanwhile.
