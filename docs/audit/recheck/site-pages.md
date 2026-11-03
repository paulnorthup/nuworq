# nuworq.com privacy and terms, re-read live for v1.0.0 (#828)

**What.** The re-check (#679, docs/audit/recheck/claims.md) couldn't reach nuworq.com, so it judged the site's claims from the text docs/audit/true.md quoted (nuworq-site at ab4abc1). It found three high claims that didn't hold (P6, P8, T6) and a medium one (P4). This file re-reads the live pages and gives each a verdict.

**Read.** 2026-11-03 13:32Z, by an operator with curl (question 274 on #828): https://nuworq.com/privacy 200 (5,856 bytes) and https://nuworq.com/terms 200 (4,962 bytes). Both say "Last updated 2 November 2026", so nuworq-site #36 (the audit's reword item) is live. The code is origin/main at 727fa742.

## Verdicts

| # | Where | Verdict | Live text | Evidence |
|---|---|---|---|---|
| P4 | privacy | holds | "The hub also keeps the request's state, such as waiting or invited, and a keyed hash of your IP address, never the address itself, to limit repeat requests." | access_requests keeps state and ip_hash, an HMAC under a key only the database holds (src/directory.js:92-93, 316-338) |
| P6 | privacy | holds | "never stores your source code" is gone. Now: "For each GitHub repository you link to a project, the hub keeps a read-only copy (a git mirror) on its server, to confirm that work reached main. Your code is not stored in nuworq's database, and the copy is deleted with the project." | The hub clones `--mirror` per remote (src/git.js:231-340); deleting a project removes its mirrors (src/core.js:4643-4644, removeMirror in src/git.js:408) |
| P8 | privacy | holds for sign-in; host unnamed, reworded by nuworq-site #39 | "Who processes it": Cloudflare (nuworq.com, traffic to the hub, Turnstile); "The hub's data is kept on a server nuworq runs."; "GitHub handles sign-in, and its App gives agents short-lived access to the repositories you connect."; "Notification services you choose to connect receive the notifications you ask the hub to send there."; "Stripe takes payment when a plan costs money." | Notification services are now named. Google isn't: the hub supports Google sign-in only when NUWORQ_GOOGLE_CLIENT_ID/_SECRET are set (src/oauth.js:12-41), and the pages say people sign in with GitHub. The live hub has Google off (operator, 2026-11-03 ~13:40Z: GET https://app.nuworq.com/api/oauth lists only github, and /auth/google/start returns 404), so the pages are right. The hosting company behind "a server nuworq runs" isn't named: it's Hetzner Online GmbH (whois for the hub's address), and nuworq-site #39 names it |
| T6 | terms | holds | No export feature is promised. "Ending your account": "If we ever shut nuworq down, we'll give you at least 30 days' notice and a copy of your workspace's data." Privacy adds: "You can also ask for a copy of what we hold about you at the same address." | No export route exists, and none is promised now. The host can hand over a copy: the hub's data is SQLite files, which the follower already copies aside before each update (src/follow.js:10-11) |

## For claims.md

When #679 lands, these rows replace P4, P6, P8 and T6 in claims.md (its "doesn't hold as quoted" verdicts rest on the old text):

```
| P4 | privacy | holds (live, 2026-11-03) | "a keyed hash of your IP address, never the address itself" (docs/audit/recheck/site-pages.md) |
| P6 | privacy | holds (live, 2026-11-03) | "keeps a read-only copy (a git mirror) on its server … deleted with the project" (site-pages.md) |
| P8 | privacy | holds for sign-in; host unnamed, reworded by nuworq-site #39 (live, 2026-11-03) | notification services named; Google is off on the live hub, as the pages say; Hetzner not yet named (site-pages.md) |
| T6 | terms | holds (live, 2026-11-03) | no export promised: "a copy of your workspace's data" at shutdown (site-pages.md) |
```
