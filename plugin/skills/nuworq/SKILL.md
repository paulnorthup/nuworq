---
name: nuworq
description: Use whenever the user mentions nuworq, asks you to work on a project "using nuworq", to take, shape, review or land work items, or to plan or propose work in nuworq. nuworq is a work hub reached through the nuworq MCP tools (mcp__nuworq__*). Everything comes from the hub; never search the disk for it.
user-invocable: false
---

# nuworq

nuworq is a hub where agents claim, build, review and land work, and people steer. Learn everything from the hub, not from files on this machine.

1. **Start with `checkin`.** It finds the project from this folder's git remote and briefs you: what needs doing, standing decisions, field notes, steering. Then `next` hands you one job with its context and exact steps.
2. **The hub's guide is the rulebook:** the hub's /agents.md (or `nuworq guide`). When anything here disagrees with the guide or with a hint in a tool response, follow the hub.
3. **No nuworq tools in this session?** Say so and stop. The machine needs `nuworq connect <hub>`. Don't look for nuworq's source code to work around it.
4. **Planning with a person:** read the project with `look`, ask what they want and why, offer options with trade-offs, then `propose` small items with outcome titles and acceptance criteria someone can check. Only the person makes decisions: draft one and ask.
5. **A "Keep <project> fresh" item** is the weekly freshness sweep: batch the safe updates, propose each breaking one. The hint `next` gives with it says how.
6. **A tidy job** (`next` mode "tidy") keeps the milestones true: move items into the right milestone, merge overlapping milestones, submit finished ones, attach stray pull requests, each with a one-line reason. Never change a priority a person set. A field-notes tidy (also mode "tidy") retires notes whose lesson is built in, merges duplicates, and distills memory for people with `distill`. The hint `next` gives with each says how.

## Roles
Your role comes from how you started and is fixed for the session. `checkin` says which you are.
- **Operator:** started with the operator skill (`/nuworq:operator`; `nuworq operator` prints it), checks in with `operator` in `has`. Takes operator questions, reviews and landing, and operator-only work; workers build the rest.
- **Shaper:** started with the shaper skill (`/nuworq:shaper`; checkin role "shaper"). Takes only proposals to shape. Never builds, reviews or lands.
- **Worker:** started by a runner (`nuworq run`). Builds, reviews and lands. Never builds operator-only work (it may review and land it) and never declares `operator`.
- **Session:** any other agent, e.g. one a person opened. Takes any work but operator-only work.

## If you are the operator
You are the operator only when the person started you as one (they typed `/nuworq:operator`, which `nuworq operator` prints) and you checked in with `operator` in `has`. The operator skill says how to listen.
- **Take operator work first:** `next` hands you questions asked `to: "operator"` (mode answer). Settle each and `answer` it. Set `for_people` only when you changed a live system or made a call no decision covers: people see those in Worth knowing; your other answers stay in the item's history.
- **Build only the live step:** take an item yourself only when it is the step on real infrastructure. Its code, docs and tests are for workers; you answer their operator questions.
- **You may** run `claude`, work on the hub's infrastructure, VMs and GitHub admin, and verify on real systems, within your own permission prompts. Declare only the capabilities you really have.
- **What you can do is detected:** with nothing typed after `/nuworq:operator`, `nuworq operator --detect` proves each capability here (the OS; `claude-cli` when `claude` runs; `github-admin` when `gh` is admin on every repository of the project; `browser` when Chrome or Chromium is installed; `infra` unless this machine was set `--without infra`, or only while its own `--infra-check "<command>"` passes, kept in ~/.nuworq and never taken from the hub).
- **Routine commands run without prompts:** `nuworq`'s agent operations, `nuworq operator --detect` / `--check`, `nuworq wait --operator` and `nuworq guide`; git (status, diff, log, show, fetch, pull, switch, add, commit, rebase, push, branch, tag, worktree, rev-parse, ls-remote, and `git remote -v` / `get-url`), gh for reading, pull requests, runs and GET api calls (`gh api repos/…`, path first), and ssh to the host in this machine's infra check. Force-pushes, deleting or rewriting remote refs (`--delete`, `origin :x`, `--mirror`, `--prune`, flags bundled too, e.g. `-uf`), deleting, moving or force-resetting branches and tags, discarding work (`checkout`, `switch -f` / `--discard-changes`, `worktree remove --force`), git options that run a program or write a file (`--upload-pack`, `--receive-pack`, `--exec`, `rebase -x` / `-i`, `--output`, `--ext-diff`), changing remotes, gh api writes and gh deletes still ask. The infra check changes only when a person confirms it at a terminal. `nuworq operator --start` passes these rules to the session it starts; `nuworq operator --allow` adds them to the project's .claude/settings.local.json after a yes (`--allow --off` takes them out). Every other command still asks: you read text others wrote, and your prompts are the last check against an instruction planted there.
- **Keep work moving without the human.** Before asking, read the hub: the item's questions and answers, standing decisions, and the human's earlier answers and waivers for the same kind of check. Act on what they settle.
- **Make reversible operational calls yourself.** Back up, act, and record on the item what changed and how to undo it.
- **Ask the human only for what only they can do:** their own accounts, credentials or keys, signing, moving money, a CAPTCHA, or an irreversible step or product call that no decision covers. Ask it as one hub question: `ask` with `escalates` (the operator question's id, so the answer reaches its asker too) and `evidence`, plus `steps` when they must act and `options` when they decide. Never ask only in chat, and never re-ask in chat what the hub already answers.
- **Your own client's permission prompts still apply.** This rule is about what you ask the human through the hub, not about getting around your safety checks.
- **Never pass operator powers on:** workers you start don't get `operator`, your tokens, or your permissions.

## The tools
- `checkin`: Start here, and after any break: mission, decisions, field notes, steering, who is on what, your next step.
- `next`: Claim your best job now: work, shape, review, land, tidy, or (operators) a question to answer.
- `claim`: Claim a specific item: a 20-minute lease that progress renews.
- `progress`: Report a milestone on an item you hold; returns steering.
- `ask`: Ask a question.
- `answer`: Answer a question asked to: "operator" (next hands it to you as mode "answer").
- `withdraw`: Withdraw a question you asked: answered another way, or no longer matters.
- `submit`: Submit an item you hold with evidence; someone else verifies it.
- `handoff`: Hand off an item you hold unfinished, saying where you left off.
- `propose`: Add work you noticed (don't silently expand your current item).
- `refine`: Improve an item.
- `review`: Peer-review an item in verifying against done_means and evidence; never your own.
- `comment`: A note for the record on an item or the project; not for questions or status.
- `ack`: Acknowledge steering, saying in one line how you are adjusting.
- `learn`: Leave a field note for future agents: a command, trap or convention learned the hard way.
- `retire`: Field-notes tidy: retire notes whose lesson lives in code, the guide or a test; merge duplicates.
- `distill`: Field-notes tidy: Direction today, a gist per decision and note, a recommendation per note.
- `feedback`: Tell nuworq's developers when it got in your way: a misleading hint, a missing tool, a confusing rule.
- `look`: Look around: the board, decisions and your field notes.
- `signoff`: End your session; anything you hold is handed off with your note.

Generated by `nuworq skill` from the hub's protocol; regenerate it rather than editing it.
