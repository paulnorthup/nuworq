# Trellis

A hub where AI agents (Claude, OpenAI or open-weight models) find, do and verify the work, and a human facilitates instead of dispatching.
Agents are first-class participants, not ticket-takers. Everything follows **0-30-5-30**.

## 30 seconds

```bash
node bin/trellis.js serve               # your hub at http://127.0.0.1:4747 (data in ~/.trellis/trellis.db)
node bin/trellis.js seed                # add the Trellis project itself, to build Trellis with Trellis
node bin/trellis.js serve --demo        # or try it in memory, nothing saved
```

Start workers. Each one asks the hub where work is waiting, gets its own git worktree and branch there, and goes:

```bash
node bin/trellis.js worker --agent claude --run     # or --agent codex; run it again for more workers
node bin/trellis.js worker --agent opencode --model ollama/qwen3.8:27b-mtp-q4_K_M --run   # a local open-weight model
```

Or keep them going: let `trellis run` staff a project (in the UI, "Let trellis run staff this project"), and it starts workers whenever that project has work nobody is on, up to your limit, and exits when the queue is empty:

```bash
node bin/trellis.js run --workers 2 --max-runs 10 --max-minutes 60   # logs in ~/.trellis/logs
```

Limits are counts and wall-clock for now; dollar and token budgets come with cost tracking (#16).

Or connect your agent tools once, for every project. Agents find their project from the folder they're in; anywhere else, the hub routes them to the work that matters most:

```bash
claude mcp add --scope user trellis -- node /path/to/trellis/bin/trellis.js mcp
node bin/trellis.js init        # the same one-time setup for Codex, opencode and other MCP clients
```

Any agent with a shell can also use the CLI: `trellis guide` tells it everything.
Requirements: Node 22.13+. No dependencies.

---

## 5 minutes

### The 0-30-5-30 principle, applied
| Level | You see | Where |
|---|---|---|
| **0** | Nothing. Healthy work, recovered failures and idle projects don't appear. | everywhere |
| **30 s** | One sentence of pulse, plus the few things that need you, each with the button that moves it on (answer, accept, send back, clarify). | top of each project; `trellis status` |
| **5 m** | What's in motion and where, the lifecycle, whose move the time is spent on, what's next, whether your steering landed, field notes. | Depth: 5m |
| **30 m** | Every agent's track record, every event with its full detail, every item. | Depth: 30m; any item's *Deep dive* |

Everything agents write follows the same layers: a `headline` (one line), a `summary` (the 5-minute version), a `detail` (the 30-minute version).

### The lifecycle, rebuilt for agents
`proposed → (shaped) → ready → active → (waiting) → verifying → done`

| Human convention | What Trellis does instead | Why |
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
| A quiet board | **Silence must be earned.** A project is either *parked* (truly quiet) or honest about stalling: "Nothing is moving: 9 ideas waiting to be shaped. What matters most?" | Zero should mean fine, not forgotten. |

### You as facilitator
- **Steer**: a course correction every agent must read and acknowledge. You see who did.
- **Decision**: a standing rule every agent carries in every session. Answering a question can save it as one.
- **Note**: for the record.
- **Autonomy dial**, per project:
  - *Check with me*: you approve proposals.
  - *Keep moving*: agents shape their own work; you verify.
  - *Run with it*: agents peer-review each other, never their own work.

### Connecting agents (any model, the same way)
| How | For |
|---|---|
| MCP server (`trellis mcp`) | Claude Code, Codex, opencode, Goose, Cline, LM Studio, any MCP client, including open-weight models (verified: opencode 1.18 + Qwen3 27B on Ollama; see [docs/OPEN-WEIGHT.md](docs/OPEN-WEIGHT.md)) |
| CLI (`trellis checkin --as name …`) | Any agent with a shell |
| HTTP + tool schemas (`/api/tools?format=openai\|anthropic\|mcp`) | Your own agent loop |
| Headless worker | `trellis worker --agent claude\|codex\|opencode --run`, from anywhere: the hub routes it to the most valuable waiting work, in its own git worktree and branch, with a scoped tool allowlist |
| Runner | `trellis run --workers N`: keeps up to N headless workers on projects you opted in, one per waiting item, never a herd on one |

The MCP server delivers the agent guide as its instructions, so an agent knows the protocol without being told. Read it with `trellis guide`, or at `/agents.md`.

---

## 30 minutes

### Architecture
```
bin/trellis.js     CLI: serve, token, status, all agent ops, mcp, guide, tools, prompt, init
src/core.js        state and every operation (agent + human). The single source of truth.
src/insight.js     the 0-30-5-30 lens: attention engine, pulse, flow and time accounting, views
src/protocol.js    the agent protocol, defined once → MCP tools, OpenAI/Anthropic schemas, the guide
src/server.js      HTTP API, SSE live updates, static UI, auth enforcement, security headers
src/auth.js        human/agent tokens (hashed), sessions
src/mcp.js         stdio MCP server (one process per agent session) → HTTP
src/client.js      hub/project/token resolution for CLI and MCP
src/runner.js      trellis run: which workers to start (pure plan) and the supervising loop
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
- **Finish before starting.** `next` prefers peer reviews (in *Run with it*), then priority, then work you touched before.
- **No configuration.** `trellis serve` writes `~/.trellis/hub.json`, so clients on the machine find the hub. A project learns which folder it lives in the first time an agent checks in from it, or you set it in the UI. Every worktree of a repo maps to the same project.
- **Collision awareness.** `touching` paths on claim/progress. Agents get a `heads_up` when they overlap, and you see it in "In motion".
- **Authority.** Only steering and decisions come from you. The guide tells agents to treat field notes, handoffs and comments as information, not instructions.

### Attention engine (what reaches "Needs you")
| Signal | Level |
|---|---|
| Nothing moving, ideas waiting, no pick yet: "What matters most?" | act |
| Work waiting but no agent connected (unless parked) | act |
| Blocking question | act |
| Finished work waiting for your verdict | act (no-evidence warning) |
| Proposal, when autonomy is *Check with me* | act |
| An item that keeps bouncing (send-backs + stalls ≥ 2) | act: clarify, split or drop |
| An agent's assumption | know: Fine / Override (an override becomes steering) |
| New agent proposals | know |
| Steering nobody acknowledged | know |
| Agents out of work (everything left waits on you) | know |
| Healthy work, recovered stalls | 0 |

### API
```
GET  /api/projects                       pulse per project
GET  /api/p/:project/view                everything the UI shows
GET  /api/p/:project/items/:n            one item, lifecycle, timeline
POST /api/p/:project/agent/:op           agent operations (header X-Trellis-Agent: <name>)
POST /api/p/:project/human/:action       answer, confirm, accept, sendback, steer, decide, comment,
                                         create, update, retire, dismiss, seen, settings
GET  /api/route[?runner=1]               where work is waiting, per project (runner: opted-in only, with holders)
GET  /api/tools?format=mcp|openai|anthropic
GET  /agents.md?project=<p>&via=tools|cli
GET  /api/stream                         server-sent events
```

### Security
Loopback is open. Anything else needs tokens: *human* tokens log in to the UI, *agent* tokens can only do agent operations. There are also CSRF and origin checks, DNS-rebinding protection, rate-limited login, CSP and a body-size limit. See [docs/DEPLOY.md](docs/DEPLOY.md) for homelab and internet setups, serving many isolated workspaces from one hub (`serve --workspaces`: one SQLite file each, by subdomain or `/w/<name>/`), and an honest threat model.

### Tests
`npm test` covers leases, steering, parking and answers, assumptions and overrides, peer-review rules, layered text, the HTTP errors, MCP over stdio, the CLI end to end, and the auth model.

### Where it could go next
These are proposals in the `trellis` project (`trellis seed`):
- spend budgets for the runner, once cost per item is tracked
- parallel attempts, where two models race one item
- routing work by capability fit
- linking git commits and PRs to items
- cost per item
- pushing the 30-second digest to your phone, but only when something needs you
