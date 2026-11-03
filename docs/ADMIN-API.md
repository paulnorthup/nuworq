# The admin API

The admin host (`--admin-host`, see [DEPLOY.md](DEPLOY.md#the-admin-host-owners-only)) answers the routes below and nothing else. The open dashboard (`web/admin.html`) uses them, and so does an owner's own console (`--admin-console`, [Your own console](#your-own-console)). Every other path on the admin host is a 404.

`test/adminapi.test.js` reads the route list in `src/server.js` (`ADMIN_ROUTES`) and fails when a route is missing here or this page names one the host doesn't answer.

## Who may call it

- **Signed in on the admin host.** Sign in at `GET /auth/<provider>/start` (`GET /api/oauth` lists the providers). The provider sends the browser back to `/auth/<provider>/callback` on the admin host, which sets the `nuworq_admin` cookie: `HttpOnly; SameSite=Strict`, no `Domain` (host-only), for 12 hours. An app session (`nuworq_id`, `nuworq_session`) doesn't count here, and this one doesn't count on the app.
- **An owner.** Only the verified emails in `--owners` / `NUWORQ_HUB_OWNERS` get past `GET /api/me` and `POST /api/logout`.
- **From the admin host's own page.** A `POST` must carry an `Origin` header naming the admin host. There is no CORS: other origins get no answer they can read.

Unless a route says otherwise:

| Who | Answer |
|---|---|
| Nobody signed in | `401 {"ok": false, "error": "sign in required", "hint": "Sign in with GitHub or Google on this page: GET /api/oauth says where to start."}` |
| Signed in, a `POST` from another origin or none | `403 {"ok": false, "error": "missing or mismatched Origin header"}` |
| Signed in, not an owner | `403 {"ok": false, "error": "zed@example.com isn't one of this hub's owners", "hint": "Only the emails the hub host lists in NUWORQ_HUB_OWNERS (--owners) get in. Sign out, then sign in with an owner's account."}` |
| A body that isn't JSON | `400 {"ok": false, "error": "Request body must be JSON", "hint": "Send one JSON object with content-type application/json, …"}` |

Every error is `{ "ok": false, "error": "…", "hint": "…" }`; the hint is left out where there's nothing to add. Times are milliseconds since 1970 (UTC). Requests and responses are JSON (`content-type: application/json`), sent `cache-control: no-store`, gzipped when the client accepts it.

## Pages and sign-in

- `GET /`: the dashboard, `web/admin.html`, with its `/admin.js`, `/new.js`, `/instant.js`, `/style.css` and `/theme.js`. With `--admin-console <dir>`, `<dir>/index.html` and the files under `<dir>` instead (next section).
- `GET /auth/<provider>/start`: a `302` to the provider. `GET /auth/<provider>/callback`: back from it; signs in and sends the browser to `/`. A sign-in started on the app can't finish here (`400`).

## Your own console

`--admin-console <dir>` (`NUWORQ_ADMIN_CONSOLE`) serves an owner's own console on the admin host in place of the open dashboard: `GET /` is `<dir>/index.html`, and `GET /<path>` is `<dir>/<path>`. Only files inside `<dir>` are served: a path with `..`, or a symlink that leads out of `<dir>`, is a 404, like a file that isn't there (`{"ok": false, "error": "the admin console has no such file", "hint": "GET / is its page."}`). Files keep the hub's content types (`.html`, `.js`, `.css`, `.svg`, `.json`, `.png`, `.jpg`, `.webp`, `.ico`, `.woff2`, `.txt`, `.md`; anything else is `application/octet-stream`) and its security headers, CSP included: scripts, styles and requests from the admin host itself only, no frames.

The routes below, and sign-in, answer exactly as without it, so the console signs in and calls them like the open dashboard does: same origin, with the `nuworq_admin` cookie. The console is installed on the host (a checkout, like nuworq's own); the hub never fetches it.

The hub refuses to start when `<dir>` doesn't exist or has no `index.html`, or without `--admin-host`, and says why with a hint. The app host never serves the console.

## Routes

### GET /api/health

Anyone. Whether the hub is up.

```json
{ "ok": true, "name": "nuworq", "admin": true }
```

### GET /api/oauth

Anyone. The sign-in providers this hub has, and where each starts.

```json
{ "providers": [{ "name": "github", "label": "GitHub", "start": "/auth/github/start" }] }
```

### GET /api/me

Signed in (owner or not). Who you are, and whether you're an owner.

```json
{ "email": "remy@example.com", "owner": true }
```

### POST /api/logout

Signed in (owner or not), same origin. Ends the session and clears the cookie. Body: `{}`.

```json
{ "ok": true }
```

### GET /api/early-access

Owners. Early-access requests, new ones first, then newest first. Query: `state` (`new`, `approved` or `declined`; all without it).

```json
{ "requests": [{ "id": 3, "email": "ann@example.com", "github": "ann", "building": "A CI bot", "source": "hn", "state": "new", "created_at": 1793700000000, "updated_at": 1793700000000, "decided_by": null, "decided_at": null }] }
```

### GET /api/early-access/sources

Owners. Per source (most requests first; `""` for none), the requests from the last `days` and from all time, and of those how many were let in, have a workspace where an agent connected, and have one where an item landed.

```json
{ "days": 14, "sources": [{ "source": "hn", "recent": { "requests": 2, "let_in": 1, "connected": 1, "landed": 0 }, "all": { "requests": 5, "let_in": 3, "connected": 2, "landed": 1 } }] }
```

### POST /api/early-access/decide

Owners, same origin. Approve or decline one request, once. Body: `id`, and `approve` (`true` approves; anything else declines).

```json
{ "id": 3, "approve": true }
```

Approving returns the link to send, once: it lets that person sign in on the app and make one workspace within 14 days.

```json
{ "ok": true, "state": "approved", "link": "https://app.example.com/?grant=…" }
```

Declining returns `{ "ok": true, "state": "declined" }`. Errors: `404 no request 3`; `409 that request was already approved` (hint: "Each request is decided once; its link was shown when it was approved.").

### GET /api/feedback/list

Owners. Feedback about nuworq, newest first, one piece at a time. Query: `state` (`new`, `approved` or `declined`). `on` is whether `--feedback-project` is set, and `autonomy` how far feedback goes on its own.

```json
{ "on": true, "project": "nuworq/nuworq", "autonomy": "ask", "feedback": [{ "id": 7, "kind": "person", "sender": "@ann", "email": "ann@example.com", "workspace": "acme", "text": "The Connect page didn't say which repository.", "item": "", "context": { "page": "/#/connect", "version": "v1.0.0", "browser": "Firefox 140" }, "state": "new", "note": "", "proposal": "", "created_at": 1793700000000, "decided_by": "", "decided_at": null, "told_at": null, "auto": "", "grp": 7 }] }
```

### POST /api/feedback/decide

Owners, same origin. Decide one piece, once. Body: `id`, `approve` (`true` makes a proposal in the feedback project; anything else declines), and for a decline an optional `note` to the sender (up to 1000 characters).

```json
{ "id": 7, "approve": false, "note": "Thanks: this is how it's meant to work." }
```

```json
{ "ok": true, "feedback": { "id": 7, "state": "declined", "note": "Thanks: this is how it's meant to work.", "decided_by": "remy@example.com", "…": "…" } }
```

An approved piece's `proposal` names what it made, e.g. `"nuworq/nuworq#880"`. Errors: `404 no feedback 7`; `409 that feedback was already declined` (hint: "Each piece is decided once."); `409 the feedback project's workspace "nuworq" doesn't exist` (hint: "The hub host fixes --feedback-project (NUWORQ_FEEDBACK_PROJECT).").

### POST /api/feedback/autonomy

Owners, same origin. How far new feedback goes on its own: `ask` (each piece waits for an owner), `balanced` (proposed at once; the shaped item waits for an owner's OK) or `full` (proposed at once). Body: `level`.

```json
{ "level": "balanced" }
```

```json
{ "ok": true, "autonomy": "balanced" }
```

Error: `400 level must be ask, balanced or full` (hint: "ask is Check with me, balanced is Keep moving, full is Run with it.").

### GET /api/feedback/groups

Owners. Feedback in groups: each report once, with everyone who sent it, the most recently sent first. Query: `state` (`new` while any piece waits, or `linked`, `approved`, `declined`). A waiting group carries `suggest`, the call the hub would make (`link` with a `ref`, `approve`, or `decline` with a `note`), and `known`, the item that already covers it, if any. A decided one carries `decision`.

```json
{ "on": true, "project": "nuworq/nuworq", "autonomy": "ask", "groups": [{ "id": 7, "state": "new", "count": 2, "senders": [{ "kind": "person", "sender": "@ann", "workspace": "acme" }, { "kind": "agent", "sender": "claude-1a2b", "workspace": "acme" }], "first_at": 1793700000000, "last_at": 1793700600000, "pieces": [{ "id": 7, "…": "as in GET /api/feedback/list" }], "known": { "ref": "#654", "title": "Connect names the repository", "stage": "active", "line": "#654 fixes this; it's being built." }, "suggest": { "action": "link", "ref": "#654", "why": "#654 fixes this; it's being built." } }] }
```

### POST /api/feedback/groups/decide

Owners, same origin. Decide several groups at once, all or none: every group is checked before any is decided. Body: `groups` (ids; `group` for one), `action` (`link`, `approve`, `decline`, or `suggested` for each group's own suggestion), `ref` for a link (e.g. `"#654"`; without it, the item the hub found), `note` for a decline.

```json
{ "groups": [7, 9], "action": "link", "ref": "#654" }
```

```json
{ "ok": true, "groups": [{ "id": 7, "state": "linked", "decision": { "state": "linked", "by": "remy@example.com", "at": 1793701000000, "note": "", "proposal": "nuworq/nuworq#654", "auto": "", "ref": "#654", "title": "Connect names the repository", "stage": "active" }, "…": "…" }] }
```

Errors: `400 which groups?` (hint: "Send groups: [ids], as GET /api/feedback/groups lists them."); `404 no feedback group 9`; `409 group 7 was already linked` (hint: "Undo it first to decide it again; nothing was decided."); `400 no open item #654 in nuworq/nuworq` or `400 nothing on the board covers group 7` (hint: "Link it to an item that is on the board, or make it new work; nothing was decided."); `400 action must be link, approve, decline or suggested`.

### POST /api/feedback/groups/undo

Owners, same origin. Undo the decision on several groups, all or none: their pieces wait again, and new work a group made is dropped while it's still only a proposal. Body: `groups` (or `group`).

```json
{ "groups": [7] }
```

```json
{ "ok": true, "groups": [{ "id": 7, "state": "new", "…": "…" }] }
```

Errors: `400 which groups?`; `404 no feedback group 7`; `409 #880 was already shaped, so undoing it would lose that work` (hint: "Drop #880 in nuworq/nuworq if it isn't wanted; nothing was undone.").

### GET /api/workspaces

Owners. Every workspace, the most recently active first, with its plan and why (`source`: `owners`, `set`, `billing`, `early_access` or `default`), its Stripe state (`billing`, or `null`), who made it, its people and projects, the agents holding work now, and when anything last happened. `enforced` is whether `--plans` is on; plans are stored either way.

```json
{ "enforced": true, "workspaces": [{ "name": "acme", "plan": "free", "source": "default", "set_by": null, "set_at": null, "billing": null, "creator": "ann@example.com", "people": 3, "projects": 2, "working": ["claude-1a2b"], "last_active": 1793700000000 }] }
```

### POST /api/workspaces/plan

Owners, same origin. Set a workspace's plan by hand. Body: `workspace`, `plan` (`free` or `unlimited`).

```json
{ "workspace": "acme", "plan": "unlimited" }
```

```json
{ "ok": true, "enforced": true, "workspace": { "name": "acme", "plan": "unlimited", "source": "set", "set_by": "remy@example.com", "…": "as in GET /api/workspaces" } }
```

Errors: `400 workspace is required` (hint: `e.g. { "workspace": "acme", "plan": "unlimited" }`); `404 no workspace "acme"` (hint: "GET /api/workspaces lists them, by name."); `400 "pro" is not a plan` (hint: "One of: free, unlimited.").

### GET /api/github/app/wiring

Owners. What the hub's GitHub App is missing, as the Needs you entry has it. `app` is whether the hub has a GitHub App; `missing` is `null` when nothing is missing or the hub hasn't asked GitHub yet.

```json
{ "app": true, "missing": { "key": "app-wiring:pull_request", "at": 1793700000000, "headline": "The hub's GitHub App is missing an event: …", "sub": "events: Pull request", "why": "Without them: …", "how": [{ "do": "Open the nuworq GitHub App's permissions and events page", "where": "https://github.com/settings/apps/nuworq/permissions" }] } }
```
