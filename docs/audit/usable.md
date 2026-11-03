# Audit: usable (#694)

Part of #676, for v1.0.0 (#675). Done on 2026-11-02 by claude-90c1, which built none of the flows it judges.

## How it was judged

- A demo hub from this branch's base (2e0e5c9, v0.7.0): `node bin/nuworq.js serve --demo --port 0`, on loopback with no login. No live workspace data is used here.
- A person's side in the browser at 1280×900 and 375×812, in light and in dark (`document.documentElement.dataset.theme`). Home, the project page at 30s and 5m, Needs you, the quick launcher (⌘K), Connect an agent, + New project, steering, answering a question, accepting work, and /guide.
- The agent's side through the agent API (`POST /api/p/<slug>/agent/<op>` with `x-nuworq-agent`), as two new agents (`newbie-1`, `worker-2`): checkin, next, handoff, ask (blocking with options, non-blocking with an assumption, with steps and without), propose, claim, progress, submit, ack, look, withdraw, and their error paths.
- Not walked live: GitHub sign-in, creating a workspace and cutting a release. A workspaces-mode hub (`serve --workspaces`) needed an approval this session didn't have. Sign-in and workspace creation were judged from /guide's steps 1 and 2 instead. Landing was walked up to Accept (the demo project has no repository, so Accept goes straight to Done).

## What works

- One tap answers a question from its card, on a phone too, and the toast says what happened ("Answered; the work is moving again"). The answer reaches the asker's next checkin as `answers`.
- A steer from the project page reaches the next checkin as `steers`, and `next` tells the agent to read it and ack.
- The hub refuses a do-this question without `steps`, and its hint gives a complete worked example.
- ⌘K finds a question by its words ("cap spend" offers "Answer #9: …").
- /guide reads well at 375px in dark. Each step says how to do it by hand, what nuworq can do for you, and how you know it worked.
- Dark mode reads cleanly at both widths: calm graphite, citron only as fills, magenta for your move.

## Findings

Ranked by severity. Each finding gives where it happens, what it costs, and a one-line fix. Each one of medium severity or higher is a part of v1.0.0 (#675), with acceptance criteria, and #679 and #685 depend on it. The three highs are at priority now.

### 1. High: a question the hub or an agent names by number can't be found (#710)

- **Where:**
  - `src/insight.js:563`: the "Keeps bouncing" card says "answer question N".
  - `src/bounce.js:69`: "your answer to question N".
  - `ask` returns `question: N`, and agents and operators quote that number in chat and handoffs.
  - But no Needs you card (`web/views/main.js`), no row in the item drawer (`web/views/drawer.js:105-111`) and no launcher result shows the number. `data-q="1"` is in the markup but never on screen.
  - The launcher's number match (`web/launcher.js:170`) only finds items: "question 1" offers "Propose 'question 1'" and "Tell nuworq's agents 'question 1'".
  - An operator-routed question with no item has no page at all: it shows only as the grey line under "1 question waits for an operator".
- **Cost:** The maintainer couldn't find "question 207" on 2026-11-02. When an agent says "see question 207", a person has to search by guessed words, or ask the agent which item it was on.
- **Fix:** Show "Q207" quietly beside the item ref on every question card and drawer row. Have ⌘K open a question from "q207", "Q207" or "question 207", whatever its status.

### 2. High: on a phone, the 30-second view has nothing to act on in the first screen (#711)

- **Where:**
  - Project page at 375×812, 30s: the first Needs you card's title is at y=872. Above it come the mission (5 lines), Depth, the Needs you summary card, the steer box and + Work. The summary says "3 things need you" but doesn't link to them.
  - Home at 375px: Needs you starts at y=1248, after the eight-step Get started list.
  - Code: `web/views/main.js` (layout order) and `web/style.css` (narrow layout).
- **Cost:** The standing decision is phone-first 0-30-5-30. On a phone, a person scrolls past a screen and a half before the first thing they can act on.
- **Fix:** At narrow widths, put the Needs you cards right under the summary line. Clamp the mission to one line and move the steer box below the cards. On home, put Get started after Needs you.

### 3. High: an operator-routed question leaves a person with no operator stuck (#712)

- **Where:**
  - `src/insight.js:393-401` and `web/views/main.js:290`: the "No operator connected" card's only action, **How to start an operator**, opens `/agents.md#operators` in a new tab. That's the agents' raw protocol text, with a literal `<project>`, no `#operators` section, and nothing about starting an operator. /guide has the right section at `/guide#operator`.
  - The question's own `steps` are never shown on this card. The person can't tick them or answer the question, though they could often do the steps themselves.
  - Reproduced with `ask { question: "Add the API key to the runner machine", blocking: true, steps: [...] }`. The hub routed it to the operator because it is "about credentials", and the card offered only the guide link and Not now.
- **Cost:** A newcomer working alone has a blocked item and a link to a page of agent jargon. The guide promises "A step for you to do: it lists each one". Here it doesn't.
- **Fix:** Link to `/guide#operator`. Show the question's steps on the card, with the same tick-and-answer as a question asked of a person, so whoever is there can settle it.

### 4. Medium: agents that don't say where they run all read as "Agent" (#713)

- **Where:**
  - `web/agentline.js:8-11`: with no `where` and no job, the line is just the role, and a session's role reads "Agent".
  - Two such agents show as "Agent idle · Agent idle" under Agents.
  - Cards say "· Agent asked 1m ago" and "· Agent finished it", while Worth knowing on the same page says "newbie-1 assumed…".
- **Cost:** A person can't tell which agent asked, finished or is idle. They can't match the page to what an agent tells them in a terminal.
- **Fix:** When the hub reports no `where`, add the agent's name, e.g. "Agent newbie-1". Repairs #240.

### 5. Medium: a typo in the project slug quietly creates a project (#714)

- **Where:**
  - `checkin` on `/api/p/nope/agent/checkin` answers 200 with "No mission written yet…" and "Nothing is ready".
  - It doesn't say that a new project called "nope" now exists, and "nope" appears in every person's sidebar.
  - Code: `src/core.js` (checkin, around line 2187).
- **Cost:** A misconfigured agent works in an empty project. It proposes into it, or signs off thinking nothing is ready, and the owner gets a stray project to archive.
- **Fix:** When checkin creates a project, say so in `next`, e.g. "nope is a new project here; did you mean nuworq?", naming the closest existing slug.

### 6. Medium: some agent errors carry no hint, or say "undefined" (#715)

The decision says "every error carries a hint". These don't, or name nothing:

- **Where:**
  - `submit`, `progress` and the other item ops without `item`: 400 `Not an item reference: "undefined"` (`src/core.js:1083`).
  - `ack` without `steer`: 404 `No steer undefined` (`src/core.js:3415`). It should be a 400 that names the missing field.
  - An unknown item: 404 `No item #9999 in nuworq`, with no hint (`src/core.js:1085`, `src/fieldnotes.js:165`).
  - A body that isn't JSON: `Request body must be JSON`, with no hint (`src/server.js:1974`).
- **Cost:** A new agent, often a cheaper model, loses turns guessing what it left out.
- **Fix:** A missing field says "item is required" (400) with an example, and each 404 hints how to find a real id (`look`).

### 7. Low: a fresh hub is covered in "new" tags

- **Where:** On first visit the home showed 9 "new" tags and the project page 11: Search, Projects, Get started, Guide, Shortcuts, Appearance, + Work, Needs you, Settings, Autonomy, Worth knowing, and more (`web/new.js`).
- **Cost:** For someone new, everything is new, so the tags tell them nothing and add clutter on the first screen they see.
- **Fix:** Don't show "new" tags in a browser's first session on a hub. Start counting from its first visit.

### 8. Low: Accept can't be undone

- **Where:** **Accept** on a Ready to verify card takes one tap with no confirm. The toast says only "Accepted #19" (`web/actions.js`).
- **Cost:** A mis-tap on a phone lands work nobody checked.
- **Fix:** Add Undo to the toast for a few seconds, as with other one-tap actions.

### 9. Low: a field-notes job with no notes reads broken

- **Where:**
  - `src/fieldnotes.js:141,146`: when no notes are due, the tidy job's summary starts with a blank line and "Then distill…".
  - Its acceptance still asks that "each note listed" be kept, merged or retired.
  - It was the first job `next` gave a brand-new agent.
- **Cost:** A new agent's first job starts mid-thought, which is confusing.
- **Fix:** When nothing is due, start with "Distill memory for people:" and drop the note-review criteria.

### 10. Low: Connect an agent's fallback isn't exact

- **Where:** When the hub can't build its package, Connect an agent says "install nuworq the way this hub was installed first", with no command (`web/connect.js`). Seen here because the sandbox stopped the hub writing `~/.nuworq/package`.
- **Cost:** Breaks "when a person has to act, say exactly how" in exactly the case where help is most needed.
- **Fix:** Give the commands for the likely installs (npm from the repository, or a release), and how to check with `nuworq --version`.

## The "question 207" case

Today a person who's told "question 207" has three ways to look, and none of them works:

- ⌘K: a number finds item #207, never a question.
- The item drawer: it lists questions without numbers.
- Needs you: cards show the item ref, not the question's number. A non-blocking question shows only as an "assumed" line in Worth knowing at 5m. An operator-routed question with no item shows only as grey text under "N questions wait for an operator".

Finding 1 makes the number visible and searchable. Finding 3 gives operator questions a place a person can act on.

## Screenshots

Each was taken without a file name and looked at during this audit. What they showed:

- **Home, desktop, light:**
  - Needs you on the left with "Nobody is working" and two commands to copy.
  - "Get started 1 of 8" on the right.
  - Nine "new" tags.
- **Project, desktop, light, 30s:**
  - The steer box, Needs you and the Flow card.
  - After the asks: a question card ("QUESTION #9 … Agent asked 1s ago", Per day / Per item, an answer box).
  - A "No operator connected" card with **How to start an operator**.
  - No question number anywhere.
- **⌘K, desktop, light:** "question 1" offers only Propose and Steer. "cap spend" offers "Answer #9: …".
- **/agents.md#operators, desktop:** the agents' protocol as monospace plain text, starting "# nuworq: coordination for agents working on <project>". There's no operators section.
- **Project, 375px, light, 5m, full page:** about 3,500px tall. The cards begin under the mission, Depth, Autonomy, Settings, the summary card and the steer box. Agents shows "Agent idle · Agent idle".
- **Project, 375px, light, 30s, first screen:** the mission, Depth, the pink summary card ("3 things need you, 1 now"), the steer box, and the Needs you heading at the very bottom. No card is visible.
- **Project, 375px, dark:** the Ready to verify and Question cards read clearly on graphite, with magenta rules and light buttons. After Per day, the card left and a toast said "Answered; the work is moving again". After Accept, "Accepted #19", and Flow's Done went from 8 to 9.
- **Home, 375px, dark:** Get started (2 of 8) fills the first screen. Needs you starts at y=1248.
- **/guide, 375px, dark:** a numbered step list. Steps 1 and 2 opened show "By hand", "Can nuworq do it for you?" and "How you know it worked".
- **Project, desktop, dark, 5m:**
  - A stray project "nope" in the sidebar, made by a checkin to the wrong slug.
  - In motion reads "Agent #9 … SHAPING".
  - Agents reads "Agent — shaping #9 working · Agent idle".
  - Worth knowing reads "newbie-1 assumed…".
