# Re-check: effective and efficient

**What.** A re-check of every medium-or-higher finding in docs/audit/effective.md (#699) and docs/audit/efficient.md (#700). It also re-takes the numbers that can be measured locally. Done by an agent that built none of the fixes.

**Commit.** c85fb5f7 (origin/main plus the v1.0.0 release commit).

**How.**
- Read the code each fix touched, with file:line references.
- Ran the covering tests with `npm test -- test/<file>.test.js`, in two runs. First run: tidyoutcomes, stallcause, viewcache, toolsize and usage, 40 tests, all pass. Second run: outcomes, analytics-view, migrations, runner, models, ghapp, toolroles and clientlabel, 133 tests, all pass.
- Measured a demo hub (`node bin/nuworq.js serve --demo --port 0`, loopback, no login) from the Playwright browser, then stopped it. The nuworq-sized hub numbers come from test/viewcache.test.js, which builds `seedHub()` as the audit did.
- No live hub was touched. Live-hub numbers aren't re-taken here: cost per job and land cost (#752), the effective shares (92% no person's action, 87% first-review accepts, stall rate), live turns, and the empty worker's cost (#783). For those, this re-check reads the code path instead.

## Re-checked findings

| Id | Sev. | Item | Verdict | Evidence |
|---|---|---|---|---|
| effective 1 | medium | #753 | fixed | src/outcomes.js:183: `FINISHED.tidy = ['tidied']`, so a finished tidy job counts as done and routing can calibrate it. Covered by test/tidyoutcomes.test.js (pass). |
| effective 2 | medium | #754 | fixed | Every stall now records a cause. Review and landing lapses carry `cause` (src/core.js:2326-2329), and so do active and shaping lapses (:2298, :2313, :2321). The runner sets `stopped` to timeout, budget, interrupted, or exited with its code (src/runner.js:541, :547, :660). Signoff passes that to the hand-back (src/core.js:4061-4063, `stoppedOf` :34-42). Outcomes splits stalls by cause (src/outcomes.js:194-205, `stalls_by_cause` :177, :373), and web/analytics.js shows it. Covered by test/stallcause.test.js (pass). Events from before the fix stay "unrecorded". |
| effective 3 | medium | #752 (with #742, #743) | fixed in code; live cost not re-measured | Same fix as efficient 0. |
| efficient 0 | high | #752 | fixed in code; live cost not re-measured | Three changes. (1) A PR that is behind main or conflicting is first rebased by GitHub, with no model paid. It becomes a land job only when GitHub can't rebase it (src/core.js:3139-3143, `rebaseOnGitHub` :3184-3209, src/ghapp.js:424, src/github.js:165, :210). (2) Land jobs start on the cheapest tier (src/models.js:8 `ROTE`, :53, :90). Only failed land attempts move a land job up a tier (src/core.js:1084-1091). (3) A land run gets a short brief with no browser (bin/nuworq.js:1028-1051). It has a $2 cap by default (bin/nuworq.js:23, :1290-1291, :1347). Claude enforces the cap through `--max-budget-usd` (:1103-1105) and the runner stops the run past it (src/runner.js:542-547). Covered by test/ghapp.test.js, test/models.test.js and test/runner.test.js (pass). The $5.93 per run on the live hub needs a fresh usage query there. |
| efficient 1 | medium | #750 | fixed | At 30s the view sends no `stage_items` (src/insight.js:264, :279). Agents are only those the drawn sections name, one line each (:294-297). In motion is trimmed (:278). On the seeded hub the 30s view fell from 123,212 to 58,293 bytes. Covered by test/viewcache.test.js:123-124 (bound 61,606; pass). The statement count is unchanged at 356, because the shared build still runs in full. That is low finding 5, not a regression. |
| efficient 2 | medium | #751 | fixed | A `usage.turns` column was added (src/db.js:657-658). Turns are read from Claude's `num_turns` and from each Codex `turn.completed` (src/usage.js:58-101). Turns are stored on each usage row (src/core.js:1571-1572). They are added up per job (src/outcomes.js:221-229) and summarised as median turns per kind of job (`turnsByJob` :253-257). web/analytics.js:129-132 draws them as bars. Covered by test/usage.test.js, test/outcomes.test.js, test/migrations.test.js and test/analytics-view.test.js (pass). |
| efficient 3 | medium | #678 | fixed | The definitions are shorter, and each tool is held to a size limit (test/toolsize.test.js; the worker list must be at most 2/3 of 16,354 characters; pass). Workers get a list for their role (src/mcp.js:48, :87). Claude workers start with `ENABLE_TOOL_SEARCH`, so the definitions load on first use (bin/nuworq.js:1123-1128). Workers started through `--proxy` don't get this. They get only the shorter definitions, and bin/nuworq.js says so. |

The low findings (effective 4-5, efficient 4-6) were not in scope for a verdict. Two changed in passing. Efficient 4: the app is now 50 modules, still with no modulepreload. Efficient 5: the view still runs 356 statements.

## Measurements

| What | Audit (c147ac3) | Now (c85fb5f7) | Method |
|---|---|---|---|
| Tool definitions, full list (operator or no role) | 17,498-18,098 B (≈4,400 tok) | mcp 12,951, openai 13,551, anthropic 12,971 B (≈3,300 tok) | Demo hub, `fetch('/api/tools?format=…').text().length` |
| Tool definitions, worker role | not taken | 10,775 B (≈2,700 tok); 0 up front for Claude workers with tool search | Same, `&role=worker`; session gets 12,056 |
| Agent guide `/agents.md` | 3,033 B | 3,238 B | Same fetch |
| View 30s, seeded hub (500 items, 450 agents) | 123,212 B, 356 statements | 58,293 B, 356 statements | test/viewcache.test.js diagnostics (`JSON.stringify` length, `hub.q` counted) |
| View, demo hub | 10.5 KB (3.3 KB gzip), at the page's depth | 30s 10,492 (3,750 gzip); 5m 15,896 (4,738); 30m 32,596 (6,180) | Demo hub, fetch with `cache: 'no-store'`; gzip from `encodedBodySize` in resource timing |
| Browser first load of a project page | 54 requests, 144,198 B sent (415,439 decoded); 47 JS modules 120,331 B; CSS 19.7 KB; 6 API calls 4.1 KB; 84 ms | 58 requests, 157,136 B sent (451,265 decoded); 50 JS modules 131,563 B (348,918); CSS 21,464 B (92,796); 6 API calls 3,477 B; 71 ms | Demo hub, `/?fresh=1#/p/nuworq` in Playwright, navigation and resource timing `encodedBodySize` and `decodedBodySize` |
| Land cost per run, cost per job, live turns, empty worker (#783) | $5.93 land, $3.67 work; turns not recorded | not re-taken | Needs the live usage table. Code paths checked above. Runners wait for work on a long-poll before starting a worker (src/runner.js:400-432, src/server.js:2045, bin/nuworq.js:1464, #542). |

The demo hub's 30s view is about the same size as before because the demo is small: its stage lists and agents were already tiny. The seeded hub is where #750 shows, at 47% of its old size. On a demo hub the browser payload grew by 9% (13 KB sent) and gained 3 modules. That growth is low severity.

## New findings

None at critical or high. One note: the demo server tried to write a package to ~/.nuworq/package at startup. The sandbox refused it, and the server served without /nuworq.tgz. That is expected for a demo and was not looked into further.

Critical: 0. High: 0.
