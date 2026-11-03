# Re-check: usable, polished, consistent

**What.** A second look at every medium-or-higher finding in docs/audit/usable.md (#694), docs/audit/polished.md (#698) and docs/audit/consistent.md (#696), after their fixes landed. Done by an agent that built none of the fixes.

**Commit.** c85fb5f7 (origin/main plus the v1.0.0 release commit).

**How.**
- A demo hub from this commit: `node bin/nuworq.js serve --demo --port 0`, on loopback with no login. No live hub and no ~/.nuworq data were used.
- The browser at 1280×900 and 375×812, light and dark (`document.documentElement.dataset.theme = "dark"`): Home, the project page at 30s and 5m, question cards, Settings, + Project, Notifications, Connect an agent, the launcher (⌘K), Analytics and /guide.
- The agent side through the demo hub's agent API (`POST /api/p/<slug>/agent/<op>`, sent from the page): checkin, next, ask (blocking with options, operator-routed with steps, non-blocking with an assumption), look, and the error paths. A checkin to a mistyped slug, too.
- Source lines for the wording findings, and `npm test -- test/actionkeys.test.js test/vocabulary.test.js` (6 of 6 pass).
- The CLI: running `node bin/nuworq.js --help` was refused by this runner's permissions. Its words were read from docs/CLI.md, which test/help.test.js keeps equal to `nuworq help all`, and from `serve`'s own start-up output.

## Re-checked findings

| Id | Item | Verdict | Evidence |
| --- | --- | --- | --- |
| usable 1 (high) | #710 | fixed | Cards show "Q1" and "Q2" beside the item ref (1280 light, 375 dark). ⌘K "q2" offers "Q2 Add the API key to the runner machine · Open". "question 3" finds the non-blocking Q3, and "Q1" finds Q1. |
| usable 2 (high) | #711 | fixed | Project page at 375, 30s: the first card's title is at y=722, inside the first screen. The composer moved below the cards. Home at 375: Needs you starts at y=554, and Get started now comes after it. |
| usable 3 (high) | #712 | fixed | An operator-routed question with steps shows as "FOR AN OPERATOR Q2 … no operator connected, so you can do it". The card has its steps (0 of 1 done), an answer box and Answer. "How to start an operator" links to guide#operator, which opens "Start an operator". |
| usable 4 | #713 | fixed | "Agent newbie-1 asked…" on cards, and "Agent newbie-1 idle" under Agents at 5m. |
| usable 5 | #714 | fixed | A checkin to "nuworqz" returns next: "nuworqz is a new project here; did you mean nuworq? If so, check in to nuworq instead (a person can archive nuworqz)." |
| usable 6 | #715 | fixed | submit without item: 400 "item is required", with a hint and an example. ack without steer: 400 "steer is required", with a hint. Unknown item: 404 with a `look` hint. A body that isn't JSON: a hint with an example. |
| polished 22 (high) | #747 | fixed | Project page opened at 375, then widened to 1280: after 1.5s the side column holds Needs you, Flow and the rest (423 characters of text). |
| polished 23 | #748 | fixed | + Project with no name: "Give the project a name." under the field, and the field is outlined (1280 dark). Notifications' Add with no URL: "Paste the channel's URL." under the field. |
| polished 1 | #716 | fixed | Commands in Connect an agent at 375 are `white-space: pre` and scroll sideways. `--here` is `nowrap`. |
| polished 2 | #717 | fixed | Dark `.seg` controls: the selected button has a light hairline border (rgb 216,219,224). 30s, 5m, Keep moving and Match device stand out at both widths. |
| polished 3 | #718 | fixed | Settings, light: off is a light track with a border, on is black. Dark: off is a dark outlined track, on is a light track with a dark knob. |
| polished 4 | #719 | fixed | `next` gives the field-notes job a summary that starts "Distill memory for people with distill…", and lists with "- decision 1:". |
| polished 5 | #720 | fixed | Analytics → Difficulty or size: "0 of 8 landed items were rated", and the bars show Rote/Standard/Hard 0 and "Not rated 8". Size is the same. |
| polished 6 | #721 | partly | Count fixed: 3 "new" tags on Home and the project page, against 8–11 before. Placement isn't fully fixed: a tag sits on its anchor's top-right corner. At 375 it lands at the right edge of the Needs you heading, between the summary's lines, and over the top of "standing" on the operator card. In Settings it sits above the end of each label, which reads fine. Low now. |
| consistent 1 (high) | #705 | fixed | "Keep this one" uses `keep-attempt` (web/actions.js:655, web/views/parts.js:40). test/actionkeys.test.js passes "ACTIONS names no action twice" and "'Keep this one' keeps that attempt". |
| consistent 2 | #706 | fixed | Done's blurb is "Landed: on main." (src/core.js:173). |
| consistent 3 | #706 | fixed | `look`'s stage enum lists all nine stages (src/protocol.js:344). docs/USAGE.md:124 gives the full lifecycle, and README links to it. |
| consistent 4 | #706 | fixed | No "close" left in src/tidy.js, src/protocol.js or plugin/skills/nuworq/SKILL.md. |
| consistent 5 | #706 | fixed | `next` lists "work, shape, review, land, tidy, or (operators) a question to answer" (src/protocol.js:136, docs/CLI.md:572). |
| consistent 6 | #707 | fixed | handoff: "Hand off an item you hold unfinished" (src/protocol.js:214, docs/CLI.md:750). |
| consistent 7 | #707 | fixed | The field-notes job is titled "Tidy nuworq's field notes". Settings says "Security audits". |
| consistent 8 | #707 | fixed | The composer's kinds are Steer / Decision / Comment (web/views/main.js:169, seen at both widths). |
| consistent 9 | #707 | fixed | "Recently landed" and "8 items landed in 14 days" at 5m and in Flow. No "finished" left in the drawer's text. |
| consistent 10 | #707 | fixed | The card is "Ready to verify". "Nothing to review" is gone from web/. |
| consistent 11 | #707 | fixed | The card is "Pick the next work". 5m says "did your steers land". The tidy job's summary defines Direction today for agents. |
| consistent 12 | #708 | fixed | Rail, Nobody is working card and Get started all say "Connect an agent" (1280 light, 375 dark). |
| consistent 13 | #708 | fixed | The card says "start a runner" and points at "The Runners section of this project page (depth 5m)". That section appears once the project is staffed or a runner reports (web/views/main.js:657-660). |
| consistent 14 | #708 | fixed | The rail and the dialog title say "+ Project". So do the CLI (bin/nuworq.js:375) and Get started. |
| consistent 15 | #708 | fixed | One label, "Staff it with nuworq run", in Settings, + Project, the launcher, the guide and CLI help (src/help.js:81,108,320). That help line says `nuworq staff` and `run --staff` turn on the same switch. |
| consistent 16 | #708 | fixed | The rail says Home and Guide. No "All projects" or "Getting started guide" label is left in web/. |
| consistent 17 | #708 | fixed | Settings' row is now "GitHub" ("Link pull requests and CI results to items", Set up). "Connect GitHub" means only the App. |
| consistent 18 | #708 | fixed | Settings' Park row explains: "It stays in your projects; Remove archives it instead." (web/actions.js:203). |
| consistent 19 | #709 | fixed | The 429 hint says "raise --workspace-cap" (src/server.js:1036). DEPLOY.md:104 names --org-cap only as the older name. |

## What the screenshots showed

- **Home, 1280, light (fresh hub):** a Nobody is working card with two commands, Connect an agent and Park this project. Get started (0 of 7) on the right. Three "new" tags. The rail reads + Project, Archived projects, Connect an agent, Notifications, Guide.
- **Project, 1280, light, 30s (fresh):** the composer with Steer / Decision / Comment, the Nobody is working card, and the side column with Needs you and Flow ("8 items landed in 14 days").
- **Project, 1280, light, 30s, after three asks:** Pick the next work, then "QUESTION #18 Q1 … Agent newbie-1 asked 10s ago", with Per day / Per item. Then "FOR AN OPERATOR Q2" with its steps, an answer box, "How to start an operator" and "Why it needs you".
- **Launcher, 1280, light:** "q2" gives one result, "Q2 Add the API key to the runner machine · Open".
- **Project, 1280, light, 5m:** Worth knowing ("#18 newbie-1 assumed: Yes, dashes"), Up next, Recently landed (8), Steering & memory ("did your steers land"), and Agents ("Agent newbie-1 idle").
- **Settings, 1280, light and dark:** off and on switches are clearly different in both themes. Three "new" tags sit above the end of their labels.
- **+ Project, 1280, dark:** "Give the project a name." under the outlined field. The `nuworq run` pill still breaks into its own column (low, polished 13).
- **Notifications, 1280, dark:** "Paste the channel's URL." under the field. The hint below it is still larger than the lead (low, polished 32).
- **Project, 375, light, 5m and 30s:** at 30s the mission is clamped, then Depth, the Needs you summary, and the first card from y≈650. At 5m, Autonomy and Settings come first.
- **Project, 1280, after widening from 375:** both columns are whole.
- **Home, 375, dark:** the summary, then Needs you at y=554. One "new" tag sits between the summary's lines and one at the heading's right edge.
- **Menu, 375, dark:** the rail as a list, Appearance and the version. "? Shortcuts" is still offered (low, polished 30).
- **Connect an agent, 375, dark:** commands on one line, scrolling. The GitHub App status dot sits alone on a line (low, polished 28). The fallback still says "install nuworq the way this hub was installed" with no command (low, usable 10).
- **/guide, 375, dark:** step 1 opened, with By hand and How you know it worked. **/guide#operator, 1280:** "2. Start an operator" with `claude` and `/nuworq:operator` to copy.
- **Analytics, 1280, light:** Difficulty or size shows "Not rated 8" under each chart.
- **Project, 375, dark, after tapping Per day:** the toast "Answered; the work is moving again", and the card left the list.

## New findings

No new critical or high issue. These are low:

| Severity | Where | What it costs | Fix, one line |
| --- | --- | --- | --- |
| low | Project page, Needs you summary, once an agent has checked in and gone idle | The summary says "1 item ready, but nobody is working", but no Nobody is working card is listed, so the line has nothing to act on. | Show the card whenever the summary says nobody is working, or word the summary to match the cards. |
| low | "new" tags at 375 (web/style.css:939) | A tag anchored to a wide row lands at the screen's edge or over the top of the next line's text. | Anchor to the label's text, not the row. |
| low | Connect an agent at 375, the connect command | The Copy button covers the end of the hub address until the box is scrolled. | Pad the right of `pre` by the button's width. |

One note on the setup, not the product: partway through, another session sharing this browser moved the tab to a different local hub (port 64229). The checks were redone on this hub.

Critical: 0. High: 0.
