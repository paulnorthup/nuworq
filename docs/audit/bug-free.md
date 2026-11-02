# Audit: bug-free (#695)

Scope: the item lifecycle, leases, landing, releases, sign-in and invites, and the runner, at their edge cases.
Read against main at 2e0e5c9 (2026-11-02). Every finding below was traced through the code at the lines named; none
was fixed here. Each one of medium severity or higher is its own item under #675, and its acceptance starts with a failing test.

Severity: **critical** loses data or lets a stranger in; **high** puts wrong code on main, or crosses workspaces;
**medium** stalls or loses someone's work, or leaves a state only the host can repair; **low** misleads or delays.

## High

### H1. Sending back or dropping a landing item leaves its pull request on auto-merge
- **Where:** src/core.js:3779 (verdict's reject path, reached by the human `sendback` from `landing`, src/core.js:3888),
  src/core.js:3961 (human `update` to dropped or ready), src/github.js:89 (`withFix`).
- **Cost:** work a person rejected or dropped merges to main once CI is green. A sent-back item then reads done
  (`withFix` counts ready, active and verifying as "the builder is fixing CI").
- **Reproduce:** in PR mode, accept an item so the hub opens its PR with auto-merge. `sendback` it while it's landing.
  Deliver `pull_request` closed and merged. It's done; expected: auto-merge was turned off and the item stays ready.
- **Fix:** on reject or drop of an item with an open PR, turn auto-merge off as `headMovedBack` does (src/core.js:2798);
  limit `withFix` to items the CI-failure path sent back.

### H2. A merged pull request from another branch that names "#N" marks item N done
- **Where:** src/github.js:89 (the merged branch has no `ownBranch` check; #478 added it only to the closed and CI paths).
  `itemFor` (src/github.js:27) matches "#N" in the title first.
- **Cost:** item N reads done while its accepted work never reaches main. `deleteBranch` (src/core.js:1128) then removes
  its real branch, which closes the hub's own PR. For a release item, it is tagged at someone else's merge.
- **Reproduce:** test/githubtrust.test.js's setup, item #1 landing on its branch; deliver `pull_request` merged with
  head ref `fix/typo` and title "Fix #1 typo". Item #1 is done; expected: still landing.
- **Fix:** add `&& ownBranch(item, pr.head?.ref)` to the merged condition.

### H3. A removed workspace's name, created again, inherits the old one's GitHub App installation, plan and creator
- **Where:** src/workspaces.js:287 (`remove` deletes the files, not the directory rows: `installations`, `plans`,
  `memberships`, `billing`, `org_grants.workspace`). `appOf` (src/server.js:184) trusts any installation bound to the name.
- **Cost:** whoever creates the freed name next can mint push tokens for the previous tenant's repositories and gets their
  webhooks (src/server.js:275), plan and early-access grant. The old creator's free-workspace count includes it.
- **Reproduce:** create workspace acme, bind an installation, `nuworq workspace remove acme`, create acme as someone
  else: `directory.installation(id)` is still "acme". Expected: no installation, plan, grant or creator.
- **Fix:** delete the name's directory rows in `remove`.

## Medium

### M1. Handing off a land job sends the accepted item back to ready
- **Where:** src/core.js:3348 (`handoff`'s else branch moves everything that isn't racing, verifying or proposed to ready).
- **Cost:** an accepted review is thrown away: the item is rebuilt and reviewed again, and `stepUp` counts a failed attempt.
  The lease-expiry sweep does the right thing (src/core.js:1960: stays landing, "another agent can land it").
- **Reproduce:** item landing, a3 claims the land job, a3 calls `handoff`. Stage is ready; expected: landing, no holder.
- **Fix:** a `landing` branch that clears holder and lease only, and no `stepUp`.

### M2. Dependency cycles are accepted, and every item in one waits forever
- **Where:** src/core.js:1387 (`setDeps` skips only depending on yourself). A part depending on its own parent is a cycle
  too, since a parent waits on its open parts.
- **Cost:** the work never starts; `next` says only that ready items wait on dependencies.
- **Reproduce:** #2 depends on #1; `refine #1 depends_on ['#2']` is accepted, and neither can be claimed. Or
  `propose {parent: '#3', depends_on: ['#3']}`.
- **Fix:** walk dependency and parent→part edges in `setDeps` and refuse with a hint naming the cycle, as `parent` does (src/core.js:3650).

### M3. Any agent's blocking question parks another agent's active item and drops its holder unannounced
- **Where:** src/core.js:3225 (parks `active` without checking the asker holds it).
- **Cost:** the working agent loses its lease mid-task with no steer; its next `progress` gets 409. Human `update` and
  `dropAsAnswered` both steer the holder (src/core.js:1187, 3964).
- **Reproduce:** a1 claims #7; a2 asks blocking about #7. #7 is waiting with no holder.
- **Fix:** park only when the asker holds the item (or it's ready); otherwise record the question and steer the holder.

### M4. A workspace can end with no owner
- **Where:** src/auth.js:111 (`setRole`) and src/auth.js:319 (`removePerson`) count every owner row, verified or not;
  `signInByEmail` (src/auth.js:199, 212) then demotes an unverified owner with no last-owner check.
- **Cost:** nobody can invite, change roles or settings; only the hub host's CLI recovers it.
- **Reproduce:** owner alice adds bob as owner by email; alice makes herself member (allowed: two owners); bob signs in
  with GitHub and becomes viewer holding owner. Zero owners.
- **Fix:** count only verified owners in the guard, and let sign-in keep owner when the row is the only owner.

### M5. A progress note sent after the lease ran out is lost, though the agent is told it was saved
- **Where:** src/core.js:3179 writes the comment, then throws; agentOp's `tx` (src/core.js:426) rolls the write back.
- **Cost:** an agent's last report (often right before it submits or hands off) disappears; it was told
  "Your update was saved as a comment", so it never resends.
- **Reproduce:** fake clock; alice claims #1, 21 minutes pass, alice sends progress with a headline: 409, no comment event.
- **Fix:** commit the comment before refusing (return `{ ok: false, error, hint }`, or write it in its own transaction).

### M6. A release that lands drafts the next release with the version that just shipped
- **Where:** src/core.js:1128 → src/releases.js:98 (`landed` → `draftRelease`) runs before `tagRelease`, so
  `lastRelease()` still sees the old tag. test/releases.test.js:152 asserts it ("Release v1.1.0" twice).
- **Cost:** a second "Release v1.1.0" that can't be tagged ("already on …") and repeats the version in its CHANGELOG
  entry, until another milestone happens to redraft it.
- **Reproduce:** the test above.
- **Fix:** when a release item lands, take its own version as the floor for the next, and its `release_through` as `since`.

### M7. A person's edits to a release draft are overwritten on the second redraft
- **Where:** src/releases.js:86 saves `release_draft: summary` after merging an edited summary, so the next redraft sees it
  as untouched and replaces it whole.
- **Cost:** the changelog wording a person wrote before approving disappears without a word.
- **Reproduce:** test/releases.test.js:130, then finish a third milestone: "Thanks to everyone." is gone.
- **Fix:** keep `release_draft` as the machine's draft when the summary was edited.

## Low

- **L1. A lapsed landing lease reads "null went quiet while landing #N".** src/core.js:1960: `patch` clears `it.holder`
  before the headline and `data.agent` read it. Fix: capture the holder first.
- **L2. One hub drain switches a runner's long-poll off until the runner restarts.** src/runner.js:521 reads the
  drain's early empty answer as an old hub that ignores `wait`; nothing turns it back on, so workers start up to 30s
  late after every deploy. Fix: the hub marks a drain answer, or fall back only after two early answers in a row.
  Related to #523.
- **L3. `revoke(7)` can revoke the token named "7" instead of token id 7.** src/auth.js:358 matches `name = ? OR id = ?`
  with `.get()`; all-digit names are allowed. In `removePerson` the person's agent token survives. Fix: separate lookups.
- **L4. An open /api/stream survives revocation, removal and logout.** src/server.js:353; change events (project,
  item, kind) keep flowing to a removed person until they disconnect. Fix: end the token's streams on revoke.
- **L5. Pushes from a shallow clone are refused as "not a git push".** src/gitproxy.js:31: `shallow <sha>` lines before
  the commands fail the parser. nuworq's own clones are full. Fix: skip `shallow` lines.
- **L6. "Pushed through the hub" is recorded when GitHub refused the ref.** src/gitproxy.js:127 records on HTTP 200,
  though per-ref `ng` lines arrive in a 200. Fix: read the report before recording.
- **L7. A worker exit or Ctrl-C during an await in the runner's loop can wait a full poll.** src/runner.js:511 replaces
  the `wake` resolver after the awaits; a wake in between is lost. Fix: a pending-wake flag.

## Checked and sound

Double accept and stage changes between calls (one transaction per op, stage checks); reviewing your own raced attempt;
two agents claiming one item (`BEGIN IMMEDIATE`); submit after expiry (sweep first, 409, nobody else credited);
timestamps (integer milliseconds from the injected clock everywhere; no SQLite `datetime()`); invites reused, expired or
taken; OAuth state missing, forged or replayed; redirects (none open); device codes; revoked tokens and sessions;
login case; webhook replays (delivery ids); the CI fallback clock; refused pushes send nothing upstream (seen live on #704).
