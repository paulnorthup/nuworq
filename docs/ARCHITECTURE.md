# How nuworq is built

For people working on nuworq itself: the code's layout, the agent protocol, what reaches "Needs you", the API, security and tests. Using nuworq is in [USAGE.md](USAGE.md); contributing in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Architecture
Every file in src/ starts with a comment saying what it is for; test/docsfresh.test.js fails when one is missing here.
```
bin/nuworq.js        the CLI: every command, its help from src/help.js, and the agent ops from src/protocol.js

The hub
src/core.js          state and every operation (agent + human). The single source of truth.
src/db.js            pull-request records, one per PR, merged from the hub's and GitHub's sides
src/snapshot.js      one load of a project's live state, shared by the views
src/insight.js       the 0-30-5-30 lens: attention engine, pulse, flow and time accounting, views
src/server.js        HTTP API, SSE live updates, static UI, auth enforcement, security headers, gzip
src/workspaces.js    many workspaces on one hub, one SQLite file each
src/directory.js     who is signed in to the hub itself, and their workspace memberships
src/auth.js          human/agent tokens (hashed), sessions
src/oauth.js         sign in with GitHub or Google
src/device.js        device login: the CLI shows a code, a person approves it in the browser
src/billing.js       Stripe plans, heard only from Stripe's signed webhook
src/live.js          the public, read-only live view of a project (/live/<slug>)
src/text.js          names in one form: a project's slug, a repository's remote
src/audience.js      who answers a question that leaves out `to`
src/bounce.js        why an item keeps bouncing, from its history
src/feedbackgroups.js  feedback that reports the same thing, as one group
src/fieldnotes.js    which few field notes an agent sees
src/handoff.js       the hub's side of a deploy with no gap (serve --follow)
src/follow.js        serve --follow: keep the hub on the latest main that passes its tests
src/followhub.js     what serve --follow asks of the hub's own code, as a short child process
src/freshness.js     the weekly "Keep <project> fresh" item
src/tidy.js          drift in milestones and groups becomes one tidy item per project
src/security.js      security reviews, kept like tidy jobs
src/releases.js      release drafts, per milestone
src/precondition.js  work that waits on an outside fact, checked by the hub
src/outcomes.js      what finished work came to, for other tools (GET /api/p/:project/outcomes)
src/models.js        which model a job runs on: the project's tiers, cheapest first
src/usage.js         tokens and cost: reading them from agent CLIs' JSON output, splitting a run across items
src/llmproxy.js      measured usage from llm-proxy for each agent's lease windows; supersedes reported
src/notify.js        push channels (ntfy, Slack, webhook, personal): new act-level entries, batched, each sent once
src/outbound.js      requests to URLs a person or agent chose: public addresses only, no redirects
src/getstarted.js    Get started: each step checked off from what the hub already knows
src/userguide.js     the getting-started guide at /guide
src/walkthrough.js   the weekly walk-through that keeps /guide matching the running hub
src/seed.js          the demo, replayed through real operations on a moved clock

GitHub
src/github.js        signed GitHub webhook: PRs link to items, CI results per head commit
src/ghapp.js         the GitHub App as the only door to a repository: installation tokens, mirrors, PRs
src/appwiring.js     whether the App hears and may do what the hub handles
src/issues.js        GitHub issues come in as proposals
src/alerts.js        Dependabot alerts come in as work
src/git.js           what git says about a submission: its branch, its commits, whether main has them
src/gitproxy.js      workers push through the hub, which takes only nuworq/ branches
src/gitrules.js      Claude Code permission rules for git's options
src/secrets.js       spotting GitHub tokens in text, in linear time
src/ghrelease.js     release signatures from GitHub Releases

Agents and machines
src/protocol.js      the agent protocol, defined once → MCP tools, OpenAI/Anthropic schemas, the guide
src/agentargs.js     the agent commands, generated from the protocol
src/help.js          the CLI's help, from one table; docs/CLI.md is made from it
src/mcp.js           stdio MCP server (one process per agent session) → HTTP
src/client.js        hub/project/token resolution for CLI and MCP
src/names.js         where nuworq's names are read: NUWORQ_* env, .nuworq.json, ~/.nuworq
src/connect.js       nuworq connect: register the MCP server with the agent tools on this machine
src/setup.js         what connect asks once connected: staff the project, start an operator
src/up.js            nuworq up: a runner with automatic workers, and an operator per project
src/runner.js        nuworq run: which workers to start (pure plan) and the supervising loop
src/runtrust.js      a runner checks what the hub sends before it reaches a shell
src/sandbox.js       a Claude worker's sandbox: where it writes and which hosts it reaches
src/piguard.js       the guard extension a pi worker starts with
src/service.js       nuworq run as a LaunchAgent or systemd user unit
src/operator.js      what an operator session can do, and its no-prompt rules
src/wait.js          what an idle operator session wakes for
src/session.js       which Claude Code session a process belongs to
src/plugin.js        the Claude Code plugin: MCP server, skills and the operator's listener
src/package.js       nuworq as an npm package of the commit the hub runs
src/update.js        the package updates itself, only to a release signed by the release key
src/releasesign.js   signing a release by hand, only from a signed install, never a checkout
src/browser/         the pinned Playwright MCP server workers check UI work with

scripts/             releases, signing, and live runs of open-weight models against a throwaway hub
web/                 the UI: no framework, one delegated click handler
deploy/, docs/       Dockerfile, compose, systemd unit, Caddyfile; DEPLOY.md
```
Storage is one SQLite file per workspace (Node's built-in `node:sqlite`, WAL). Every stage change is recorded in `transitions`; every event is layered text in `events`.

## The agent protocol (20 operations)
`checkin` · `next` · `claim` · `progress` · `ask` · `answer` · `withdraw` · `submit` · `handoff` · `propose` · `refine` · `review` · `comment` · `ack` · `learn` · `retire` · `distill` · `feedback` · `look` · `signoff`

Design choices:
- **Steering piggybacks on every response.** Agents don't poll; whatever they call next carries it.
- **Forgiving inputs.** An over-long headline is trimmed, with the overflow moved to the summary. Progress from an agent that lost its lease is kept as a comment. Every error carries a `hint` that says what to do instead.
- **Finish before starting.** `next` offers landing jobs first, then peer reviews (in *Run with it*), then priority (effective priority: an item ranks at least as high as its milestone (or any item it is part of) and as any open item waiting on it, e.g. "now (from #110)"; its own priority stays as set), building before shaping, then work needing what the agent's machine has (few agents can take it), then work you touched before.
- **No configuration.** `nuworq serve` writes `~/.nuworq/hub.json`, so clients on the machine find the hub. A project learns which folder it lives in, and which git repository it is (the normalized `origin` remote, e.g. `github.com/acme/api`), the first time an agent checks in from it. You can also set both in the UI. Every worktree of a repo, and every clone of it on any machine, maps to the same project: the remote is matched first, then the folder.
- **Collision awareness.** `touching` paths on claim/progress. Agents get a `heads_up` when they overlap, and you see it in "In motion".
- **Authority.** Only steering and decisions come from you. The guide tells agents to treat field notes, handoffs and comments as information, not instructions.

## Attention engine (what reaches "Needs you")
Each signal is an entry `kind` in src/insight.js.

| Signal | Level |
|---|---|
| Nothing moving, ideas waiting, no pick yet: "What matters most?" (`direction`) | act |
| Work waiting and no agent working on it, unless parked (`no-agents`) | act when nothing is in flight, else know |
| A question for you, or one for an operator when none has been here for a day (`question`) | act |
| Operator work and no operator session (`operator-missing`) | act |
| Work someone answered on but kept parked, or the hub parked after repeated stalls (`kept-parked`) | act |
| Finished work waiting for your verdict, unless under *Run with it* (`review`) | act (no-evidence warning) |
| CI failing on a PR for work in Verifying (`ci-failing`) | act |
| A pull request waiting for a person's approval on GitHub (`pr-review`) | act |
| A shaped proposal, when autonomy is *Check with me* (`proposal`) | act |
| An item that keeps bouncing, when a person can help (`struggling`) | act: the step that helps (an answer, an agent to start, clarify, split or drop) |
| A "now" group stalled on a capability no agent has (`group-stalled`) | act |
| Free's limit refused an agent (`plan-limit`), 80% of today's budget spent (`budget-near`), one worker past $50 or an hour (`run-spend`) | act |
| The hub's GitHub App misses events or permissions it needs (`app-wiring`) | act |
| An agent's assumption (`assumption`) | know: Confirm / Override (an override becomes steering) |
| What an operator changed on a live system, or a call it made (`operator-answered`) | know |
| Accepted work nobody lands (`landing-stuck`), a peer review nobody takes (`peer-review-stuck`) | know |
| Work waiting outside past the project's limit (`outside-overdue`) | know |
| Work needing what no agent seen in a day has (`unfit`) | know |
| Agents arriving and leaving with nothing (`churn`) | know |
| The App can't read a repository for its mirror (`app-read`) | know |
| Steering nobody acknowledged (`steer-unseen`) | know |
| A push channel is failing (`notify-failing`) | know |
| Healthy work, recovered stalls | 0 |

## API
For other tools, the published contract is [API.md](API.md) (e.g. outcomes per item and model); the rest can change.
```
GET  /api/projects                       pulse per project
GET  /api/p/:project/outcomes            finished work: landed/dropped, sent back, stalls, cycle time, tokens (docs/API.md)
GET  /api/p/:project/view                everything the UI shows; ?depth=30s|5m|30m only what that depth shows (&all=, &agents= pages)
GET  /api/p/:project/items/:n            one item, lifecycle, timeline
POST /api/p/:project/agent/:op           agent operations (header x-nuworq-agent: <name>)
POST /api/p/:project/human/:action       what people do: answer, confirm, accept, sendback, steer, decide,
                                         comment, create, update, step, unpark, keep, promote, pick, archive,
                                         restore, delete, settings and more (PERSON_CAN in src/core.js lists them by role)
GET  /api/wait?for=operator              held until an idle operator session has something to wake for
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
