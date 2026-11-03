# Re-check: bug-free (#695) and reliable and stable (#697)

What was checked: every finding of medium severity or higher in docs/audit/bug-free.md (3 high, 7 medium) and
docs/audit/reliable.md (4 high, 5 medium). Then a short sweep of the same areas for new critical or high issues.
At commit c85fb5f7 (origin/main plus one release commit). The re-checker built none of the fixes.

How: each fix commit was read, then the current code at the lines named. Targeted tests were run with
`npm test -- test/<file>.test.js`. Results: 19 files, 234 tests, 231 pass. The 3 failures are in
test/landing.test.js: two #724 tests that expect `chmod 0555` on `.git` to refuse a config lock, and the
GIT_SSH_COMMAND mirror test. They depend on this machine's sandbox, not on any fix re-checked here. Low findings
were spot-checked only where cheap.

## Re-checked findings

| Id | Item | Verdict | Evidence |
|---|---|---|---|
| BF-H1 Send-back or drop leaves auto-merge on | #726 | fixed (but see N1) | `autoMergeOff` src/core.js:3289, called on reject src/core.js:4336 (human `sendback` reaches it via `verdict`, src/core.js:4448) and on human `update` to ready/proposed/dropped src/core.js:4527. `withFix` now needs `sentBackByCi` src/github.js:42, 101. Test: test/prblocked.test.js (pass). |
| BF-H2 Another branch's merged PR naming #N marks it done | #727 | fixed | `ownBranch(item, pr.head?.ref)` on the merged path, src/github.js:102. Test: test/githubtrust.test.js (pass). |
| BF-H3 Freed workspace name inherits installation, plan, creator | #728 | fixed | `remove` calls `directory.forget` src/workspaces.js:328; `forget` clears installations, plans, memberships, grants, billing and feedback src/directory.js:294-304. `create` and `adopt` forget the name first src/workspaces.js:146, 183; start-up `forgetGone` keeps a copy first src/workspaces.js:162-172. Test: test/workspaces.test.js (pass). |
| BF-M1 Handing off a land job sends it to ready | #729 | fixed | Landing branch keeps the stage and skips `stepUp`, src/core.js:3865-3867, 3888. Test: test/landing.test.js (its #729 case passes). |
| BF-M2 Dependency cycles accepted | #730 | fixed | `setDeps` refuses via `waitPath` over deps and parent-to-part edges; parent moves check too. Test: test/depcycle.test.js (pass). Cycles made before the fix are not repaired (low). |
| BF-M3 Any agent's blocking question parks another's active item | #731 | fixed | `theirs` steers the holder instead of parking, unless the asker is an operator, in `ask` (src/core.js, AGENT_OPS.ask). Test: test/askholder.test.js (pass). |
| BF-M4 A workspace can end with no owner | #732 | fixed | `lastOwner` counts only verified owners, src/auth.js:109-111; used by `setRole`, `removePerson` and sign-in's `keepOwner`. Test: test/identity.test.js (pass). |
| BF-M5 Late progress note lost though "saved" | #733 | fixed | `UserError` `keep` commits the transaction, src/core.js `tx` (around :505); `progress` throws with `keep: true`. Test: test/savedrefusal.test.js (pass). |
| BF-M6 Landed release drafts the version just shipped | #735 | fixed | `contents` takes the shipped release item's version as the floor and its `release_through` as the start, src/releases.js:43-55. Test: test/releases.test.js (pass). |
| BF-M7 Edits to a release draft lost on second redraft | #737 | fixed | `release_draft` keeps the hub's own draft, src/releases.js:96-104. Test: test/releases.test.js (pass). |
| R1 Item that kills its worker re-offered forever | #734 | fixed | Third hand-back of active work with nothing submitted parks it (`handbacks`, src/core.js:1136; park src/core.js:3870-3884) with a kept-parked Needs you entry. Signoff goes through the same path. Test: test/handbacks.test.js (pass). Land and review hand-backs aren't counted, but landing-stuck and peer-review-stuck tell a person. |
| R2 Hung worker keeps its item | #736 | fixed | Vouching skips agents not heard from in 2 h (`VOUCH_IDLE_MS`, src/core.js `renewVouched`); a push counts as heard, src/server.js:1915; the runner's git is killed after 2 min, src/runner.js `runnerGit`, bin/nuworq.js:1302. Test: test/vouch.test.js (pass). |
| R3 Push proxy waits on GitHub with no timeout | #738 | fixed | `r.setTimeout` and an abort signal on the upstream request, `unreachable` answers 502, src/gitproxy.js:72-103, 109-110. Test: test/gitproxy.test.js (pass). |
| R4 Issue GitHub won't close retried every 15 s | #739 | fixed | Per-issue backoff kept in the database (`close_tries`, `close_next`), gives up after a day and says so once, src/issues.js:232-246; rate limits held per installation, src/ghapp.js:20-30. Tests: test/issueclose.test.js, test/reporter.test.js, test/ghapp.test.js (pass). |
| R5 One background error stops the hub | #740 | fixed | `flush().catch`, src/notify.js:246; `try` around `closeIdle` and `wake`, src/server.js:411-412; `keepServing` logs unhandled rejections, src/server.js:2146-2153. Test: test/background-errors.test.js (pass). |
| R6 Follower never restarts a hub that runs but doesn't answer | #741 | fixed | Health check each tick, restart after `MISSES`, `state.retry` after a failed start, crash-loop backoff reported via `sys.trouble`, src/follow.js:580-605, 714-731. Test: test/follow.test.js (pass). |
| R7 One failed GitHub call opening a PR sends work to hand-landing | #742 | fixed | Transient failures retried for an hour, item held by the hub meanwhile, src/core.js:3064-3071, 733-739; ghapp marks 5xx, 429, rate-limit 403 and no answer as transient. The retry list is in memory, so a restart falls back to a land job, which is safe. Test: test/prland.test.js (pass). |
| R8 Red PR with a missed check webhook waits in landing | #743 | fixed | `readChecks` reads check runs after 30 min, at most every 10 min, and sends back as the webhook would, src/core.js (`mergeReady`, `readChecks`). Test: test/prland.test.js (pass). |
| R9 Push sent while a channel is down is lost | #744 | fixed | Failed entries go to `unsent` and are retried on later scans for a day, src/notify.js:253-307. Test: test/notify.test.js (pass). |

Lows spot-checked: BF-L1 fixed (holder captured, src/core.js:2328). BF-L3 not fixed (src/auth.js:367 still
`name = ? OR id = ?`). BF-L5 not fixed (no `shallow` handling in src/gitproxy.js). R-14 not fixed (src/follow.js:806-807
still checks out before setting `running`). These stay low.

## New findings

| Severity | Where | What it costs a person | Fix |
|---|---|---|---|
| high (N1) | src/core.js:1482-1500 (`dropAsAnswered`), reached from `refine` with `drop` src/core.js:3918 and from a person's "drop" answer to a parked item's question src/core.js:4382-4392 | Work a person dropped can still merge to main. `dropAsAnswered` moves the item to dropped but never calls `autoMergeOff`, unlike `update` to dropped. Two ways in: a landing item whose PR waits on CI, asked about and answered "drop #N"; or work sent back by CI (auto-merge kept on by design), then parked by a blocking question and answered "drop". Once CI goes green, GitHub merges it. The merged webhook then ignores the dropped item, so the record says dropped while the code is on main. | Call `autoMergeOff.call(this, p, item, \`: #${item.seq} was dropped\`)` inside `dropAsAnswered`'s transaction, and test both ways in. |

No other new critical or high issue was found in the sweep (leases and vouching, landing and PR retries, release
drafting and tagging, sign-in owner guards, workspace forget, follower restarts, notifier retries).

Critical: 0. High: 1.
