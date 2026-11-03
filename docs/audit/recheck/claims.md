# Recheck: true to its claims, for v1.0.0 (#679)

**What.** A second pass over docs/audit/true.md (#703), by an agent that didn't build the fixes. Every "not yet" and "reworded" claim was checked again, 28 "true" claims were spot-checked (mostly safety, data, cost and security), and the claims in the rewritten README (#808, #685) that the list lacks were added (R1-R16).

**Code.** The worktree at fba8de71: c85fb5f7 plus one CHANGELOG-only commit on top.

**Sources.** README.md (64 lines now), docs/USAGE.md, docs/CLI.md, docs/ARCHITECTURE.md, docs/SECURITY-MODEL.md, the source, and these test runs (`npm test -- test/<file>.test.js`): forgetperson 5/5, routingconfirm 6/6; up, package, update, connect, connectmodal, staffing, usage, notify, models, routing, releasesign, plugin, device, service, leaserenew 200/200; sweep, protocol, earlyaccess, landing, auth, runner 123/126. The 3 failures are in test/landing.test.js:528, 559 and 589 (an ssh-key capture comes back empty, and two expected "could not lock config file" errors don't happen). They look like this sandbox, not the product, but that wasn't proven here. None of the claims below rests on them.

**nuworq.com was not re-read.** It can't be reached from here. Its claims use the text as true.md quotes it (nuworq-site at ab4abc1). Where the code still contradicts that text, the verdict is "doesn't hold as quoted". If nuworq-site #33-#36 have changed the pages since, those rows may already hold.

**Couldn't run.** `node bin/nuworq.js --help` (and `serve --demo`) needed approval, so no CLI output is quoted. Demo-screenshot claims S9 and S10 rest on true.md's check at 75f477c. Policy claims (P9, P12, T2, T4, T5, T7) and live figures (S5, S32, S59) weren't checked: they need the live hub or aren't code.

## Claims

| # | Where | Verdict | Evidence |
|---|---|---|---|
| **Not yet, and #770** | | | |
| P11 | privacy | holds | `nuworq person forget <email>` removes identity, sessions, memberships, requests and grants (src/directory.js, src/workspaces.js forgetPerson); test/forgetperson.test.js 5/5 |
| B71 | docs/ARCHITECTURE.md:93 (was README:231) | doesn't hold | "Every error carries a hint", but src/core.js:1544, 3935, 4354, 4569, 4761, 4814 throw UserError with none (#715) |
| W-770 | app: Cheaper models confirm | holds | web/routingconfirm.js:13-19 says builds start on top, move after 20 attempts, trials and races, rote on cheapest, a lost lease steps up; test/routingconfirm.test.js 6/6 |
| **README rewordings (#685): the sentence is gone from the README; where it moved** | | | |
| A7 | USAGE.md:18 | holds | "registers nuworq with the agent tools it finds" |
| A9 | USAGE.md:27, 45 | holds | "start again when you log in after a restart"; `loginctl enable-linger` named |
| A12 | docs/CLI.md:81 | doesn't hold | "restarts one whose flags differ": only a missing `--workers auto`, a browser mismatch or a stopped runner restart it (src/up.js:120-124). USAGE.md:35 says it right |
| A16 | USAGE.md:35 | holds | "uninstalls the runner service" |
| A19 | USAGE.md:37 | holds | `--project`, else the folder's, else where the hub routes it, "and stays there" |
| A27 | USAGE.md:45 | holds | names "git pointers the worker changed" |
| A37 | USAGE.md:53 | holds | "in light and in dark" |
| A61 | USAGE.md:96 | holds | "prints MCP config snippets" |
| A62 | README | holds | the former name is gone (#792) |
| B7 | USAGE.md:130 | holds | "effective priority, building before shaping, then whatever waited longest" |
| B10 | README, USAGE | holds | no heartbeat claim left; test/leaserenew.test.js "the heartbeat rule has left the guide" |
| B18 | USAGE.md:138 | holds | "agents, queue, you, or outside" |
| B33 | USAGE.md:163 | holds | "hub-wide, or a person's own (`--person`)" |
| B37 | USAGE.md:168 | holds | qwen3.8:27b |
| B44 | README, USAGE | holds | "offered only to it" no longer said |
| B53 | USAGE.md:189 | holds | "gh writes outside pull requests and runs still ask" (src/operator.js:94-110) |
| B56 | USAGE.md:191 | holds | steering named; "(#219 in <project>)" |
| B60 | ARCHITECTURE.md | holds | the CLI list moved to docs/CLI.md |
| B63 | ARCHITECTURE.md:83 | holds | "one delegated click handler" |
| B65 | ARCHITECTURE.md | holds | 66 `src/` lines for src/'s 66 entries |
| B67 | ARCHITECTURE.md:88-89 | holds | 20 operations, matching src/protocol.js:122-349 |
| B72 | ARCHITECTURE.md:94 | holds | landing jobs, then reviews, then priority, building before shaping |
| B78 | ARCHITECTURE.md:105 | holds | "no agent working… act when nothing is in flight, else know" |
| B79 | ARCHITECTURE.md:109 | holds | "unless under Run with it" |
| B80 | ARCHITECTURE.md:113 | holds | "when a person can help… an answer, an agent to start" |
| B81 | ARCHITECTURE.md | holds | row removed |
| B82 | ARCHITECTURE.md | holds | row removed |
| B83 | ARCHITECTURE.md:104-126 | holds | operator-missing, kept-parked, pr-review, group-stalled, plan-limit, app-wiring, landing-stuck, outside-overdue, peer-review-stuck, unfit all listed |
| B85 | ARCHITECTURE.md:136-139 | holds | step, unpark, keep, … "and more"; `/api/wait` listed |
| **nuworq.com rewordings (site not re-read; text as true.md quotes it)** | | | |
| S1 | index meta, lead | doesn't hold as quoted | open-weight workers only on projects with no remote, and since #768 Codex too (bin/nuworq.js:1017-1023) |
| S2 | index meta, lead | doesn't hold as quoted | "Another agent reviews each item": new projects default to Keep moving (src/db.js:11), where the person verifies (src/core.js:193-197, 3930) |
| S4 | index lead | doesn't hold as quoted | by default you also verify finished work (as S2) |
| S9 | index #at-work | doesn't hold as quoted | per true.md at 75f477c; not re-run here |
| S10 | index #at-work | doesn't hold as quoted | as S9 |
| S16 | index #how 1 | doesn't hold as quoted | priority comes before building-before-shaping (src/core.js:2633-2635) |
| S23 | index #how 3 | doesn't hold as quoted | own-work rule holds (src/core.js:3932); by default a person reviews |
| S25 | index #how 3 | doesn't hold as quoted | "a different agent" only under Run with it (src/core.js:3827) |
| S28 | index #how 4 | doesn't hold as quoted | a PR landing is done on GitHub's merged event (src/github.js:102-108) |
| S31 | index #how 4 | doesn't hold as quoted | as S28 |
| S38 | index #see mock | doesn't hold as quoted | the app says "since you last looked" (src/insight.js:94, 249) |
| S41 | index #why | doesn't hold as quoted | as S2 |
| S42 | index #why | doesn't hold as quoted | as S28 |
| S44 | index #why | doesn't hold as quoted | as S1; pi not named |
| S47 | index #why | doesn't hold as quoted | the mirror also feeds prefetch and rebase nudges (src/core.js:824, 4301) |
| S50 | index #why | doesn't hold as quoted | the app's level is "Check with me" (src/core.js:189) |
| S57 | index #pricing | doesn't hold as quoted | "workspace", not "organization" (test/workspaceword.test.js) |
| S60 | index #proof | doesn't hold as quoted | 17+109+85+203 = 414, not 429 (arithmetic) |
| S61 | index #faq | doesn't hold as quoted | as S1 |
| S62 | index #faq | doesn't hold as quoted | as S2 |
| S64 | index #faq | doesn't hold as quoted | the agents' token is read-only (src/ghapp.js:15; src/server.js:336) |
| S68 | index #faq | doesn't hold as quoted | only projects you let it staff (test/staffing.test.js "off until answered") |
| W15 | workflow #workers | doesn't hold as quoted | as S2 |
| W16 | workflow #workers | doesn't hold as quoted | across projects priority comes first |
| W20 | workflow #workers | doesn't hold as quoted | as S28 |
| W22 | workflow #operator | doesn't hold as quoted | "It signs releases": the release workflow signs after the maintainer approves; no session reads the key (docs/SECURITY-MODEL.md:76) |
| W26 | workflow #cheaper | holds | Settings → Staffing → "Cheaper models where they do as well" (web/actions.js:123; test/routingconfirm.test.js) |
| W38 | workflow #you | doesn't hold as quoted | only once a channel is added; channels also get a weekly line |
| W39 | workflow #you | doesn't hold as quoted | a steer is re-sent until acknowledged, for 3 days (src/core.js:85) |
| P1 | privacy | doesn't hold as quoted | identities hold only email and provider (src/directory.js:55-61) |
| P4 | privacy | doesn't hold as quoted | also a keyed hash of the address (src/directory.js:93, 319) |
| P6 | privacy | doesn't hold as quoted | the hub keeps a bare mirror of each repository on disk (src/git.js:231-238) |
| P8 | privacy | doesn't hold as quoted | Google sign-in (src/oauth.js:20-24) and the person's notification services aren't named |
| P10 | privacy | doesn't hold as quoted | several sign-in cookies, one a 10-minute sign-in check (src/server.js:540, 567, 923) |
| T1 | terms | doesn't hold as quoted | GitHub or Google (src/oauth.js:13-24) |
| T6 | terms | doesn't hold as quoted | no data export exists (no export route in src/server.js or bin/nuworq.js) |
| **Spot-checked "true" claims** | | | |
| A3 | install | holds | web/connect.js:16-21; test/connectmodal "checks it against the key before npm runs" |
| A5 | update | holds | test/update.test.js "tampered bytes with a matching sha256…", "signed by another key", "an older release… is refused" |
| A20 | keys | holds | bin/nuworq.js:582-584 |
| A24 | service | holds | src/service.js:117-118 (0600); test/service.test.js |
| A28 | branch cleanup | holds | test/sweep.test.js "a worker's branch goes at exit once its item is done and it is on origin" |
| A29 | GitHub branch | holds | test/sweep.test.js "the hub deletes its branch on GitHub as its app" |
| A30 | weekly sweep | holds | test/sweep.test.js "keeps uncommitted and unpushed work… and home" |
| A31 | USAGE.md:47 (was README:48) | doesn't hold | "codex and local models report no cost… spend is known when a worker exits": since #761 codex is priced (src/usage.js:147-160) and running workers' spend counts (src/runner.js:470) |
| A33 | daily budget | holds | src/core.js:1162-1170; test/staffing.test.js "stops new workers at the budget until the UTC day rolls over" |
| A35 | worker isolation | holds | bin/nuworq.js:943-947, 1128 (`--strict-mcp-config`, `--disable-slash-commands`) |
| A36 | browser | holds | bin/nuworq.js:912-916 (`--isolated`, local origins only), 885 (run_code_unsafe denied) |
| A49 | release branch | holds | no longer in README; docs/SECURITY-MODEL.md:76 describes the workflow signer and the rulesets; test/releasesign.test.js all pass |
| A53 | connect.json | holds | bin/nuworq.js:1600 (0600) |
| B9 | lease | holds | src/core.js:79 (20 minutes) |
| B15 | never your own verdict | holds | src/core.js:3932; test/protocol.test.js:157 |
| B34 | URLs masked | holds | test/notify.test.js "secrets are never shown back in full" |
| B36 | channel retry | holds | test/notify.test.js "retried once, then shows as worth knowing" |
| B86 | security | holds | src/server.js:58, 99, 881, 1271, 1293; test/auth.test.js local and required mode |
| S7 | early access free | holds | src/workspaces.js:235-245 (grants unlimited, never charged) |
| S46 | model keys | holds | src/runtrust.js:118 scrubs ANTHROPIC_API_KEY and others from Claude workers |
| S63 | read-only mirror | holds | src/ghapp.js:15 (contents: read) |
| E4 | Turnstile | holds | test/earlyaccess.test.js "a passing Turnstile token is stored; none or a bad one is refused" |
| W25 | workflow #cheaper | doesn't hold | "Off until you turn it on": on by default since #723, for new projects (src/core.js:621) and old ones nobody set (src/db.js:637-643); test/models.test.js "on by default" |
| W27 | workflow #cheaper | doesn't hold | "nuworq never adds a model itself": Claude defaults to Haiku, Sonnet and Opus 5.5 when none are set (src/models.js:14, 37) |
| W28 | up to six | holds | src/models.js:9 |
| W29 | quality bars | holds | src/models.js:62-66; test/routing.test.js |
| W32 | 10% trials | holds | src/models.js:119; web/routingconfirm.js:7 |
| W35 | step up | holds | test/models.test.js "the next attempt steps up" |
| **README claims the list lacked** | | | |
| R1 | README:9, 19, 52 | doesn't hold | "agents… check the work", "review each other's work", "Workers build, review and land": by default (Keep moving) agents don't review; the person verifies (src/core.js:193-197, 2678, 3930) |
| R2 | README:19 | holds | Claude, OpenAI (Codex) and open-weight models work through MCP (USAGE.md:168). Headless non-Claude workers run only on projects with no remote (bin/nuworq.js:1019) |
| R3 | README:19 | holds | you see a decision, a question, finished work (ARCHITECTURE.md:104-126) |
| R4 | README:21 | holds | 0-30-5-30: test/notify.test.js "healthy activity sends nothing"; src/insight.js depths |
| R5 | README:25 | holds | GitHub sign-in (src/oauth.js:13); Node 24 (package.json engines) |
| R6 | README:27-33 | holds | the dialog's lines (web/connect.js:16-21); the key equals release-key.pub:2; "NOT signed" message; test/connectmodal.test.js |
| R7 | README:36 | holds | `nuworq up` installs the runner and opens operators (src/up.js:115-141); test/up.test.js. Workers take only projects you agree to staff, and operators start only in a clone of an unparked project |
| R8 | README:42 | holds | "starts only what's missing": test/up.test.js "a second run starts nothing" and "installed when there is none, restarted when… down, else left alone" |
| R9 | README:44 | holds | plugin/skills/shaper/SKILL.md:15 "Nothing goes to the hub until the person says to propose it" |
| R10 | README:48 | holds | `--demo` is `:memory:` (bin/nuworq.js:1793); port 4747 (src/client.js:10); open on loopback (test/auth.test.js "is open on loopback"); found through hub.json (src/client.js:12, 89) |
| R11 | README:52 | holds | own worktree, routed to the most valuable work (USAGE.md:130; test/priority.test.js) |
| R12 | README:53 | holds | the operator answers `to: "operator"` questions and lands work (src/operator.js; test/roles.test.js) |
| R13 | README:54 | holds | the shaper skill turns intent into items with done-means |
| R14 | README:55 | holds | "Agents never mark their own work done: someone else checks": under Check with me and Keep moving the person verifies (src/core.js:3827, 3930); under Run with it another agent, never the builder (src/core.js:3932). One exception: a tidy job (bookkeeping on milestones or field notes) is done at its own submit (src/core.js:3820-3825) |
| R15 | README:55 | holds | "Steer, answer, accept or send back": the human actions (ARCHITECTURE.md:136-138) |
| R16 | README:11, 59-63 | holds | docs/USAGE.md, ARCHITECTURE.md, DEPLOY.md, API.md, CONTRIBUTING.md, SECURITY.md, LICENSE exist; /guide is served (src/server.js) |

## Claims that don't hold

Severity is high if a person relying on the claim would be misled about safety, data or cost.

**High**
- P6 (privacy). "Never stores your source code": the hub keeps a mirror of each repository on its disk. Fix: reword the site (site #36): "The hub keeps a read-only mirror of each linked repository to check landings; nuworq's database holds no code."
- P8 (privacy). Processors leave out Google (sign-in) and the notification services a person adds. Fix: name them (site #36).
- T6 (terms). "A way to export your data" on shutdown: there is no export. Fix: build an export of a workspace's SQLite file, or reword to "the host can hand you your workspace's database" (site #36).

**Medium**
- R1 (README:9, 19, 52). Says agents review each other's work. By default (Keep moving) the person verifies. Fix: "…build it and land it on main, checked by you or, under Run with it, by another agent", and "Workers build and land the work, and review it under Run with it".
- S2, S4, S23, S25, S41, S62, W15 (site). The same claim on nuworq.com. Fix: site #33.
- S28, S31, S42, W20 (site). "Done only when git shows main contains it": a PR is done on GitHub's merged event. Fix: site #34.
- S47 (site). The mirror is read for more than landing checks. Fix: site #34.
- P4 (privacy). It leaves out the keyed address hash. Fix: name it (site #36).
- W25 (site). "Off until you turn it on": Cheaper models is on by default since #723. Fix: reword to "On by default; turn it off in Settings → Staffing" (nuworq-site).
- W27 (site). "Never adds a model itself": Claude's tiers default to Haiku, Sonnet and Opus 5.5. Fix: "Uses Claude's three current models unless you set your own; adds no others" (nuworq-site).

**Low**
- B71 (docs/ARCHITECTURE.md:93). "Every error carries a hint": 6 UserErrors in src/core.js have none. Fix: add hints (#715), or say "most errors".
- A12 (docs/CLI.md:81). "Restarts one whose flags differ". Fix: "restarts one without --workers auto, with the wrong browser setting, or not running".
- A31 (docs/USAGE.md:47). It says codex costs aren't counted and spend is known at exit. Both changed with #761. Fix: "Spend counts as workers run; codex is priced from nuworq's table; local models report no cost."
- S1, S44, S61 (site). Open-weight workers, and since #768 Codex workers, run only on projects with no remote. Fix: site #34, and add Codex.
- S9, S10 (site). The demo doesn't show the pictured state. Fix: site #35.
- S16, W16 (site). Priority comes before the order the site gives. Fix: site #35.
- S38, S50, S57 (site). The words differ from the app's ("since you last looked", "Check with me", "workspace"). Fix: site #35.
- S60 (site). The days add up to 414, not 429. Fix: site #35, from the live hub.
- S64 (site). It leaves out that the token is read-only. Fix: site #34.
- S68 (site). It leaves out that the runner staffs only opted-in projects. Fix: site #35.
- W22 (site). "It signs releases": the release workflow signs after the maintainer approves. Fix: "it prepares releases; the maintainer approves the signing".
- W38, W39 (site). They leave out the channel needed and the 3-day limit. Fix: site #35.
- P1, P10, T1 (site). Less is stored than said, the cookies are miscounted, and Google sign-in is left out. Fix: site #36.

Not a claim, but seen: package.json still says 0.9.0 while CHANGELOG.md leads with 1.0.0. The release checks refuse a version mismatch, so the release step has to bump it.

Claims checked: 112. Hold: 71. Don't hold: 41 (critical 0, high 3).
