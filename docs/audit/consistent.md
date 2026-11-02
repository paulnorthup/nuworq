# Audit: consistent (#696)

One name for each thing and one way to do it, across the app, the CLI, the agent guide, tool descriptions, the docs and nuworq.com. Taken on 2026-11-02 at 2e0e5c9.

**How.** Two read-only sweeps of the source: the agent side (src/protocol.js, src/mcp.js, src/help.js, src/userguide.js, src/getstarted.js, hints in src/core.js and src/server.js, plugin/, README, docs/) and the person side (web/, bin/nuworq.js, docs/CLI.md). Each finding was checked again at its line. Counts are `grep -o` totals, case-insensitive. Then the app itself on a demo hub (`node bin/nuworq.js serve --demo --port 0`), with screenshots of Home, the project page at 30s, 5m and 30m, and the Connect an agent dialog, at 1280px and 375px, in light and dark. For the CLI's own words, docs/CLI.md was used: it is `nuworq help all --markdown`, and test/help.test.js fails when they differ. Running `nuworq --help` directly needed approval in this runner.

**Not covered: nuworq.com.** This runner's sandbox can't reach it (curl and web fetch were both refused), and the browser here is for local pages. The site's words are left to #703, and to #685, which already owns nuworq.com's docs. The repository's own mentions of nuworq.com were checked.

**Verdict.** The standing workspace decision holds in the app: no "organization" for a workspace anywhere a person looks in web/. Hub, question, lease, handoff, milestone/part, Needs you as a heading, and the depth names 30s/5m/30m are each used one way. The trouble is in the middle of the vocabulary. One dialog has six names, and release, review, note, finished and direction each mean two or more things. And one duplicate name broke a button.

## Glossary

The term to keep comes first, then its variants and where they appear.

| Thing | Keep | Variants seen |
|---|---|---|
| Unit of work | item (371) | job (48: what `next` hands out), task (2) and ticket (1), both in idiom; board/dashboard for the project page (actions.js:97,255; getstarted.js:31) |
| Top level | workspace (260) | organization, for a workspace: server.js:882 (`--org-cap`), DEPLOY.md:70,104,333; `/api/orgs` route. GitHub organizations (GITHUB.md) are right |
| Item within an item | part | "Broken into" (drawer.js:146) |
| Lifecycle | proposed, ready, outside, active, waiting, verifying, landing, done, dropped (core.js:95-105) | README.md:126 lists 6 of 9; `look` enum lists 7 (protocol.js:339) |
| Done | landed: on main | "Accepted." (core.js:103), "finished" (main.js:458,532) |
| Checking a submission | verify (the act), Accept / Send back (buttons) | review (`review` tool, "Nothing to review" main.js:490), reject (agent verdict), approve (proposals) |
| Letting an item go | hand off | "Release an item you hold" (protocol.js:211, CLI.md:698) |
| Software release | release | |
| A person's guidance | steer (one), steering (all) | nudges (main.js:593), Direction (main.js:195 card; main.js:591 memory) |
| Standing rule | decision | |
| An agent's lesson | field note | note (learn, look, retire params), "Keep as a note" (main.js:579) |
| For the record | comment (`comment`, `nuworq comment`) | Note (composer main.js:166, drawer.js:194), "a note for the record" (protocol.js:283) |
| Waiting on a person | Needs you (38) | Waiting on you (main.js:454, drawer.js:68), Waits on you (groupline.js:7), Asks you (drawer.js:38) |
| Setting a machine up | Connect an agent (19) | Start an agent (7), Connect your machine (getstarted.js:28), Connect a machine (device.html:8), Set up this machine (actions.js:222) |
| What starts workers | runner (`nuworq run`) | "start a runner", "Start an agent", "Nothing starts workers" in one card; "Runners, on this project page at 5m" where the section is Agents |
| Roles | worker, shaper, operator, session | session is also a login (CLI.md:458) and "an attended Claude Code session" (README.md:177) |
| Staffing | Staff it with nuworq run | Let nuworq run staff this project (userguide.js:111, main.js:274), Let run staff it (main.js:97), Staffing on (launcher.js:107); `nuworq staff` and `run --staff` |
| Adding a project | + Project (CLI, Get started) | + New project (rail.js:25), New project (dialog) |
| Home | Home | All projects (launcher.js:84, shortcuts.js:14), Projects (rail heading) |
| The guide | Get started / Guide | Getting started guide (rail) |
| Autonomy | Check with me, Keep moving, Run with it | ask, balanced, full (API and checkin) |
| Sign-in | Sign in (16) | Log in (8: login.html:8,24; login.js:64; bin/nuworq.js:1478) |

## Findings

Severity: **high** means a person or agent does the wrong thing or can't do the right one. **Medium** is visible confusion in a main flow or doc. **Low** is rare or cosmetic.

### High

1. **"Keep this one" on a raced item does nothing.** web/actions.js:564 and :712 both define `keep:` in one object, and the second (#552's field-note Keep) wins. The race button (web/views/parts.js:40) sends `human('keep', { note: NaN })`. *Cost:* a person can't pick a race's winner from the app. *Fix:* give the race action its own name. → **#705** (now)

### Medium

2. **Done says "Accepted."** (src/core.js:103), but Landing (:102) is the accepted stage. *Cost:* a person reading Flow thinks accepted work is on main. *Fix:* "Landed: on main." → #706
3. **`look` can't see landing or dropped** (src/protocol.js:339, docs/CLI.md:970), and README.md:126's lifecycle leaves out outside, landing and dropped. *Cost:* an agent can't list the stages it may need to act on. *Fix:* add both to the enum and every stage to README. → #706
4. **Hints say "close" an item, but there's no close operation** (src/tidy.js:39, src/protocol.js:400; plugin/skills/nuworq/SKILL.md:16). *Cost:* a tidy agent looks for a tool that isn't there or is refused by `refine drop`. *Fix:* name submit, or ask and then refine with drop. → #706
5. **`next` describes 3 of its 6 modes** (src/protocol.js:133, CLI.md:521). *Fix:* list work, shape, review, land, tidy, answer. → #706
6. **"Release" means a version and also letting go of an item** (handoff: src/protocol.js:211, CLI.md:698, SKILL.md:47; versions: protocol.js:106,238, actions.js:162-167). *Fix:* "Hand off an item you hold unfinished". → #707
7. **"Review" means four things:** the peer verdict, a field-notes review that arrives as mode tidy (protocol.js:400, CLI.md:896,918), a security review built like work (actions.js:158-160), and GitHub's PR review (main.js:196). *Cost:* an agent on a field-notes review may call `review` with a verdict. *Fix:* keep review for verdicts and rename the other two. → #707
8. **"Note" means a comment and a field note.** The composer kind and drawer button post a comment (main.js:166, drawer.js:194; actions.js:520,665). "Keep as a note" (main.js:579) means a field note. *Fix:* call the composer's Note "Comment", matching `nuworq comment`. → #707
9. **"Finished" means submitted and landed.** drawer.js:69 "finished it X ago" is submitted. "Recently finished" (main.js:532) and "N items finished in 14 days" (main.js:458) are landed, while live.js:41 says "Recently landed". *Fix:* landed / submitted. → #707
10. **Verify, review and accept for one act.** "Ready to verify" (main.js:195), "Nothing to review: no submissions are waiting" (main.js:490), "verified by" (credit.js:4). *Fix:* verify in labels, and Accept stays the button. → #707
11. **"Direction" names two things, and steers are also "nudges".** The Needs you card for what's next (main.js:195) and memory's "Direction today" (main.js:591, never defined for agents: protocol.js:315-317); "did your nudges land" (main.js:593, seen at 5m). *Fix:* rename the card; say steers. → #707
12. **One dialog, six names.** data-action="connect" opens "Connect an agent" from "Connect an agent", "Start an agent", "Connect your machine", "Install the GitHub App" (getstarted.js:22), "Set up this machine" (actions.js:222). Seen on Home at desktop and 375px: rail "Connect an agent", card "Start an agent", Get started "Install and connect your machine / Connect your machine". *Fix:* "Connect an agent" everywhere. → #708
13. **The Nobody is working card uses three names for one action** ("start a runner", "Start an agent", "Nothing starts workers": main.js:274,388) and points at "Runners, on this project page at 5m", where the 5m section is "Agents" (seen at 5m). *Fix:* one name, and point at the section by its name. → #708
14. **"+ Project" in the CLI and Get started, "+ New project" in the rail** (bin/nuworq.js:327, getstarted.js:25,31, rail.js:25). *Cost:* told to find "+ Project", a person finds no such button. → #708
15. **Staffing has four labels and two commands** (actions.js:153, main.js:97,274, launcher.js:107, userguide.js:96,111; `nuworq staff` CLI.md:1009 and `run --staff` CLI.md:109). → #708
16. **Home is also "All projects"; the guide is "Getting started guide", "Get started" and "Guide"** (launcher.js:84, shortcuts.js:14; rail, Home card). → #708
17. **"Connect GitHub" is the App in Get started and the webhook in Settings** (getstarted.js:27, userguide.js:69; actions.js:173, DEPLOY.md:125). *Cost:* a person who ticked the step thinks the webhook is set up. → #708
18. **Park this project sits beside Archived projects** (Home and project card; rail). Two words for the same thing, or two things the app doesn't explain. → #708
19. **"Organization" for a workspace:** the 429 hint "raise --org-cap" (src/server.js:882), when the flag is --workspace-cap (CLI.md:308), and DEPLOY.md:70,104,333. Breaks the standing decision. → #709

### Low (listed only)

20. **"Session"** is a role, a login (CLI.md:458) and "Three sessions" in setup (connect.js:90). *Fix:* sign-ins for logins.
21. **Autonomy is ask/balanced/full to agents and the API, but Check with me/Keep moving/Run with it to people** (src/core.js:119, server.js:690). The 400 hint maps them. *Fix:* checkin's `autonomy.means` names the label too.
22. **Sign in vs Log in** (login.html:8,24, login.js:64, bin/nuworq.js:1478). *Fix:* Sign in.
23. **Restore** is used for a dropped item, the same as Reopen (drawer.js:89,91), and for an archived project (actions.js:596). *Fix:* Reopen for items.
24. **Approve, Skip shaping and Add to Ready all make an item ready** (drawer.js:87-88, propose.js:17). Fine in context, but their titles could say they're the same.
25. **Merge and ship stand in for land** ("Now merge X" actions.js:566, "Shipped with this assumption" drawer.js:112). Merge also means combining milestones or field notes (tidy.js:51, protocol.js:305). *Fix:* land for main, combine for the rest.
26. **`--role` means a person's role, a token kind and shaper** (CLI.md:394,419,443,501). *Fix:* `token --kind`.
27. **`status --all` vs `wait --all-projects`** (CLI.md:174,1179). *Fix:* one flag.
28. **CLI flag help lines end in "e.g" with no example** (CLI.md:498,499,504,736-741,773-786).
29. **README says the agent protocol has 15 operations; OPS has 20** (README.md:222-223). *Fix:* generate it.
30. **The human, the person, a person** (95/46/85) in agent text; `to: "human"` vs "ask the person" (tidy.js:67).
31. **README's depth table writes "30 s", "5 m", "30 m"** (README.md:119-121), and the app writes 30s/5m/30m.
32. **"Create GitHub App" vs "Create the GitHub App"** (GITHUB.md:7,13, server.js:1185 vs userguide.js:73).
33. **"Escalated by an operator" vs "asked an operator"** (main.js:206, drawer.js:108).
34. **Two ways to correct a field note:** `learn` with replaces, and `retire` with into (protocol.js:299,309). **Four ways to start workers:** `nuworq run`, `run --install`, `nuworq up` and `nuworq worker --run`. Both are documented. A note on which to use first would help.

## What was seen in the app

- **Home, 1280px light.** Needs you card "Nobody is working / 1 item ready, but no agent is working" with steps naming a runner, buttons Start an agent and Park this project. The right column says "1 thing needs you now. No work in flight.", while the project page says "1 thing needs you now. 1 item ready, but nobody is working." for the same state. Get started: Add a project, Link a project to its repository, Connect GitHub, Install and connect your machine, Start workers, Start an operator, Shape work with a shaper, Watch your first item land (Open the board). The rail: + New project, Archived projects, Connect an agent, Getting started guide.
- **Project page, 1280px light.** 30s: composer kinds Steer / Decision / Note, + Work, Flow stages Proposed, Ready, Outside, Active, Waiting, Verifying, Landing, Done, then "8 items finished in 14 days" and "0.3 of your actions per landed item" one line apart. 5m: "Steering & memory: did your nudges land", Recently finished, Agents ("No agent has checked in here yet", Connect an agent). 30m: Everything that happened, with "CREATED · You added #17" beside "CREATED · nuworq proposed #18", and All work.
- **Project page, 375px dark.** The same words, readable on graphite. Commands in the steps wrap mid-flag ("--workers 1 --" / "staff nuworq"), which #698 (polished) owns.
- **Home, 375px light.** Get started comes before Needs you on a phone and after it on desktop. That's for #694 (usable).
- **Connect an agent dialog, 1280px dark.** Titled "Connect an agent", its first section is "Set up this machine (once)", and it says "staff the project with workers here" and "link the repo in the project header" (the header's link reads "+ repo").
