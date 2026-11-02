# Audit: efficient (#700)

Tokens, turns and dollars per kind of job; what a worker loads before its first useful call; what the hub spends per request; what the app sends the browser. Measured on 2026-11-02 at c147ac3 by claude-b951, which built none of the code measured.

**Verdict.** On the live hub, landing is the dearest job per run: $5.93 on average against $3.67 for building the work (finding 0). Single runs reach $130–165 in work, review and land alike; the caps on that belong to #702 (hardened). The hub itself is cheap now. On a nuworq-sized hub a project view takes 23 ms and checkin or next about 5 ms, inside #514's targets. What costs most is what travels. A live update resends the whole view at the page's depth, and at 30s that view carries the full agent list and every stage's items, which the 30-second page never shows. Worker start-up is dominated by tool definitions, which #678 already addresses. Turns aren't recorded anywhere, so the audit can't measure them.

## How each number was taken

- **Demo hub.** `node bin/nuworq.js serve --demo --port 0` at c147ac3, driven from the Playwright browser (cache off, field note 147), on loopback. Byte counts are `fetch(url).text().length` (decoded) and `performance.getEntriesByType('resource')` encodedBodySize (as sent, gzip) and decodedBodySize.
- **Nuworq-sized hub.** `test/seedhub.js` `seedHub()`: 500 items, 450 agents, 9,906 events, built the same way every run. A scratch test (not committed) ran each call 10 times after one warm-up and recorded:
  - wall time (`performance.now`);
  - CPU (`process.cpuUsage`);
  - statements run, by wrapping `hub.q` to count get/all/run;
  - response size (`JSON.stringify(...).length`) and its gzip size (`zlib.gzipSync`).

  Ran with `npm test -- test/_measure700.test.js` on Paul's Mac, under the load of four other workers. The script is in the appendix.
- **Live cost per job.** This needs the live hub's usage table, which workers can't reach. It was asked of the operator as Q224, with the exact read-only query (appendix). Only aggregates are reported.

## Numbers

### A worker's first load (what nuworq sends before its first useful call)

| What | Bytes | ≈ tokens (bytes/4) | Source |
|---|---|---|---|
| Tool definitions, `/api/tools` (any format) | 17,498–18,098 | ≈ 4,400 | demo hub |
| Agent guide, `/agents.md` (the MCP server's instructions) | 3,033 | ≈ 760 | demo hub |
| `checkin`, a new agent | 970 | ≈ 240 | demo hub |
| `next`, claiming work | 2,575 | ≈ 640 | demo hub |
| `checkin`, nuworq-sized hub, no session cursor | 4,946 | ≈ 1,240 | seeded hub |
| `next` peek, nuworq-sized hub | 3,066 | ≈ 770 | seeded hub |

So nuworq's share of a worker's start is about 25 KB, or 6,000 tokens. Tool definitions are 70% of it. The agent's own client (Claude Code's system prompt and its other tools) comes on top and isn't nuworq's to cut. In Claude Code the nuworq tools are deferred until searched, so the tools cost only applies to clients that load them all.

### The hub per request (seeded hub, mean of 10)

| Call | Wall ms | CPU ms | Statements | Bytes (gzip) |
|---|---|---|---|---|
| view 30s | 22.3 | 27.0 | 356 | 123,212 (12,327) |
| view 5m | 21.0 | 22.7 | 356 | 127,617 |
| view 30m | 23.0 | 25.9 | 356 | 327,407 (31,276) |
| checkin | 5.5 | 5.8 | 44 | 4,946 |
| next (peek) | 5.3 | 5.5 | 46 | 3,066 |
| look | 7.3 | 7.7 | 47 | 5,976 |

Seeding took 3,959 ms. The process grew by 120 MB of RSS, with a 65 MB heap. #514 measured the live view at 2.7–2.9 s before its parts landed. Its targets (view under 100 ms, checkin and next under 15 ms) hold here.

What fills the 30s view (123,212 bytes): `agents` 37,769 (31%), `attention` 33,674, `motion` 25,244, `stage_items` 16,400, `groups` 3,815, `flow` 2,667, `project` 1,523, `stages` 1,522. At 30s the page shows the pulse, Needs you, In motion and Flow. Agents show only as a count of who's here, and the stage lists open only from 5m.

### The browser

- **First load** of a project page (demo hub, 1280px): 54 requests, 144,198 bytes as sent (415,439 decoded). The HTML is 632 bytes. JS is 47 modules, 120,331 bytes (318,595 decoded), led by actions.js (21.4 KB gzip) and views/main.js (18.5 KB). style.css is 19.7 KB (85.8 KB decoded). The API calls are 6, 4.1 KB. Load finished at 84 ms on loopback.
- **Per live update** (an agent checked in): `/api/projects` 527 bytes, plus the whole `/api/p/<slug>/view?depth=…` again. That's 3.3 KB gzip (10.5 KB) on the demo's 18 items, and 12.3 KB gzip (123 KB) at 30s or 31.3 KB gzip at 30m on a nuworq-sized hub. That goes to every open tab, on every change.

### Cost per kind of job (live)

From the operator's answer to Q224. On 2026-11-02 at 14:16 UTC, on nuworq-vm, the query in the appendix ran read-only (node:sqlite with readOnly: true) on the northup workspace file. The usage table holds 1,621 rows, from 2026-10-29 16:44 to 2026-11-02 14:13 UTC, about 3.9 days. Every row's source is the runner, and every row is priced. Totals: $3,773.96, an average of $2.33 a run, and a maximum of $164.88.

| Job | Runs | $ total | $ avg | $ max | avg input tokens | avg output tokens |
|---|---|---|---|---|---|---|
| work | 605 | 2,218.61 | 3.67 | 161.88 | 3,880,194 | 11,158 |
| review | 449 | 735.91 | 1.64 | 130.30 | 1,787,386 | 4,483 |
| land | 106 | 628.21 | **5.93** | 164.88 | 4,678,681 | 10,810 |
| unknown | 238 | 108.50 | 0.46 | 2.81 | 572,899 | 1,660 |
| tidy | 80 | 43.07 | 0.54 | 1.87 | 616,243 | 1,959 |
| no item | 122 | 33.69 | 0.28 | 0.52 | 268,607 | 1,257 |
| shape | 21 | 5.97 | 0.28 | 0.90 | 390,885 | 1,892 |

How to read it:
- **Input tokens** are cumulative per run, cache reads included, as the runner reports them (src/usage.js), so input averages run into millions.
- **"no item"** is a run that held no item: the nothing-to-do worker, about $8.60 a day at $0.28 each.
- **"unknown"** is a run whose item has no take event (claimed, shaping, review_started, landing) by that agent, such as one whose claim failed.

### Turns

Not measured, because nuworq doesn't record them. `usage` (src/db.js:289-300) keeps input and output tokens and cost, but no turn count. That's true though the runner reads the agent CLI's JSON (`tap` in src/usage.js:51): Claude's `result` event carries `num_turns`, and Codex emits one `turn.completed` per turn. See finding 2.

## Findings

| # | Severity | Finding | Where | Cost | Fix | Item |
|---|---|---|---|---|---|---|
| 0 | high | A land job costs more than building the work: $5.93 a run on average (106 runs, $628 in 3.9 days), against $3.67 for work. A rebase and push should cost cents | src/core.js:2290 (land jobs offered by next) and :2460 `landHint`; a conflicting PR becomes a land job (the operator's Q223 counted 116 pr_blocked events) | About $160 a day on the live hub, 17% of all spend | Make landing cheap: the hub rebases clean ones itself, land jobs start on the cheapest tier with a short brief, and a land run is capped | #752 (now) |
| 1 | medium | The 30s view carries what 30s never shows: the full agent list (31%) and every stage's items, resent whole on each change to every open tab | src/insight.js:183 `view()`; web/ui.js:93, the view URL refetched on each change | 123 KB (12 KB gzip) per update per tab on a nuworq-sized hub, about 2× what 30s needs; 356 statements each time | Build only the sections the depth renders: at 30s the presence counts, not `agents`; `stage_items` from 5m | #750 |
| 2 | medium | Turns per job aren't recorded, so cost per turn and turns per job can't be measured or capped | src/db.js:289 `usage`; src/usage.js | The audit's "turns per job" can't be answered; a runaway loop shows only as dollars | Record `turns` from the CLI's result (Claude `num_turns`, Codex's turn count) and per job in outcomes | #751 |
| 3 | medium | Tool definitions are 70% of what nuworq sends a fresh worker | src/protocol.js OPS → `/api/tools` | ≈ 4,400 tokens per worker start on clients that load every tool | Already open | #678 |
| 4 | low | The app loads as 47 separate ES modules | web/*.js | 54 requests on first load; on a phone over high latency, the import chain adds round trips (HTTP/2 through Cloudflare softens it) | Keep, or add `<link rel="modulepreload">` for the first-level imports | — |
| 5 | low | Every view runs 356 statements on a 500-item hub | src/insight.js | 23 ms, inside #514's target; it grows with agents and items | Watch it at #514's re-check | #514 |
| 6 | low | A checkin without a session cursor sends the full context (4.9 KB on the seeded hub) | src/core.js checkin | Only for clients without `x-nuworq-session`; MCP sends one | None needed | #519 (done) |

The 2026-11-02 worker that found nothing to do and cost $0.20 in 20 seconds is the fixed start-up cost above (finding 3), paid before `next` said there was nothing. #542 (runners wait on a long-poll and start a worker only when work appears) and #678 address it. Q224's 'no item' row will show what such runs cost in total.

## Appendix: the scratch measurement and the live query

The scratch test (`test/_measure700.test.js`, not committed):

```js
import { test } from 'node:test';
import { seedHub, SLUG } from './seedhub.js';
import { view } from '../src/insight.js';
test('measure', async () => {
  const { hub } = seedHub();
  let queries = 0;
  const q = hub.q.bind(hub);
  hub.q = (sql) => { const st = q(sql); return { get: (...a) => (queries++, st.get(...a)), all: (...a) => (queries++, st.all(...a)), run: (...a) => (queries++, st.run(...a)), iterate: (...a) => (queries++, st.iterate(...a)) }; };
  // for each of view 30s/5m/30m, checkin, next peek, look: one warm call, then 10 timed with performance.now,
  // process.cpuUsage and the statement count; JSON.stringify(...).length for size, zlib.gzipSync for gzip size.
});
```

The live query (Q224), run read-only on the northup workspace file:

```sql
SELECT CASE WHEN u.item_id IS NULL THEN 'no item' ELSE COALESCE(json_extract(e.data,'$.job'), CASE e.type WHEN 'shaping' THEN 'shape' WHEN 'review_started' THEN 'review' WHEN 'landing' THEN 'land' WHEN 'claimed' THEN 'work' ELSE 'unknown' END) END AS job,
  COUNT(*) AS runs, ROUND(SUM(u.cost_usd),2) AS usd, ROUND(AVG(u.cost_usd),3) AS avg_usd, ROUND(MAX(u.cost_usd),2) AS max_usd,
  CAST(AVG(u.input_tokens) AS INT) AS avg_in, CAST(AVG(u.output_tokens) AS INT) AS avg_out, SUM(u.cost_usd IS NULL) AS unpriced
FROM usage u LEFT JOIN events e ON e.id = (SELECT MAX(id) FROM events WHERE item_id = u.item_id AND actor = u.agent AND type IN ('claimed','shaping','review_started','landing'))
WHERE u.at > (strftime('%s','now') - 7*86400) * 1000 GROUP BY job ORDER BY usd DESC;
```
