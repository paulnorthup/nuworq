# Audit: polished (#698)

Part of #676. Judged by using nuworq on a demo hub (`node bin/nuworq.js serve --demo --port 0`, main at 2e0e5c9) on 2026-11-02, at 1280px and 375px wide, light and dark (`document.documentElement.dataset.theme`). The auditor (claude-e174) built none of the screens it judges.

## Seen

| Screen | Desktop light | Desktop dark | 375 light | 375 dark |
| --- | --- | --- | --- | --- |
| Home (Needs you, Get started) | ✓ | ✓ | — | — |
| Project at 30s | ✓ | — | ✓ | ✓ |
| Project at 5m | ✓ | — | — | — |
| Project at 30m (activity, All work) | ✓ | — | — | — |
| Empty project at 30m (every empty state) | ✓ | — | — | ✓ |
| Item drawer | ✓ | — | — | ✓ |
| Unknown project (error state) | — | ✓ | — | — |
| Connect an agent, Settings, New project, + Work, quick launcher | ✓ | — | — | — |
| Notifications, Archived projects, Shortcuts, launcher with no match | read as text | — | — | — |
| Analytics | ✓ | — | — | — |
| Getting started guide (/guide) | ✓ | — | — | — |
| Live view (/live/nuworq) | — | ✓ | ✓ | — |

Not seen: a hub with no projects at all, and the signed-out pages (login, early access, admin). Both need a hub started from a script outside the repo, which this runner's sandbox refused. Loading states didn't show: on loopback every request answered before a frame was drawn.

## Findings

Most severe first. None is critical or high: nothing breaks, and nothing a person needs is unreadable.

| # | Severity | Where | What it costs a person | Fix, one line |
| --- | --- | --- | --- | --- |
| 1 | medium | Commands in every step and dialog at 375px. `pre` in web/style.css:183 (`white-space: pre-wrap; word-break: break-word`) | `nuworq run --workers 1 --staff nuworq` wraps as `… --workers 1 --` / `staff nuworq`. Connect an agent's `(add --here)` wraps as `add --` / `here)`. Someone reading or retyping a command sees a lone `--` and a bare word. | Command blocks keep `white-space: pre` and scroll sideways (overflow-x is already auto), and inline flags don't break. |
| 2 | medium | Dark theme, every `.seg` control: Depth, Autonomy, Steer/Decision/Note, Appearance. web/style.css:254 | The selected button is rgb(34,37,42) on rgb(23,25,29), about 1.15:1. Only the text shade and weight say which depth or autonomy is on. On a phone in dark, "which depth am I at" takes a second look. | Give `.seg button.on` a fill visibly lighter than `--sunken` in dark (or a hairline border), keeping the calm graphite. |
| 3 | medium | Settings' switches (Staff it, Keep it fresh, Security reviews, Release per milestone, Anyone can watch). web/style.css:742-744 | An off switch is a dark slate track (`--muted`) and an on switch is black (`--ink`), so both read as filled and "on". Only the knob's side differs. Deciding whether a project is staffed, which can cost money, needs a careful look. | Off: a light track (`--line` or `--sunken`) with a border; on keeps `--ink`. |
| 4 | medium | The hub's field-notes review item (#18 in the demo), its drawer's Summary. src/fieldnotes.js:141-147 | When no notes are due, the summary begins with a blank line and "Then distill memory…", a sentence continuing a step that isn't there. Its `* decision 1:` lines show their asterisks, because the drawer renders only `-` lists. The first item a new project gets reads broken. | Start DISTILL without "\nThen " when nothing is due (e.g. "Distill memory for people…"), and list with "- ". |
| 5 | medium | Analytics → Difficulty or size. web/analytics.js:109-112 | The verdict says "0 of 8 landed items were rated", then the bars count all 8 as Standard and Small. The figures contradict their own sentence, so the section can't be trusted. | Count unrated items as "Not rated" (or leave them out) instead of under the default rating. |
| 6 | medium | "new" tags everywhere. web/new.js, web/style.css:896-907 | With all 44 keys inside 7 days, Home shows 8 tags and the 5m project page 10. In Connect an agent and Settings they float at the right edge, below the row they belong to. On Get started's Guide link and the rail's Getting started guide they cover the word. Against "restraint, no extra fluff", the tag stops meaning "this is new". | Show at most a few at once (the newest per screen), and in dialogs anchor the tag beside the row's label, never over text or adrift at the edge. |
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

## What holds up

- The unknown-project error says what happened and offers Home and Archived projects.
- Empty states say what will appear and what to do: Needs you's "Nothing needs you…", "No work yet…" with Connect an agent, and the launcher's Propose/Tell on no match.
- In dark, body text on cards is bright and calm, citron only fills the logo, and nothing is near-black.
- At 375px nothing overflows sideways except the commands in finding 1. The rail folds into Menu, and Flow becomes a 4×2 grid.
- Dialogs close on Esc and give focus back to what opened them.
