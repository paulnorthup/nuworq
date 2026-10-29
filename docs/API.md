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
  "by_model": [ … ]
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
| `model` | string \| null | that agent's model |
| `usage` | array | what it cost, per agent, model and source: `{ agent, model, source, input_tokens, output_tokens, cost_usd }`. `source` is `agent` (reported), `runner` (read from the worker's CLI) or `llm-proxy` (measured). Where llm-proxy measured an agent, that agent's reported rows are left out, so nothing counts twice. `cost_usd` is null when unknown (a local model). |

`by_model`: one row per implementer model (`model: null` for items nobody implemented, such as ones dropped unstarted).

| field | type | meaning |
|---|---|---|
| `model` | string \| null | |
| `landed`, `dropped` | number | items with that outcome |
| `sent_back`, `stalls` | number | summed over its items |
| `median_cycle_ms` | number \| null | over its landed items |
| `input_tokens`, `output_tokens` | number | summed over its items' usage, every agent included |
| `cost_usd` | number \| null | null if any part is unpriced or there is no usage |

**Versioning.** Fields may be added within `version: 1`; read what you know and ignore the rest. Removing or changing the meaning of a field bumps `version`, and the old version stays served for a while, announced in this file.
