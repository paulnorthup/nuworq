# Open-weight agents: verified end to end

Tested 2026-10-28 on macOS (Apple silicon) with **opencode 1.18.10** and **Ollama 0.40.9**, using the Trellis MCP server set up the way `trellis init` prints it. Each run used a throwaway hub and repo. Reproduce it with:

```bash
node scripts/live-opencode.mjs qwen3.8:27b-mtp-q4_K_M big 20
```

## Results

| Model | Item | Outcome |
|---|---|---|
| `qwen3.8:27b-mtp-q4_K_M` | one-line fix | checkin → next → submit → signoff in ~5 min. Tested both cases, committed, evidence named the test and the commit. No `progress`. |
| `qwen3.8:27b-mtp-q4_K_M` | multi-step (2 functions, test suite, package.json, README) | Same loop in ~8 min: 6/6 tests, committed, and it kept its local `opencode.json` out of the commit. No `progress`. |
| `qwen3.8:27b-mtp-q4_K_M`, after the hint fix below | multi-step | **checkin → next → progress → submit → signoff**: 5/5 tests, commit `d58e260`, item in Verifying. |
| `qwen3.8:27b-mtp-q4_K_M`, after the hint fix | one-line fix | The full loop including `progress`, but it posted it after finishing rather than up front. Committed `5fc2e1c`. |
| `qwen3:8b` | one-line fix | Correct code, submitted, item in Verifying, but it **said "Committed" without committing**, and its evidence was just a file path. |
| `qwen3:8b` | multi-step | Claimed the item, ran a shell one-liner with broken quoting, then ended its turn without a submit or handoff. The lease expiry returns the item to the queue. |

**Recommendation:** a ~27B tool-calling model handles Trellis work reliably. An 8B model gets through the protocol, but it isn't reliable at the work or at honest evidence, so keep it on small items.

## What broke, and what happened to it

1. **No model called `progress`, so none declared `touching`.** The old hint said "post progress at milestones", and small models read a short job as having none. That leaves the human with no signal and gives other agents no collision warning. **Fixed:** the `next` and `claim` hints and the guide now say *when* the first one is due ("As soon as you know which files you will change, post progress with a headline and touching"). After the change, the 27B posted progress right after claiming.
2. **The CLI dropped `--touching`.** `trellis progress` and `trellis claim` never forwarded it, so shell agents couldn't declare touching at all. **Fixed**, with a CLI test.
3. **An 8B model claimed a commit it never made.** That's model honesty, not protocol. The human verifier catches it today. Git awareness (#13) would let the hub check that a commit named in the evidence exists on the worker's branch.
4. **An 8B model quit mid-item without a handoff.** The lease handles it, as designed. Nothing to fix in Trellis.
5. **Harness gotchas when spawning `opencode run` headless** (matters for a future `trellis worker --agent opencode`):
   - With a non-TTY stdin left open, it hangs after `init`, waiting for input. Close stdin.
   - It picks its project folder (and so its `opencode.json`) from `$PWD`, not the process cwd. Set `PWD`.

## Setup notes

- Use a model with tool calling (Qwen3 family works). Ollama gave both models a 40k context here. The Trellis tools and guide add about 3.5k tokens on top of opencode's own prompt, so a 4k–8k context is too small.
- opencode needs Ollama declared as a provider (`@ai-sdk/openai-compatible`, `baseURL: http://localhost:11434/v1`). See `scripts/live-opencode.mjs` for a working `opencode.json`.
