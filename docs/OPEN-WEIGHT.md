# Open-weight agents: verified end to end

opencode first, then [pi](#pi).

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

## pi

Tested 2026-11-01 on macOS (Apple silicon) with **pi 1.4.0** and Ollama, model `qwen3.8:27b-mtp-q4_K_M`, against a throwaway hub and repo. Reproduce it with:

```bash
node scripts/live-pi.mjs qwen3.8:27b-mtp-q4_K_M small 12 direct   # pi started directly, registered as nuworq connect does it
node scripts/live-pi.mjs qwen3.8:27b-mtp-q4_K_M small 15 run      # through nuworq run --agent pi
```

Set it up beside you: `nuworq connect` runs `pi mcp add nuworq --exposure direct -- nuworq mcp` when pi is installed (it writes `~/.pi/agent/mcp.json`), and `nuworq disconnect` removes it. Headless pi workers:

```bash
nuworq worker --agent pi --model ollama/qwen3.8:27b-mtp-q4_K_M --run
nuworq run --agent pi --model ollama/qwen3.8:27b-mtp-q4_K_M --workers 1
```

What a pi worker gets:

- **A config folder of its own**, `~/.nuworq/pi/<worker>` (`PI_CODING_AGENT_DIR`), written when it starts and removed when it exits. It holds `mcp.json` (the nuworq server, direct exposure, the agent token only as the path of its file) and `models.json` (the provider for `--model`). None of your `~/.pi/agent` follows it in: extensions, skills, prompt templates, MCP servers, sign-ins and your global AGENTS.md. Nothing is written into the worktree.
- **Models:** `ollama/<model>` uses Ollama at `OLLAMA_URL` (default `http://localhost:11434/v1`). `proxy/<model>` with `--proxy` goes through llm-proxy's OpenAI Chat Completions route, keyed by `NUWORQ_LLM_PROXY_KEY` from the environment. Anything else is one of pi's built-in providers, e.g. `anthropic/claude-sonnet-5-5`; your pi sign-ins stay behind, so give its key in the environment (`ANTHROPIC_API_KEY`). Every provider sends `x-client-name: nuworq/<project>/<worker>`.
- **Flags:** `pi -p --mode json --no-session --no-approve --no-extensions -e builtin:mcp -e <nuworq>/src/piguard.js --no-skills --no-prompt-templates --no-themes`. `--no-approve` skips a project's `.pi` folder, but its AGENTS.md still loads, as it does for Claude.
- **Limits:** pi has no sandbox and no permission prompts, so pi workers run only on projects without a remote, as opencode's do (#472). nuworq's pi extension (`src/piguard.js`, shipped in the package and loaded by path, never fetched) blocks `git push` in pi's bash tool. codemode isn't loaded, so no other tool can reach bash around it.
- **Spend:** read from `--mode json`. Each assistant `message_end` carries its tokens and pi's own price. A local model's cost shows "—".

| Path | Outcome |
|---|---|
| `nuworq run --agent pi` | The runner started `pi-5ba4` in its own worktree. It went checkin → claim #1 → progress (named its branch and file) → commit `f170506` on `nuworq/1-greet-handles-a-missing-name` → submit, with evidence naming the branch, the commit and an inline check of both cases → signoff, in 287 s. #1 reached Verifying. The runner removed the worktree and the worker's pi folder ("1 launched, 1 exited cleanly"). |
| pi started directly | MCP connected (`pi mcp list`: "nuworq: connected, 18 tools (direct, global)"). The model checked in with `role: "shaper"`, so every claim was refused ("A shaper doesn't build"). It asked a blocking question and polled until the 12-minute limit. Spend read from its output: 180,458 tokens in, 4,696 out, cost "—". |

What broke, and what happened to it:

1. **`--no-extensions` turned off pi's MCP too.** pi's MCP support is a built-in extension, so the first direct run had no nuworq tools: the model went looking for the CLI instead. **Fixed:** workers load it back explicitly with `-e builtin:mcp`, which pi's docs give as the way to keep only MCP.
2. **A pi worker checked in "via claude-code".** The model copied the checkin schema's example client. **Fixed:** the launcher sets `NUWORQ_CLIENT` (pi workers get `pi`), and the MCP server uses it over whatever the model sends, as it does for `NUWORQ_MODEL`.
3. **In a session started by hand, a model can pick `role: "shaper"` and get stuck.** The role is fixed at checkin by design. Workers never meet this: `nuworq run` starts them with `NUWORQ_ROLE=worker`, and the MCP server sends that role. Nothing changed in nuworq.
4. **No sandbox, seen live.** Before the MCP fix, the model read `~/.pi/agent/AGENTS.md` and listed `~/.nuworq` with bash. Once stuck, it read the throwaway hub's SQLite database directly. A pi worker can read anything your user account can. That's why pi workers aren't started for projects with a remote. Run them only where that's acceptable, or inside a VM or container.

## Setup notes

- Use a model with tool calling (Qwen3 family works). Ollama gave both models a 40k context here. The nuworq tools and guide add about 3.5k tokens on top of opencode's own prompt, so a 4k–8k context is too small.
- opencode needs Ollama declared as a provider (`@ai-sdk/openai-compatible`, `baseURL: http://localhost:11434/v1`). See `scripts/live-opencode.mjs` for a working `opencode.json`.
