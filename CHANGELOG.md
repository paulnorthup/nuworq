# Changelog

## 0.5.0 (2026-10-31)

What landed since v0.4.0.

**Each finished milestone becomes a versioned, signed release with a changelog and upgrade notes, in any project (#397)**

- Releases sign themselves on Paul's Mac: a signer service signs each vX.Y.Z tag on main, built from GitHub, and puts the signature on the hub (#430)
- The release signer runs on Paul's Mac, and v0.3.0 is signed by it, not by hand (#431)
- A release tag gets signed even when the hub never ran its commit: v0.4.0 (e596c95) is stuck unsigned (#434)
- v0.4.0 is signed by the signer and installs on Paul's Mac with its changelog, once the hub runs #434 (#435)
- After nuworq updates itself in the background, the next command says once what changed: the version and its changelog lines (#436)

**Also in this release**

- A person sees two nuworq commands, /nuworq:shaper and /nuworq:operator, installed once through the plugin (#432)

## 0.4.0 (2026-10-31)

What landed since v0.3.0.

**An idle operator session wakes on its own when operator work, an operator question or an answer arrives: no /loop, and nothing spent while… (#281)**

**Also in this release**

- A release item lands as a version bump, a CHANGELOG entry and a vX.Y.Z tag, and for nuworq the signature checks the version (#400)
- Tidy jobs don't flag a release item as ungrouped: a release spans every milestone and stays top-level (#425)

## v0.3.0 (2026-10-31)

What landed since v0.2.0.

**Git awareness: submissions carry the worker's real branch and commits, and PR/CI status shows on items (#13)**

- On submit, the hub records the worker's branch and commits, and flags evidence naming commits that don't exist (#24)
- GitHub PRs and CI results link to items automatically (webhook) (#25)

**Race an item: up to N agents (on different models) attempt it at once, and the reviewer keeps the best (#14)**

- Race mechanics: an item marked race=N can be claimed by N agents at once, each with its own lease and submission (#26)
- Race review: the reviewer sees attempts side by side and accepts one; the rest are recorded as not chosen (#27)
- Changing race count on a verifying item can't leave stale attempts that block a later race (#39)

**Cost and tokens per item: captured where possible, shown per finished item and model, and capping trellis run (#16)**

- Usage is recorded per item: tokens and cost from the runner's agent CLIs, or reported by agents (#28)
- Cost shows per finished item by model in Flow, and trellis run stops at a --max-usd budget (#29)
- Recording a worker's usage after it exits doesn't bring it back online (#61)

**Hosted nuworq: a company signs up, connects its agents, and runs its projects on one shared hub (#31)**

- One hub process serves many workspaces: one SQLite file each, picked by subdomain or /w/<slug>, fully isolated (#32)
- People have accounts: sign in with GitHub or Google, join by invite, and hold a role per workspace (#33)
- `trellis connect <workspace>` sets up a machine in one command: browser login, saved token, MCP registered (#34)
- Projects are found by git remote, so every clone on every machine reaches the same project (#35)
- "Needs you" is per person: each act-level entry has owners (stewards, or whoever steered the item), and the view is written for the viewer (#36)
- Agent tokens record who minted them (a person or a runner) and carry powers (shape, build, review) that the hub enforces (#37)
- Agent writes containing secrets are refused before anything is stored, with a hint naming the field (#38)
- People and roles: each human is a person with a role, and every human action records who did it (#40)
- Invite links: an owner invites a person with a role; opening the link signs them in (#41)
- Sign in with GitHub or Google: OAuth/OIDC login maps to a person, with zero dependencies (#42)
- Device login: a CLI gets a person's agent token by showing a code the person approves in the browser (#43)
- `trellis connect <workspace>` saves a 0600 credential and registers MCP for installed agents; `disconnect` undoes exactly that (#44)
- A signed-in person creates an organization on nuworq.com in under a minute, owns it, and switches between their organizations in one click (#52)
- On a hosted hub, a workspace can only make the hub read repositories it was granted: no local paths, no shared keys, App installations… (#59)
- The hub knows which organizations each signed-in person belongs to, and lets them create one they own (#67)
- New-organization flow in the UI: name → slug → first project with repos → connect command, plus an org switcher in the header (#69)
- Manual check: after `nuworq connect`, a headless Claude and Codex reach the hub with no other setup (#81)
- On a shared hub, Get started's "app installed" check only counts installations bound to that organization (#123)

**Projects live on GitHub: each claim gets the repo, a branch and short-lived access, and issues flow in and close when work lands (#46)**

- A GitHub App is the only door to a repo: the hub mints a 1-hour, one-repo token per claim, and nothing else holds GitHub credentials (#47)
- Remote-mode projects land through a pull request: the hub opens it with auto-merge on, and GitHub's merge marks the item done (#48)
- Open GitHub issues come in as proposals that agents shape, so an existing project moves onto nuworq by installing the app (#49)
- `ask` with to: "reporter" posts the question on the item's GitHub issue; the reporter's reply answers it, and silence falls back to "needs… (#50)
- A project holds several repos, and each item names the one it lands in (#53)
- On accept, the hub opens a PR for the item's branch with auto-merge (squash) on; the merged webhook marks the item done (#63)
- A landing PR that can't merge routes itself: conflict → land job, red required check → back to builder, required approval → one "needs you"… (#64)
- Open issues become linked proposals on install and through the issues webhook, never duplicated (#65)
- An issue-linked item closes its GitHub issue when it lands, on either landing path (#66)
- Shaping agents can merge duplicate issues and flag stale ones; the human gets one "close these N?" card (#68)
- Each item names its repo, and the claim, git facts and landing all use that repo (#70)
- Agents get work in the repo they're in, and workers start in the claimed item's repo (#73)
- A self-hosted hub creates its GitHub App in one click (app-manifest flow), and reuses a worker's token until it nearly expires (#80)

**Claude users get nuworq as one plugin: a generated work skill, a planning skill, and the MCP server (#62)**

- `nuworq skill` writes the nuworq work skill from src/protocol.js, and a test fails if it drifts from the guide (#95)
- A nuworq-plan skill turns a short conversation with a person into well-shaped proposals (#96)
- One Claude Code plugin install gives the nuworq MCP server and both skills (#97)

**An item can wait on an outside fact: the hub checks a precondition and makes the item ready when it passes (#78)**

- Items can wait on an HTTP precondition: held out of next in a new "Outside" stage, checked off the request path, ready when it passes (#98)
- Version preconditions: an item waits until a reported version or a GitHub release reaches a semver minimum (#99)
- The human sees and sets preconditions: an overdue wait shows under worth knowing, the UI edits them, and "ask a person" becomes a question (#100)

**Installing nuworq is one command from the hub, and agents always see the hub's current protocol without reinstalling (#101)**

- The hub serves an npm-installable package of the commit it runs at /nuworq.tgz, with its sha256 in /api/info (#102)
- The MCP server is a bridge: tools, descriptions and the guide come from the hub at startup, and tools/list_changed reloads them mid-session (#103)
- The package updates itself from the hub after verifying the checksum, and connect registers `nuworq mcp` with no paths (#104)
- The Connect dialog and README say one command: npm install -g https://<hub>/nuworq.tgz, then nuworq connect (#105)
- connect registers `nuworq mcp` with no folder paths when nuworq is installed as a package, and rewrites old path-based entries (#106)
- The package updates itself from the hub only when the new version is signed by the release key pinned at install; otherwise it keeps… (#107)
- Self-update never moves to an older signed release, and its by-hand fallback installs only the verified file (#128)

**Early access works end to end: a request reaches Paul, he lets people in from admin.nuworq.com, and they start at app.nuworq.com (#109)**

- The app runs at app.nuworq.com and nuworq.com is free for the landing page; old app links redirect (#110)
- nuworq.com landing page: a static site/ with the promise, how it works, why it's different, planned pricing, FAQ, and an early-access… (#111)
- Early access: a spam-proof request form, a list hub owners approve from, and an invite that lets the person create their organization (#112)
- Plan limits are enforced where work is claimed: Free runs one agent at a time (#113)
- The hub serves the app under its public URL (app.nuworq.com) and sends app paths that reach the apex there (#119)
- app.nuworq.com is live: tunnel route, DNS, the hub's --public-url and --site-host, and the GitHub App's URLs (#120)
- The early-access button opens a form that sends the request to the hub, with Cloudflare Turnstile (#121)
- A running single hub moves into workspaces mode without losing anything: its projects, tokens and history become one workspace, and… (#204)
- Signups are live: the live hub runs with workspaces and early access on, the form's spam check has real keys, and Paul is its owner (#205)
- nuworq.com's early-access form reaches the hub: app.nuworq.com allows https://nuworq.com on the early-access API (CORS) (#245)
- An early-access request reaches the hub owner as a push even when their only channel is their own one-person workspace's (#251)
- DEPLOY.md says each sign-in host needs its own callback on the GitHub OAuth App (#278)

**A full UI pass: usability, information hierarchy and interface fundamentals, so using nuworq feels natural (#114)**

- UI audit: every screen reviewed against interface principles, with screenshots and proposed fixes (#115)
- Light only, and desktop gets the same design care as the phone (#141)
- When the hub can't be reached, the page says so and stops looking live; errors read in plain words (#142)
- A link to a project that doesn't exist says so instead of silently showing the home (#143)
- The 30-second project view is only what needs you and what's moving; Flow moves to 5m, as its footer already says (#144)
- Recently finished never shows an empty "built by" (#145)
- Retiring a standing decision or field note can be undone (or asks first) (#146)
- Get started's "Add a project" ticks itself when projects exist, and says what's actually missing (#147)
- On a phone, the item drawer's buttons and close are thumb-sized (44px) (#148)
- An empty hub has one next step, not two competing primary buttons (#149)
- Plain words for the pulse and cards: no "First look.", no "Why? (5m)", and "Who" that means who worked on it (#150)
- Every error in the UI shows the API's hint, not just its message (#151)
- A parked project's pulse and badges agree on what still needs you (#152)
- Approving a machine while signed out brings you back to the code after you log in (#153)
- The project's GitHub dialog leads with the GitHub App; the per-project webhook is the fallback (#154)
- Small fixes from the UI audit: dialogs close on navigation, sign-in pages name the organization, notification form fits (#155)
- Every color in the app means one thing, and the same thing on every screen (#187)
- The color map is written beside the tokens, and a test keeps state colors and provider marks clearly apart (#188)
- Orange means it's your move: every Needs you card is orange, and the "now" priority isn't (#189)
- Blue means agents are on it: a flowing project and a working agent are blue, and links, focus and "new" are not (#190)
- Green means finished or passed: dropped work, nudging empty states, commits and agents' own claims aren't green (#191)
- A failing check shows a red ✗, never inside a green ✓; red means failed and amber means at risk (#192)
- Buttons show emphasis, not state: the action that moves work on is ink, and peer choices look alike (#193)
- Whose move it is has one color everywhere: Flow, stage pills, the lifecycle bar and the timeline agree (#194)
- Text that carries information is readable (4.5:1), and no state is told by color alone (#195)
- Needs you names every card kind in plain words, never "OPERATOR-MISSING" (#196)
- Outside's hatched segment and pill keep their labels readable (4.5:1) once #194 and #195 are both on main (#209)
- A steer that many agents acknowledged reads as one line: a count, the latest few, and the rest on demand (#211)
- A project's settings are in one Settings dialog; the header keeps only Depth and Autonomy (#213)
- A group that Needs you calls stalled says "Stuck" on its Groups line, naming what it waits for (#214)
- A group's map shows its open parts first and folds the done ones (#215)
- Work that's been accepted stops showing as "Keeps bouncing" in Needs you (#216)
- The CLI's help says "workspace", never "organization" (#217)
- Every agent shows what it is and what it's doing: Operator, Shaper or Worker, where it runs, and its current job, instead of claude-<hex> (#234)
- The hub knows each session's role (operator, shaper, worker, session) and offers work by it (#238)
- Agents read as role · where · job on every screen, e.g. "Worker · mac-mini runner — building #170" (#240)
- The guide and both skills describe the three roles: how each starts, what it may take, and what it never does (#241)
- An item without done_means doesn't make the drawer scroll sideways on a phone (#256)
- A Groups line says Stuck when the stalled "now" group is nested inside it, or inherits "now" through a dependency (#266)
- Groups are called milestones wherever a person reads them: finishing one releases something (#269)
- Each milestone shows how far along it is as a small bar beside its state, so progress reads at a glance (#270)
- Typing ? outside a text box shows every keyboard shortcut, and the list can't fall behind the shortcuts (#274)
- Small fixes from #114's closing pass: plurals, a clipped placeholder, and a stale demo decision (#289)
- Tapping a "new" tag dismisses it without opening the feature; tags still last 7 days (#314)

**A new person goes from sign-in to their first landed item in minutes, guided by a Get started checklist (#116)**

- A Get started checklist on All projects that checks itself off from hub state, links each next action, and disappears for good once complete (#117)
- Every empty screen in the dashboard says why it's empty and offers one next action (#118)
- Get started can finish for a project that isn't on GitHub, and a non-owner is told who sets up GitHub (#129)

**The home page is the 50,000-foot view: everything that needs Paul across all projects, then a one-line pulse per project (#124)**

- GET /api/home answers "does anything need me?" across every project in one request (#125)
- The signed-in home (#/) shows everything that needs you across projects, with actions working in place (#126)
- The new home is verified on screen: 375px and desktop, light and dark, with screenshots (#127)

**An operator lane: run/infra/admin work and questions go to an attended operator session, and Paul sees only decisions and escalations (#131)**

- Questions an agent can't settle alone go to: "operator" and are answered by an operator session, not Paul (#133)
- An operator escalates to Paul with one precise question and its evidence, and Paul's answer reaches the original asker (#134)
- The guide and README explain the operator role, its capability tags, and the /loop prompt that keeps an operator session running (#135)

**The operator lane, finished: default routing, quiet waiting, a one-command operator session, and an end-to-end proof (#136)**

- An operator session gets operator work before anything else, and work only an operator can do never asks Paul to start an agent (#137)
- When an agent omits `to`, the hub sends run/permission/infra questions to the operator and decisions to Paul (#138)
- `nuworq operator` prints the capabilities to declare and the /loop prompt, and the nuworq skill knows the operator role (#140)

**Anything that needs a person comes with numbered steps, and Needs you shows them as a checklist (#160)**

- ask carries numbered steps, and the hub refuses a do-this question to a person without them (#161)
- Needs you shows a question's steps as a checklist the person ticks, and the last tick reports back (#162)

**admin.nuworq.com: Paul runs the hub from an admin dashboard only he can open: early-access approvals, workspaces and plans (#165)**

- The hub serves an admin dashboard on its admin host, only hub owners get in, and early-access requests are decided there (#166)
- A new early-access request reaches the hub's owners as a notification that opens it on the admin dashboard (#167)
- admin.nuworq.com is live: tunnel route, DNS, the hub's --admin-host, and sign-in callbacks (#168)
- The admin dashboard lists every workspace with its plan, and Paul switches a workspace between Free and Unlimited there (#169)

**Projects on nuworq stay nu: known vulnerabilities get fixed and dependencies stay current without anyone asking (#179)**

- Each Dependabot alert on a project's repository becomes a ready nuworq item, ranked by severity, and closes when GitHub marks it fixed (#180)
- Every project gets a weekly freshness sweep: an agent lands safe updates in one batch and proposes each breaking upgrade with a migration… (#181)

**Paul sees the work as a few groups and steers by setting a group's priority; agents keep the groups true without him (#197)**

- A group's priority reaches everything in it and everything it waits on (#198)
- An item can be moved to another group, or out of one (#199)
- The project page shows its groups at a glance, each opens as a map, and Paul sets a group's priority there in one tap (#200)
- A "now" group stalled on work no available agent can take reaches Needs you with the one fix (#201)
- Agents keep the groups true: the hub hands out a tidy job when work is ungrouped, groups overlap, or a PR belongs to nothing (#202)
- When Paul answers "Drop it" on an item's question, the item is dropped and next stops offering it (#207)
- Tidy jobs stop re-flagging groups that are waiting on review or a person, and files every group shares like docs/DEPLOY.md (#243)

**The live hub hears GitHub: every App event reaches the right workspace, and owners are told with steps when it can't (#229)**

- The live GitHub App hears GitHub: it subscribes to every event the hub handles and can read Dependabot alerts (#219)
- When the hub's GitHub App can't hear what the hub handles, the hub's owners are told which events and permissions to add, with the steps (#220)
- Adopting a single hub into workspaces keeps its GitHub App working: its installations are bound to the adopted workspace (#226)

**Workspace owners pay for nuworq and decide from its analytics (#230)**

- Workspace owners pay for nuworq: Stripe Checkout upgrades a workspace, the billing portal changes or cancels it, and the plan follows the… (#221)
- Owners decide from analytics across their workspace and over months: cost, throughput, waits and quality by project, model and agent (#223)
- A paid Stripe subscription puts a workspace on a paid plan: the hub verifies Stripe's signed webhook and the plan follows it (#227)
- A Free workspace's owner can upgrade: Upgrade opens Stripe Checkout from the claim refusal, its Needs you entry and the workspace's settings (#228)
- A paying owner manages billing in Stripe's portal, and hears about a failed payment before the plan drops (#231)
- The early-access form links to nuworq.com's terms and privacy pages (#232)
- Billing is proven end to end in Stripe's test mode: pay, plan changes, portal cancel, back to Free (#233)
- The outcomes API answers across a workspace: each project's landed, cycle time, cost, owner's time and escapes over 14d/90d/all, with the… (#237)
- Owners see their workspace's analytics on a phone: one line per project, models compared, and a takeaway on top (#239)

**Moving around nuworq and acting in it is fast from the keyboard, without the mouse (#292)**

- ⌘K opens a quick launcher: type a number or a few letters to jump to any item, project or page, change a setting, act on Needs you, or… (#290)

**People and agents send feedback about nuworq, it reaches the hub's owners as feedback, and feedback's own autonomy decides how far it goes… (#293)**

- People and agents send feedback about nuworq, and the hub's owners see it in the admin dashboard and approve or decline it (#295)
- Feedback has its own autonomy (Check with me, Keep moving, Run with it), and scope or direction requests always go to the owners (#296)
- Whoever sent feedback sees what happened to it, and hears once when it's fixed (#297)

**The owner's billing and analytics screens read right: small fixes found after #230's end-to-end run (#310)**

- Analytics put an item under the model its usage reported when its agent never declared one at checkin, not under "Model not reported" (#306)
- On a Free workspace, the rail's "Workspace settings · Upgrade" stays on one line at desktop width (#308)

**nuworq has a look of its own: the Hi-vis palette and a new logo, in the app and on the site (#318)**

- The app wears the Hi-vis palette: graphite on cool grey, a citron logo tile, magenta for your move (#319)
- The logo is the q: a geometric lowercase q on the citron tile, drawn from one source everywhere (#322)
- The board's feedback tag doesn't wear magenta, which means "your move" (#336)

**Live updates never disturb what you're doing: your text box, your cursor and your place in a list stay put (#378)**

- Live updates never take you out of the text box you're writing in: focus, cursor and scroll stay where they were (#374)
- Live updates never move what you're reading: every scrolled area keeps its place, and the line you're on stays put (#376)

**nuworq feels premium: precise, solid and calm, like a well-made tool, with live updates that never flicker or jump (#390)**

- Every screen is built from one strict set of tokens: a short type scale, a spacing grid, three radii, two shadows, tabular figures (#391)
- Live updates change only what changed, in place: nothing blinks, jumps or shifts, and there's no animation (#392)
- Every control answers instantly and solidly: clear pressed, hover and focus states, and actions that show their result at once (#393)
- A precision pass over every screen, measured against the token system and Paul's benchmarks, with every flaw filed and fixed (#394)
- + Work's extra controls are thumb-sized, and Propose with Waits on says it's a proposal (#403)
- The home and project headers keep their buttons on their control's row, beside the title (#409)
- Get started reads cleanly at every width: title on one line, each step's actions under its label (#410)
- Flow's tiles fill the side card edge to edge, four a row (#411)
- An empty state's button starts a line of its own; its links read as part of the sentence (#412)
- All work's column headings stay on one line (#413)
- The scripts' inline styles use the space tokens too, and the token test checks them (#414)
- Sign-in and early access are thumb-sized: every field and button 44px tall (#415)
- The admin page carries the logo beside its name, like every other page (#416)
- Search shows ⌘K only where there's a keyboard (#417)

**Also in this release**

- Core: lifecycle, leases, steering, attention engine (#1)
- Agent transports: MCP server, CLI, OpenAI/Anthropic tool schemas (#2)
- Web UI with 30s / 5m / 30m depth (#3)
- Agent memory: field notes, feedback at checkin, file-collision warnings (#4)
- Security: human and agent tokens, hardening, deploy recipes (#5)
- Shaping as agent work; parked vs stalled projects; "what matters most" (#6)
- Headless worker command (trellis worker) (#7)
- Verified with real agents: Claude via MCP, Codex via the CLI (#8)
- trellis run: a supervisor that keeps up to N headless workers on waiting work in opted-in projects (#9)
- An open-weight model (opencode + Ollama) completes a full Trellis loop via MCP, and what broke is fixed (#10)
- Agent tokens can be limited to named projects, and each agent shows which token it used (#12)
- Fit hints: items say what they need, agents say what they have, and next routes accordingly (#15)
- When something new needs you, the hub pushes one line (ntfy, Slack, or any webhook); otherwise silence (#17)
- `trellis worker` / `trellis run` can start opencode with a local model (--agent opencode --model ollama/...) (#18)
- Docker recipe verified: compose builds, token create works, hub serves with login, data survives restart (#19)
- `next` doesn't hand an item straight back to the agent that just handed it off (#22)
- Workers started by `trellis worker`/`run` get an agent token, never the human's (#23)
- Peer reviewers see the hub's git facts (branch, commits, missing-hash warning) in their review context (#30)
- Push notifications go to the person who owns the entry, not to everyone (#45)
- Six loose ends from the branch merges are fixed or closed with a note (#54)
- The menu shows which version is live: a quiet line under Sign out, like v0.1.0 · c3a3008 (#56)
- nuworq run pauses launches after 3 workers in a row exit without claiming anything, and the hub shows the churn under worth knowing (#57)
- The hub never blocks on the network: mirror fetches run async, off the request path, and fresh decisions await a fetch before their… (#58)
- the "Lives in" folder path for a project is now irrelevant (#60)
- Before the hub moves to a new commit, serve --follow copies its database(s) to backups/<sha>.db; a rollback restores that copy; the last 10… (#71)
- serve --follow restarts itself when a move changes its own code: exits for systemd to restart, or logs one line asking for a restart in a… (#72)
- notify.test.js passes reliably under a full parallel npm test (#74)
- Workers can route their model traffic through llm-proxy (--proxy / NUWORQ_LLM_PROXY_URL): opencode and Codex now, Claude Code refused with… (#75)
- Item usage comes from llm-proxy when the work went through it: tokens, cost, model time and failures for the agent's lease windows (#76)
- serve --follow backs up and restores the host directory (directory.sqlite) along with the workspace files (#77)
- "Connect an agent" gives commands that work when pasted: no shell placeholders, nuworq connect for a hub on another machine (#82)
- "+ Project" lists the repos the GitHub App can see; picking one creates the project, links the repo and offers run's opt-in (#84)
- The hub fetches its repository mirrors with a GitHub App installation token over HTTPS; deploy keys only when there is no App (#85)
- nuworq run/worker clone a project's repo this machine lacks, through the hub's GitHub App, instead of skipping it (#86)
- An owner can remove a project: archive it with its history, or delete it for good after typing its name (#87)
- PR bodies say "Fixes #N" from the issue an item came in from (#65's issues table), not a createItem arg (#88)
- Copy buttons copy their text on nuworq.com (#89)
- Answering a blocking question can keep its item parked ("not yet" answers don't hand it straight back to agents) (#90)
- Workers that route through llm-proxy label their traffic nuworq/<project>/<agent> automatically (#91)
- Item history shows why the hub couldn't open a PR (pr_failed and other landing events), so landing agents can see the reason (#92)
- Find and fix why the hub can't open landing PRs on github.com/paulnorthup/nuworq (#93)
- Connect GitHub looks and reads like the rest of nuworq at every step, and the hub always shows where the app stands (#94)
- nuworq publishes a documented outcomes API: per finished item and per model, landed vs sent back, stalls, cycle time and tokens (#108)
- Binding an App installation to an organization is verified with GitHub, not just a signed state (the setup redirect's installation_id can… (#122)
- A tiny "new" tag marks features shipped in the last 7 days, and goes away once you've used them (#130)
- The Connect an agent dialog offers the Claude Code plugin as an optional line, after #105 and #97 (#132)
- Workers are told to check UI in light only: the browser instruction no longer asks for dark mode (#156)
- The `serve` banner tells you to connect with the installed `nuworq`, not `node <path>/bin/nuworq.js` (#157)
- People see "workspace" everywhere, never "organization": projects live within a workspace (#159)
- needsSteps doesn't refuse decision questions phrased as requests ("Could you decide whether to add…") (#163)
- nuworq no longer carries the marketing site: site/, its test and --site-host go once nuworq.com is served from nuworq-site (#164)
- The hub knows which runners are up: each `nuworq run` reports its state on every poll, and the project page shows it (#171)
- `nuworq run --install` keeps a runner going across closed terminals and reboots, and removes each worker's worktree when it's done (#172)
- Needs you says why nothing is working, with the one fix, and a session that only reads no longer counts as an agent working (#173)
- Staffing is set on the hub: a new project asks whether `nuworq run` may staff it, and each project has a worker limit, a pause and a daily… (#174)
- Flow shows what work costs you: your actions per landed item, and how long Needs you entries wait for you (#175)
- Escapes are counted: landed work that a later item fixes shows per model, with how often a peer's verdict is overturned (#176)
- One scenario test walks the pitch end to end, so a change that breaks one of its promises fails (#177)
- Once a week, one push says what you got: items landed, your actions, what it cost, and escapes (#178)
- Worth knowing only holds what you can still act on: an assumption closes by itself when its item lands or is dropped (#182)
- Agreeing with an agent's assumption reads as agreement: "Confirm", not "Fine" (#183)
- An agent can withdraw its own open question, with a one-line reason, when the answer arrived some other way (#184)
- A project with nuworq run on duty doesn't say "no agent is working" before the runner's first worker checks in (#185)
- A Dependabot alert reintroduced after its item landed comes back as new work (#186)
- Agents keep working through a hub restart or move: the client waits out a restart and follows a moved hub instead of failing until it's… (#222)
- Machines that install nuworq from the live hub can install and update it: the package is reachable and signed (#224)
- A runner installed with `nuworq run --install` finds this machine's checkouts and survives a node upgrade (#225)
- A proposal flagged stale isn't offered for shaping again while its close question waits (#248)
- Reinstalling the runner on macOS leaves a runner running: install waits for the old one to stop, and says so plainly if launchd refuses (#250)
- Installs update to the newest signed release even after the hub has moved on to newer, unsigned commits (#254)
- CI tests on Node 26, the new Active LTS, as well as Node 24 (#257)
- A review waiting on an open question isn't offered to agents again and again (#259)
- A PR the hub opens has one record, even when GitHub's "opened" webhook arrives before the land step writes it (#261)
- An agent who resolved a land job's conflicts isn't offered that item's re-review (#264)
- A review of operator-only work is offered to any agent that may review: it checks the code and the recorded live output, and asks the… (#271)
- Infra work is shaped in two parts: workers build it, and the operator runs only the live step, asked for with exact commands (#272)
- The live hub serves nuworq's first signed release, and an install on Paul's Mac updates from it (#276)
- An accepted group with no code of its own is done at once, not sent to landing for a branch that doesn't exist (#280)
- An operator can wait on the hub: GET /api/wait returns the moment operator work, an operator question, an answer or steering is there for it (#283)
- An idle operator Claude Code session starts a turn on its own when `nuworq wait --operator` reports something: no /loop (#284)
- A review that waits on an open operator question isn't offered to reviewers until that question is answered (#298)
- An idle operator session wakes on its own in the desktop app and the terminal: the live check of #284 (#303)
- An operator keeps work moving without the human: it acts on what the hub already settles and asks only for what only the human can do (#312)
- Test for #303: an operator-only item wakes the idle operator (#317)
- Test for #303: an operator-only item wakes the idle terminal operator (#323)
- Operator work uses one generic infra tag: nuworq-infra and homelab-vm become infra, so any project can keep live-infrastructure work for… (#325)
- The plugin's operator listener starts when /nuworq:nuworq-operator runs, and the skill checks that it is running (#328)
- A fresh operator listener reports only what is new and actionable for the session it serves: no replayed answers, no other operators' tags,… (#329)
- An answer that differs from the asker's assumption steers the asker, not the item's holder, and never the answerer itself (#330)
- next doesn't hand an operator ordinary build work: it gets operator questions, live steps, reviews and landing, and workers build the rest (#333)
- An operator's listener wakes only its own session: another operator's answers and steering on the same token don't start its turns (#335)
- When the hub is down or restarting, agents get a one-line error with a retry hint, not Cloudflare's 502 HTML page (#339)
- `nuworq wait --operator --follow` outlives hub restarts: it retries a 502 or a dropped connection instead of exiting (#342)
- The hub measures what Claude workers cost per item through llm-proxy, not only what the runner reports (#346)
- Rote jobs start on a cheaper model and step up a tier when an attempt fails; the runner starts each worker on the model its job calls for (#347)
- Every item gets a difficulty when it's shaped, and a small share of jobs try a cheaper model, so nuworq learns what each model can do (#348)
- nuworq routes each job to the cheapest model whose results are close to the best, at the quality bar the project's owner sets (#349)
- nuworq is ready to go public: its history is scanned clean, the scan reruns anytime, and the switch is written down (#354)
- People let in through early access can run several agents at once from day one (#355)
- Each early-access request shows where it came from, and the admin dashboard counts how far each source got (#356)
- Anyone can watch agents build nuworq live: a public, read-only view of the nuworq project (#358)
- Runner workers load only the MCP servers the runner gives them: no plugin or user MCP servers with another identity (#360)
- `claude plugin update` installs nuworq's latest plugin: the manifest no longer pins version 0.2.0, so every commit on main is an update (#364)
- An agent told to drop an item can see the question id `refine drop` needs: next and look show each question's id (#366)
- Runner workers don't load a person's user-level skills (~/.claude/skills), such as nuworq-operator (#368)
- The preview server's launch config is named nuworq and starts bin/nuworq.js, not the old trellis name (#370)
- Every command you're asked to run copies clean: one Copy per command, never with backticks or the words around it (#379)
- New users get going from a getting-started guide in the app that always matches the running version (#381)
- New users read a getting-started guide at /guide that walks them from sign-in to a first landed item (#383)
- npm test fails when the getting-started guide names a command, flag, page or label nuworq no longer has (#384)
- Agents' guide says an item that changes a new user's path updates /guide in the same change, and reviewers check it (#385)
- Once a week, when something the guide covers changed, the hub opens one walk-through item to follow /guide on a fresh workspace (#386)
- A question is always shown whole; other long lines are cut at a sentence, never mid-sentence, and the agent is told (#387)
- People propose work straight from a project's board, without an agent or the CLI (#389)
- Items say when they break someone: a breaking flag with who must do what, set at shaping and checked in review (#398)
- When a milestone finishes, the hub proposes the next release: its version, changelog and upgrade notes drafted from what landed (#399)
- The hub says which release it is on and which installs it still supports, and an older install gets "run nuworq update", not odd errors (#401)
- An operator listener never misses a push: work that becomes ready while it waits reaches it, across in-process hub restarts (#406)
- The operator skill notices a stale nuworq CLI: a plugin update no longer leaves the listener running old code (#419)
- nuworq releases per milestone: the setting is on, now that the hub runs #399 (#420)
