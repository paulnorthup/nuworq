# How nuworq is built

For people working on nuworq itself: the code's layout, the agent protocol, what reaches "Needs you", the API, security and tests. Using nuworq is in [USAGE.md](USAGE.md); contributing in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Architecture
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
src/names.js       where nuworq's names are read: NUWORQ_* env, .nuworq.json, ~/.nuworq
src/runner.js      nuworq run: which workers to start (pure plan) and the supervising loop
src/usage.js       tokens and cost: reading them from agent CLIs' JSON output, splitting a run across items
src/llmproxy.js    measured usage from llm-proxy (NUWORQ_LLM_PROXY_URL/_KEY) for each agent's lease windows; supersedes reported
scripts/           live-opencode.mjs, live-pi.mjs: an open-weight model works one item against a throwaway hub
src/seed.js        the demo, replayed through real operations on a moved clock
web/               the UI: no framework, one delegated event handler
deploy/, docs/     Dockerfile, compose, systemd unit, Caddyfile, DEPLOY.md
```
Storage is one SQLite file (Node's built-in `node:sqlite`, WAL). Every stage change is recorded in `transitions`; every event is layered text in `events`.

## The agent protocol (15 operations)
`checkin` · `next` · `claim` · `progress` · `ask` · `submit` · `handoff` · `propose` · `refine` · `review` · `comment` · `ack` · `learn` · `look` · `signoff`

Design choices:
- **Steering piggybacks on every response.** Agents don't poll; whatever they call next carries it.
- **Forgiving inputs.** An over-long headline is trimmed, with the overflow moved to the summary. Progress from an agent that lost its lease is kept as a comment. Every error carries a `hint` that says what to do instead.
- **Finish before starting.** `next` prefers peer reviews (in *Run with it*), then priority (effective priority: an item ranks at least as high as its milestone (or any item it is part of) and as any open item waiting on it, e.g. "now (from #110)"; its own priority stays as set), then work needing what the agent's machine has (few agents can take it), then work you touched before.
- **No configuration.** `nuworq serve` writes `~/.nuworq/hub.json`, so clients on the machine find the hub. A project learns which folder it lives in, and which git repository it is (the normalized `origin` remote, e.g. `github.com/acme/api`), the first time an agent checks in from it. You can also set both in the UI. Every worktree of a repo, and every clone of it on any machine, maps to the same project: the remote is matched first, then the folder.
- **Collision awareness.** `touching` paths on claim/progress. Agents get a `heads_up` when they overlap, and you see it in "In motion".
- **Authority.** Only steering and decisions come from you. The guide tells agents to treat field notes, handoffs and comments as information, not instructions.

## Attention engine (what reaches "Needs you")
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

## API
For other tools, the published contract is [API.md](API.md) (e.g. outcomes per item and model); the rest can change.
```
GET  /api/projects                       pulse per project
GET  /api/p/:project/outcomes            finished work: landed/dropped, sent back, stalls, cycle time, tokens (docs/API.md)
GET  /api/p/:project/view                everything the UI shows; ?depth=30s|5m|30m only what that depth shows (&all=, &agents= pages)
GET  /api/p/:project/items/:n            one item, lifecycle, timeline
POST /api/p/:project/agent/:op           agent operations (header x-nuworq-agent: <name>)
POST /api/p/:project/human/:action       answer, confirm, accept, sendback, steer, decide, comment,
                                         create, update, retire, unretire, dismiss, seen, settings
GET  /api/route[?runner=1]               where work is waiting, per project (runner: opted-in only, with holders)
                                         &wait=<s>&skip=<projects>: held until work appears outside skip (≤90 s)
                                         &jobs=<n>: each project's top n claimable items as jobs, one per worker
GET  /api/claims?agent=<name>&since=<ms> how many jobs a worker took since then (runner: did a quick exit do anything?)
                                         &project=<slug>&item=<#n>: taken_by, who else took that item (a lost race)
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

## Security
Loopback is open. Anything else needs tokens: *human* tokens log in to the UI, *agent* tokens can only do agent operations. People can also sign in with GitHub or Google when the hub host sets them up (`NUWORQ_GITHUB_CLIENT_ID`/`_SECRET`, `NUWORQ_GOOGLE_CLIENT_ID`/`_SECRET`): a verified email that matches a person, or an invite to that email, gets in. There are also CSRF and origin checks, DNS-rebinding protection, rate-limited login, CSP and a body-size limit. See [DEPLOY.md](DEPLOY.md) for homelab and internet setups, serving many isolated workspaces from one hub (`serve --workspaces`: one SQLite file each, by subdomain or `/w/<name>/`), and an honest threat model.

## Tests
`npm test` covers leases, steering, parking and answers, assumptions and overrides, peer-review rules, layered text, the HTTP errors, MCP over stdio, the CLI end to end, and the auth model.

## Where it could go next
What's next lives on the hub, as proposals in the `nuworq` project, not in this file (it went stale here: races, routing by fit, git and PR links, cost per item and phone push all exist now).
