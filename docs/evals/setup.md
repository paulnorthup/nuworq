# Eval: a newcomer's setup, to the three sessions (#492)

Setup is measured, not assumed. It starts from a signed-in workspace with a project. It ends with workers staffed, an operator running and a shaper started (the setup that works, #489). For each step this records the time, commands typed, pastes, questions asked, places visited and anything a newcomer would hesitate over.

Two measurements:
- **The walk.** A person's walk in a real browser and terminal, on a throwaway hub, by the operator claude-code-9ccc on 2026-11-02, as Paul chose (Q197).
- **The script.** `node scripts/setup-walkthrough.js`, which repeats what can run unattended. The weekly guide walk-through (#386, `src/walkthrough.js`) reruns it whenever setup changes.

## Targets

From a signed-in workspace with a project:

| Target | Before (2026-11-01) | After: walk | After: script |
|---|---|---|---|
| 1 copied block | 6 commands + 2 pastes | **met**: 1 block, 1 paste (5 more blocks shown beneath it: B, folded since #644) | **met** |
| At most 3 yes/no answers | none asked: a switch instead | **met**: plugin, staff, operator. A yes to staffing adds a cap prompt (D). The page banner no longer asks a 4th before a runner exists (A, fixed in #643) | **met**: 3 |
| 1 browser approval | 1 | **met** | **met** |
| 1 line typed in the Claude Code app | not said | **met**: `/nuworq-shaper` (plugin declined) | **met**: `/nuworq:shaper` (plugin installed) |
| No settings switch | 1 hidden switch (staffing) | **met** | **met** |
| Every step's words match the guide | not checked | **not met** with the plugin declined (C) | **met** once C was fixed in #492: the guide, Get started and Connect an agent name both forms |
| Places | 4 | 4: hub page, terminal, browser (device page), Claude Code app | 4 |

**Before** is the setup evaluation of 2026-11-01, read and run from a fresh HOME before #489, #490 and #491 landed: 6 terminal commands plus 2 pastes, 1 hidden switch, 4 places, 1 browser approval. It wasn't rerun here, because that needs main from before #489 checked out. Its numbers stand as recorded.

## The walk (after)

A local hub on main 877fc22, with login required, owner @paul, and project Demo backed by a local bare repository. The newcomer joined through an owner's invite as @newcomer. The machine had a fresh HOME and npm's global prefix in a scratch folder. The browser was Chrome, and `connect` ran under `script` (a real pty). It started signed in, on Demo's page.

| # | Step | Place | Counts | What the person saw |
|---|------|-------|--------|---------------------|
| 1 | Project page | hub page | 1 yes/no offered (A) | Banner: "Let nuworq run staff this project? It starts headless workers whenever work is waiting, and they can cost money. Off until you say." with **Let run staff it** and **Not now** |
| 2 | Click **Connect an agent** | hub page | 1 click | A 471-word dialog with 6 copy blocks: the connect line, then under "The setup that works": `nuworq run --install --workers auto`, `claude`, `/nuworq:operator`, `/nuworq:shaper`, `nuworq up` (B) |
| 3 | Copy and paste the first block | terminal | 1 copied block, 1 paste, 1 command | `npm install -g <hub>/nuworq.tgz && nuworq connect <hub>`, in the project's clone; the install took under 1 s |
| 4 | Approve the device | browser (device page) | 1 approval, ~25 s | "Pauls-MacBook-Pro asks for an agent token in your name… Approve / Deny" (connect opened the browser itself) |
| 5 | Question 1: the plugin | terminal | 1 yes/no | "Install the nuworq plugin for Claude Code, for every project? … costs nothing. [Y/n]". Answered n: the repository is private (#365) |
| 6 | Connected | terminal | | "Connected … as newcomer@…", the MCP server added, and the nuworq, nuworq-shaper and nuworq-operator skills written (the plugin was declined) |
| 7 | Question 2: staffing | terminal | 1 yes/no (+1 number on yes: D) | "Staff Demo with workers on this machine? … up to a daily cap you set next. [y/N]". Answered n |
| 8 | Question 3: an operator | terminal | 1 yes/no | "Start an operator now? It opens Claude Code in <folder> with /nuworq-operator … [y/N]". Answered n |
| 9 | Last lines | terminal | 1 line for the app | "Last, to plan work with a shaper: open <folder> in the Claude Code app and type /nuworq-shaper." Then "nuworq up keeps the runner going and an operator open…" |

From the paste to connect's last line: **62 s**, including the approval and the answers.

## The script (after)

`node scripts/setup-walkthrough.js` on this branch (2026-11-01, Node 26). It runs a throwaway hub with login required and project Demo with a bare origin. @newcomer joins by invite. The real `nuworq connect` runs from a fresh HOME, as at a terminal, with a stand-in `claude` that records what connect asks of it. The answers are: plugin yes, staffing no, operator yes. The device approval is the device page's own call.

| # | Step | Place | Time | Counts |
|---|------|-------|------|--------|
| 1 | Copy the first block, paste it in the clone | hub page → terminal | 0.0s | 1 copied block, 1 paste, 1 command |
| 2 | Approve this machine | browser (device page) | 6.7s (the code shows after 1.6s; connect sees the approval at its next 5 s poll) | 1 approval |
| 3 | Answer connect's questions | terminal | 0.7s | 3 yes/no: the plugin [Y/n], staff Demo [y/N], an operator [y/N] |
| 4 | Start a shaper | Claude Code app | | 1 line: `/nuworq:shaper` |
| 5 | What connect set up | | | `plugin marketplace add paulnorthup/nuworq#release`, `plugin install nuworq@nuworq --scope user`, then the operator: `claude --settings {…} /nuworq:operator` |

Total **7.5 s**: 1 copied block, 1 paste, 1 command typed, 3 yes/no answers, 1 browser approval, 1 line in the Claude Code app, no settings switch, 4 places. Every scripted target was met.

Times are the hub's and the CLI's. A person's reading, switching windows and typing come on top: in the walk, 62 s from paste to done.

## Hesitations

- **A. Staffing is asked twice, the first time before anything can run it.** The project page asks "Let nuworq run staff this project?" before a machine is connected, and connect asks again. A yes on the page with no runner anywhere staffs nothing. **Fixed in #643.** The project page offers staffing only once a runner has reported for the project: before that, a yes there starts nothing, and connect asks on the machine that would run the workers. Connect no longer asks about a project that is already staffed. It says so, with the command to add this machine (`nuworq run --install`). `node scripts/setup-walkthrough.js` still meets every target (2026-11-02: 3 yes/no, 1 block, 1 approval).
- **B. The dialog reads like six steps.** Under the one block that's needed, "The setup that works" showed 5 more copy blocks, all of which connect already offers. **Fixed in #644.** Connect an agent's first screen has the one block, and says connect then asks about the plugin, workers and an operator. "The setup that works" and `nuworq up` sit folded beneath it under "What connect sets up, to do by hand", still copyable.
- **C. The command names don't match the guide without the plugin.** With the plugin declined, connect rightly says `/nuworq-operator` and `/nuworq-shaper`. The dialog and the guide said only `/nuworq:operator` and `/nuworq:shaper`. Until #365 makes the repository public, everyone without access declines the plugin. **Fixed in #492.** The setup's own lines (`SETUP` in `web/connect.js`, which the guide, Get started and Connect an agent all show) and the guide's shaper and operator paragraphs now add "/nuworq-shaper" or "/nuworq-operator" "without the plugin".
- **D. A yes to staffing asks a number next.** "Daily spending cap for its workers, in dollars [20]:" follows the staffing yes. The question says so ("up to a daily cap you set next"), and Enter takes 20. It counts here as a 4th answer on that path, not a yes/no. No change proposed: the cap is what makes the yes safe to give.

## Not walked, to rerun

- **The plugin from GitHub.** It needs a Claude account with access to the private repository. Rerun from an account without access once #365 makes it public. The script installs it through the stand-in `claude`.
- **The staffing service.** A yes installs a real LaunchAgent (or systemd unit) and spends on a Claude account. Rerun on a spare machine or VM. The script answers no.
- **A real operator and shaper.** Claude Code can't sign in from a fresh HOME, and the shaper runs in the Claude Code app on Paul's account. The script checks that connect starts `claude` with `/nuworq:operator` and names `/nuworq:shaper`.
- **The live hub.** The walk ran on a local hub; rerun on a throwaway workspace of the live one once #365 is done.
