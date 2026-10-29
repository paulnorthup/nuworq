# Eval: invite link to a landed item (#116)

A stand-in for an observed onboarding, approved by Paul for #116: an agent (claude-opus-5-5) ran
`node scripts/onboarding-walkthrough.js` on 2026-10-29. The script stands up a throwaway hub with login
required, and an owner sends a steward invite. The invited person, @sam, acts through the same HTTP calls
the web pages make. Their machine acts through the real CLI (`connect`, `checkin`, `next`, `submit`), with
HOME in a temporary folder. The project's repository is a bare repo on disk, so GitHub isn't involved.

## Steps and times

The times are the hub's and the CLI's, not a person's. Reading and clicking add to each one.

| # | Step | Time | What the person saw / got |
|---|------|------|---------------------------|
| 1 | Open the invite link | 0.0s | "You're invited to join as steward, by @paul" |
| 2 | Pick a handle and join | 0.0s | Signed in as @sam (steward), session cookie set |
| 3 | Land on All projects: Get started | 0.0s | Five steps open; first: **Connect GitHub** (opens the Connect dialog) |
| 4 | + Project (name and repository) | 0.0s | Project `demo`, remote linked |
| 5 | Connect a machine: `nuworq connect <url>`, approve the device code | 5.3s | "Connected … (agent token)": one poll interval |
| 6 | Add work in the UI | 0.0s | #1 ready |
| 7 | Agent: `checkin`, `next` | 0.4s | Claimed #1, branch `nuworq/1-say-hello-in-the-readme` |
| 8 | Agent: commit, push the branch, `submit` | 0.9s | Submitted for review |
| 9 | Person: Needs you shows the review, accept | 0.4s | "README says hello" → accepted |
| 10 | Agent: `next` gives the land job; push to main, `submit` | 0.9s | main moved to the item's commit |
| 11 | Person: item done; Get started rechecks | 0.0s | #1 done; ✓ project ✓ machine ✓ agent ✓ landed, · github |

Invite link to a landed item: **8.0s, 11 steps**, and nobody had to ask the owner anything.

## Where a person would have hesitated

- **Step 3, then for good:** Get started puts "Connect GitHub" first. For a steward on a hub without an
  App, its action opens a dialog where only an owner can create one. For a project that isn't on GitHub,
  the step never checks off, so the card can't complete. Filed as #129, and fixed there. "Add a project"
  now comes first, so step 3's first undone step is "+ Project". The GitHub step leaves the list once the
  project's repository turns out not to be on github.com. Someone who can't create the App is told whom to
  ask. A rerun ends with "Get started still open: none".

## What this run doesn't cover

- How the pages look and read (no browser here). The calls are the ones `web/invite.js`, `web/app.js` and
  `web/device.js` make.
- Installing the package (`/nuworq.tgz`, #101) and starting a headless worker (`nuworq worker --run`, which
  needs an agent CLI). The script ran the CLI from this checkout and did the agent's steps itself.
- The GitHub App: installing it, worker tokens, and landing through a pull request.
