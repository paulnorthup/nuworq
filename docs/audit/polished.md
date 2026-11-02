# Audit: polished (#698)

Part of #676. Judged by using nuworq on a demo hub (`node bin/nuworq.js serve --demo --port 0`, main at 2e0e5c9) on 2026-11-02, at 1280px and 375px wide, light and dark (`document.documentElement.dataset.theme`). The auditor (claude-e174) built none of the screens it judges.

## Seen

Every screen below was screenshotted in all four modes: 1280px light, 1280px dark, 375px light and 375px dark. Two demo hubs were used: the first pass (attempt 1, at 2e0e5c9) and a second pass that filled the rest of the grid (attempt 2, at a80f8cc, a docs-only commit on the same main).

| Screen | What each of the four showed |
| --- | --- |
| Home (Needs you, Get started, Projects) | Desktop: Needs you on the left with "Nobody is working" and two commands to copy; Get started (1 of 8) on the right; 8 "new" tags. 375: Get started fills the first screen and Needs you starts below it (#711 owns that). Its eight steps take about 95px each, because "How?" sits on its own line. In dark, the selected "30s" barely differs from 5m and 30m (finding 2). |
| Phone Menu (375) | The rail's actions as a list, then Appearance, then the version. "? Shortcuts" is offered on a phone (finding 30). |
| Project at 30s | Desktop light and dark: composer, Needs you card, Flow and the Needs you summary on the right. 375: commands break inside flags (finding 1). |
| Project at 5m | Up next, Recently finished, Steering & memory and Agents. Dark desktop reads cleanly. At 375 the rows wrap to 2-3 lines with times aligned right. |
| Project at 30m | Everything that happened and All work. At 375 the activity rows squeeze to 3-4 lines and repeat each item's ref (finding 26); All work scrolls sideways with nothing to say so (finding 27). |
| Empty project (every empty state) | Idle card, "No work yet" with Connect an agent, "Nothing needs you", zero Flow tiles, "No work yet" in All work. "Mark all seen" is offered with nothing to see (finding 15). The dark Outside hatch is loud (finding 7). |
| Item drawer (#18) | Blank line under Summary, "Then distill…", raw "*" lines (finding 4); "AGENTS 1S · QUEUE 59S" (finding 8). It reads the same in all four. |
| Unknown project (error state) | "No project "nope": it may have been archived, renamed or never existed", with Home and Archived projects. Clear in all four. |
| Connect an agent | "new" tags adrift at the right (finding 6). At 375 the GitHub App row breaks apart (finding 28). At 30m a "Setting up by hand" section follows. |
| Settings | In light, off switches are slate and on is black; in dark, both are light grey with a dark knob (finding 3). Remove is wider than the other buttons and starts left of them (finding 29). |
| New project | The `nuworq run` pill wraps in its own column (finding 13). Create with no name shows only a "Name it" toast at the screen's bottom (finding 23). |
| + Work (propose) | One field and Propose, "+ What done means, context, priority", and "An agent shapes it into work…". At 375 the placeholder is cut to "What should be true when done" (finding 31). |
| Quick launcher (⌘K, the phone's Search) | Needs you first, then Recent; no match offers Propose and Tell. Fine in all four. |
| Notifications | The explanation, then "No channels yet…" and Add a channel. Add with no URL shows a toast that repeats the field's hint (finding 23). The hint under the field is in body ink and larger than the grey lead above it (finding 32). |
| Archived projects | "No archived projects. Removing a project archives it…" and Close. |
| Shortcuts | Five groups of keys. There's no Close button, and a phone has no Esc (finding 30). |
| Analytics | The verdict line, periods, then Projects, Models, Agents and Difficulty or size; the counts contradict their sentence (finding 5). It survives a resize from 375 to 1280. |
| Getting started guide (/guide) | Eleven numbered steps, then Once you're going. An opened step at 375 is dense but whole. "10" crowds its circle (finding 19). |
| Live view (/live/nuworq) | In motion, So far, Flow, Recently landed, early access. "–" for missing values (finding 20). |

Every dialog in dark: the backdrop is rgba(20,22,26,.3) in both themes, so in dark it barely dims the page behind (finding 33).

Not seen: a hub with no projects at all, and the signed-out pages (login, early access, admin). Both need a hub started from a script outside the repo, which this runner's sandbox refused. An empty project inside the demo hub stood in for the empty states. Loading states didn't show: on loopback every request answered before a frame was drawn.

## Findings

Most severe first. One is high, finding 22: the project page drops its side column when the window widens. Eight are medium; the rest are low. Numbers are IDs kept from attempt 1. Findings 22, 23 and 26-33 came from attempt 2's second pass; 24 and 25 aren't used.

| # | Severity | Where | What it costs a person | Fix, one line |
| --- | --- | --- | --- | --- |
| 22 | high | Project page, any depth, after the window widens past 1024px. web/app.js:20 re-renders main on the WIDE change; web/views/main.js:121 builds the columns | The side column (`.col-side`) is empty: the Needs you summary, Flow, Agents and Runners are gone from the page. They're still gone 8 seconds later and come back only on a depth change or reload. Seen 3 times, at 30s, 5m and 30m. A laptop window dragged wider, a tablet turned to landscape, or a page first opened narrow loses the glance the standing decision puts at every depth. Wide to narrow is fine, and Analytics survives. | Make the WIDE re-render rebuild both columns (likely web/morph.js keeping keyed sections across the one-to-two-column change), with a test. → **#747** (now) |
| 23 | medium | Form errors: New project's "Name it" and Notifications' "A channel needs a URL. Ntfy topic URL…", both shown as toasts | The error appears at the screen's bottom, outside the dialog on desktop, about 500px from the field, and over the dialog's edge on a phone. The field isn't marked or focused, the Notifications one repeats the hint under the field, and it capitalizes "Ntfy". A person looks at the field they left and sees nothing wrong. | Show the reason under the field, marked and focused; keep toasts for results. → **#748** |
| 1 | medium | Commands in every step and dialog at 375px. `pre` in web/style.css:183 (`white-space: pre-wrap; word-break: break-word`) | `nuworq run --workers 1 --staff nuworq` wraps as `… --workers 1 --` / `staff nuworq`. Connect an agent's `(add --here)` wraps as `add --` / `here)`. Someone reading or retyping a command sees a lone `--` and a bare word. | Command blocks keep `white-space: pre` and scroll sideways (overflow-x is already auto), and inline flags don't break. → **#716** |
| 2 | medium | Dark theme, every `.seg` control: Depth, Autonomy, Steer/Decision/Note, Appearance. web/style.css:254 | The selected button is rgb(34,37,42) on rgb(23,25,29), about 1.15:1. Only the text shade and weight say which depth or autonomy is on. On a phone in dark, "which depth am I at" takes a second look. | Give `.seg button.on` a fill visibly lighter than `--sunken` in dark (or a hairline border), keeping the calm graphite. → **#717** |
| 3 | medium | Settings' switches (Staff it, Keep it fresh, Security reviews, Release per milestone, Anyone can watch). web/style.css:742-744 | An off switch is a dark slate track (`--muted`) and an on switch is black (`--ink`), so both read as filled and "on". Only the knob's side differs. Deciding whether a project is staffed, which can cost money, needs a careful look. | Off: a light track (`--line` or `--sunken`) with a border; on keeps `--ink`. In dark, on and off are both light grey with a dark knob. → **#718** |
| 4 | medium | The hub's field-notes review item (#18 in the demo), its drawer's Summary. src/fieldnotes.js:141-147 | When no notes are due, the summary begins with a blank line and "Then distill memory…", a sentence continuing a step that isn't there. Its `* decision 1:` lines show their asterisks, because the drawer renders only `-` lists. The first item a new project gets reads broken. | Start DISTILL without "\nThen " when nothing is due (e.g. "Distill memory for people…"), and list with "- ". → **#719** |
| 5 | medium | Analytics → Difficulty or size. web/analytics.js:109-112 | The verdict says "0 of 8 landed items were rated", then the bars count all 8 as Standard and Small. The figures contradict their own sentence, so the section can't be trusted. | Count unrated items as "Not rated" (or leave them out) instead of under the default rating. → **#720** |
| 6 | medium | "new" tags everywhere. web/new.js, web/style.css:896-907 | With all 44 keys inside 7 days, Home shows 8 tags and the 5m project page 10. In Connect an agent and Settings they float at the right edge, below the row they belong to. On Get started's Guide link and the rail's Getting started guide they cover the word. Against "restraint, no extra fluff", the tag stops meaning "this is new". | Show at most a few at once (the newest per screen), and in dialogs anchor the tag beside the row's label, never over text or adrift at the edge. → **#721** |
| 7 | low | Flow's Outside tile in dark (`--hatch`) | Strong diagonal stripes behind "0 Outside" make it the loudest tile on the page while it's usually zero. | Soften the hatch's contrast in dark. |
| 8 | low | Item drawer: "LIFECYCLE AGENTS 1S · QUEUE 1M · YOU 1S"; live view: "FLOW · LAST 14D" | The section headers' uppercase turns units into "1M" and "14D", which read as a million and as a code. | Keep the times out of the uppercase label, or `text-transform: none` on them. |
| 9 | low | Project 5m: Up next's age "32s" next to Recently finished's "3.5h ago" | The same kind of figure is written two ways. A bare "32s" beside a 30s/5m/30m Depth control reads like a depth. | "waiting 32s", or "32s ago". |
| 10 | low | Project 5m: Recently finished "last 3 days"; Flow "8 items finished in 14 days" | Two windows for the same count on one screen. | One window, or say why they differ. |
| 11 | low | Needs you, Nobody is working: "Runners, on this project page at 5m, shows it as up within a minute" | Doesn't parse: "Runners … shows". | "Within a minute it shows as up under Runners, at 5m on this page." |
| 12 | low | Steer composer at desktop: "Every agent must read and acknowledge it. You'll see wh…" | The one line explaining what Steer does is cut off. | Let the hint wrap under the controls, or shorten it to fit. |
| 13 | low | New project dialog: "Let `nuworq run` staff it" | The code pill becomes its own column and wraps onto two lines inside the checkbox label. | Keep the label inline text; `white-space: nowrap` on its code. |
| 14 | low | Get started (Home): "Start workers / Start workers", "Start an operator / Start an operator", "Shape work with a shaper" twice | Each step's link repeats its title word for word, so the list reads twice as long. | Drop the duplicate link text where it equals the title (the title links), or make the link say the action ("Copy the command"). |
| 15 | low | Empty project: "Everything in this project is new to you. Mark all seen" | Offered when there is nothing to see. | Hide the line and button when the project has no items. |
| 16 | low | Project 30m: Everything that happened truncates a decision with "…" | 30m promises the whole story, but it clips the words. | Wrap at 30m; clip only at 5m. |
| 17 | low | Connect an agent: "It's at  depth 30m ." | A space before the period around the inline button. | Drop the space. |
| 18 | low | 375px: "include routine progress" wraps to three lines beside its header | Ragged header. | Move the checkbox under the header on narrow screens. |
| 19 | low | Guide: step 10's number | "10" touches its circle's edge. | Let the circle widen for two digits (min-width plus padding). |
| 20 | low | Live view shows missing values as "–"; the app uses "—" | One mark for "no value" in the app, another on the live page. | Use "—" on the live view too. |
| 21 | low | Analytics: an unknown agent is "unknown", an unknown model "Model not reported" | Two phrasings for the same gap. | "Not reported" for both. |
| 26 | low | Project 30m at 375px: Everything that happened | The "CREATED" label column takes a quarter of the width, so titles wrap to 3-4 lines. Each row shows the item ref twice: the `#17` pill, then "You added #17: …". | Drop the ref from the sentence when the pill is there, and put the label above the title on narrow screens. |
| 27 | low | Project 30m at 375px: All work table | Worked on by and In stage sit off-screen to the right. The table scrolls sideways inside its card, but nothing shows that it can. | A fade or shadow at the cut edge, or drop those two columns on narrow screens. |
| 28 | low | Connect an agent at 375px: the GitHub App row | The status dot sits alone on its own line, and Create is indented under the text, unaligned with anything. | Stack the row as dot+text, then the button, aligned to the text. |
| 29 | low | Settings: This project's Remove button | It's wider than Park and Draft and starts left of them, so the right-hand buttons don't line up. | Same button size as the rest of the column. |
| 30 | low | Shortcuts dialog, and "? Shortcuts" in the phone's Menu | The dialog is the only one without a Close button. On a phone, which has no Esc and no keyboard shortcuts, it's offered anyway and can only be left by tapping outside. | Add Close, and hide Shortcuts where there's no keyboard (the KEYBOARD media query already exists in web/views/html.js:11). |
| 31 | low | + Work at 375px | The placeholder is cut to "What should be true when done", without its question mark, which reads as a cut-off sentence. | A shorter placeholder on narrow screens ("What should be true?"). |
| 32 | low | Notifications: the hint under the URL field | "ntfy: ntfy topic URL (phone push), e.g. …" is in body ink and larger than the grey lead above it, so the hint outranks the explanation. It also says "dashboard" where the app says Home. | Muted hint style for the line under the field; "Home" for the dashboard. |
| 33 | low | Every dialog in dark: `#modal` background rgba(20,22,26,.3) in both themes | In dark, a 30% graphite veil over a graphite page barely dims it, so the dialog doesn't separate from the page behind. | A stronger veil in dark (e.g. 60%). |

## What holds up

- The unknown-project error says what happened and offers Home and Archived projects.
- Empty states say what will appear and what to do: Needs you's "Nothing needs you…", "No work yet…" with Connect an agent, and the launcher's Propose/Tell on no match.
- In dark, body text on cards is bright and calm, citron only fills the logo, and nothing is near-black.
- At 375px the page itself never scrolls sideways (scrollWidth 375). Only commands (finding 1) and All work's table (finding 27) scroll inside their boxes. The rail folds into Menu, and Flow becomes a 4×2 grid.
- Dialogs close on Esc and give focus back to what opened them.
