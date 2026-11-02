# Audit: hardened (#702)

Limits and timeouts on every input, queue and loop; cheap outages; pinned versions; safe defaults. Audited on
2026-11-02 against main at 75f477c by claude-bde0. It built the push proxy's timeout (#738) and nothing else covered
here.

**Verdict:** the network edges are sound:
- request bodies are capped at 1 MB;
- connections and held requests are capped;
- every outbound fetch has a timeout;
- CI actions are pinned by SHA;
- updates are signed;
- `serve` binds loopback;
- workers are sandboxed and hold no write credential.

Spend and volume are not bounded:
- nothing caps what a worker spends by default, and what exists counts spend only after the worker exits;
- the runner's brake ignores failures slower than 15 s;
- one agent can write without limit, in size and in number.

There are 6 high findings, 4 medium and 9 low. Proposed: #761, #762, #764, #765, #766, #767 and #768.

## Findings

| # | Severity | Finding | Where | Costs or exposes | Fix (the limit to set) | Item |
|---|---|---|---|---|---|---|
| 1 | high | Spend counts only after a worker exits; no default caps; a killed claude run records $0; codex is never priced | src/runner.js:477-481, src/usage.js:58-61, 102, 68, bin/nuworq.js:1321, 1387-1388, src/up.js:91 | A 3.3 h run ($402.91 on 2026-11-01) is invisible to --max-usd and to the daily budget until it ends | Count spend per message while the worker runs; defaults of --max-minutes 90 and $25 per worker | #761 |
| 2 | high | The daily budget gates only starting a worker, not claiming | src/core.js:831 (route), next never checks staffing() | One worker takes item after item past the budget | next refuses runner workers new work once the budget is spent; Settings defaults run_budget to $20 | #762 |
| 3 | high | The runner's brake counts only exits under 15 s | src/runner.js:482 (FAST_FAIL_MS) | Workers that fail after 60 s: 595 launches in 3.3 h, no pause | Pause after 3 non-zero exits in a row, whatever their duration | #764 |
| 4 | high | summary, detail, acceptance, assumption, step fields and option text have no length limit | src/core.js:183-210 (layered), 3225-3226, 2974, 3242, 3594 | 20 comments of 900 KB make the project view 18 MB, refetched by every open tab | summary 4,000, detail 32,000, acceptance 4,000, step field 500, option 200 | #765 |
| 5 | high | No write rate limit per agent | src/core.js:2023-2030 (agentOp) | 5,000 proposals from one token in 2.5 s, all accepted | 60 writes a minute per agent; 200 open questions and 500 proposals per project | #766 |
| 6 | medium | checkin auto-creates projects with no cap | src/core.js:2034, 500-503 | Every project is loaded by tidyAll on every sweep | 100 projects per hub or workspace | #766 |
| 7 | medium | evidence and depends_on have no count or length limit | src/core.js:2955-2960, 1400-1407 | 1 MB of refs is about 250k queries in one transaction, blocking the hub | evidence 20 entries (label 300, url 2,000); depends_on 30 | #765 |
| 8 | medium | No spend alert reaches a person | web/views/main.js:658, src/notify.js:144 | A runaway run is found on the bill | Push at 80% of the daily budget, and when one worker passes $50 or 60 min | #767 |
| 9 | medium | The default allowlist includes npm install and every npm script | src/sandbox.js:155-156 | A worker can run any code it writes into package.json (inside the sandbox) | Only npm test and npm ci by default; more by project setting | #768 |
| 10 | medium | Codex runs with workspace-write, which doesn't stop reads | bin/nuworq.js:1083, 666 | A codex worker can read the person's keys | Refuse codex for projects with a remote, as opencode and pi are, until a read-deny exists | #768 |
| 11 | low | Reported usage has no upper bound | src/usage.js:7-26 | cost_usd 1e12 skews cost views | Refuse cost over $1,000 or tokens over 1e8 per report | — |
| 12 | low | events, questions, notes, usage and stripe_events are never pruned | src/core.js:4099, src/directory.js:163 | Slow growth, bounded once 4 and 5 are fixed | Prune stripe_events after 30 days | — |
| 13 | low | The MCP stdio line buffer has no limit | src/mcp.js:155-162 | Local parent only; the hub refuses over 1 MB anyway | Drop lines over 2 MB | — |
| 14 | low | checkin's model, client and status are stored unclipped | src/core.js:1251 | Large rows from one agent | 200 characters each | — |
| 15 | low | On a single hub, outbound reads a whole body (precondition res.text()) | src/outbound.js:76, src/precondition.js:231 | Memory, bounded only by the 10 s timeout | Read through the 1 MB cap guarded mode has | — |
| 16 | low | A clean PR whose merge keeps failing is retried every minute forever | src/core.js:2711-2743, 2781 | 60 GitHub calls an hour per item | Back off 1 min → 1 h per item | — |
| 17 | low | A GitHub webhook over 1 MB gets a 413 and is lost | src/server.js:56 | A rare big push event is missed | Polling covers PR state; accept 5 MB on the webhook route | — |
| 18 | low | An install with no commit time skips the downgrade check | src/update.js:223 | An older signed package could be installed over it | Refuse when the installed time is unknown | — |
| 19 | low | `--workers auto` defaults to half the cores, with no spend cap | src/runner.js:41 | Multiplies finding 1 | Cap the default at 2 until #761 lands | — |

## What was tried

The demo hub needs approval for anything beyond `serve --demo --port 0`. So these ran as throwaway node:test files
through `npm test -- <file>` (scripts/run-tests.js), against the repo's own code, in memory. They weren't committed.

- **The model API down or degraded:** `run()` from src/runner.js on a virtual clock for 3.3 h (the length of the
  2026-11-01 outage), with 3 workers, work always waiting, and a fake launch whose workers exit 1:

  | Workers fail | Launches | Pauses | Spend |
  |---|---|---|---|
  | in 5 s (API down) | 29 | 9 | — |
  | after 60 s (API retries, then fails) | **595** | **0** | — |
  | after 20 min, $3.67 each (the live mean per work run, #700), no --max-usd | 30 | 0 | $110 |
  | same, --max-usd 25 | 9 | 0 | $33, stopped by the cap after the runs that passed it ended |

  The brake works only for failures under 15 s (finding 3). Even an explicit --max-usd overshoots, because a run is
  counted only once it ends (finding 1).
- **One agent writing without limit:** an in-memory Hub; one agent made 20 comments with 900 KB summaries (all
  accepted; the project view went from 6,444 bytes to 18,009,168), then 5,000 proposals (all accepted, 2.5 s; the
  view built in 158 ms at 2.4 MB). Findings 4 and 5.
- **GitHub hanging or cut off:** the push proxy against a local fake that never answers, or that cuts mid-answer.
  It ends in 30 s with "remote: nuworq: GitHub didn't answer", and the hub survives (test/gitproxy.test.js, #738).
  GitHub refusing PRs or issue closes: #742, #739 and docs/audit/reliable.md.

## Pinning

- **CI:** actions pinned by full SHA (`.github/workflows/test.yml:27-28`), `permissions: contents: read`, 10-minute
  timeout, Node 24 and 26. Node is pinned by major only and the runner image is `ubuntu-latest`. That's acceptable
  with zero dependencies.
- **Updates:** `nuworq update` checks the sha256, verifies the ed25519 signature against the key in the installed
  package, refuses a different key, and refuses downgrades (src/update.js:209-226; gap in finding 18).
- **Plugin:** plugin/.mcp.json runs the installed `nuworq`. No npx, nothing fetched at runtime.
- **Runtime dependencies:** none, by decision.

## Safe defaults on a stranger's machine

- **Network:** `serve` binds 127.0.0.1:4747. Any other host forces auth and refuses to start without a human token
  (bin/nuworq.js:1682-1708). Without auth, only loopback Host names are answered, which blocks DNS rebinding, and
  cross-origin writes are refused (src/server.js:1095, 1099). `--demo` is in memory and loopback only.
- **Workers:** sandboxed with failIfUnavailable, no unsandboxed commands, writes limited to the worktree, network to
  an allowlist, and key files denied (src/sandbox.js:99-102). Settings are passed in, so a repo can't loosen them.
- **Credentials:** a read-only GitHub token; pushes go through the hub's proxy to nuworq/ branches only;
  subprocess env scrubbed; the SSH agent unset.
- **`nuworq up`:** installs one `--workers auto` runner (finding 19) and starts operators only where the person chose.

## Already capped

- **Requests:** body 1 MB (unread past 16 MB); 2,000 connections; held requests per caller (stream 20, wait 32,
  listener 2, route 8); waits at most 10 minutes.
- **Per address:** logins 10 per 10 min, device starts 10, early access 5 an hour; limiter maps 10k addresses.
- **Fields:** headline 140, agent name 60, touching 30, needs and has 20, steps 12, options 6, status 200, field
  note 600, feedback 4,000 characters and 10 a day.
- **Pruned:** deliveries, replies, session cursors, sessions, device requests, notified.
- **Webhooks:** redeliveries deduplicated by id.
- **Preconditions:** back off 60 s → 1 h, one check per host per 10 s.
- **Push proxy:** the command head is capped at 1 MB and the pack streamed.

Covered elsewhere: #734 (a dying worker's item), #736 (hung worker, runner git timeouts), #738 (push proxy), #739
(GitHub backoff), #740 (crash guards), #741 (follower health), #742 to #744, #752 (land cost).
