# Audit: reliable and stable (#697)

Does nuworq keep working for days with nobody watching, through restarts, deploys, outages and loops? Audited on
2026-11-02 at 2e0e5c9 by claude-bde0, which built none of the code covered.

**Verdict:** restarts and deploys are sound. Drain, transactional migrations, smoke boots on copies of live data,
rollback and idempotent retries all hold. Leases on lapsed items come back. What can run for days unnoticed are
loops and hangs that never escalate:

- a worker that dies mid-item hands it back to be re-offered forever, and no person is told;
- a hung worker keeps its lease for as long as its runner lives;
- a GitHub issue that won't close is retried every 15 seconds forever;
- a push through the hub waits on a hung GitHub with no timeout.

There are four high findings and five medium ones. Each medium-or-higher finding is proposed under #675.

## Findings

Severity: what it costs a person running nuworq for days with nobody watching.

| # | Severity | Finding | Where | Item |
|---|---|---|---|---|
| 1 | high | An item that kills its worker is re-offered forever; nobody is told | src/core.js:1919, src/bounce.js:35, src/insight.js:553, src/runner.js:473 | #734 |
| 2 | high | A hung worker keeps its item as long as the runner runs | src/core.js:1582-1587, src/runner.js:299, bin/nuworq.js:1216, 1329 | #736 |
| 3 | high | The push proxy waits on GitHub with no timeout | src/gitproxy.js:67-87 | #738 |
| 4 | high | An issue GitHub won't close is retried every 15 s, forever | src/issues.js:189-231, src/server.js:396-398 | #739 |
| 5 | medium | One background error stops the whole hub | src/notify.js:241, src/server.js:375-378 | #740 |
| 6 | medium | The follower never restarts a hub that runs but stops answering | src/follow.js:541-546, 603 | #741 |
| 7 | medium | One failed GitHub call while opening a PR sends the work to hand-landing | src/core.js:2643-2653 | #742 |
| 8 | medium | A red PR whose check webhook was missed waits in landing, with the wrong advice | src/core.js:2687-2726, src/insight.js:417-421 | #743 |
| 9 | medium | A push sent while a channel is down is lost | src/notify.js:259-265, 92-106 | #744 |
| 10 | low | The runner's own hub calls have no deadline | bin/nuworq.js:1368-1381 | — |
| 11 | low | Workers outlive a killed runner; the first SIGTERM never escalates | bin/nuworq.js:1290, src/runner.js:329, 373-379 | — |
| 12 | low | A migration that takes 15–60 s passes smoke, then rolls back live on every commit | src/follow.js:23, 26 | — |
| 13 | low | A hub left on a newer schema after a failed restore runs without saying so | src/db.js:618-619, src/follow.js:598 | — |
| 14 | low | A checkout that fails mid-rollback leaves `running` on the bad commit | src/follow.js:600-604 | — |
| 15 | low | A comment GitHub took after the 10 s timeout is posted twice | src/issues.js:208-212 | — |
| 16 | low | DNS lookup runs outside outbound's timeout | src/outbound.js:80 | — |
| 17 | low | A runner on a shared token stays paused 30 min at a time (now shown in Needs you) | src/runner.js:340, src/insight.js:897-901 | — |
| 18 | low | No off-machine backup is automated; follow's copies share the hub's disk | docs/DEPLOY.md:362-369 | — |

### 1. An item that kills its worker is re-offered forever (high)

The runner signs off a worker that exits (bin/nuworq.js:1384), and signoff hands its item back to `ready`. Nothing
counts that as a failure:

- `stalls` rises only on a lapsed lease, and a runner's worker or a signed-off agent is excused as `session`
  (src/core.js:1919).
- Needs you's "keeps bouncing" card needs `stalls + rejections >= 2` (src/insight.js:553).
- The runner's own brake counts only exits under 15 s (src/runner.js:473).

So a worker that dies a minute in, every time (context overflow, an API error, out of memory), is replaced by one
that takes the same item, on and on.

- **Cost:** spend with no cap (`--max-usd` defaults to none), and the owner never hears.
- **Reproduced** on `serve --demo --port 0`, from the browser. Six agents in turn each called `next` and then
  `signoff` ("worker exited 1"). All six got #18, attempts 1 to 6. Afterwards #18 was `ready` with `stalls: 0`, its
  history read six `handoff` events, and `/api/p/nuworq/view` had `attention: []`.
- **Fix:** count a handoff with no submit, from a worker that exited, as a stall. After 3, park the item with a
  Needs you entry.

### 2. A hung worker keeps its item as long as the runner runs (high)

`renewHeld` extends every unlapsed lease a runner vouches for, with no limit on age or progress (src/core.js:1584).
The runner vouches for every worker still in `running` (src/runner.js:348), and `--max-minutes` defaults to none
(src/runner.js:299). Neither `nuworq up` nor the service sets it.

A worker can also stay in `running` after its process is gone. Its exit waits on `git fetch --prune`
(bin/nuworq.js:1329) through a `git` helper with no timeout (bin/nuworq.js:1216).

- **Cost:** an item sits in `active` for days, holding a worker slot. With `--workers 1` the runner goes quiet.
- **Found** by reading. Not run: it needs a CLI that hangs, and starting one needs approval in this runner.
- **Fix:** stop renewing a lease that has had no progress, push or call for its item in 2 hours. Give the runner's
  git calls a timeout.

### 3. The push proxy waits on GitHub with no timeout (high)

`upstream()` makes its request with no `timeout` or `signal` (src/gitproxy.js:67-80). `relay` pipes GitHub's answer
with no handler for its errors (src/gitproxy.js:84-87). The server's `keepAliveTimeout` and `headersTimeout` don't
cover a response that never comes. A client that disconnects doesn't cancel the request to GitHub either.

- **Cost:** while GitHub hangs, every worker push hangs too, since git has no HTTP timeout by default. Its lease is
  renewed meanwhile (finding 2), so the item is stuck with no limit.
- **Found** by reading. Running a fake GitHub that hangs needs a script, which needs approval here.
- **Fix:** time out the upstream request (30 s to first byte), cancel it when the client goes, and end the response
  with an error line on a failure upstream.

### 4. An issue GitHub won't close is retried every 15 s, forever (high)

`closeLanded` and `askReporters` run on every sweep (`sweepMs = 15_000`, src/server.js:396-398). A failed close
leaves the issue `open`, with `close_error` set (src/issues.js:222), and the next sweep tries it again. Each try is a
GET plus a POST or PATCH, after `asRepo`. Each pass that has rows also calls `hub.changed(p)` (src/issues.js:230), so
the page and the notifier re-scan every 15 s. No code reads `retry-after` or `x-ratelimit-*`.

- **Cost:** a locked or deleted issue (403, 410) costs about 500 calls an hour. Ten of them exhaust the
  installation's 5,000 an hour, and then PR merges, push tokens and clones fail too.
- **Found** by reading.
- **Fix:** back off each issue (1 min, doubling to 6 h). After a day, stop trying and say so once on the item. Wait
  out `retry-after` and `x-ratelimit-reset` for every GitHub call.

### 5. One background error stops the whole hub (medium)

Neither `src/` nor `bin/` has an `uncaughtException` or `unhandledRejection` handler. Two paths can throw outside
any catch:

- `Notifier`'s batch timer calls the async `flush()` with no `.catch` (src/notify.js:241). In it, `this.current()`
  and `mark.run` can throw on SQLITE_BUSY, SQLITE_FULL or a closed workspace database.
- The sweeper calls `spaces.closeIdle`/`spaces.wake` outside its `try` (src/server.js:375-378). `wake` opens and
  migrates a workspace database, so one corrupt workspace file throws on every wake.

Either one ends the process. Under `--follow` the hub restarts within about 10 s, dropping every request in flight
without a drain. With a bad workspace file, it crashes again on the next wake.

- **Found** by reading.
- **Fix:** `.catch` on `flush()`, a `try` around `closeIdle`/`wake`, and a process-level handler that logs
  `unhandledRejection`.

### 6. The follower never restarts a hub that runs but stops answering (medium)

`tick()` restarts the hub only when the child process is gone (`sys.alive()`, src/follow.js:541). If a restart or
rollback ends with "didn't answer… trying again at the next check" (src/follow.js:545, 603), nothing tries again:
the child is alive, so the next tick does nothing. A wedged event loop is never noticed either. A crash loop, where
the hub dies and restarts every 10 s, never reaches anyone: push notifications run inside the hub.

- **Found** by reading.
- **Fix:** restart on repeated failed `/api/health` checks, not only on exit. After 3 restarts in 10 minutes, back
  off and write the reason where `nuworq status` and the operator see it.

### 7. One failed GitHub call while opening a PR sends the work to hand-landing (medium)

If `github.openPr` throws (a 502, a timeout, a rate-limit 403), the item is released with `pr_failed`
(src/core.js:2643-2653). `prFailed()` keeps it on the manual path from then on (src/core.js:640-644), and nothing
retries the PR.

- **Cost:** everything accepted during a short GitHub outage needs an agent's land job instead of auto-merge.
- **Found** by reading.
- **Fix:** retry opening the PR on the next mergeReady passes for an hour before falling back to a land job.

### 8. A red PR whose check webhook was missed waits in landing (medium)

CI failure reaches the hub only through webhooks (src/github.js:225-258). `mergeReady` polls `state` and
`mergeable_state`, never check runs (src/core.js:2687-2726). After an hour, `landing-stuck` tells the person to
"Start an agent" (src/insight.js:417-421), which doesn't help.

- **Found** by reading.
- **Fix:** when a PR has been open past its usual CI time, read its check runs, and treat a failed required check as
  the webhook would.

### 9. A push sent while a channel is down is lost (medium)

`flush()` marks entries as notified before delivering (src/notify.js:259-265). `deliver` tries twice, 2 s apart
(src/notify.js:92-106). If both fail, the entry is never sent; only the channel's `failing_since` remains.

- **Cost:** an act-level alert during an ntfy or Slack blip never arrives.
- **Found** by reading.
- **Fix:** mark only what was delivered, and retry the rest on the next scan while it still needs the person.

### Lows (not proposed)

- 10: `routes`, `report`, `claimed`, `took` and `unstaffed` run serially in the runner's loop with no `deadline`, so
  a half-open connection waits on undici's 300 s. Fix: give each the 15 s deadline `waitRoutes` has.
- 11: workers are spawned `detached` (bin/nuworq.js:1290). The first SIGTERM to the runner forwards SIGTERM but
  never sets `killedAt`, so it doesn't escalate to SIGKILL. A runner that is SIGKILLed leaves its workers running.
  Their own calls keep their leases, beside a restarted runner's new workers. Fix: set `killedAt` on the forwarded
  SIGTERM, and kill the workers' process groups on exit.
- 12: smoke boots get 60 s (SMOKE_MS) but a live boot must be healthy in 15 s (HEALTHY_MS). Fix: give the live check
  the smoke boot's measured time plus a margin.
- 13: migrations run forward only, with no check that `user_version` is newer than the code knows. Fix: refuse to
  start on a schema newer than the code knows.
- 14: `sys.checkout(state.good)` can throw before `state.running = state.good`. Fix: set `running` first.
- 15: a comment is recorded only after a 201. Fix: look for the comment before posting again.
- 16: `await resolve(host)` runs before the AbortSignal timeout. Fix: race it against the same signal.
- 17: the shared-token pause (2026-11-02's loop) backs off to 30 min and stays there, but it now reaches Needs you
  as "Runners paused". Fix: none needed beyond what #656 did.
- 18: documented, not automated. Fix: a nightly `VACUUM INTO` to a second disk or bucket, as an operator step.

## What was tried

The demo hub here is `node bin/nuworq.js serve --demo --port 0`, driven from the browser's `fetch`. This runner
needs approval for node scripts, `--db`, fixed ports, curl and gh, so the cases below are the ones it allows.

- **Loop:** finding 1, reproduced as described there.
- **Restart under a waiting runner:** a `GET /api/route?runner=1&wait=60&skip=nuworq` was waiting, and the hub was
  stopped (SIGTERM) about 7 s in. The wait answered `200 []` at 8.9 s, not a reset, so a runner reads it as "nothing
  yet" and polls again. The drain works as #545 says.
- **Hub outage, as a person sees it:** with the hub down, the open page said "Can't reach the hub since 07:53 AM;
  what you see may be out of date." and kept its last state. Bringing it back on the same port needs a fixed
  `--port`, which needs approval here. test/wait.test.js's "a real hub restarted under a waiting listener" covers
  that in CI.
- **Restart with leases held:** not run: `--demo` is in memory. By reading, `sweep()` marks a lease that ran out
  while the hub was down as `restart` and doesn't count it as a stall (src/core.js:1917). `replies` keeps a retried
  write's first answer for 10 minutes (src/server.js:1923-1944).

## Flaky tests (CI history)

These come from the operator's read of the last 400 runs of test.yml, 2026-10-31 17:16 to 2026-11-02 13:35 UTC:
322 success, 64 cancelled (superseded), 14 failure.

| Test | File | Failed | Status |
|---|---|---|---|
| a real hub restarted under a waiting listener: the item that becomes ready on the new one reaches it | test/wait.test.js | 3 runs (11-01 20:52 main, 21:00 #542, 21:25 #582) | timing; loosened by #569, #576, #584; none since |
| a branch whose heads haven't moved keeps its answer without running merge-base | test/headsup.test.js | 1 run (11-01 16:36, #528) | timing; fixed by #556, #557; none since |

The other failures were real breaks, each fixed: #656's runner-token tests (4 runs, fixed by #673), stale
docs/CLI.md (1 run, fixed by #588), and single branch-only runs (#603's shallow checkout, #474, #456, #453, #434).
No test has failed flakily since 11-01 21:25. Runs before 10-31 17:16 weren't read.

## Checked and fine

- **Drain** (src/server.js:1882-1893): waits answer empty, streams are told to reconnect, idle keep-alives close at
  once, and everything is cut at 10 s. The follower waits 12 s before SIGKILL.
- **Migrations** (src/db.js:618-628): each runs in `BEGIN IMMEDIATE`, sets `user_version` and rolls back on error.
  ALTERs are idempotent. WAL is on, with `busy_timeout` 3000.
- **Deploys** (src/follow.js:537-609): CI-gated, then a smoke boot on `VACUUM INTO` copies, a backup before the move
  (10 kept), and restore plus rollback on a failed health check. If the backup fails, the hub stays where it is.
  When CI is unreachable, the tests run locally after 30 min.
- **Leases:** `sweep()` returns every lapsed lease (active, landing, verifying, proposed, race attempts). Renewal
  never revives a lapsed one.
- **Runner backoff:** fast-fail and empty-claim streaks pause 5 to 30 min. If the hub is down, it logs once, retries
  every 30 s, and says when the hub is back.
- **Outbound timeouts:** every `fetch` in ghapp, issues, alerts, llmproxy, precondition, outbound, billing and
  oauth has an `AbortSignal.timeout`. Git fetches have 30 s/120 s timeouts and `ConnectTimeout=10`.
- **Landing recovery:** `mergeReady` never runs twice at once and asks again when GitHub didn't answer. A merge
  that timed out here but succeeded on GitHub lands on the next pass.
- **Memory:** limiter maps are capped, and token caches, `held` and `_behind` are pruned. No unbounded queue was
  found.
- **Requests:** a database error inside a request is a 500 with an id, not a crash (src/server.js:1857-1862).
