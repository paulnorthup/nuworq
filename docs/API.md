# nuworq's published API

What other tools may build against. Anything not here (the UI's `/view`, item pages, internal ops) can change without notice.

## Outcomes: what finished work came to

```
GET /api/p/<project>/outcomes?since=<ms>&until=<ms>
Authorization: Bearer <token>
```

For tools that learn from results: a router choosing models, a dashboard, a cost report.

**Auth.** A human session or token, or an agent token whose projects include `<project>` (`nuworq token create <name> --role agent --project <project>`). An agent token for another project gets `403`. On a hub without login (local mode), no token is needed.

**Window.** Items that finished (reached done or dropped) in `[since, until]`, in milliseconds since the epoch. Defaults: `until` = now, `since` = 30 days before `until`.

**Response.**

```json
{
  "version": 1,
  "project": "api",
  "since": 1759309200000,
  "until": 1761901200000,
  "items": [ … ],
  "by_model": [ … ],
  "by_reviewer": [ … ],
  "human_actions": { "total": 9, "landed": 6, "per_landed": 1.5, "median_wait_ms": 5400000 }
}
```

`items`: one per finished item, oldest first.

| field | type | meaning |
|---|---|---|
| `item` | string | `#<n>` within the project |
| `title` | string | the item's title |
| `size` | `"small"` \| `"large"` \| null | as shaped |
| `repo` | string \| null | the repository it lands in (`github.com/acme/api`) |
| `outcome` | `"landed"` \| `"dropped"` | done (on main) or dropped |
| `done_at` | number (ms) | when it reached that outcome |
| `cycle_ms` | number \| null | first claim to `done_at`; null if never claimed |
| `sent_back` | number | times a reviewer sent it back |
| `stalls` | number | times a worker went quiet and its lease lapsed |
| `attempts` | number | times it was claimed to build |
| `implementer` | string \| null | the agent whose submission was accepted |
| `model` | string \| null | that agent's model, as it said at checkin in this project; without one, the model its own `usage` rows on this item name, if just one |
| `reviewer` | string \| null | who accepted it last, the verdict it landed on (an agent, or a person: `you` / `@handle`); null if dropped |
| `reviewer_model` | string \| null | that reviewer's model when it was an agent (a peer) |
| `escaped` | boolean | landed, and a later item names it in `fixes` (it repairs this one) |
| `fixed_by` | string[] | those later items, `#<n>` |
| `overturned` | boolean | an agent accepted it and a person later sent it back, or it landed on an agent's verdict and escaped |
| `human_actions` | number | what it took from people, ever: their answers, accepts, send-backs, steers, decisions, comments and confirmed assumptions on this item (an override's answer and its steer count once, as does answering an escalation and the operator question it carried) |
| `usage` | array | what it cost, per agent, model and source: `{ agent, model, source, input_tokens, output_tokens, cost_usd }`. `source` is `agent` (reported), `runner` (read from the worker's CLI) or `llm-proxy` (measured). Where llm-proxy measured an agent, that agent's reported rows are left out, so nothing counts twice. `cost_usd` is null when unknown (a local model). |

`by_model`: one row per implementer model (`model: null` for items nobody implemented, such as ones dropped unstarted).

| field | type | meaning |
|---|---|---|
| `model` | string \| null | |
| `landed`, `dropped` | number | items with that outcome |
| `sent_back`, `stalls` | number | summed over its items |
| `escapes` | number | its landed items that escaped (as builder) |
| `median_cycle_ms` | number \| null | over its landed items |
| `input_tokens`, `output_tokens` | number | summed over its items' usage, every agent included |
| `cost_usd` | number \| null | null if any part is unpriced or there is no usage |
| `cost_per_landed` | number \| null | `cost_usd / landed`, to the cent; null when either is unknown or nothing landed |
| `escape_rate` | number \| null | `escapes / landed`, two decimals; null when nothing landed |

`by_agent`: the same per implementing agent (`agent: null` for items nobody implemented), with that agent's `model`.

`by_reviewer`: one row per peer reviewer's model (agents only; a person's verdicts aren't scored), over the landed items in the window.

| field | type | meaning |
|---|---|---|
| `model` | string \| null | the reviewer's model |
| `reviewed` | number | landed items that landed on its accept |
| `escapes` | number | of those, how many escaped |
| `overturned` | number | its accepts a person overturned: sent back afterwards, or escaped |

An item names the landed work it repairs with `fixes` (on `propose` and `refine`, or in the item's Edit for people); only an item that reached done can be named.

`human_actions`: what the work cost people over the same window, on any item or none.

| field | type | meaning |
|---|---|---|
| `total` | number | people's actions (as for an item's `human_actions`) in the window |
| `landed` | number | items that reached done in the window |
| `per_landed` | number \| null | `total / landed`, one decimal; null when nothing landed |
| `median_wait_ms` | number \| null | how long what needed a person (an act-level Needs you entry) waited until a person resolved it, median over those resolved in the window. Each counts from when it reached them: a blocking question from when it was asked (a reporter's once `reporter_wait` passed; an operator's only as its escalation, from when it was escalated), a review from submission (unless agents review), a proposal under autonomy `ask` from when it was shaped. Entries an agent or operator resolved don't count |

**Versioning.** Fields may be added within `version: 1`; read what you know and ignore the rest. Removing or changing the meaning of a field bumps `version`, and the old version stays served for a while, announced in this file.

## Outcomes across the workspace

```
GET /api/outcomes?period=14d|90d|all
Authorization: Bearer <token>
```

For an owner deciding where agents, money and attention go: which projects need more agents, which models are worth their cost, and whether they are the wait themselves. The same figures as the project outcomes above, for every project at once.

**Auth.** As for project outcomes. An agent token covers only its own projects: the others are left out, not refused.

**Period.** `14d` (default), `90d` or `all`: items that finished in the last 14 or 90 days up to now, or ever. For `14d` and `90d` each project also carries the same figures for the period just before (`previous`); for `all`, `previous` is null. Any other period gets `400`.

**Response.**

```json
{
  "version": 1,
  "period": "14d",
  "since": 1760692800000,
  "until": 1761902400000,
  "takeaway": "claude-opus-5-5 lands for $1.00 an item vs $3.00 for gpt-5, with as few escapes: prefer it.",
  "summary": { "landed": 7, "median_cycle_ms": 14400000, "cost_usd": null, "cost_per_landed": null, "escapes": 0, "escape_rate": 0, "median_wait_ms": null, … },
  "projects": [ … ],
  "by_model": [ … ],
  "by_agent": [ … ]
}
```

`projects`: one per project.

| field | type | meaning |
|---|---|---|
| `project`, `name` | string | its slug and name |
| `landed` | number | items that reached done in the period |
| `median_cycle_ms` | number \| null | first claim to done, over those; null when nothing landed |
| `cost_usd` | number \| null | the usage of the items that finished in the period (landed or dropped); null if any part is unpriced or there is no usage |
| `cost_per_landed` | number \| null | `cost_usd / landed`, to the cent |
| `human_actions` | number | the owner's actions in the period (as `human_actions.total` above) |
| `median_wait_ms` | number \| null | how long what needed a person waited (as `human_actions.median_wait_ms` above) |
| `escapes` | number | its landed items that a later item repairs |
| `previous` | object \| null | the same fields (without `project`, `name`) for the period before; null for `all` |

`by_model`, `by_agent`: as in project outcomes, over every project's finished items in the period. `summary`: the same figures for all of them together, plus `median_wait_ms` across projects.

`takeaway`: one sentence naming the decision the figures suggest, or null with fewer than 3 landed items or nothing worth deciding. It checks, in order: the owner's wait (median at least an hour and a quarter of the cycle time), escapes (a fifth or more of landed work), models (with 3 or more landed and priced each, the dearest costing at least 1.5 times the cheapest per landed item, while the cheapest escapes no more often, within 10 points), and a project that landed half or less of what it did the period before. Only the first that applies is said.

## Operators: answering what agents can't settle alone

```
POST /api/p/<project>/agent/answer
Authorization: Bearer <token>
{ "agent": "<name>", "question": 12, "answer": "Ran it on prod: it works." }
```

For an operator: a trusted, attended session (or a tool driving one) that agents ask about running things, permissions, or verifying on real infra. The same operation is the `answer` MCP tool and `nuworq answer <question-id> <answer>`.

**Who.** An agent that declared `operator` at checkin (`has: ["operator"]`) in this project. Anyone else gets `403` with a hint. Only questions asked with `ask { to: "operator" }` can be answered here; one meant for the human or an issue's reporter gets `403`, an already answered one `409`.

**Default audience.** An `ask` without `to` is routed by a fixed rule (src/audience.js, no model call): a question or context about running a command, permissions or approval, credentials, infrastructure (server, VM, DNS, deploy, prod), the GitHub App or admin, or verifying on a real system goes to an operator; one about direction, scope, priority, money, publishing or deleting, or matching nothing, goes to the human. Human signals win over operator ones. The response always has `to` (`"human"`, `"operator"` or `"reporter"`) and, when the hub picked, `routed`: the reason and how to override. A given `to` is stored as is.

**Finding them.** An operator's `next` returns `mode: "answer"` before any land, review or other work, while one is open: `question` (`id`, `question`, `context`, `detail`, `options`, `assumption`, `blocking`, `asked_by`, `asked`) plus the item's usual context. Blocking questions come first, then the oldest.

**Effect.** As the human's answer: the question is answered by the operator, the item returns to ready once no blocking question is left, and the asker gets the answer in its next checkin. Operator questions never appear in Needs you; if none of this project's agents with `operator` has been seen for a day while some wait, Needs you shows one line saying how many.

**Steps when a person must act.** A question to the human (or an escalation) that asks them to do something, not just decide, needs `steps`: up to 12, in order, each `{ "do": "…", "where": "<URL or command>", "check": "<how they see it worked>" }` (`where` and `check` optional; a plain string is a `do`). The hub spots such a question by a fixed rule (`needsSteps` in src/audience.js: a request like "can you" / "please" / "you'll need to" near an action verb, or a question that starts with one) and refuses it without steps (`400`, the hint shows the shape). Questions to an operator or a reporter are not checked. Needs you and the item page carry `steps`.

**Escalating to the human.** When settling a question needs what only the human can do (their accounts, credentials or keys, signing, moving money, a CAPTCHA, or an irreversible step or product call no decision covers), the operator escalates it instead of answering: the `ask` operation with `escalates`.

```
POST /api/p/<project>/agent/ask
{ "agent": "<name>", "escalates": 12, "question": "Drop the 3 orphaned tables on prod?",
  "evidence": [{ "label": "dry run: 3 tables, 0 rows referenced", "url": "https://…" }] }
```

`evidence` is required (labels, optional links). Only an operator can escalate (`403` otherwise), and only an open operator question (`403` for any other, `404` unknown, `409` answered or already escalated). The escalation is a blocking question to the human: it shows in Needs you with the original question, its asker and the evidence, and on the item page. While it is open, operators' `next` skips the original. The human's answer answers both: the original's asker gets it at its next checkin, and the item unparks once no blocking question is left. If the operator answers the original after all, the escalation is withdrawn. In the CLI: `nuworq ask "<question>" --escalates 12 --evidence "label|url"`.

**What operators settled.** An operator question answered without escalation shows for a day under Worth knowing (`kind: "operator-answered"`, "Operator answered …"), never in Needs you.
