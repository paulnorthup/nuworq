# Audit: effective (#699)

Does nuworq do its job? Measured from the nuworq project's own history on the live hub, as aggregates only. Written on 2026-11-02 by claude-b951, which built neither src/outcomes.js nor scripts/effective.js.

**Verdict.** Yes, and with little of the maintainer's time:
- 92% of landed items needed no action from a person, and 87% were accepted at their first review.
- The median item lands 12 minutes after it's ready.
- A person spends 0.2 actions per landed item and answers blocking questions in a median 6 minutes.

What it wastes is agent work:
- 17% of building jobs stall (147 of 863), and most stalls say nothing about why.
- Landing hits 116 blocked pull requests.
- One bug hides every tidy job's result, so model routing never learns from tidy jobs.

## How the numbers were taken

- **Script.** `scripts/effective.js` (commit 8094388 on this branch, with test/effective.test.js) copies a workspace file with `VACUUM INTO` and runs the hub's own `outcomes()` (src/outcomes.js) on the copy. It adds the event counts outcomes doesn't break down (hand-backs, lapsed leases by cause, who sent work back, question wait times) and prints JSON of counts, shares and durations only.
- **Run.** The operator ran it on nuworq-vm on 2026-11-02 at 14:14 UTC (Q223), against `/var/lib/nuworq/workspaces/northup.db`, with `--project nuworq --days 14` and `--days 30`. The live file was only read. Both outputs are identical: every finished item falls within the last 14 days (2026-10-19 to 2026-11-02).
- **Cost by kind of job** comes from #700's query (Q224, docs/audit/efficient.md): 3.9 days of usage rows.

## Numbers (nuworq project, 2026-10-19 → 2026-11-02)

| Measure | Value | Definition |
|---|---|---|
| Finished items | 687: 637 landed, 50 dropped | outcomes().items in the period |
| Landed with no person's action | 583 of 637, **92%** | human_actions = 0 on the item |
| Accepted at first review | 554 of 637, **87%** | sent_back = 0 |
| Escaped (a later item repairs it) | 30 of 637, 5% | an item with fixes pointing at it |
| Cycle, ready → landed | median **0.2 h**, p90 3.9 h | cycle_ms |
| Sent back | 92 (agents 78, GitHub CI or a closed PR 17) | sent_back events by actor |
| Stalls | 24 on finished items | items.stalls |
| Hand-backs | 172, none with a recorded stage (before #734) | handoff events |
| Lapsed leases | 40 review or landing, 1 worker or session ended | lease_expired by data.cause |
| Landing blocked | 116 pr_blocked, 2 pr_merge_failed | events |
| Building jobs | 863 taken: 487 landed, 147 **stalled**, 120 open, 78 sent back, 31 escaped | jobsTaken, job = work |
| Other jobs | review 607 done, 58 stalled; land 155 done, 4 stalled; shape 65 done; tidy **78 open, 0 done** | jobsTaken |
| People | 109 actions, 0.2 per landed; median wait 0.1 h; 66 blocking questions, 61 answered by a person, median 0.1 h, p90 2 h; 79 operator questions | outcomes().human_actions, questions |
| Cost per landed item | median $1.98, p90 $14.36, over 537 priced (100 unpriced, from before usage was recorded); total $3,575.26 | usage on landed items |
| Cost by job, 3.9 days | work $3.67 a run, review $1.64, land **$5.93**, tidy $0.54, shape $0.28, no item $0.28 | Q224 |

The script's `sent_back` (92) counts finished items, while `sent_back_by` (95) counts every event in the period, so the two differ by 3.

## Findings

| # | Severity | Finding | Where | Cost to a person | Fix | Item |
|---|---|---|---|---|---|---|
| 1 | medium | Every tidy job counts as "open" for ever, so routing never calibrates tidy jobs ("20 to go" never moves) and Analytics shows 78 open tidy jobs | src/outcomes.js:182 `FINISHED.tidy = ['submitted']`, but a finished tidy job records `tidied` (src/core.js:3309); routing skips open jobs (src/core.js:886) | Tidy jobs stay on the fallback tier with no evidence it does them well; Analytics misreports | Count `tidied` as tidy's finish | #753 |
| 2 | medium | 17% of building jobs stall, and the record rarely says why: hand-backs before #734 have no stage, and review or landing lapses record no cause | src/core.js:1962-1963 (review and landing `lease_expired` without `data.cause`); runner exits recorded only as a signoff note | 147 stalled builds at about $3.67 a run is about $540 of the period's spend, with no way to tell crashes from budget stops from context limits | Record a cause on every stall (exit code and reason from the runner, the cause on review and landing lapses) and break stalls down by it in outcomes | #754 |
| 3 | medium | Landing friction: 116 blocked PRs, and land is the dearest job per run | conflicts with main become land jobs | About 17% of spend | Already open | #752, #742, #743 |
| 4 | low | 100 of 637 landed items are unpriced | usage recorded only since 2026-10-29 | Older cost figures are partial | None: it ages out | — |
| 5 | low | Escapes are 5% (30 items) | — | Fixes after landing | Watch at the re-check | — |

Overlaps: the dying-worker loop is #734 (done), hung workers are #736 (done), and per-run spend caps are #702.
