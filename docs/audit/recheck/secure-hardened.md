# Re-check: secure (#701) and hardened (#702)

- **What.** Every medium-or-higher finding in docs/audit/secure.md and docs/audit/hardened.md, checked against the current code, plus a sweep for new critical or high issues before the repository goes public.
- **Commit.** c85fb5f7 (origin/main plus the v1.0.0 release commit).
- **Who.** An agent that built none of the fixes.
- **How.** Read the code at each finding's lines and the fix commits. Ran targeted tests with `npm test -- test/<file>.test.js`. Scanned tracked files for secret shapes. Nothing ran against a live hub, GitHub or ~/.nuworq.

Tests run, all passing: precondition (13), githubflow (6), gitproxy (7), releasesign (22), floodlimits (3), textlimits (6), spendalerts (4), runner (53), sandbox (15), update (29), staffing (10), ciworkflow (1). One fails in this runner: isolation, "over SSH only with the organization's own deploy key" (the stand-in ssh logged nothing). The code it covers (src/git.js:260-293) is unchanged by these fixes and looks right. It is most likely this sandbox's git or ssh setup, but CI should confirm it passes. The other 3 isolation tests pass, #758's among them.

## Re-checked findings

| id | item | verdict | evidence |
| --- | --- | --- | --- |
| secure 1 (high) | #756, dropped | partly | The Mac signer service is gone. Releases are signed in .github/workflows/release.yml: `sign` runs no repository code, rebuilds with `git archive`, must match check's sha256, and signs with inline node:crypto. The App has no `workflows` permission, so landed code can't reach `RELEASE_KEY`. That much of the risk is gone. The hand fallback still has it: `scripts/sign-release.js release` imports `src/client.js`, `src/package.js` and `scripts/release.js` from whatever checkout it runs in (scripts/sign-release.js:50-52), then loads the key (:55). The script itself is also the checkout's. docs/DEPLOY.md:283-289 says only "in a checkout of nuworq". See new finding N1. |
| secure 2 (high until checked) | #757 | fixed, as recorded | Can't be read from here. docs/SECURITY-MODEL.md:76 records the `release` and `v*` rulesets as checked live on 2026-11-02, with the App unable to bypass them. Approval for outside contributors' workflows can only be set once the repository is public (#365), so it is still a go-public step. The exposure is small: test.yml has `contents: read`, no secrets, no `pull_request_target`. |
| secure 3 (medium) | #758 | fixed | src/server.js:422 passes `appOf(hub)` to `runChecks`. Test: test/precondition.test.js:303 ("mints only through its own workspace's installation (#758)"), plus test/isolation.test.js. |
| secure 4 (medium) | #759 | fixed | src/git.js `gitFacts` takes a named branch only if it isn't another live item's (`holderOf`). src/core.js `branchHolder` (:1301-1306) backs it, and src/core.js:2550 saves it. The proxy refuses a branch another live item holds: src/gitproxy.js `refusedRef(..., holder)`, src/server.js:1916-1918. Tests: test/gitproxy.test.js:35, test/githubflow.test.js:341. |
| hardened 1 (high) | #761 | fixed (default caps by decision) | Spend is counted per streamed message (src/usage.js:55-73). A killed run keeps its estimate. The runner stops a worker past `--worker-usd` or `--max-minutes` and counts running workers toward `--max-usd` (src/runner.js:530-541). Default caps were removed on purpose by #795, an owner decision (Q230): connect sets caps by payment type (83620388). Tests: test/runner.test.js:815-820, :1050. |
| hardened 2 (high) | #762 | fixed | src/core.js:3586-3592: once the budget is spent, `next` gives runner workers only reviews. Test: test/staffing.test.js. |
| hardened 3 (high) | #764 | fixed | src/runner.js:513-520, 663-665: 3 non-zero exits in a row pause the runner, however long each ran. Tests: test/runner.test.js:1176-1220 (60 s and 20 min workers). |
| hardened 4 (high) | #765 | fixed | src/core.js:49-53 `LIMITS`, enforced by `refuseLong` at src/core.js:2391 (agent ops) and :4847 (human ops). Test: test/textlimits.test.js. |
| hardened 5 (high) | #766 | partly | 60 writes a minute, plus 200 open questions and 500 proposals per project (src/core.js:44-50, 2362-2377, 3698, 3900). But the window is keyed by agent name (`${p.id}:${agent}`, src/core.js:2365), and any token can check in under new names: `ownsAgent` only refuses names already bound to another token (src/core.js:1612-1624). Comments and notes have no per-project cap. See N2. Test: test/floodlimits.test.js:23 (one name only). |
| hardened 6 (medium) | #766 | fixed | src/core.js:608-617 and :2400: checkin creates projects only below 100. Test: test/floodlimits.test.js:66. |
| hardened 7 (medium) | #765 | fixed | src/core.js:275-281: evidence 20 entries (label 300, url 2,000), depends_on 30. Test: test/textlimits.test.js. |
| hardened 8 (medium) | #767 | fixed | src/notify.js:15-19 `budget-near` and `run-spend` alerts, sent once per day or run (f44ba088). Test: test/spendalerts.test.js. |
| hardened 9 (medium) | #768 | fixed | src/sandbox.js:149-156: by default only check scripts (test, lint, check, typecheck, build) and exact `npm ci`. Deploy, release and publish are excluded. Test: test/sandbox.test.js. |
| hardened 10 (medium) | #768 | fixed | bin/nuworq.js:1017-1023: codex, opencode and pi won't start for a project with an origin. bin/nuworq.js:582-584 also requires `--can-read-keys`. Test: test/runner.test.js. |

## New findings

| # | severity | where | exposure | fix, one line |
| --- | --- | --- | --- | --- |
| N1 | medium | scripts/sign-release.js:50-55; docs/DEPLOY.md:283-289; docs/SECURITY-MODEL.md:76-77 | Scenario: GitHub Actions can't sign, so the maintainer uses the fallback in a checkout pulled to main. Agents land on main without a person, so the code that runs could be an agent's: `sign-release.js` and the modules it imports. That code gets the key path from argv, then has the person's shell and an approved-looking prompt. It can copy the key or sign a different file. The TTY check (:47) is in the same file, so it protects nothing. This is #756's risk, narrowed to the fallback. SECURITY-MODEL says landed code can't reach the key, which holds only for the workflow. | Run the fallback only from a checkout at the last signed release tag (refuse unless HEAD is that tag and the tree is clean), and say so in DEPLOY.md and SECURITY-MODEL.md. |
| N2 | medium | src/core.js:2362-2377 (key), :1612-1624 (names) | Scenario: one agent token, prompt-injected or leaked, writes as `a1`, `a2` and so on: 60 writes a minute per name, so no real limit. Comments, learn and usage have no per-project cap, so it can fill a workspace's database and every open page. On a shared hub that costs other workspaces CPU and disk. `_writes` also keeps a key per name and never drops it. | Key the window by the calling token (identity.id or token name) as well as the name, and cap new agent names per token per hour. |

Checked and sound in this sweep (no new issue):
- **Secrets.** `git grep` for `sk-ant-`, `ghp_`, `github_pat_` and private-key headers finds only test fixtures, redaction patterns and docs. No .pem, .key, .env or .npmrc file is tracked.
- **Release workflow.** `permissions: {}` at the top. `check` and `changes` have read-only access and no secrets. `sign` needs the `release` environment (v* tags, a required reviewer) and checks the commit and sha256. Checkouts don't keep credentials, actions are pinned by SHA, nothing is cached, and the `release` push is fast-forward only.
- **CI on outside pull requests.** `pull_request` only, `contents: read`, no secrets. A fork can't reach the release environment: its ref isn't a v* tag, and the job needs approval.
- **`nuworq update`.** https or loopback only. It checks the sha256, then ed25519 against the pinned key, then that the key is the same, the commit is the one named and its signed time is later. A package with no time is refused (src/update.js:180-226).
- **Push proxy.** Basic auth maps to the agent's token. The agent name must be the caller's, it must hold an item, the repository must be the item's, and the ref must be exactly the held branch, which no other live item holds (src/server.js:1129-1137, 1894-1928).
- **Zero-gap front (#477, new since the audit).** The handed-over hub listens on a random loopback port. Nothing in src/server.js trusts a loopback address. The real client's socket is passed by descriptor, so per-address limits still see it (src/follow.js:265-285, src/handoff.js).
- **Workspace deletion (#799).** Owner only, never an agent. The name must be typed, and a plan that renews blocks it (src/server.js, `/api/workspace/delete`).
- **Plugin.** It runs the installed `nuworq mcp` and `nuworq wait`, comes from the `release` ref, has no hooks and fetches nothing at runtime.

Critical: 0. High: 0.

Update: both mediums have since landed on main. N1: signing by hand runs only code from a signed release, never the checkout's (#836, 601b96b6; with #829, #843). N2: write limits count per token, comments and field notes included (#831, 6cf8b875; #851, 25f04d60). The pre-release security audit (#848, 24187de8) only changed docs/SECURITY-MODEL.md.
