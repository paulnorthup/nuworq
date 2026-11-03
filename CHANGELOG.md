# Changelog

## 0.11.0 (2026-11-03)

What landed since v0.10.0.

**After v1.0.0, nuworq stays as hardened and as true as the re-check asked: its medium findings are fixed (#833)**

- Signing by hand runs only code from the last signed release, never whatever the checkout holds (#829)
- One token can't flood a hub by checking in under new names: write limits count per token (#831)
- The README says who checks work as it is: under Keep moving the person verifies, not another agent (#832)

**Pre-release audit #835's findings are fixed: the release signing path holds against landed code and a compromised hub, and a passed-on… (#840)**

- Signing a release by hand runs only code from a signed release, never the checkout's (#836)
- The release approval summary compares with a signed release it verified, not one the hub names (#837)
- Only a person's own words drop or hold a parked item, never a reply they pass on (#839)
- The release approval summary can't be fooled by a swapped release key or a hub commit that isn't a sha (#842)
- Signing by hand's recipe works with the last signed release's own command line, v0.9.0's included (#843)

**Pre-release audit #849's findings are fixed: the release key's folder is hidden from workers, and comment and field-note caps count per… (#853)**

- Workers can't read the release key's folder: ~/.nuworq-release is among the paths the sandbox hides (#850)
- One token can't use up a project's day of comments or its field-note room for every other agent (#851)

**Also in this release**

- Work dropped by a person's answer can't merge: dropping it turns its pull request's auto-merge off (#827)
- nuworq.com's privacy and terms pages say only what the hub does: no "never stores your source code", every processor named, no export… (#828)

## 0.10.0 (2026-11-03)

What landed since v0.9.0.

**In this release**

- Updates go live with no gap: a stable front hands connections from the old hub to the new one, and only the newest runs background loops (#523)
- Workers load only the nuworq tools they use: definitions load when first called, and the longest tool descriptions are cut (#678)
- Someone new can start and keep going from the docs alone: the guide, README, docs/, CLI help and nuworq.com describe v1.0.0 as shipped (#685)
- Live: a 10 Hz probe through two deploys after #523 sees no refused request (#787)
- Accepted work lands without a new review only when it is the reviewed change in the same place: a rebase or merge of main can't move its… (#806)
- The README is a front page for people: the logo and name on top, what nuworq is, a short quick start, and where to go next (#808)
- Sections of the project page fold away: click a heading to fold it, and it stays folded until you open it (#809)
- CI tests on Node 24 only, the minimum nuworq declares, in one job named test (#811)
- Releases are signed on GitHub Actions once the maintainer approves them with one tap, and the signer service on their Mac retires (#813)
- The first release is signed by the GitHub workflow after the maintainer's approval, and the Mac signer retires (#815)
- Nothing in the repository names its maintainer: docs, help, screens and code say the maintainer, the owner or you, and a test keeps it so (#817)
- Answering "drop" to the question a parked item waits on drops it, and "not yet" keeps it waiting, instead of either one releasing it (#819)
- The rail is only navigation: projects and Connect an agent stay, while settings and help move into a workspace menu and a help menu (#824)

## 0.9.0 (2026-11-03)

What landed since v0.8.0.

**nuworq is ready to launch: newcomers get in and get going, and the maintainer sees which channels bring people who stay (#359)**

- nuworq's repository is public and anyone can install the Claude Code plugin from it (#365)

**Also in this release**

- Deploys never drop work: only commits CI passed go live, after a test boot on copies of the live data, and the old hub drains first (#522)
- A day on the live hub after #515: agent writes through the tunnel get no connection-reset 502s (#534)
- A day of deploys after #545 measured: 502s and cut requests per deploy, against the 2026-11-01 baseline (#575)
- The maintainer gets through feedback in minutes: repeats arrive as one group that says what's known and suggests a call, decided in one tap (#688)
- One word, one meaning: release, review, note, finished and direction each mean one thing in the app, the CLI and the guide (#707)
- Getting going uses one name per step: connect an agent, start workers, + Project, staff it, Get started, Home (#708)
- People never see \"organization\" for a workspace: the --org-cap hint and DEPLOY.md say workspace (#709)
- Agents that don't say where they run read by name, not all as "Agent" (#713)
- An agent checking in to a project slug that doesn't exist is told it made a new project, and which one it may have meant (#714)
- Every agent error names what's wrong and carries a hint: no "undefined", no hintless 404s (#715)
- Commands on a phone wrap only at spaces: never "--" on one line and "staff nuworq" on the next (#716)
- In dark, the chosen depth, autonomy and appearance stand out at a glance (#717)
- An off switch in Settings reads as off: only an on switch is filled (#718)
- The hub's field-notes review item reads cleanly: no leading blank line, no "Then…" with nothing before it, lists that render (#719)
- Analytics' Difficulty or size counts only rated items under each rating (#720)
- "new" tags stay rare and sit beside their feature: a few per screen, never over words or adrift in a dialog (#721)
- Cheaper models work out of the box: routing is on by default, and Claude's tiers default to Haiku, Sonnet and Opus 5.5 (#723)
- A runner worker creates its item's branch without a sandbox error (#724)
- Staffing says when a model trial can't run: a trial share needs two or more models listed, or it does nothing (#725)
- Handing off a land job keeps the item landing for another agent; the accepted review stands (#729)
- A dependency that would make a cycle is refused, with a hint naming the loop (#730)
- A blocking question parks only work the asker holds; the holder of other work hears about it instead (#731)
- A workspace always keeps an owner: an unverified owner doesn't count as the second one (#732)
- Progress sent after the lease ran out stays on the record as a comment, as the error says (#733)
- The release drafted after one lands carries the next version, not the one that just shipped (#735)
- A person's edits to a release draft survive every redraft (#737)
- One background error doesn't stop the hub: notifier, workspace wake and stray rejections are caught and logged (#740)
- The follower restarts a hub that stops answering, and a crash loop backs off and is reported (#741)
- A GitHub blip while opening a pull request is retried before the work falls back to a land job (#742)
- A landing PR whose CI failed is noticed even if GitHub's check webhook never arrived (#743)
- A push that fails while a channel is down is sent once the channel is back (#744)
- Milestones that are only waiting step out of sight until their wait ends, and Stuck means something must change before it can move (#746)
- A form's error shows at its field: "Name it" and "A channel needs a URL" sit by the input, not in a toast across the screen (#748)
- A live update at 30s sends what 30s shows: the view leaves out the agent list and stage lists until 5m (#750)
- Turns per job are recorded: each run's turn count is kept beside its tokens and cost, and shown per kind of job (#751)
- A finished tidy job counts as finished: outcomes and model routing see "tidied", not "open" for ever (#753)
- Every stall says why: a worker's exit reason and each lapsed review or landing lease carry a cause, and outcomes breaks stalls down by it (#754)
- The hub's start-up forget of gone workspaces keeps a copy first, so a workspace file moved aside doesn't lose its directory rows for good (#755)
- A release precondition reads GitHub only through its own workspace's app installation (#758)
- An item's branch can't be taken over by naming it: submit and the push proxy keep each nuworq/ branch with its own item (#759)
- A release tag the hub can't create reaches an operator as work, not only a tag_failed event (#760)
- A person hears about spend before it surprises them: a push at 80% of a project's daily budget and when one worker passes $50 or 60 minutes (#767)
- Workers run only the project's checks by default, and codex can't read the person's keys (#768)
- A person's data can be deleted as the privacy policy promises: their sign-in, sessions and early-access request go on request (#769)
- Turning on Cheaper models says what it does: builds try cheaper models too, and a lost lease also steps up a model (#770)
- test/service.test.js passes in a Claude Code sandbox: its "no claude in the plist" check ignores the temp folder's name (#771)
- Connect asks how this machine pays for its models (subscription or API key) and sets worker caps to fit (#776)
- Accepted work still lands when main is merged into it or rebased under it next to main's own edits: the hub compares only what the change… (#784)
- A worker's exit leaves other live workers' branches alone: #618's ref guard reverts only what that worker could have moved (#788)
- Workers are told how to run tests in the runner: the hints say `npm test -- <file>`, which the sandbox allows, not `node --test` (#789)
- nuworq up starts fully featured workers: auto counts by CPU, so a Mac with idle cores runs several, and each gets a browser (#790)
- No trace of the old name Trellis is left: its command, settings and every old-name fallback are gone, and a test keeps it that way (#792)
- Workers a runner starts together each get their own job, so a restart with free slots doesn't send them all to one item (#793)
- No default per-worker cap, as decided in Q230: the caps are opt-in flags, and nuworq up writes none (#795)
- A runner worker can delete a tracked file in its own worktree: `git rm` is allowed there, nothing else gets looser (#796)
- The guide says plainly what an operator is and how to start one, with nuworq up first (#797)
- A workspace's owner can delete it in the app: they type its name to confirm, and everything in it goes for good (#799)
- A submit's hint keeps its branch notice when steering waits: "X is #N's branch, so #M keeps Y" is never replaced by "The human has steered… (#800)
- The getting-started guide leads with the easy path in plain words: nine steps, with the shaper and nuworq up first (#801)

**Upgrade notes**

- Codex workers on a project with a remote no longer start: use --agent claude. Workers no longer run npm install or npm scripts other than test, lint, check, typecheck and build: add any they need under the project's Settings → Worker commands. (#768)
- Old Trellis names stop working: the `trellis` command (use `nuworq`), TRELLIS_* variables (NUWORQ_*), .trellis.json (.nuworq.json), ~/.trellis and trellis.db (~/.nuworq/nuworq.db), trl_ tokens (make nwq_ ones with `nuworq token create`), the trellis_session cookie (sign in again), x-trellis-* headers (update old clients), "trellis:" browser prefs (set again) and trellis/<agent> branches (nuworq/<agent>). (#792)

## 0.8.0 (2026-11-03)

What landed since v0.7.0.

**Workers keep the machine responsive: CI runs the full suite, and nuworq run adds workers only while there's CPU to spare (#531)**

- An hour of the maintainer's runner on --workers auto: workers and load over time, then back to its own setting (#548)

**Also in this release**

- GitHub guards nuworq's repository before it goes public: main and release tags are protected, private reports are on, old branches are gone (#476)
- The hub knows each agent session: later calls send only what's new to it, and its lease renews without spending model turns (#519)
- Runners wait for work on a long-poll, so a worker starts about 1 second after work appears instead of polling every 30 (#542)
- Feedback #7 closed: once #654, #658 and #660 are live, a runner worker's next never answers "can't review your own work" (#661)
- Feedback #2 closed: an operator sharing a device token with runner workers isn't refused their reviews, and next never answers with the… (#663)
- The reported #640 loop stays fixed: next, peeking or claiming, never offers a review that review refuses (#665)
- A full audit once today's work is done: nuworq is usable, bug-free, reliable, secure, efficient and polished, and does what nuworq.com says (#676)
- A live update at 30m redraws only the sections of the page whose data changed, not the whole 880 KB page (#682)
- A landing PR that GitHub closes because main already holds its branch counts as landed: the item is done, not sent back (#686)
- Needs you's "finished it 3m ago" ticks in the page, so a minute passing doesn't redraw all its cards (#689)
- The follower's CI fallback clock runs from the first commit it waited on, so a busy main still deploys within 30 minutes (#690)
- A question that asks a person to do steps stays in Needs you after its item lands, until the steps are done (#692)
- Audit: usable. A newcomer and the maintainer get going, steer, answer and land on phone and desktop; agents' hints carry them (#694)
- Audit: bug-free. The item lifecycle, leases, landing, releases, sign-in and the runner hold up at their edge cases (#695)
- Audit: consistent. One name for each thing and one way to do it across the app, CLI, guide, tool descriptions, docs and nuworq.com (#696)
- Audit: reliable and stable. nuworq keeps working for days with nobody watching, through restarts, deploys, outages and loops (#697)
- Audit: polished. Wording, empty and error states, loading, alignment, light and dark are right everywhere a person looks (#698)
- Audit: effective. Measured from the hub's history: what lands without the maintainer, first-time accepts, bounces, waits, cost (#699)
- Audit: efficient. Tokens, turns and dollars per job, a worker's first load, hub cost per request, browser payload: measured (#700)
- Audit: secure. Changes since #468's re-review, plus what open source adds: forks, outside PRs, CI, releases, plugins, history (#701)
- Audit: hardened. Limits and timeouts on every input, queue and loop; cheap outages; pinned deps; safe defaults (#702)
- Audit: true to its claims. Every claim on nuworq.com and in the README is listed with its verdict: true, not yet, or reworded (#703)
- Live check: the hub refuses a runner worker's push to main and to a tag through /api/git (#704)
- "Keep this one" on a raced item keeps that attempt again: the app's two keep actions get their own names (#705)
- The lifecycle reads the same everywhere: Done means landed, every stage can be looked at, and hints name only real operations (#706)
- A question named by its number is easy to find: each question card shows Q207, and ⌘K opens "q207" or "question 207" (#710)
- On a phone, Needs you's first card is on the first screen of the home and of a project at 30s (#711)
- A question waiting for an operator shows its steps, and whoever is there can do them and answer it; its guide link opens /guide#operator (#712)
- Sending back or dropping a landing item stops its pull request merging: auto-merge goes off (#726)
- Only an item's own branch merging marks it done: a PR from another branch that names "#N" doesn't (#727)
- A workspace name freed by remove starts clean: no old GitHub installation, plan, grant, members or creator (#728)
- Work that keeps killing its worker reaches a person: a worker's exit without submitting counts as a stall (#734)
- A stuck worker gives its item back: leases renew only with progress, and the runner's git calls time out (#736)
- A hung GitHub fails a worker's push in seconds: the hub's push proxy times out and cancels upstream (#738)
- GitHub calls back off: an issue that won't close is retried less and less, and rate limits are waited out (#739)
- Widening the window keeps the project page whole: Needs you's summary, Flow and Agents never vanish (#747)
- Names removed before #728 start clean too: the hub forgets directory rows of workspaces that no longer exist (#749)
- Landing costs cents, not dollars: a land job's average run costs a fraction of building, measured on the live hub (#752)
- Before going public, the release branch, v* tags and outside contributors' workflows are guarded on GitHub: checked live (#757)
- A runaway worker is stopped while it runs: spend counts during the run, every worker has a default cap, and a killed run still counts (#761)
- A project's daily budget stops claims, not only new workers: next refuses a runner worker new work once the budget is spent (#762)
- The runner pauses on a streak of failing workers however long each took, not only those that fail within 15 seconds (#764)
- Agents' long text fields have limits, refused with a hint past them (#765)
- One agent can't flood a hub: per-agent write limits and per-project caps (#766)
- The secret check takes time in proportion to the text, however a write is shaped, so no write can stall a shared hub (#780)
- Needs you renders whatever an item's title or a question says: only the hub's own time markers become times (#781)
- A project's daily budget counts live spend only from runner tokens, for their own running workers, within each worker's cap (#782)

**Upgrade notes**

- Runners now stop a worker at $25 spent or 90 minutes by default, and `nuworq up` / `nuworq run --install` write these caps into the service. If your workers often run past them (long audits), run `nuworq run --install --workers auto --worker-usd <N> --max-minutes <M>` (0 turns a cap off) from your checkout: it replaces the installed service, and `nuworq up` keeps it from then on. (#761)

## 0.7.0 (2026-11-02)

What landed since v0.6.0.

**nuworq is easy on the eyes in the dark: a calm graphite theme in the app and on the site (#482)**

- The app has a calm dark theme that follows the device: graphite, softer text, softer state colors (#484)
- You can set the app to Match device, Light or Dark, and each browser remembers it (#485)

**Getting going takes one copied block and a few yeses, and ends in the setup that works: workers, an operator in a terminal, a shaper (#488)**

- nuworq suggests the setup that works: workers on nuworq run, an operator in a terminal, and a shaper in the Claude Code app (#489)
- Setup is measured, not assumed: a newcomer's walk to the three sessions is timed and counted, before and after, and meets its targets (#492)
- /nuworq:operator with nothing after it declares everything the session can really do, and its routine commands run without prompts (#494)
- Claude Code gets nuworq in every project: connect installs the plugin for the person's account and clears nuworq's own leftovers (#496)
- nuworq up brings everything up: a runner with automatic workers and one operator per unparked project, each in its own terminal (#559)
- nuworq up never starts a duplicate operator against a hub that doesn't list operators, and a restarted runner keeps its agent token (#582)
- The guide's "The operator" essential can be linked again: no two elements share id="operator" (#592)
- Staffing is asked once, where it can happen: the project page doesn't offer it before a machine can run workers, and connect skips it when… (#643)
- Connect an agent shows one block to copy; what connect sets up for you sits folded beneath it (#644)
- Wherever nuworq names the shaper and operator commands, it gives the form this machine has: /nuworq:… with the plugin, /nuworq-… without (#645)
- The setup lines name the command first and the no-plugin form after it: "type /nuworq:operator (or /nuworq-operator without the plugin)" (#646)

**Switching projects feels instant: a project shows the moment you click it, and even nuworq's page is quick to build and send (#499)**

- The hub builds each project's page once per change and sends only what the depth shows: nuworq's in under 100 ms and 150 KB (#501)
- A project appears the moment you click it: its header from what the app already knows, the rest filled in place (#503)
- Live hub measured after #502: time per live update for nuworq under 50 ms, and agents' p95 before and after (#513)
- A click on a big project draws its header in the first frame and the rest in the next, so it shows within 100 ms (#637)

**Needs you puts the most important first: cards ranked by the priority of the work they hold up, in the order agents work (#504)**

- Needs you shows why each card is where it is: a quiet priority mark on each, most important first, and the 30-second line counts what's now (#506)
- Push messages list what needs you most important first, and their first line says how many are now (#507)

**Steering & memory reads as direction a person can own: only people's steering, item steering retires itself, memory in plain words (#549)**

- Your steering shows only what people wrote; operators' answers and the hub's notices live on their item, as one plain line (#550)
- Steering about an item retires itself when the item is finished or dropped, and today's stale steering goes, each with its reason (#551)
- Memory is distilled for people: a short Direction today, a plain gist and a recommendation for each note, one-line decisions (#552)
- Live Steering & memory after #552's first distill: what a person must read, against the 2026-11-01 baseline (#619)

**Also in this release**

- Workers stay inside their job: a sandboxed shell, exact commands, pushes only to their own branch, and landing on main done by the hub (#472)
- Code reaches people's machines only with the maintainer's approval: they approve each release before it's signed, and the plugin installs from releases (#473)
- Security stays checked: a threat model in the repository, and a fresh review before every release that holds it on a serious finding (#480)
- The release signer runs #473's code: it signs only approved releases, and origin's `release` branch exists (#486)
- A headless claude with #472's worker sandbox settings is refused writes outside its worktree, ~/.ssh reads and off-allowlist network (#487)
- pi works with nuworq like the other harnesses: connect registers it, nuworq run starts pi workers, and it's tested end to end (#495)
- Worth knowing holds only what a person might act on: agents' assumptions, unseen steers and real trouble, one line each (#497)
- app.nuworq.com sends #479's edge: HSTS on every response, generic 500s with an id, no `bin` in /api/info (#508)
- Writes through the tunnel stop failing: the hub keeps idle connections longer than cloudflared does, and says how long it keeps them (#515)
- Only real changes travel: reads and lease renewals change nothing, and each change names the project and item it touched (#517)
- Each project loads once per request: views, checkin, next and route compute from one snapshot instead of a query per row (#518)
- Every agent sees the whole rulebook: a guide core that fits Claude Code's limit, mode rules in next's hints, tools by role (#520)
- The CLI is generated from the protocol: every operation and parameter reachable, unknown flags and fields refused with a did-you-mean (#521)
- Many workspaces cost little: a workspace opens when it's used and closes when idle, and push work runs only where channels exist (#525)
- Agents get compact JSON, gzipped when they accept it, and look without an item gives counts and the top items per stage (#528)
- Relative times tick in the browser, so the page drops its 30-second refresh (#530)
- Where CI checks every pull request, workers run only the tests near their change, and a red CI sends the work back (#532)
- Drift detection (tidyUp, reviewUp) runs on the sweep timer, not on every claim (#536)
- A per-project snapshot: view, homeView, projectList, claimable, briefing and groupsOf compute from one load instead of a query per row (#538)
- After the first checkin, an agent session gets only what changed: mission, decisions and field notes sent once per session (#539)
- Leases renew without the model: the runner renews its live workers, and an attended session's MCP process renews while it's active (#540)
- The MCP process refetches tools and the guide only when the hub's protocol changes, not every 60 seconds (#541)
- A commit goes live only once CI's required check passed for it; the VM stops running the full suite (#543)
- Before a deploy switches, the new code boots on a side port against copies of the live databases and answers health (#544)
- The hub drains on shutdown: in-flight requests finish, waits answer empty and live streams reconnect, within 10 seconds (#545)
- The follow supervisor imports only node: modules and follow.js, so a commit that changes the CLI never restarts it (#546)
- runner.test.js's --max-minutes test waits for the signals instead of a fixed 50 ms, so it doesn't fail and hang the file under load (#553)
- headsup.test.js's "keeps its answer without running merge-base" doesn't race a queued refresh under load (#556)
- refreshBehind runs one at a time, so the "heads haven't moved" test can't count a background refresh's git calls (#557)
- A session that ends signs itself off: its MCP server hands back what its agent held, and the hub stops listing it at once (#558)
- A red main reaches someone on a hub with workspaces: follow files "fix main" in the workspace that owns the repo (#561)
- A bouncing item says why and what it waits on, and reaches Needs you only when a person can actually help (#564)
- wait.test.js's restarted-hub test passes on a loaded machine: its 1-second bound doesn't fail at 1.1 s (#569)
- wait.test.js's hub-restart test stops failing on a busy machine: its 1-second bound has room over the ~0.9 s it takes (#576)
- Workers can't read Claude Code's or opencode's own credentials: DENY_READ covers ~/.claude/.credentials.json and ~/.config/opencode (#580)
- Workers can't read opencode's stored provider keys: DENY_READ covers ~/.local/share/opencode/auth.json (#581)
- wait.test.js's restarted-hub assertion accepts a wait asked in the same millisecond the item became ready (#584)
- Main is green again: docs/CLI.md is regenerated with the pi env vars help all now prints (#588)
- The app's files revalidate instead of downloading again: no-cache with a content ETag, 304 when unchanged (#598)
- The app starts with its requests in parallel, and fetches nothing twice (#599)
- The app's state lives in a store module: every field declared up front, changed only through setters (#600)
- The app keeps each answer per URL until a change event says it changed (#601)
- An update redraws only the region whose data changed: rail, main and drawer each a pure view module (#602)
- A release signed by hand is GitHub's own build of a tag the maintainer approved, on main (#603)
- Workers push only their held item's branch, and landing merges only the head that was reviewed (#605)
- A worker on a project without an origin can't write what unsandboxed git or agents later read (#606)
- The operator's commands that run without a prompt never run a program or write files the person didn't ask for (#607)
- Plugin installs from before #473 move onto the release branch when nuworq connects (#608)
- Only a token a steward or owner minted can act as an operator (#609)
- Agents can tell an operator's answer and steer from a person's (#610)
- A field note a person pinned stays until a person unpins or retires it (#611)
- A verified sign-in never vouches for a session someone else opened from an invite link (#612)
- An outsider's issue keeps the title a person let in (#613)
- "Fix main" files only in the workspace bound to the repository's GitHub App installation (#614)
- Every worker harness starts with the machine's keys unreadable, or the person opts in knowing it can read them (#615)
- Workers' read denies and environment cover every stored credential (#616)
- nuworq up starts operators only in folders the person chose (#617)
- A worker exiting leaves the checkout's other branches where they were (#618)
- A restarted hub supervisor starts on the last commit that passed CI, not on untested main (#620)
- Only GitHub Actions' test check counts as CI's verdict (#621)
- A token can't review or security-review work it built under another agent name (#622)
- Replies kept for retried requests never hold a credential (#623)
- The runner checks the sandbox hosts the hub sends are host names (#624)
- The worker allowlist refuses git options that run a program (#625)
- Worker logs hold no provider or llm-proxy keys, and the browser MCP server comes from the package, not npx (#626)
- An agent token does no more than its minter's current role allows (#629)
- Joining a workspace takes the person's own confirmation: no cross-site link signs them into a workspace they were invited to (#630)
- People's emails show only to those who manage people; others see handles and roles (#631)
- A memory distill never retires a field note a person pinned (#633)
- Main holds no stray test logs: .test-550.txt and .test-550b.txt leave the repository root, and a test keeps them out (#635)
- A machine's workers can review each other's work: nuworq run gives them a runner token, not the person's connect token (#656)
- Workers of one runner review each other's work again: a runner's workers count as themselves alone, whatever token the runner uses (#658)
- next never offers a review that review would refuse as the caller's own work (#660)

**Upgrade notes**

- Machines running nuworq run or worker with --agent codex, opencode or pi must add --can-read-keys; for an installed runner, run nuworq run --install again with it. (#615)
- Workers no longer inherit the runner's environment: a project whose build or tests need a variable (DOCKER_HOST, VIRTUAL_ENV, JAVA_OPTS…) names it with nuworq run --env NAME (an installed runner: nuworq run --install again with it) (#616)
- Worker or operator machines a member connected can no longer claim, review or push: a steward or owner reconnects them (nuworq connect), or an owner makes the member a steward. (#629)

## 0.6.0 (2026-11-01)

What landed since v0.5.0.

**When work is waiting, workers are on it: nobody has to start an agent (#170)**

**Also in this release**

- Codex workers can go through llm-proxy too: its passthrough carries the OpenAI Responses API on the LAN/tailnet route (#362)
- Agents show only while they matter: working or seen in the last hour; signed-off sessions leave every list at once (#441)
- Old work leaves the board: done after 3 days, dropped at once, finished milestones fold up, stale ready items get asked about (#442)
- Field notes stay few and relevant: checkin gives the ten that fit your work, and notes whose lesson is now built in are retired (#443)
- No leftovers on disk or GitHub: workers remove their worktrees, landed branches are deleted, and a weekly sweep clears the rest (#444)
- The home's "Here now" counts wrap cleanly in the narrow side column, with no stray indent or tall gap (#445)
- The first leftovers sweep has run on the maintainer's Mac, with worktree and branch counts before and after (#447)
- The leftovers sweep can read finished branches: agent tokens may GET /api/finished (#448)
- A field-notes review doesn't open another review just for the notes it wrote (#451)
- Deleting a project never fails on a mirror that a fetch is still writing into (ENOTEMPTY seen on Node 24 CI) (#453)
- The sweep clears landed work it keeps today: branches rebased before landing, and worktrees from the project's old path (#455)
- A runner moves onto a newly installed nuworq by itself: it restarts between workers when the package under it changed (#456)
- A fresh operator listener doesn't replay answers its session already read: idle operators take no turns for old news (#458)
- feedback.test.js waits for the sender's push instead of asserting right after landing (flaked on Node 26 CI) (#460)
- Work can wait for a date: a precondition { kind: "date", after: "2026-11-08" } keeps an item out of the queue and out of Needs you until… (#464)
- An operator question goes to one operator at a time: next leases it like an item, so two operators never act on the same question (#467)
- Agent operations are for agents, and each agent acts only as itself: a person's role and a token's identity decide what a caller may do (#469)
- Who someone is comes only from how they signed in: plans, owner rights and notifications never follow an email someone typed (#470)
- Text from outside the project waits for a person before any agent works from it: strangers' GitHub issues and replies are held like feedback (#471)
- The hub reaches only the public internet on people's behalf: notification channels and preconditions can't touch the network it runs on (#474)
- nuworq's repository is ready for anyone to read: a license, a way to report vulnerabilities, a complete history scan, nothing private (#475)
- A runner trusts its own machine, not the hub: it checks what the hub sends and keeps its token out of commands, environments and logs (#477)
- GitHub and Stripe events count only from those entitled to send them: installs bind to their owner, strangers' PRs change nothing (#478)
- The hub's web edge is hardened: real client addresses, links from its own address, HSTS, quiet errors, single-pass markdown, capped streams (#479)
- The CLI's help reads at a glance: one screen for a bare nuworq, help for each command, and a full reference, all from one table (#481)
- nuworq connect finishes the setup: it asks once each to install the plugin, staff the project with workers, and start an operator (#490)
- Staffing is never off without saying so: nuworq run tells you when no project is opted in, and offers to opt in the one you're in (#491)
- A worker's llm-proxy token stays off its command line: ANTHROPIC_CUSTOM_HEADERS isn't copied into the start string (#493)
- A live update refreshes only what changed: the project on screen when the change is in it, never a reload for another project's news (#502)
- Each Needs you card carries the priority of the work it holds up, and the hub ranks cards by it, the way it ranks work for agents (#505)
- An installed nuworq names its own commit, even inside another git repository such as Homebrew's (#511)
- The database has the indexes its queries need, migrations are numbered and fail loudly, and a request writes only what it must (#516)
- Agents' writes can be retried safely: each carries an idempotency key, so the client retries writes through 502s and restarts (#524)
- The guide's core fits in 3,500 characters, and each mode's rules arrive in next's hint for that mode (#527)
- Agents get only the tools their role can use, with short descriptions and one precondition schema (#529)
- nuworq run --workers auto starts another worker only while the machine has CPU and memory to spare, and says why it's holding (#533)
- No request path runs git synchronously: "main moved past your branch" is cached per repository, branch and base head (#535)
- Outcomes read finished items' events in one query, and cellStats isn't recounted after every event (#537)

**Upgrade notes**

- Machines running `nuworq run` (or its service) must choose the folders workers may use, by running `nuworq run` once in a terminal or `nuworq run --folder <path>`; until then the runner starts no workers. (#477)

## 0.5.0 (2026-10-31)

What landed since v0.4.0.

**Each finished milestone becomes a versioned, signed release with a changelog and upgrade notes, in any project (#397)**

- Releases sign themselves on the maintainer's Mac: a signer service signs each vX.Y.Z tag on main, built from GitHub, and puts the signature on the hub (#430)
- The release signer runs on the maintainer's Mac, and v0.3.0 is signed by it, not by hand (#431)
- A release tag gets signed even when the hub never ran its commit: v0.4.0 (e596c95) is stuck unsigned (#434)
- v0.4.0 is signed by the signer and installs on the maintainer's Mac with its changelog, once the hub runs #434 (#435)
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

**Cost and tokens per item: captured where possible, shown per finished item and model, and capping nuworq run (#16)**

- Usage is recorded per item: tokens and cost from the runner's agent CLIs, or reported by agents (#28)
- Cost shows per finished item by model in Flow, and nuworq run stops at a --max-usd budget (#29)
- Recording a worker's usage after it exits doesn't bring it back online (#61)

**Hosted nuworq: a company signs up, connects its agents, and runs its projects on one shared hub (#31)**

- One hub process serves many workspaces: one SQLite file each, picked by subdomain or /w/<slug>, fully isolated (#32)
- People have accounts: sign in with GitHub or Google, join by invite, and hold a role per workspace (#33)
- `nuworq connect <workspace>` sets up a machine in one command: browser login, saved token, MCP registered (#34)
- Projects are found by git remote, so every clone on every machine reaches the same project (#35)
- "Needs you" is per person: each act-level entry has owners (stewards, or whoever steered the item), and the view is written for the viewer (#36)
- Agent tokens record who minted them (a person or a runner) and carry powers (shape, build, review) that the hub enforces (#37)
- Agent writes containing secrets are refused before anything is stored, with a hint naming the field (#38)
- People and roles: each human is a person with a role, and every human action records who did it (#40)
- Invite links: an owner invites a person with a role; opening the link signs them in (#41)
- Sign in with GitHub or Google: OAuth/OIDC login maps to a person, with zero dependencies (#42)
- Device login: a CLI gets a person's agent token by showing a code the person approves in the browser (#43)
- `nuworq connect <workspace>` saves a 0600 credential and registers MCP for installed agents; `disconnect` undoes exactly that (#44)
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

**Early access works end to end: a request reaches the hub's owner, who lets people in from admin.nuworq.com, and they start at app.nuworq.com (#109)**

- The app runs at app.nuworq.com and nuworq.com is free for the landing page; old app links redirect (#110)
- nuworq.com landing page: a static site/ with the promise, how it works, why it's different, planned pricing, FAQ, and an early-access… (#111)
- Early access: a spam-proof request form, a list hub owners approve from, and an invite that lets the person create their organization (#112)
- Plan limits are enforced where work is claimed: Free runs one agent at a time (#113)
- The hub serves the app under its public URL (app.nuworq.com) and sends app paths that reach the apex there (#119)
- app.nuworq.com is live: tunnel route, DNS, the hub's --public-url and --site-host, and the GitHub App's URLs (#120)
- The early-access button opens a form that sends the request to the hub, with Cloudflare Turnstile (#121)
- A running single hub moves into workspaces mode without losing anything: its projects, tokens and history become one workspace, and… (#204)
- Signups are live: the live hub runs with workspaces and early access on, the form's spam check has real keys, and the maintainer is its owner (#205)
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

**The home page is the 50,000-foot view: everything that needs you across all projects, then a one-line pulse per project (#124)**

- GET /api/home answers "does anything need me?" across every project in one request (#125)
- The signed-in home (#/) shows everything that needs you across projects, with actions working in place (#126)
- The new home is verified on screen: 375px and desktop, light and dark, with screenshots (#127)

**An operator lane: run/infra/admin work and questions go to an attended operator session, and the human sees only decisions and escalations (#131)**

- Questions an agent can't settle alone go to: "operator" and are answered by an operator session, not the human (#133)
- An operator escalates to the human with one precise question and its evidence, and the human's answer reaches the original asker (#134)
- The guide and README explain the operator role, its capability tags, and the /loop prompt that keeps an operator session running (#135)

**The operator lane, finished: default routing, quiet waiting, a one-command operator session, and an end-to-end proof (#136)**

- An operator session gets operator work before anything else, and work only an operator can do never asks the human to start an agent (#137)
- When an agent omits `to`, the hub sends run/permission/infra questions to the operator and decisions to the human (#138)
- `nuworq operator` prints the capabilities to declare and the /loop prompt, and the nuworq skill knows the operator role (#140)

**Anything that needs a person comes with numbered steps, and Needs you shows them as a checklist (#160)**

- ask carries numbered steps, and the hub refuses a do-this question to a person without them (#161)
- Needs you shows a question's steps as a checklist the person ticks, and the last tick reports back (#162)

**admin.nuworq.com: the hub's owner runs the hub from an admin dashboard only they can open: early-access approvals, workspaces and plans (#165)**

- The hub serves an admin dashboard on its admin host, only hub owners get in, and early-access requests are decided there (#166)
- A new early-access request reaches the hub's owners as a notification that opens it on the admin dashboard (#167)
- admin.nuworq.com is live: tunnel route, DNS, the hub's --admin-host, and sign-in callbacks (#168)
- The admin dashboard lists every workspace with its plan, and the hub's owner switches a workspace between Free and Unlimited there (#169)

**Projects on nuworq stay nu: known vulnerabilities get fixed and dependencies stay current without anyone asking (#179)**

- Each Dependabot alert on a project's repository becomes a ready nuworq item, ranked by severity, and closes when GitHub marks it fixed (#180)
- Every project gets a weekly freshness sweep: an agent lands safe updates in one batch and proposes each breaking upgrade with a migration… (#181)

**A person sees the work as a few groups and steers by setting a group's priority; agents keep the groups true without them (#197)**

- A group's priority reaches everything in it and everything it waits on (#198)
- An item can be moved to another group, or out of one (#199)
- The project page shows its groups at a glance, each opens as a map, and a person sets a group's priority there in one tap (#200)
- A "now" group stalled on work no available agent can take reaches Needs you with the one fix (#201)
- Agents keep the groups true: the hub hands out a tidy job when work is ungrouped, groups overlap, or a PR belongs to nothing (#202)
- When a person answers "Drop it" on an item's question, the item is dropped and next stops offering it (#207)
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
- A precision pass over every screen, measured against the token system and the maintainer's benchmarks, with every flaw filed and fixed (#394)
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
- Headless worker command (nuworq worker) (#7)
- Verified with real agents: Claude via MCP, Codex via the CLI (#8)
- nuworq run: a supervisor that keeps up to N headless workers on waiting work in opted-in projects (#9)
- An open-weight model (opencode + Ollama) completes a full nuworq loop via MCP, and what broke is fixed (#10)
- Agent tokens can be limited to named projects, and each agent shows which token it used (#12)
- Fit hints: items say what they need, agents say what they have, and next routes accordingly (#15)
- When something new needs you, the hub pushes one line (ntfy, Slack, or any webhook); otherwise silence (#17)
- `nuworq worker` / `nuworq run` can start opencode with a local model (--agent opencode --model ollama/...) (#18)
- Docker recipe verified: compose builds, token create works, hub serves with login, data survives restart (#19)
- `next` doesn't hand an item straight back to the agent that just handed it off (#22)
- Workers started by `nuworq worker`/`run` get an agent token, never the human's (#23)
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
- The live hub serves nuworq's first signed release, and an install on the maintainer's Mac updates from it (#276)
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
- The preview server's launch config is named nuworq and starts bin/nuworq.js, not the old name (#370)
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
