# Audit: true to its claims (#703)

Every claim on nuworq.com and in README.md, each with its verdict. Taken on 2026-11-02: the README at 0fcaec3, nuworq.com as nuworq-site's main at ab4abc1 (index, workflow, early-access, privacy, terms, 404).

**How.** Each page was split into sentences a reader could check. Each claim was then checked against the code and the test that make it true, or tried on a demo hub (`node bin/nuworq.js serve --demo --port 0`). The checking was split four ways: README to line 110, README from line 111, the landing page, and the other pages. The findings that decide a verdict (B44, P1, S2, S9, A37, A9, the Cheaper-models confirm) were checked again by hand at their lines. The tests below were run: `npm test -- test/{notify,weekly,freshness,leaserenew,opdetect,connect,plugin,up,service,usage,staffing,update,package,connectmodal,setupworks,sweep,device,rename,infratag,layered,priority}.test.js` gave 220 of 221 passing. The one failure is test/service.test.js:87, which fails only because this sandbox's TMPDIR contains "claude" (→ #771).

**nuworq.com itself** can't be reached from this runner (curl and web fetch are refused). Its pages were read from the nuworq-site repository's main, which is what nuworq.com serves. Whether the deployed copy matches ab4abc1 wasn't checked here.

**Live figures.** The landing page's "built itself" numbers (S5, S32, S59) come from the live hub, so they can't be checked from a demo. Their arithmetic was checked; a recheck from the live hub is for #679.

**Verdicts.** *true*: the evidence is given. *not yet*: the product doesn't do it, and the item that makes it true is named. *reworded*: the product does something close; the item that changes the words is named. nuworq.com rewordings are nuworq-site items (written `site #N`). README rewordings belong to #685, which makes the README describe v1.0.0 as shipped. *policy*: a promise about conduct, not something code can show; flagged where it needs product support.

**Result.** 290 claims: 215 true, 64 reworded, 2 not yet, 6 policy, and 3 live figures not rechecked. Only two claims promise something the product lacks: deleting a person's data (P11) and a hint on every error (B71). The rest of the gaps are scope or stale words. The biggest:
1. **Who checks the work.** nuworq.com's lead says "another agent reviews each item". New projects start on Keep moving, where you verify (S2). → site #33
2. **Privacy says code is never stored.** The hub keeps a `git clone --mirror` of each linked repository on its disk (P6). → site #36
3. **Done "only when git shows main contains it".** Pull-request landings are done on GitHub's merged event (S28). → site #34
4. **The privacy and terms promises have no product support.** Deleting a person's data → #769. Data export: reworded in site #36.
5. **The README's 5m and 30m sections have gone stale.** There are 20 operations, not 15. The attention table has rows that were removed and lacks the new ones. The architecture lists 15 of 63 source files. → #685

Not yet, now open: #769 (deleting a person's data), #770 (the Cheaper-models confirm contradicts what routing does). Also found: #771 (a test fails in Claude Code's sandbox).

To walk this again (#679): take each row, open its place, and check that the evidence still holds. Where a row names an item, check that the item is done and the sentence changed.

## README.md

Lines at 0fcaec3.

| # | Line | Claim | Verdict | Evidence |
|---|---|---|---|---|
| A1 | 8 | The "Connect an agent" dialog gives these install lines with the hub's address | true | web/connect.js:18-22, 35; test/connectmodal.test.js:59-62 |
| A2 | 8 | The newest signed release is served publicly, no login | true | src/server.js:994-1003; test/package.test.js:82, 255 |
| A3 | 8, 12 | The signature is checked before anything installs | true | web/connect.js:14-16, 40; test/package.test.js:124-129 |
| A4 | 16 | The last word of line 2 is `release-key.pub` | true | release-key.pub; test/connectmodal.test.js:54, 62 |
| A5 | 16 | The install pins that key and updates only to releases signed with it | true | src/update.js:43, 51, 216; test/update.test.js:176, 181, 231, 236 |
| A6 | 19 | `connect` logs in in the browser and saves the token | true | bin/nuworq.js:1430-1496; test/connect.test.js:134 |
| A7 | 19 | `connect` "registers Claude Code and Codex" | reworded → #685 | It also registers opencode and pi (src/connect.js:139-190). With the plugin installed it leaves Claude Code to the plugin (:315-326). Say "registers nuworq with the agent tools it finds" |
| A8 | 24-34 | The three-session setup; `connect` offers the plugin | true | web/connect.js:67-86; test/setupworks.test.js:87; bin/nuworq.js:1536-1563 |
| A9 | 26, 46 | The runner service keeps going "after a restart" / "across reboots" | reworded → #685 | A LaunchAgent or systemd user unit starts at login, not at boot (src/service.js:36-66). Linux needs `loginctl enable-linger` to run while logged out (bin/nuworq.js:1139) |
| A10 | 32 | `operator --start` runs `claude` with `/nuworq:operator` | true | bin/nuworq.js:178, 245-265; test/setupworks.test.js:101 |
| A11 | 36 | `run --workers 3 --agent claude` runs here until Ctrl-C | true | bin/nuworq.js:1390-1392 |
| A12 | 36 | `up` restarts the runner "if its flags differ" | reworded → #685 | Only when it lacks `--workers auto` or isn't running (src/up.js:91-94; test/up.test.js:57) |
| A13 | 36 | `up` asks once about unstaffed projects; a no is remembered | true | bin/nuworq.js:349-369 |
| A14 | 36 | Operators open in tmux, else Terminal/iTerm, else commands are printed; projects without a clone are skipped | true | src/up.js:60-145; test/up.test.js:90, 161, 168, 178 |
| A15 | 36 | Rerun starts only what's missing; `--dry-run` only prints | true | src/up.js:150-164; test/up.test.js:82, 141 |
| A16 | 36 | `down` "stops … the runner service" | reworded → #685 | It uninstalls it (bin/nuworq.js:442 → src/service.js:131-139) |
| A17 | 38 | `run` staffs only opted-in projects, one worker per waiting item | true | src/runner.js:20-34; web/views/main.js:277 |
| A18 | 38 | A worktree per worker, a branch per item from the latest main | true | bin/nuworq.js:958, 1008-1015 |
| A19 | 38 | `worker --run` "goes wherever work is waiting across projects" | reworded → #685 | It takes `--project`, else the folder's project, else the hub's route, and stays there (bin/nuworq.js:633-651) |
| A20 | 38 | codex/opencode/pi need `--can-read-keys`; only Claude is kept from keys | true | bin/nuworq.js:527-531, 559 |
| A21 | 38 | opencode and pi run only on projects without a remote | true | bin/nuworq.js:953-957 |
| A22 | 38 | A pi worker gets its own config folder | true | bin/nuworq.js:868-885, 1070 |
| A23 | 43 | `--max-runs`, `--max-minutes`; logs in `~/.nuworq/logs` | true | bin/nuworq.js:1213, 1268, 1385-1388. `--max-minutes` caps each worker (src/runner.js:382) |
| A24 | 46 | `--install` writes the LaunchAgent / user unit, starts it, prints removal | true | src/service.js:71-128; test/service.test.js:15, 27, 58 |
| A25 | 46 | Installing again replaces it; log `~/.nuworq/logs/run.log` | true | src/service.js:115-120; bin/nuworq.js:1126 |
| A26 | 46 | The service looks for checkouts beside it or in `NUWORQ_REPOS`, naming missing ones | true | src/service.js:145-181; test/service.test.js:164, 173, 193 |
| A27 | 46 | A worktree is kept only for uncommitted changes or commits on no branch | reworded → #685 | It's also kept when its git pointers changed (src/runner.js:76; bin/nuworq.js:1309) |
| A28 | 46 | The branch goes once landed (origin, merged PR or `git cherry`) | true | src/runner.js:136-153; test/sweep.test.js:125 |
| A29 | 46 | The hub deletes a landed item's branch on GitHub | true | src/core.js:1141, 2755-2771; test/sweep.test.js:219 |
| A30 | 46 | The weekly sweep: repair first, never your checkout or unlanded work; `--sweep`, `--dry-run` | true | src/runner.js:155-212; test/sweep.test.js:40, 92, 125, 180 |
| A31 | 48 | `--max-usd` stops launching; codex and local models don't count | true | src/runner.js:477-481; src/usage.js:68, 103; test/runner.test.js:852 |
| A32 | 50 | Staffing is set on the hub (`run_workers`, `run_paused`, `run_budget`) | true | web/actions.js:108-124; src/core.js:4118-4190 |
| A33 | 50 | Workers at once / Pause / Daily budget (UTC, all runners) | true | src/core.js:976-983; test/staffing.test.js:55, 72 |
| A34 | 50 | A new project asks once and stays unstaffed | true | test/staffing.test.js:28 |
| A35 | 52 | Claude workers load only nuworq (+ Playwright), no plugins or skills | true | bin/nuworq.js:888-910, 1046; test/runner.test.js:307-319 |
| A36 | 54 | `--browser`: pinned Playwright MCP, throwaway profile, local pages only | true | bin/nuworq.js:830-861; test/runner.test.js:283 |
| A37 | 54 | "(the app is light only)" | reworded → #685 | The app has a dark theme. The worker task says "in light and in dark" (bin/nuworq.js:982), and test/runner.test.js:347 asserts it doesn't say "light only" |
| A38 | 54 | A browser worker gets browser work ahead of same-priority work | true | src/core.js:2329; test/fit.test.js:174 |
| A39 | 56 | Per-item cost by agent and model, split by time | true | web/views/drawer.js:41; src/usage.js:31 |
| A40 | 56 | The per-CLI readers and what each reports | true | src/usage.js:54-105; test/usage.test.js:53-76 |
| A41 | 56 | The tests use sample output, not live captures | true | test/usage.test.js:17, 37 |
| A42 | 58 | The plugin is the MCP server, two commands and a self-loading skill | true | src/plugin.js:35-52; test/plugin.test.js:18, 53 |
| A43 | 61-62 | Install from the marketplace at `#release`, user scope | true | src/connect.js:14; test/plugin.test.js:37 |
| A44 | 67 | The plugin starts `nuworq mcp` and holds no token | true | plugin/.mcp.json; test/plugin.test.js:29 |
| A45 | 67 | `connect` leaves Claude Code to the plugin, removes earlier entries | true | src/connect.js:315-326; test/connect.test.js:246 |
| A46 | 67 | Only an account-wide install counts; leftovers removed (`--yes`) | true | src/connect.js:213-305; test/connect.test.js:289, 351 |
| A47 | 67 | Without the plugin, skills are written only on decline / `--skills` / no terminal | true | bin/nuworq.js:1553-1562; test/connect.test.js:375 |
| A48 | 67 | `plugin/` is generated; a test fails on drift | true | bin/nuworq.js:2187-2197; test/plugin.test.js:73-79 |
| A49 | 69 | Only the release signer moves `release`, to approved, signed releases | true | scripts/signer.js; test/signer.test.js:279, 294. GitHub rulesets let only the maintainer move `release`, checked live 2026-11-02 (docs/SECURITY-MODEL.md:70, #757) |
| A50 | 69 | The marketplace entry is `git-subdir` ref `release` | true | .claude-plugin/marketplace.json; test/plugin.test.js:37-40 |
| A51 | 69 | The plugin has no version, so each release is new | true | src/plugin.js:31-33; test/plugin.test.js:26, 33 |
| A52 | 78 | Approve a code in the browser; the token is `<you>@<machine>` | true | src/device.js:14-93; test/device.test.js:51, 92 |
| A53 | 78 | Saved in `~/.nuworq/connect.json`, readable only by you | true | bin/nuworq.js:1491-1496 (0600); test/connect.test.js:46 |
| A54 | 78 | MCP added to Claude Code, Codex, opencode, pi; no token in configs | true | src/connect.js:76-190; test/connect.test.js:156-184. (Typo: a comma is missing after "Codex (…)") |
| A55 | 78 | `NUWORQ_URL`/`NUWORQ_TOKEN` win over the saved connection | true | test/connect.test.js:46 |
| A56 | 78 | Connecting again revokes the old token; `--token`, `--token -`, `--no-mcp` | true | bin/nuworq.js:1472-1489; test/connect.test.js:61, 212 |
| A57 | 78 | `disconnect` revokes and removes only what connect added; twice is harmless | true | bin/nuworq.js:1583-1591; test/connect.test.js:191-234 |
| A58 | 83-85 | `serve` on :4747 with `~/.nuworq/nuworq.db`; `--demo`; `seed` | true | bin/nuworq.js:1659-1723; src/client.js:10 |
| A59 | 88 | Agents find their project from the folder, else the hub routes them | true | bin/nuworq.js:638-651 |
| A60 | 89 | Node 24+, no dependencies | true | package.json (`engines >=24`, no `dependencies`) |
| A61 | 97 | `nuworq init` does "the same for opencode and other MCP clients" | reworded → #685 | `init` only prints snippets, and they use `node "<path>/nuworq.js" mcp`, not `nuworq mcp` (bin/nuworq.js:1606-1639) |
| A62 | 109 | The product's former name is still read | removed → #792 | Only nuworq's own names are read now: src/names.js; test/names.test.js |
| B1 | 120 | 0: healthy work, recovered failures, idle projects don't appear | true | src/insight.js:231; test/notify.test.js "healthy activity sends nothing" |
| B2 | 121 | 30 s: a sentence of pulse and the act entries; `nuworq status` | true | bin/nuworq.js:77-93 |
| B3 | 122-123 | 5m, 30m and *Deep dive* | true | src/insight.js:180, 251-288; web/views/drawer.js:195 |
| B4 | 125 | headline / summary / detail layers | true | src/protocol.js:111; test/layered.test.js |
| B5 | 128-130 | The lifecycle line | true | Fixed by #706: src/core.js:101-111 |
| B6 | 134 | Routing across projects; workers don't name one | true | src/core.js:825, 2147 |
| B7 | 134 | Order: "your picks first, then whatever waited longest" | reworded → #685 | Effective priority, then building before shaping, then longest waiting (src/core.js:843-846) |
| B8 | 134 | Each worker gets its own worktree | true | bin/nuworq.js:958, 1014 |
| B9 | 135 | 20-minute lease | true | src/core.js:45 |
| B10 | 135 | "progress or a silent heartbeat renews it" | reworded → #685 | Any call renews it, and so does the runner's report (src/core.js:2091; test/leaserenew.test.js) |
| B11 | 135 | A quiet agent's work returns to the queue | true | src/core.js:1952-1984 |
| B12 | 136 | The checkin brings mission, decisions, notes, steering, answers, verdicts, who's on what | true | src/core.js:2204-2232 |
| B13 | 137 | Handoffs are notes the next agent starts from | true | src/protocol.js:210 |
| B14 | 138 | Ask with an assumption; blocking parks the item | true | src/protocol.js:149-169 |
| B15 | 139 | Evidence and someone else's verdict, never your own | true | src/core.js:2290-2300 |
| B16 | 140 | Field notes | true | src/protocol.js:294 |
| B17 | 141 | With nothing ready, `next` hands out shaping | true | src/core.js:2327-2342 |
| B18 | 142 | Flow: agents, queue, or you | reworded → #685 | There's a fourth court, outside (src/insight.js:1059) |
| B19 | 143 | Weekly freshness item, on by default, priority later, off in controls | true | src/freshness.js:8-36; src/db.js:416; test/freshness.test.js |
| B20 | 143 | Safe updates in one batch, breaking ones proposed | true | src/protocol.js:103 |
| B21 | 144 | "Nothing is moving: 9 ideas waiting… What matters most?" | true | src/insight.js:240, 656 |
| B22 | 147 | A steer must be acknowledged; you see who did | true | src/insight.js:603 |
| B23 | 148 | Decisions every session; an answer can save one | true | src/core.js:2212, 3881 |
| B24 | 149 | Note for the record | true | human `comment` |
| B25 | 150-153 | The autonomy dial | true | src/core.js:123-148, 2290 |
| B26 | 154, 157 | Push on new act entries in unparked projects | true | src/notify.js:194-204; test/notify.test.js "a parked project stays silent" |
| B27 | 157 | A 2-minute window, one message, a link to the project | true | src/notify.js:117, 157 (with several projects the link is the home page) |
| B28 | 157 | Each entry pushed once; ones dismissed in the window are dropped | true | src/notify.js:236, 253; test/notify.test.js "never pushed twice" |
| B29 | 159 | A weekly line per busy unparked project | true | src/notify.js:135-152; test/weekly.test.js |
| B30 | 159 | Its numbers match `/outcomes` | true | test/weekly.test.js "with the outcomes API's numbers" |
| B31 | 159 | A quiet week sends nothing; off per channel | true | src/notify.js:149; test/weekly.test.js |
| B32 | 161-165 | `notify add/test/list/remove`; bare topic means ntfy.sh | true | bin/nuworq.js:2031-2058; src/notify.js:10-40 |
| B33 | 167 | "Channels are hub-wide" | reworded → #685 | There are personal channels too (`--person`, src/notify.js:31-46, 262) |
| B34 | 167 | URLs are never shown in full | true | src/notify.js:21; test/notify.test.js |
| B35 | 167 | `--public-url` / `NUWORQ_PUBLIC_URL` | true | bin/nuworq.js:1698 |
| B36 | 167 | Retried once, then Worth knowing; never blocks agents | true | src/notify.js:86-107; src/insight.js:688-695 |
| B37 | 172 | Verified with opencode 1.18 + "Qwen3 27B" | reworded → #685 | docs/OPEN-WEIGHT.md:5, 23 says qwen3.8:27b |
| B38 | 173 | CLI `nuworq checkin --as name` | true | bin/nuworq.js:2072, 2089 |
| B39 | 174 | `/api/tools?format=…` | true | src/server.js:1611; src/protocol.js:359-366 |
| B40 | 175 | Headless workers for four CLIs, worktree, branch per item, scoped tools | true | bin/nuworq.js:515, 977, 1014, 1046 |
| B41 | 176 | The runner: up to N, one per item, never a herd | true | src/runner.js:15-30; test/runner.test.js |
| B42 | 178 | The MCP server delivers the guide; `nuworq guide`; `/agents.md` | true | src/mcp.js:83; src/server.js:1109 |
| B43 | 182 | The operator checks in with `has: ["operator", …]` | true | src/core.js:1444-1449 |
| B44 | 182 | Items needing operator tags "are offered only to it" | reworded → #685 | Only workers are kept off them (src/core.js:2273). An attended session that declares `infra` gets them too. Say "never to workers" |
| B45 | 182 | Old tag names are stored as `infra` | true | src/protocol.js:47; test/infratag.test.js |
| B46 | 183 | The operator answers `to: "operator"` questions instead of you | true | src/insight.js:353; src/core.js:3088-3107 |
| B47 | 184 | It escalates with one question and evidence | true | src/protocol.js:165; src/core.js:3032 |
| B48 | 185 | No operator in a day → Worth knowing | true | src/insight.js:617-634 |
| B49 | 191 | `--detect` rules | true | src/operator.js:39-70; test/opdetect.test.js |
| B50 | 191 | Only a person at a terminal changes the infra check | true | src/operator.js:28-35; test/opdetect.test.js |
| B51 | 191 | Typed capabilities replace detection | true | src/protocol.js:53-56 |
| B52 | 193 | `--start`'s allow list | true | src/operator.js:101-113 |
| B53 | 193 | "gh writes still ask" | reworded → #685 | `gh pr:*` and `gh run:*` are allowed outright, so merge, close, rerun and cancel don't ask (src/operator.js:101-136) |
| B54 | 193 | `--allow` after a yes; `--allow --off` | true | bin/nuworq.js:227-239 |
| B55 | 195 | The listener holds one request and wakes only its own session | true | src/wait.js:16-46; bin/nuworq.js:457-507 |
| B56 | 195 | It wakes for operator items, questions and answers | reworded → #685 | It also wakes for steering (src/wait.js:89-92). The line reads "(#219 in <project>)" (:165) |
| B57 | 195 | Ids and kinds only; `--project`, `--all-projects` | true | src/wait.js:1-5, 85-88 |
| B58 | 195 | Only a person invokes the skill | true | src/plugin.js:14-19 |
| B59 | 197 | The monitor needs Claude Code ≥ 2.1.105, interactive, trusted | true (not checkable here) | A Claude Code requirement; the repo has the fallback (src/protocol.js:495) |
| B60 | 205 | `bin/nuworq.js` command list | reworded → #685 | It leaves out worker, run, operator, notify, connect, up/down, wait, update and more (bin/nuworq.js:2125-2214) |
| B61 | 206-220 | Each listed source file does what's said | true | the header comment of each file |
| B62 | 219 | `scripts/live-opencode.mjs`, `live-pi.mjs` | true | both exist |
| B63 | 221 | web: "one delegated event handler" | reworded → #685 | One delegated click handler (web/app.js:48), with about 20 other listeners |
| B64 | 222 | deploy/ holds Dockerfile, compose, systemd, Caddyfile | true | deploy/ |
| B65 | 203-222 | The architecture covers the main files | reworded → #685 | It lists 15 of 63 src files. Missing include db.js, operator.js, wait.js, workspaces.js, oauth.js, git.js, gitproxy.js, ghapp.js, outcomes.js, models.js |
| B66 | 224 | One SQLite file, `node:sqlite`, WAL | true | src/db.js:1, 90, 636 |
| B67 | 226-227 | "15 operations" | reworded → #685 | src/protocol.js defines 20: also answer, withdraw, retire, distill, feedback |
| B68 | 230 | Steering rides on every response | true | src/core.js:2111-2118 |
| B69 | 231 | Over-long headlines are trimmed into the summary | true | src/core.js:179-210 |
| B70 | 231 | Progress after a lost lease is kept as a comment | true | src/core.js:3209-3214 (#733 is open on how) |
| B71 | 231 | "Every error carries a hint" | not yet → #715 | Hintless: src/core.js:1098, 1241, 1647, 2422; src/server.js:1862 |
| B72 | 232 | `next` order: reviews, priority, fit, touched before | reworded → #685 | Landing jobs come first, then reviews, then priority; building before shaping (src/core.js:2312-2343) |
| B73 | 233 | `serve` writes `~/.nuworq/hub.json` | true | bin/nuworq.js:1722 |
| B74 | 233 | A project learns its folder and remote; remote first | true | src/core.js:788-815 |
| B75 | 234 | `touching`, `heads_up`, shown in In motion | true | src/core.js:3206, 3220; src/insight.js:755 |
| B76 | 235 | Notes and handoffs are information, not instructions | true | src/core.js:72-85 |
| B77 | 240-252 | The attention table's rows for: What matters most, blocking question, CI failing, proposal under Check with me, assumption, unacknowledged steer, failing channel, healthy work | true | src/insight.js:353-374, 523-549, 586-615, 651-661, 687-695 |
| B78 | 241 | "Work waiting but no agent connected" → act | reworded → #685 | No agent *working*; act only when nothing is in flight, else know (src/insight.js:676-684) |
| B79 | 243 | Finished work waiting for you → act | reworded → #685 | Not under Run with it (src/insight.js:497-520) |
| B80 | 246 | A bouncing item → act: clarify, split or drop | reworded → #685 | Only when a person can help, and the step may be an answer or an agent to start (src/insight.js:566-584) |
| B81 | 248 | "New agent proposals" → know | reworded → #685 | Removed in #497 (src/insight.js:535): delete the row |
| B82 | 250 | "Agents out of work" → know | reworded → #685 | Removed in #497 (src/insight.js:685): delete the row |
| B83 | 237-253 | The table lists the signals | reworded → #685 | Missing: operator-missing, kept-parked, pr-review, group-stalled, plan-limit, app-wiring (act); landing-stuck, outside-overdue, peer-review-stuck, unfit (know) |
| B84 | 257-276 | Each API route exists as described | true | src/server.js:1086-1850; src/wait.js:11 |
| B85 | 262-263 | The human actions listed | reworded → #685 | Those exist, plus step, unpark, keep, promote, pick, archive, restore, delete and more; `/api/wait` isn't listed |
| B86 | 280 | Security: loopback open, tokens, GitHub/Google sign-in, CSRF, rebinding, rate limits, CSP, body limit, workspaces | true | src/server.js:56, 97, 727, 1095-1145; src/oauth.js:35-128. (Agent tokens can do a little more than agent operations: AGENT_ROUTES, src/server.js:119) |
| B87 | 283 | `npm test` covers the listed areas | true | test/leaserenew, steering-split, keepparked, layered, errors, mcpbridge, auth |

## nuworq.com: the landing page (index.html)

| # | Where | Claim | Verdict | Evidence |
|---|---|---|---|---|
| S1 | meta, lead | Claude Code, Codex and open-weight models work in your repos | reworded → site #34 | opencode and pi run only on projects with no remote (bin/nuworq.js:952-956) |
| S2 | meta, lead | "Another agent reviews each item" | reworded → site #33 | Only under Run with it. New projects start on Keep moving, where you verify (src/db.js:11; src/core.js:123-139, 2290, 3435) |
| S3 | lead | Each item lands on main | true | src/core.js:2854; test/landing.test.js |
| S4 | lead | Your part is a sentence or two and the few decisions | reworded → site #33 | By default you also verify finished work (S2) |
| S5 | #promise | 429 items in about 3½ days, one action per 8 or so, as of 1 Nov | live figure | 429/50 = 8.6 fits. For the span, see S60 |
| S6 | #promise | The getting-started guide at /guide | true | src/server.js:845, 1113; demo hub: GET /guide → 200 "nuworq · Getting started" |
| S7 | #promise | Nothing is charged during early access; people let in by hand | true | src/workspaces.js:203-214 (grants unlimited, never charged); web/requests.html |
| S8 | #promise | The app has the same three depths | true | web/views/main.js:43-65 |
| S9 | #at-work | The screenshots were captured from `nuworq serve --demo` | reworded → site #35 | A fresh demo hub (75f477c) shows "Nobody is working": no agents, nothing to verify, no question on #12. The pictured state needs scripted activity |
| S10 | #at-work | #9 ready to verify, a question on #12, Flow 5/2/1/1/8 | reworded → site #35 | Same as S9 |
| S11 | #at-work | Phone: "2 things need you, 2 agents working on 2 items" | true | The pulse format matches src/insight.js:24-28, 238 |
| S12 | #how 1 | Write it as an outcome | true | web/propose.js:19 |
| S13 | #how 1 | Open GitHub issues come in as proposals | true | src/issues.js:1-23; test/issues.test.js |
| S14 | #how 1 | Agents shape them: criteria, read the code, split big work | true | src/core.js:102; test/shaping.test.js |
| S15 | #how 1 30m | Each item has an outcome title, summary, done means | true | src/core.js:3592 |
| S16 | #how 1 30m | "When nothing is ready, an agent is handed a proposal to shape" | reworded → site #35 | Priority comes first: a now proposal is shaped before soon ready work (src/core.js:2334-2340) |
| S17 | #how 1 30m | Dependabot alerts come in as ready work, first patched version as the bar | true | src/alerts.js:62-66; test/alerts.test.js:76. With no patched version, or under Check with me, they come in as proposals |
| S18 | #how 2 | Any number at once, each with its own worktree and branch | true | bin/nuworq.js:958 |
| S19 | #how 2 | Claim, say the files, keep a lease; quiet means back to the queue | true | src/core.js:45, 1952-1983; test/leaserenew.test.js |
| S20 | #how 2 30m | The hub routes workers across projects, your picks first | true | src/core.js:817-850; test/routewait.test.js |
| S21 | #how 2 30m | A 20-minute lease that progress renews | true | src/core.js:45 |
| S22 | #how 2 30m | Low on context, it hands off with a note | true | src/protocol.js (handoff) |
| S23 | #how 3 | Reviewed against criteria and evidence, never its own | reworded → site #33 | The own-work rule holds (src/core.js:2290-2292). By default a person reviews |
| S24 | #how 3 30m | Evidence: tests, commits, PRs, screenshots | true | src/core.js:2955 (labels and links) |
| S25 | #how 3 30m | A different agent accepts or sends back with reasons | reworded → site #33 | The send-back is as said (src/core.js:3825-3833); "a different agent" holds only under Run with it |
| S26 | #how 3 30m | The record shows who built and who verified | true | web/views/drawer.js:144 |
| S27 | #how 4 | Rebased, checked, fast-forwarded or merged by PR | true | src/core.js:3803-3806 |
| S28 | #how 4 | Done only when git shows main contains it | reworded → site #34 | A PR landing is done on GitHub's merged event (src/github.js:102-111). No-code items and repo-less projects are done at accept (src/core.js:3784-3796) |
| S29 | #how 4 30m | Accepted work lands before new work starts | true (in a project) | src/core.js:2342. Across projects priority comes first (W16) |
| S30 | #how 4 30m | If rebase fixes change the approved work, it goes back to review | true | src/core.js:2856-2864; test/landing.test.js "conflicts that change the approved work…" |
| S31 | #how 4 30m | Done only when its mirror shows main contains it | reworded → site #34 | As S28 |
| S32 | #how tally | ⌘K launcher: 31 min, five agents, $8.22 | live figure | See S55 for the code it describes |
| S33 | #how | Needs you: a blocking question, a direction, work to verify | true | src/insight.js:497-507; src/notify.js:15 |
| S34 | #see 0 | Healthy work, recovered failures, idle projects don't appear | true | test/notify.test.js "healthy activity sends nothing" |
| S35 | #see 30s | Pulse plus the few things, each with its button | true | src/insight.js:228-241; web/views/main.js:289-333 |
| S36 | #see 5m | What's moving, whose move, what's next, whether steering landed | true | web/views/main.js:447-457 |
| S37 | #see 30m | Every item's history, every event, every agent's record | true | web/views/drawer.js:153; web/views/main.js:621 |
| S38 | #see mock | "23 finished while you slept" | reworded → site #35 | The app says "since you last looked" (src/insight.js:241) |
| S39 | #see | At 30m each card opens to why | true | src/insight.js:504 |
| S40 | #see | Agents write in three layers | true | src/core.js:178 |
| S41 | #why intro | Work is checked by a different agent | reworded → site #33 | As S2 |
| S42 | #why | Done when git confirms main contains its branch | reworded → site #34 | As S28 |
| S43 | #why | Notifications only when something new needs you | true | test/notify.test.js "never pushed twice" (the weekly line is a separate opt-out) |
| S44 | #why | Claude Code, Codex, opencode with local models, or your own | reworded → site #34 | opencode only without a remote; pi isn't named (bin/nuworq.js:515, 952) |
| S45 | #why | Agents are warned before they touch the same files | true | src/core.js:1698-1706; test/race.test.js:72 |
| S46 | #why | Model keys never touch nuworq | true | Agents call providers themselves; src/runtrust.js:118; src/secrets.js |
| S47 | #why | The hub reads a mirror "only to confirm that work landed" | reworded → site #34 | It also feeds review prefetch, rebase nudges and head checks; pushes go through the hub (src/gitproxy.js) |
| S48 | #why | Agents start warm: mission, decisions, notes, item history | true | src/core.js:2204-2231 |
| S49 | #why | An answer can become a decision | true | web/actions.js:555 |
| S50 | #why | From "ask me" to "run with it" | reworded → site #35 | The app says "Check with me" (src/core.js:123-138) |
| S51 | #why 30m | Checkin briefings | true | src/core.js:2208-2229 |
| S52 | #why 30m | Only a truly blocked item parks | true | Items handed back 3 times also park (src/core.js:56) |
| S53 | #why 30m | Flow: agents, queue, or you | true | web/views/main.js:457 (plus outside) |
| S54 | #why 30m | "Nothing is moving: 9 ideas…" | true | src/insight.js:240, 656 |
| S55 | #story | `GET /api/launcher`, fzf-style ranking, one-pass pre-check, second Enter, nothing deletes, current project first | true | src/server.js:1459; web/launcher.js:1-93; test/launcher.test.js |
| S56 | #pricing | Free: one agent at a time, "coming" | true | src/workspaces.js:15, 95 (built, enforced only with plans on) |
| S57 | #pricing | Team: "Shared organizations" | reworded → site #35 | The standing decision says workspace (test/workspaceword.test.js:7) |
| S58 | #pricing 30m | Per-item cost per agent and model; a daily budget stops new workers | true | web/views/drawer.js:41-49; test/staffing.test.js (codex reports no cost) |
| S59 | #proof | 429 items, 11m, 50 actions, $3.38, 11/338, 11/421, $1,451, 198 sessions | live figure | $1,451/429 = $3.38; 429−8 = 421; 429/50 = 8.6 |
| S60 | #proof | 17 + 109 + 85 + 203 by day; "about 3½ days" | reworded → site #35 | These sum to 414, not 429. The evening of 28 Oct to 1 Nov 12:33 is about 3.7 days |
| S61 | #faq | Ready-made workers for Claude Code, Codex, opencode | reworded → site #34 | As S44 |
| S62 | #faq | Unlike Conductor: a different agent reviews each piece | reworded → site #33 | As S2; the rest holds |
| S63 | #faq | Agents run on your machines; the hub keeps a read-only mirror | true | src/ghapp.js:15 |
| S64 | #faq | A one-hour token for one repository | reworded → site #34 | The agents' token is read-only; pushes go through the hub (src/server.js:310-320) |
| S65 | #faq | Stuck: assume and go on, or park; out of context: hand off | true | src/protocol.js |
| S66 | #faq | You see Needs you, Flow and layered history | true | as S35-S37 |
| S67 | #faq | You're told the price and asked first | true | src/server.js:1497-1507 (only an explicit Checkout charges) |
| S68 | #faq 30m | `nuworq run --workers 3` starts an agent per waiting item | reworded → site #35 | Only in projects you let it staff (src/core.js:829; test/staffing.test.js:28) |
| S69 | #faq 30m | From your phone: workers at once, pause, budget | true | web/actions.js:110-124 |
| S70 | #faq 30m | Files declared, warned before collisions, who's touching what | true | src/core.js:1698; web/views/main.js:418 |
| S71 | #faq 30m | Autonomy per project; answers can become decisions | true | src/core.js:123 |
| S72 | #faq 30m | Dependabot alerts: patched version, tests, GitHub shows fixed; critical/high are now | true | src/alerts.js:13, 65; test/alerts.test.js:76 |
| S73 | #faq 30m | A notification only when something new needs you, each with its button | true | as S43, S35 |

## nuworq.com: How work moves (workflow.html)

| # | Where | Claim | Verdict | Evidence |
|---|---|---|---|---|
| W1 | #cast | You, shaper, workers, operator, hub, each in its role | true | src/core.js:2268 |
| W2 | #setup | Install, connect, approve the code; a token per machine | true | src/device.js; test/device.test.js |
| W3 | #setup | The plugin gives /nuworq:shaper and /nuworq:operator | true | plugin/.claude-plugin/plugin.json; test/plugin.test.js:53 |
| W4 | #setup | GitHub App; staffing; `nuworq run --workers 3 --agent claude` | true | src/userguide.js:112; test/guidefresh.test.js |
| W5 | #setup 30m | One-hour tokens, one repo at a time, no PAT | true | src/ghapp.js:3, 12, 233 (read-only for agents: site #34) |
| W6 | #setup 30m | Staffing off by default; the runner can be a service | true | src/db.js:15; test/staffing.test.js; src/service.js |
| W7 | #setup 30m | Operator in a terminal, shaper in the app | true | src/userguide.js:92 |
| W8 | #shape | Reads first, asks 1-2 at a time, recommends, files only on yes, reads back; decisions only if you confirm | true | plugin/skills/shaper/SKILL.md:12-26; src/core.js:2268 |
| W9 | #autonomy | Check with me: proposals wait; you check all finished work | true | src/core.js:148, 3435; test/shaping.test.js |
| W10 | #autonomy | Keep moving: agents shape and start; you check finished work | true | src/core.js:2940, 3435 |
| W11 | #autonomy | Run with it: peer review, never their own | true | src/core.js:3437; test/protocol.test.js |
| W12 | #workers | A worker per waiting item, own worktree and branch | true | src/runner.js:16-33; test/runner.test.js "no herd" |
| W13 | #workers | Routed to the most valuable work, your priorities first | true | src/core.js:817-850; test/priority.test.js |
| W14 | #workers | Claims and says which files | true | src/protocol.js:139, 145 |
| W15 | #workers | Evidence, then "a different worker checks it" | reworded → site #33 | As S2 |
| W16 | #workers | Accepted work lands before new work starts | reworded → site #35 | True in a project. Across projects priority comes first (src/core.js:845) |
| W17 | #workers 30m | 20-minute lease; quiet → back to the queue | true | src/core.js:45; test/leaserenew.test.js |
| W18 | #workers 30m | Questions with assumptions; only truly blocked parks | true | src/protocol.js:150; test/protocol.test.js |
| W19 | #workers 30m | Handoff notes; send-backs with reasons | true | src/core.js:3825-3833 |
| W20 | #workers 30m | Done only when git shows main contains it | reworded → site #34 | As S28 |
| W21 | #operator | An attended session with your permissions; answers permission questions; runs live steps | true | plugin/skills/operator/SKILL.md; src/operator.js:63-67 |
| W22 | #operator | "It signs releases" | reworded → site #35 | Only after the maintainer approves at the key's machine; no session reads the key (docs/DEPLOY.md:268-280) |
| W23 | #operator | Administers GitHub, uses a browser, can review and land | true | src/operator.js:47-59; test/roles.test.js:85-108 |
| W24 | #operator 30m | Idle until the listener wakes it; asks you one question with steps | true | plugin/monitors/monitors.json; src/protocol.js:85, 544 |
| W25 | #cheaper | Off until you turn it on | true | src/db.js:448; test/models.test.js:50 (#723 would turn it on: change with it) |
| W26 | #cheaper 30m | In Settings under "Cheaper models" | reworded → site #35 | It's in Staffing, "Cheaper models where they do as well" (web/actions.js:113, 153) |
| W27 | #cheaper | nuworq never adds a model itself | true | src/core.js:4157; src/db.js:449 |
| W28 | #cheaper 30m | Up to six models per agent | true | src/models.js:9, 114; test/models.test.js:143 |
| W29 | #cheaper 30m | Best quality / Balanced 5 points / Cheapest that passes 15 | true | src/models.js:30-34; test/routing.test.js:16, 26 |
| W30 | #cheaper | Reviews and shaping on the top model | true | src/models.js:55; test/routing.test.js:37 |
| W31 | #cheaper 30m | Builds start on top; landing and tidying on cheapest | true | src/models.js:58-65 |
| W32 | #cheaper 30m | 10% of builds try one model down, or race | true | src/db.js:457-458; src/core.js:905-931; test/difficulty.test.js:84, 121 |
| W33 | #cheaper 30m | Only rote/standard, not urgent, within budget, counted | true | src/models.js:80-92; src/core.js:932; test/difficulty.test.js:58-134 |
| W34 | #cheaper 30m | 20 finished attempts each, then the cheapest within the bar | true | src/models.js:35, 57-69; test/routing.test.js:115 |
| W35 | #cheaper 30m | A failed attempt steps up a model | true | src/core.js:955-971; test/models.test.js:81, 113 |
| W36 | #cheaper | Analytics: Model routing, clean rate by kind | true | web/analytics.js:89; test/routing.test.js:152 |
| W37 | #you | Needs you holds only what you must do | true | src/insight.js |
| W38 | #you | "Your phone pings only when something new needs you" | reworded → site #35 | Only once you add a channel, and channels get a weekly line (src/notify.js:146) |
| W39 | #you | A steer "every agent must acknowledge" | reworded → site #35 | It's re-sent until acknowledged, up to 3 days (src/core.js:51, 1671-1678) |
| W40 | #you | A decision is a rule every agent follows | true | src/protocol.js:548 |
| W41 | #you 30m | Depth: 30s, 5m, 30m | true | src/insight.js:180 |

The app itself also contradicts this page. The Cheaper-models confirm (web/actions.js:651) says "Building, reviews and shaping stay on the top model", which W30-W34 and src/models.js disprove. → #770

## nuworq.com: early access, privacy, terms

| # | Where | Claim | Verdict | Evidence |
|---|---|---|---|---|
| E1 | early-access | Let in by hand; we send a link to set up a workspace | true | Owners decide in /requests.html; a grant link (docs/DEPLOY.md:333) |
| E2 | early-access | Email required, GitHub optional, 2000 characters | true | src/directory.js:310-319 |
| E3 | early-access.js | The config gives `{sitekey, open}`; closed says so | true | src/server.js:821; test/earlyaccess.test.js |
| E4 | early-access.js | One POST, checked with Turnstile | true | src/server.js:801-819; src/directory.js:32-44; test/earlyaccess.test.js |
| E5 | early-access.js | "updated" for a repeat | true | src/server.js:811; src/directory.js:315-318 |
| E6 | every page | Where you came from is sent and kept as a tag or hostname | true | site early-access.js (ab4abc1) sends `source`; src/server.js:810; src/directory.js:25-28 |
| E7 | early-access | Nothing charged | true | as S7 |
| P1 | privacy | Stores "GitHub username and account id" and email | reworded → site #36 | Only the verified email and provider (src/directory.js:53-59) |
| P2 | privacy | Stores workspace content | true | |
| P3 | privacy | Stores usage: tokens, cost, model | true | src/db.js:288-302 |
| P4 | privacy | Early access: email, handle, building, source, never the full address | reworded → site #36 | Also a keyed IP hash and the request's state (src/directory.js:300-319) |
| P5 | privacy | Billing: plan and Stripe customer; cards at Stripe | true | src/directory.js:111-127; src/server.js:1487-1523 |
| P6 | privacy | "Never stores your source code … not kept in nuworq's database" | reworded → site #36 | The hub keeps a `git clone --mirror` on its disk (src/git.js:152-345; docs/DEPLOY.md:243-245) |
| P7 | privacy | Model keys never touch nuworq | true | as S46 |
| P8 | privacy | Processors: Cloudflare, GitHub, Stripe | reworded → site #36 | Google sign-in, and the notification services you add, aren't named (src/oauth.js:20-26) |
| P9 | privacy | No selling, ads or training | policy | No analytics code; the CSP blocks third-party scripts (src/server.js:97) |
| P10 | privacy | A cookie only to keep you signed in; nuworq.com sets none | reworded → site #36 | Four cookies, all for sign-in, one a 10-minute sign-in check (src/oauth.js:30; src/server.js:493-504) |
| P11 | privacy | Deleted within 30 days on request | not yet → #769 | Only a whole workspace can be removed (src/workspaces.js:287-298); no way to delete an identity or a request |
| P12 | privacy | Told by email before changes | policy | |
| T1 | terms | "You sign in with GitHub" | reworded → site #36 | GitHub or Google (src/oauth.js:12-44) |
| T2 | terms | Your content stays yours | policy | |
| T3 | terms | Agents run on your machines; nuworq doesn't run your code | true | bin/nuworq.js:990-1046; the hub only runs git on its mirrors |
| T4 | terms | Acceptable use; may suspend | policy | No suspend feature; a host can remove a workspace |
| T5 | terms | Billing monthly via Stripe, cancel any time, 30 days' notice | policy | Stripe subscriptions exist (src/directory.js:111-127) |
| T6 | terms | On shutdown, "a way to export your data" | reworded → site #36 | There's no export; the host can copy the workspace's SQLite file |
| T7 | terms | No warranty, liability, changes by email | policy | |
| X1 | 404 | "Nothing here." | true | |
