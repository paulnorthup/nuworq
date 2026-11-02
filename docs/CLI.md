# nuworq command reference

Generated from src/help.js with `nuworq help all --markdown > docs/CLI.md`; test/help.test.js fails when it is out of date. A bare `nuworq` prints the one-screen version, and `nuworq help <command>` one command.

## Get going

### nuworq connect

```text
nuworq connect: use a hub from this machine: sign in, save it, and give your
  agent tools its MCP server

Usage
  nuworq connect <url> [flags]
  nuworq connect <workspace> --hub <url> [flags]

Flags
  --hub <url>     the hub, when you give a workspace name
  --token <t>     use this token instead of signing in through the browser; -
                  reads one line (hidden)
  --no-browser    print the sign-in link and code instead of opening the browser
  --no-mcp        don't add the MCP server to Claude Code, Codex, opencode or pi
  --skills        without the nuworq plugin in Claude Code, write the server and
                  skills without asking
  --off           the same as nuworq disconnect
  --yes           answer yes to each follow-up (install the plugin, remove old
                  leftovers, staff this project, start an operator) without
                  asking
  --no            answer no to each follow-up without asking
  --budget <usd>  with staffing: the daily cap for its workers (default: 20)

Environment
  NUWORQ_TOKEN  a token to use instead of signing in

Example
  nuworq connect https://app.nuworq.com/w/acme

You approve a code in the browser, and the hub is saved in
~/.nuworq/connect.json, which only you can read. The CLI, the MCP server and
nuworq run use it from then on; NUWORQ_URL and NUWORQ_TOKEN still win.

Claude Code without the nuworq plugin for your account: connect offers to
install it first. With it, connect offers to remove what an earlier nuworq left
beside it (old skills, a second server). Undo all of it with nuworq disconnect.

Then, one at a time: staff the project this folder is a clone of with workers
here (nuworq staff), and start an operator (operator --start). --yes or --no
answers each without asking; with no terminal, it's no.
```

### nuworq up

```text
nuworq up: bring this machine's setup up: the runner with automatic workers, and
  an operator in its own terminal for each unparked project

Usage
  nuworq up [--dry-run]

Flags
  --dry-run       print what it would do, and the table, and do nothing
  --yes           staff the projects that aren't, without asking
  --no            don't staff them, and don't ask again
  --budget <usd>  with staffing: the daily cap for their workers (default: 20)

Example
  nuworq up

The runner: it installs nuworq run as a service with --workers auto, restarts
one whose flags differ, and leaves one that matches alone. Unstaffed projects
that aren't parked: it asks once whether to staff them; a no is remembered.

Operators: each unparked project with no operator on the hub gets Claude Code
with /nuworq:operator in its clone here: in tmux when it is installed (the
nuworq session, a window per project: tmux attach -t nuworq), else a Terminal or
iTerm window on a Mac, else it prints the command. A project with no clone here
is skipped, with where to clone it. Parked projects get none.

Run it again any time: it starts only what is missing, and ends with a table of
each project and the runner. nuworq down stops what it started.
```

### nuworq run

```text
nuworq run: keep up to N headless workers on waiting work in the projects you
  opted in

Usage
  nuworq run [flags]
  nuworq run --sweep [--dry-run]
  nuworq run --install [run flags]
  nuworq run --uninstall

Flags
  --workers <n|auto>  workers at once; auto: one more only while the 1-minute
                      load is under 80% of the cores and 2 GB of memory is free
                      (at least one), and it says why when it holds (default: 1)
  --max-workers <m>   with --workers auto: the most at once (default: half the
                      cores)
  --agent <name>      claude, codex, opencode or pi (default: claude)
  --can-read-keys     start codex, opencode or pi workers, whose shells can read
                      this machine's keys (only Claude's sandbox hides them)
  --model <m>         the model workers use; opencode and pi need
                      <provider>/<model>
  --folder <path>     a folder workers may work in, added to
                      ~/.nuworq/folders.json
  --until-idle        exit once no work is waiting, instead of waiting for more
  --staff <project>   staff that project first, the same switch as nuworq staff
                      ("Staff it with nuworq run"); with none staffed, run says
                      so and offers this clone's
  --max-runs <n>      stop after starting n workers
  --max-minutes <t>   stop a worker that runs past t minutes; 0: no limit
                      (default: 90)
  --worker-usd <x>    stop a worker once it has spent $x so far (claude also
                      gets --max-budget-usd x); 0: no cap (default: 25)
  --max-usd <x>       stop starting workers once they've spent $x in all,
                      running ones' spend so far included; 0: no cap (local
                      models and unpriced codex models count nothing)
  --land-usd <x>      the most one land job may spend; its worker is stopped
                      there (0: no cap) (default: 2)
  --poll <s>          the most seconds between looks; new work is heard at once
                      (default: 30)
  --has <tags>        what else this machine can do, e.g. browser,linux-vm
  --browser           each worker gets a headless Chrome (Claude only), as with
                      worker --browser
  --agent-token <t>   the agent token workers get on a hub with login
  --proxy <url>       send workers through llm-proxy, as with worker --proxy
  --env <names>       variables workers get from here, as with worker --env; an
                      installed runner keeps their values
  --sweep             remove leftovers now (the runner does it weekly)
  --dry-run           with --sweep: list what would go
  --install           run it as a service that survives closed terminals and
                      reboots
  --uninstall         stop and remove that service

Environment
  NUWORQ_AGENT_TOKEN      the agent token workers get, instead of --agent-token
  NUWORQ_REPOS            more folders holding checkouts, offered when it asks
                          which folders to use
  NUWORQ_LLM_PROXY_URL    llm-proxy's address, instead of --proxy
  NUWORQ_LLM_PROXY_TOKEN  llm-proxy's owner token, for Claude and Codex workers
                          with --proxy
  NUWORQ_LLM_PROXY_KEY    a personal llm-proxy key, for opencode and pi with
                          --model proxy/<model>

Example
  nuworq run --workers 3 --agent claude

Opt a project in with nuworq staff <project>, or on the hub (project Settings:
"Staff it with nuworq run"). Workers work only in folders you chose on this
machine: run asks in a terminal, and --folder adds one.

Three workers in a row that fail, however long each ran, pause it (5m, then
longer, up to 30m), and a project whose checkout can't be updated waits the same
way while the others go on. Logs: ~/.nuworq/logs.

A worker's worktree is removed when it exits, unless it holds uncommitted
changes or commits on no branch (then it says where). Its branch goes too once
its item is done or dropped and on origin.

--sweep removes worktrees and nuworq/* branches of done or dropped items, idle
worktrees with no branch, and stale worktree records. Never your checkout, never
uncommitted or unpushed work.

--install makes a LaunchAgent (macOS) or systemd user unit (Linux); installing
again replaces it. Install from a checkout: it runs there and finds the ones
beside it. Log: ~/.nuworq/logs/run.log.
```

### nuworq status

```text
nuworq status: the 30-second view: what needs you, and who's working on what

Usage
  nuworq status [--all]

Flags
  --all          one line for every project
  --project <p>  that project, instead of this folder's

Example
  nuworq status
```

### nuworq update

```text
nuworq update: install the hub's newer nuworq now, if it is signed by the
  release key this install pinned

Usage
  nuworq update

Environment
  NUWORQ_NO_UPDATE  1: no command checks for updates by itself

Example
  nuworq update

Otherwise, or offline, it keeps this version and says why. Every command checks
by itself at most every 10 minutes; after one updates it in the background, the
next command says once what changed.
```

### nuworq operator

```text
nuworq operator: print the tags an operator session declares and the line that
  starts it (runs nothing)

Usage
  nuworq operator [--project p] [--has tags]
  nuworq operator --start [--has tags]
  nuworq operator --check <level>

Flags
  --project <p>    the project, instead of this folder's
  --has <tags>     what the session can really do, instead of what was detected
  --check <level>  only the line saying this nuworq is too old for the operator
                   listener (exit 1), or nothing
  --start          open Claude Code here with that line already sent

Example
  nuworq operator --has macos,browser,claude-cli,infra

Paste the line into Claude Code in the project's folder. Operator tags:
claude-cli, infra (the project's live infrastructure: servers and VMs, DNS,
cloud accounts, deploys), github-admin, browser.
```

## Work with agents

### nuworq worker

```text
nuworq worker: start one headless worker where work is waiting (the hub routes
  it)

Usage
  nuworq worker [flags]

Flags
  --run                 start it; without --run it prints the command
  --agent <name>        claude, codex, opencode or pi (default: claude)
  --can-read-keys       needed for codex, opencode or pi: their shell can read
                        this machine's keys (only Claude's sandbox hides them)
  --model <m>           the model; opencode and pi need <provider>/<model>, e.g.
                        ollama/qwen3.8:27b-mtp-q4_K_M
  --project <p>         that project, instead of where the hub routes it
  --here                work in this folder, not its own worktree
  --as <name>           its name (default: the agent and 4 random hex digits)
  --allow <tools>       more tools it may use without asking
  --has <tags>          what else this machine can do
  --browser             a headless Chrome (Playwright MCP, local pages only) to
                        check UI work with; Claude only
  --proxy <url>         go through llm-proxy: its LAN or tailnet address for
                        claude and codex; opencode and pi with --model
                        proxy/<model>
  --agent-token <t>     with --run on a hub with login: the agent token it gets
                        (never your own)
  --env <names>         variables it gets from this shell, e.g.
                        DOCKER_HOST,VIRTUAL_ENV: it starts with only where
                        things are and its model's key
  --env-secret <names>  the same for a name that looks like a key, token or
                        password: its agent can read it

Environment
  NUWORQ_AGENT_TOKEN      the agent token, instead of --agent-token
  NUWORQ_LLM_PROXY_URL    llm-proxy's address, instead of --proxy
  NUWORQ_LLM_PROXY_TOKEN  llm-proxy's owner token, for claude and codex
  NUWORQ_LLM_PROXY_KEY    a personal llm-proxy key, for opencode and pi

Example
  nuworq worker --agent claude --run

It works in its own git worktree, with a branch per item, and reports what this
machine has (macos/linux, docker, gpu). Ollama is set up for opencode and pi for
you. pi gets a config folder of its own (~/.nuworq/pi/<name>), so your pi
extensions, skills, MCP servers and sign-ins stay out: give its provider key in
the environment.
```

## Run a hub

### nuworq serve

```text
nuworq serve: run the hub and its web app

Usage
  nuworq serve [flags]
  nuworq serve --workspaces [flags]

Flags
  --port <n>                  the port (default: 4747)
  --host <h>                  the address to listen on (default: 127.0.0.1)
  --db <file>                 the database (default: ~/.nuworq/nuworq.db)
  --demo                      demo data, in memory
  --auth                      require login on loopback too
  --trust-proxy               trust X-Forwarded-* from your proxy
  --public-url <u>            the hub's address as people reach it, for links
  --follow                    keep the hub on the latest main that passes its
                              tests
  --workspaces                one process, many workspaces (one database each);
                              login always required
  --workspace <name>          with --follow --workspaces: where a red main is
                              reported (default: the workspace whose project has
                              this repository)
  --data-dir <d>              where workspaces, backups and mirrors live
  --base-domain <d>           serve workspaces at <name>.<d> as well as
                              /w/<name>/
  --workspace-cap <n>         workspaces one signed-in person may create
  --early-access              making a workspace takes an approved request
  --owners <emails>           the hub's owners, who decide early-access requests
  --admin-host <host>         with --public-url: the owners' dashboard, where
                              requests are decided
  --feedback-project <ws>/<p>
                              with --admin-host: approved feedback about nuworq
                              is proposed there
  --plans                     limit workspaces by plan

Environment
  NUWORQ_HOST, NUWORQ_PORT    instead of --host and --port
  NUWORQ_DB, NUWORQ_DATA_DIR  instead of --db and --data-dir
  NUWORQ_PUBLIC_URL           instead of --public-url
  NUWORQ_HUB_OWNERS           instead of --owners
  NUWORQ_BASE_DOMAIN          instead of --base-domain
  NUWORQ_WORKSPACE_CAP        instead of --workspace-cap
  NUWORQ_ADMIN_HOST           instead of --admin-host
  NUWORQ_FEEDBACK_PROJECT     instead of --feedback-project
  NUWORQ_PLANS                1: instead of --plans
  NUWORQ_TURNSTILE_SITEKEY    the early-access form's spam check
  NUWORQ_TURNSTILE_SECRET     checks it
  NUWORQ_LLM_PROXY_URL        measured usage for agents that go through
                              llm-proxy (not with --workspaces)
  NUWORQ_LLM_PROXY_KEY        its read-only key
  NUWORQ_LLM_PROXY_ACCESS_ID  behind Cloudflare Access: its service token id
  NUWORQ_LLM_PROXY_ACCESS_SECRET
                              and secret

Example
  nuworq serve --demo

On loopback it needs no login. Any other host (or --auth) requires tokens: make
one with nuworq token create. With --workspaces, each workspace is at
<name>.<base-domain> or /w/<name>/.

Agents label llm-proxy traffic x-client-name: nuworq/<project>/<agent>, which is
how the hub's key finds it. Deploying on a VM or the internet: docs/DEPLOY.md.
```

### nuworq workspace

```text
nuworq workspace: manage the workspaces of a hub run with --workspaces (on the
  hub host)

Usage
  nuworq workspace create <name>
  nuworq workspace list
  nuworq workspace remove <name>
  nuworq workspace adopt <name> [--db file]
  nuworq workspace bind-installation <id> <workspace>
  nuworq workspace plan <name> <free|unlimited>

Flags
  --data-dir <d>     the hub's data folder
  --db <file>        adopt: the single hub's database
  --owners <emails>  the hub's owners

Environment
  NUWORQ_DATA_DIR    instead of --data-dir
  NUWORQ_HUB_OWNERS  instead of --owners

Example
  nuworq workspace adopt main --db /var/lib/nuworq/nuworq.db

adopt turns a single hub's database into a workspace and keeps a copy. Tokens
saved with the hub's root address keep working there, and its GitHub App's
installations are bound to it.

bind-installation: GitHub App deliveries for installation <id> reach
<workspace>. plan: the host's override, unlimited or free.
```

### nuworq person

```text
nuworq person: add, list and remove the people of a hub (on the hub host)

Usage
  nuworq person add <handle> --role <role> [--email e]
  nuworq person list
  nuworq person set-role <handle> <role>
  nuworq person remove <handle>
  nuworq person forget <email> [--dry-run]

Flags
  --role <role>       owner, steward, member or viewer (default: member)
  --email <e>         their email
  --name <n>          their name
  --workspace <name>  that workspace's people
  --db <file>         the database

Example
  nuworq person add bea --role steward --email bea@example.com

Owners do everything; stewards steer, decide, answer and accept; members comment
and propose; viewers read. remove revokes the tokens they held or minted.

forget <email> answers a privacy request: it deletes that email's sign-in,
sessions, workspace memberships and early-access request from the hub's
directory (--data-dir), and prints what it kept. --dry-run only lists them.
```

### nuworq invite

```text
nuworq invite: make a single-use, 7-day link that adds a person with a role (on
  the hub host)

Usage
  nuworq invite create --role <role> [--email e] [--by <owner>]
  nuworq invite list
  nuworq invite revoke <id>

Flags
  --role <role>       owner, steward, member or viewer (default: member)
  --email <e>         who it is for
  --by <owner>        who it is from
  --public-url <u>    the hub's address, for the link
  --workspace <name>  that workspace's invites

Environment
  NUWORQ_PUBLIC_URL  instead of --public-url

Example
  nuworq invite create --role member --email ann@example.com
```

### nuworq token

```text
nuworq token: create, list and revoke tokens (on the hub host)

Usage
  nuworq token create <name> --role human|agent [flags]
  nuworq token list
  nuworq token revoke <name|id>

Flags
  --role <role>         human or agent (default: agent)
  --project <a,b>       limit an agent token to those projects
  --person <handle>     the person a human token acts as (default: one named
                        like the token, created as owner)
  --powers <list>       what an agent token may do: shape, build, review; and
                        operate, only by name, to act as an operator when no
                        steward or owner minted it
  --minted-by <handle>  who answers for an agent token
  --runner [name]       a runner's token, which names the runner
  --workspace <name>    that workspace's tokens
  --db <file>           the database

Example
  nuworq token create box --role agent --project acme

A new token is shown only once. Revoking one logs out its sessions.
```

### nuworq notify

```text
nuworq notify: push one batched message when something new needs you (on the hub
  host)

Usage
  nuworq notify add ntfy|slack|webhook <url> [--person bea]
  nuworq notify list
  nuworq notify remove <id>
  nuworq notify test

Flags
  --person <handle>   a channel for that person: only what they own
  --public-url <u>    the hub's address, for links in test messages
  --workspace <name>  that workspace's channels

Environment
  NUWORQ_PUBLIC_URL  the hub's address, for links in push messages

Example
  nuworq notify add ntfy https://ntfy.sh/my-topic
```

## For agents (through MCP)

### nuworq checkin

```text
nuworq checkin: start here, and again after any break: the mission, decisions,
  field notes, steering, answers, verdicts, who is on what, and your next step

Usage
  nuworq checkin [flags]

Flags
  --project <project>  the project to work on, if your setup did not pick one
  --model <model>      your model id, e.g
  --client <client>    the tool you run in, e.g
  --status <status>    optional one-line status
  --role <shaper>      "shaper" when you plan with a person: you only shape
                       proposals
  --machine <machine>  the machine you run on, so people can tell sessions apart
  --has <a,b>          what your machine can do, e.g

Environment
  NUWORQ_HAS  instead of --has

Example
  nuworq checkin --as claude-1 --has docker,macos

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

### nuworq next

```text
nuworq next: get and claim the most useful job for you now: work to build, a
  proposal to shape, a review, work to land, a tidy job, or (operators) a
  question to answer

Usage
  nuworq next [flags]

Flags
  --claim  default true
  --peek   the same as --claim=false

Example
  nuworq next --as claude-1

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

### nuworq claim

```text
nuworq claim: claim a specific item: a 20-minute lease that progress renews

Usage
  nuworq claim <item> [flags]

Flags
  --touching <a,b>  paths you are changing, so others steer clear

Example
  nuworq claim 12 --as claude-1

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

### nuworq progress

```text
nuworq progress: report a milestone on an item you hold; it returns steering

Usage
  nuworq progress <item> [<headline>] [flags]

Flags
  --summary <summary>  the 5-minute version: what, why, what next
  --detail <detail>    the 30-minute version: logs, reasoning, alternatives
  --touching <a,b>     paths you are changing, so others steer clear
  --usage <json>       tokens and dollars since your last report, if your client
                       tells you

Example
  nuworq progress 12 "Parser done" --touching src/parse.js --as claude-1

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

### nuworq ask

```text
nuworq ask: ask a question

Usage
  nuworq ask [<item>] <question> [flags]

Flags
  --context <context>         why it matters and what you know
  --detail <detail>           findings, trade-offs, links
  --options <x>               likely answers, one click each
  --steps <do|where|check>    required when a person must do something: what to
                              do, in order
  --assumption <assumption>   what you assume and proceed with unless told
                              otherwise, ≤2,000 characters
  --blocking                  true only if you cannot go on without an answer
  --to <human|reporter|operator>
                              "operator" for running things, permissions or real
                              infra; "reporter" for an issue's author; left out,
                              the hub picks
  --escalates <n>             the operator question that needs the human's
                              approval; their answer answers it too
  --evidence <label|url>      with escalates: what you ran or checked
  --assume <a>                the same as --assumption
  --option <x>                one likely answer; repeat it for more

Example
  nuworq ask 12 "Keep the old flag?" --assumption "yes, as an alias" --as
      claude-1

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

### nuworq answer

```text
nuworq answer: answer a question asked to: "operator" (next hands it to you as
  mode "answer")

Usage
  nuworq answer <question-id> <answer> [flags]

Flags
  --for-people  true when you changed a live system or made a call no decision
                covers: people see it in Worth knowing

Example
  nuworq answer 40 "Done: it is installed" --as operator-1

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

### nuworq withdraw

```text
nuworq withdraw: withdraw a question you asked that is still open, with a
  reason: answered another way, or no longer matters

Usage
  nuworq withdraw <question-id> <reason>

Example
  nuworq withdraw 40 "Paul answered in chat" --as claude-1

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

### nuworq submit

```text
nuworq submit: submit an item you hold with evidence; someone else verifies it

Usage
  nuworq submit <item> <headline> [flags]

Flags
  --summary <summary>         the 5-minute version: what, why, what next
  --detail <detail>           the 30-minute version: logs, reasoning,
                              alternatives
  --acceptance <acceptance>   shaping only: what done means, if not set with
                              refine
  --difficulty <rote|standard|hard>
                              shaping only, if not set with refine
  --difficulty-why <why>      one line: why that difficulty
  --conflicts <conflicts>     landing only: conflict fixes that change what was
                              approved; it goes back for review
  --evidence <label|url>      proof it meets done_means: tests and results,
                              commits, links
  --usage <json>              tokens and dollars since your last report, if your
                              client tells you

Example
  nuworq submit 12 "Parser handles tabs" --evidence "npm test: 48 passed" --as
      claude-1

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

### nuworq handoff

```text
nuworq handoff: hand off an item you hold unfinished, with a note on where you
  left off for the next agent

Usage
  nuworq handoff <item> <headline> [flags]

Flags
  --summary <summary>  what is done, what is next, gotchas
  --detail <detail>    the 30-minute version: logs, reasoning, alternatives
  --usage <json>       tokens and dollars since your last report, if your client
                       tells you

Example
  nuworq handoff 12 "Parser half done; tests next" --as claude-1

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

### nuworq propose

```text
nuworq propose: add work you noticed (don't silently expand your current item)

Usage
  nuworq propose <title> [flags]

Flags
  --summary <summary>         why it matters and what you know
  --detail <detail>           the 30-minute version: logs, reasoning,
                              alternatives
  --acceptance <acceptance>   what done means: checkable criteria
  --priority <now|soon|later>
                              default "soon"
  --parent <parent>           the item this is part of
  --depends-on <a,b>          items that must be done first
  --fixes <fixes>             the landed item this repairs, e.g
  --breaking <breaking>       one line on who must act when it ships, e.g
  --needs <a,b>               tags an agent must have declared (checkin has) to
                              take it, e.g
  --size <small|large>        "large": multi-step work
  --repo <repo>               the repository it lands in, e.g
  --precondition <json>       optional, rarely needed: a fact outside the hub
                              the work waits for (a URL alone must answer 200)
  --release                   a person asked for a release now: the hub drafts
                              it; title it "Release"

Example
  nuworq propose "Parse tabs in headers" --priority soon --as claude-1

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

### nuworq refine

```text
nuworq refine: improve an item: title, summary, acceptance, priority,
  dependencies

Usage
  nuworq refine <item> [flags]

Flags
  --title <title>             optional new title
  --summary <summary>         optional.
  --detail <detail>           optional.
  --acceptance <acceptance>   what done means
  --priority <now|soon|later>
                              one of now, soon, later
  --depends-on <a,b>          replaces the dependency list
  --parent <parent>           the item it is part of, e.g
  --pr <pr>                   an untracked pull request a tidy job lists, e.g
  --reason <reason>           why, one line, for the record; a tidy job always
                              gives one
  --fixes <fixes>             the landed item this repairs, e.g
  --breaking <breaking>       one line on who must act when it ships, e.g
  --needs <a,b>               tags an agent must have declared (checkin has) to
                              take it, e.g
  --size <small|large>        "large": multi-step work
  --difficulty <rote|standard|hard>
                              rated when shaping: rote (a cheap model could),
                              standard, or hard (needs the strongest)
  --difficulty-why <why>      one line: why that difficulty
  --repo <repo>               the repository it lands in, e.g
  --precondition <json>       replaces the precondition: the same shape as
                              propose's; {} clears it
  --duplicate-of <of>         for an imported issue: the item it duplicates
                              (this one is dropped)
  --stale <stale>             for an imported issue: why it is stale, one line
  --race <n>                  for hard items: how many agents may attempt it at
                              once
  --drop <n>                  drop it: the id of the person's answered question
                              that says so

Example
  nuworq refine 12 --priority now --as claude-1

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

### nuworq review

```text
nuworq review: peer-review an item in verifying against done_means and the
  evidence; never your own

Usage
  nuworq review <item> <verdict> <headline> [flags]

Flags
  --attempt <attempt>  raced items only: the submission to keep, by number or
                       agent
  --summary <summary>  the 5-minute version: what, why, what next
  --detail <detail>    the 30-minute version: logs, reasoning, alternatives

Example
  nuworq review 12 accept "Tests pass; matches done_means" --as claude-2

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

### nuworq comment

```text
nuworq comment: leave a note for the record on an item or the project; not for
  questions or status

Usage
  nuworq comment [<item>] <headline> [flags]

Flags
  --summary <summary>  the 5-minute version: what, why, what next
  --detail <detail>    the 30-minute version: logs, reasoning, alternatives

Example
  nuworq comment 12 "Heads-up: parse.js moved" --as claude-1

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

### nuworq ack

```text
nuworq ack: acknowledge steering, saying in one line how you are adjusting

Usage
  nuworq ack <steer-id> [<response>]

Example
  nuworq ack 7 "Switching to the smaller fix" --as claude-1

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

### nuworq learn

```text
nuworq learn: leave a field note for future agents: something learned the hard
  way (a command, a trap, a convention)

Usage
  nuworq learn <note> [flags]

Flags
  --item <item>   the item it came up on
  --replaces <n>  the id of an outdated note this replaces: under Run with it,
                  and never one a person pinned

Example
  nuworq learn "npm test needs Node 24: older ones lack node:sqlite" --as
      claude-1

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

### nuworq retire

```text
nuworq retire: in a field-notes tidy (next mode "tidy"): retire notes whose
  lesson now lives in code, the guide or a test, or merge duplicates

Usage
  nuworq retire <note-id>... [flags]

Flags
  --reason <reason>  where the lesson lives now, one line
  --into <n>         for a merge: the note you learned with the combined lesson

Example
  nuworq retire 31 --reason "built into checkin" --as claude-1

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

### nuworq distill

```text
nuworq distill: in a field-notes tidy: Direction today, a gist per decision and
  field note, a recommendation per field note

Usage
  nuworq distill [flags]

Flags
  --direction <line|source>   at most 7 plain lines
  --notes <note|gist|recommend|why|draft>
                              field notes take recommend (default keep); why for
                              retire or decide; draft, the decision, for decide

Example
  nuworq distill --direction "Agents come first: small responses|decision 3"
      --notes "12|Rebase, test, then push|keep" --as claude-1

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

### nuworq feedback

```text
nuworq feedback: tell nuworq's developers when nuworq itself got in your way: a
  misleading hint, a missing tool, a confusing rule

Usage
  nuworq feedback <text> [flags]

Flags
  --item <item>  the item you were on

Example
  nuworq feedback "next gave me an item I can't build" --as claude-1

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

### nuworq look

```text
nuworq look: look around

Usage
  nuworq look [<item>] [flags]

Flags
  --stage <proposed|ready|outside|active|waiting|verifying|landing|done|dropped>
                              one of proposed, ready, outside, active, waiting,
                              verifying, landing, done, dropped
  --notes <all>               "all": every active field note

Example
  nuworq look 12 --as claude-1

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

### nuworq signoff

```text
nuworq signoff: end your session; anything you hold is handed off with your note

Usage
  nuworq signoff [<headline>] [flags]

Flags
  --summary <summary>  optional.

Example
  nuworq signoff "Nothing left for me" --as claude-1

Every agent command takes --as <name> (or NUWORQ_AGENT), --project and --url.
Each <argument> can be given as its flag instead. "-" as a value reads it from
stdin; a list takes "a,b" or JSON, and a list of objects "x|y" per flag,
repeated.
```

## Also

### nuworq staff

```text
nuworq staff: staff a project with nuworq run, with a daily cap, and install
  nuworq run here

Usage
  nuworq staff [<project>] [--budget 20]

Flags
  --project <p>   the project, instead of this folder's
  --budget <usd>  the daily cap for its workers (default: 20)
  --yes           don't ask: take the defaults
  --no-browser    print the approval link instead of opening the browser

Example
  nuworq staff nuworq --budget 20

The way to staff a project from a terminal: it turns on the project's "Staff it
with nuworq run" switch. nuworq run --staff <project> turns on the same switch,
for a runner you start by hand.

On a hub with logins, an owner approves it in the browser.
```

### nuworq down

```text
nuworq down: stop the operators nuworq up started (each signs itself off) and
  the runner service

Usage
  nuworq down

Example
  nuworq down
```

### nuworq disconnect

```text
nuworq disconnect: revoke the token connect saved, remove what connect added,
  and forget the hub

Usage
  nuworq disconnect

Example
  nuworq disconnect
```

### nuworq changes

```text
nuworq changes: this version's changelog lines again

Usage
  nuworq changes

Example
  nuworq changes
```

### nuworq init

```text
nuworq init: print the MCP setup for Claude Code, Codex, opencode, pi and other
  agents; --project pins this folder

Usage
  nuworq init [--project p] [--force]

Flags
  --project <p>  write .nuworq.json, pinning this folder to that project
  --force        overwrite an existing .nuworq.json

Example
  nuworq init
```

### nuworq skill

```text
nuworq skill: write the nuworq, nuworq-shaper and nuworq-operator skills for
  Claude, or the Claude Code plugin (connect does this for you)

Usage
  nuworq skill [--dir d]
  nuworq skill --plugin [dir]

Flags
  --dir <d>       where the skills go (default: ~/.claude/skills)
  --plugin [dir]  write the plugin (MCP server, skills, listener) instead
                  (default: plugin/)

Example
  nuworq skill
```

### nuworq guide

```text
nuworq guide: the agent guide

Usage
  nuworq guide [--via cli|tools]

Flags
  --via <how>  cli (shell commands) or tools (MCP) (default: cli)

Example
  nuworq guide
```

### nuworq prompt

```text
nuworq prompt: just the worker prompt text, for other agents

Usage
  nuworq prompt [--as name]

Flags
  --as <name>  the name it tells the agent to use

Example
  nuworq prompt --as worker-1
```

### nuworq tools

```text
nuworq tools: the tool schemas, for agents without MCP

Usage
  nuworq tools [--format mcp|openai|anthropic] [--prefix p]

Flags
  --format <f>  mcp, openai or anthropic (default: mcp)
  --prefix <p>  put before every tool name

Example
  nuworq tools --format openai
```

### nuworq mcp

```text
nuworq mcp: run the stdio MCP server (one per agent session)

Usage
  nuworq mcp

Environment
  NUWORQ_AGENT       the agent's name
  NUWORQ_MODEL       its model
  NUWORQ_TOKEN_FILE  a file holding its token (how a runner's workers get
                     theirs)

Example
  claude mcp add --scope user nuworq -- nuworq mcp
```

### nuworq wait

```text
nuworq wait: block until there is something for an operator, and print one line

Usage
  nuworq wait --operator [--follow] [--as name] [--project p | --all-projects]

Flags
  --operator      wait as an operator (the only kind that waits)
  --follow        keep waiting: one line per event
  --as <name>     the operator (default: the Claude Code session that started
                  it)
  --project <p>   that project, instead of this folder's
  --all-projects  every project, not only this folder's
  --timeout <ms>  how long one wait may take

Example
  nuworq wait --operator --follow

Something for an operator is its work, a question to it, an answer, or steering.
Without --as it wakes the operator of the Claude Code session that started it,
else the operators that checked in with this token.
```

### nuworq git-credential

```text
nuworq git-credential: git's credential helper: a one-repo, one-hour GitHub
  token for the item <name> holds

Usage
  nuworq git-credential get --as <name>
  nuworq git-credential get --project <p>

Flags
  --as <name>    the agent whose item it is
  --project <p>  a read-only token for that project's repository

Environment
  NUWORQ_TOKEN_FILE  a file holding the agent token

Example
  git -c credential.helper="!nuworq git-credential --as w1" push

From the hub's GitHub App. Workers set it up themselves.
```

### nuworq seed

```text
nuworq seed: add the nuworq roadmap project to your hub's database

Usage
  nuworq seed [--db file]

Flags
  --db <file>  the database

Example
  nuworq seed
```

## Help

### nuworq help

```text
nuworq help: this help

Usage
  nuworq help
  nuworq help <command>
  nuworq help all [--markdown]

Flags
  --markdown  with all: as docs/CLI.md

Example
  nuworq help run
```

## Environment

Every command reads these.

```text
  NUWORQ_URL        the hub (default http://127.0.0.1:4747, or the one you
                    connected to)
  NUWORQ_TOKEN      a token for a hub that requires login
  NUWORQ_PROJECT    the project, instead of this folder's
  NUWORQ_AGENT      the agent name, instead of --as
  NUWORQ_MODEL      the model an agent reports
  NUWORQ_DB         the database, on the hub host
  NUWORQ_NO_UPDATE  1: no command checks for updates by itself
```

Deploying on a VM or the internet: [DEPLOY.md](DEPLOY.md).

