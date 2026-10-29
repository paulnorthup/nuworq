# Open-weight agents: verified end to end

Tested 2026-10-28 on macOS (Apple silicon) with **opencode 1.18.10** and **Ollama 0.40.9**, using the nuworq MCP server set up the way `nuworq init` prints it. Each run used a throwaway hub and repo. Reproduce it with:

```bash
node scripts/live-opencode.mjs qwen3.8:27b-mtp-q4_K_M big 20        # opencode started directly
node scripts/live-opencode.mjs qwen3.8:27b-mtp-q4_K_M small 12 run  # through nuworq run --agent opencode
```

Headless open-weight workers:

```bash
nuworq worker --agent opencode --model ollama/qwen3.8:27b-mtp-q4_K_M --run
nuworq run --agent opencode --model ollama/qwen3.8:27b-mtp-q4_K_M --workers 1
```

The worker passes opencode its config through `OPENCODE_CONFIG_CONTENT`: the nuworq MCP server, an Ollama provider for `ollama/...` models (override with `OLLAMA_URL`), and a deny on `git push`. That keeps the worktree free of config files the agent could commit. opencode has no sandbox, so apart from `git push` it can run any shell command.

## Results

| Model | Item | Outcome |
|---|---|---|
| `qwen3.8:27b-mtp-q4_K_M` | one-line fix | checkin → next → submit → signoff in ~5 min. Tested both cases, committed, evidence named the test and the commit. No `progress`. |
| `qwen3.8:27b-mtp-q4_K_M` | multi-step (2 functions, test suite, package.json, README) | Same loop in ~8 min: 6/6 tests, committed, and it kept its local `opencode.json` out of the commit. No `progress`. |
| `qwen3.8:27b-mtp-q4_K_M`, after the hint fix below | multi-step | **checkin → next → progress → submit → signoff**: 5/5 tests, commit `d58e260`, item in Verifying. |
| `qwen3.8:27b-mtp-q4_K_M`, after the hint fix | one-line fix | The full loop including `progress`, but it posted it after finishing rather than up front. Committed `5fc2e1c`. |
| `qwen3.8:27b-mtp-q4_K_M` via `nuworq run --agent opencode` | one-line fix | The runner started one worker in its own worktree. It committed `692b265` on `trellis/opencode-fb47`, left the worktree clean, and #1 reached Verifying; the runner then exited ("1 launched, 1 exited cleanly"). The model reported itself as "unknown", so the MCP server now prefers the launcher's `NUWORQ_MODEL`. |
| `qwen3:8b` | one-line fix | Correct code, submitted, item in Verifying, but it **said "Committed" without committing**, and its evidence was just a file path. |
| `qwen3:8b` | multi-step | Claimed the item, ran a shell one-liner with broken quoting, then ended its turn without a submit or handoff. The lease expiry returns the item to the queue. |

**Recommendation:** a ~27B tool-calling model handles nuworq work reliably. An 8B model gets through the protocol, but it isn't reliable at the work or at honest evidence, so keep it on small items.

## What broke, and what happened to it

1. **No model called `progress`, so none declared `touching`.** The old hint said "post progress at milestones", and small models read a short job as having none. That leaves the human with no signal and gives other agents no collision warning. **Fixed:** the `next` and `claim` hints and the guide now say *when* the first one is due ("As soon as you know which files you will change, post progress with a headline and touching"). After the change, the 27B posted progress right after claiming.
2. **The CLI dropped `--touching`.** `nuworq progress` and `nuworq claim` never forwarded it, so shell agents couldn't declare touching at all. **Fixed**, with a CLI test.
3. **An 8B model claimed a commit it never made.** That's model honesty, not protocol. The human verifier catches it today. Git awareness (#13) would let the hub check that a commit named in the evidence exists on the worker's branch.
4. **An 8B model quit mid-item without a handoff.** The lease handles it, as designed. Nothing to fix in nuworq.
5. **Harness gotchas when spawning `opencode run` headless** (`nuworq worker --agent opencode` handles both):
   - With a non-TTY stdin left open, it hangs after `init`, waiting for input. Close stdin.
   - It picks its project folder (and so its `opencode.json`) from `$PWD`, not the process cwd. Set `PWD`.

## Setup notes

- Use a model with tool calling (Qwen3 family works). Ollama gave both models a 40k context here. The nuworq tools and guide add about 3.5k tokens on top of opencode's own prompt, so a 4k–8k context is too small.
- opencode needs Ollama declared as a provider (`@ai-sdk/openai-compatible`, `baseURL: http://localhost:11434/v1`). See `scripts/live-opencode.mjs` for a working `opencode.json`.
