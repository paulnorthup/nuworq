// Claude Code permission rules for git's options (#607, #625), shared by the operator's no-prompt rules
// (src/operator.js) and a worker's denies (src/sandbox.js). Claude Code matches rule text: `*` is any text, spaces
// included, and `:*` means "and anything" only at the very end.

// A flag, wherever it sits: first (`git push -fu`) or later (`git push origin x --force`), with its value attached or not.
export const flag = (cmd, ...flags) => flags.flatMap((f) => [`Bash(${cmd} ${f}*)`, `Bash(${cmd} * ${f}*)`]);
// A short flag bundled with others too (#607), e.g. `-uf` for -f: letters are the command's short flags, and a
// bundle starts with one of them, so `--dry-run` never matches. Rule text can't say "within one word", so a later
// word may make it match (`-u origin feature`): that command asks, which is the safe side.
export const short = (cmd, letters, ...targets) => targets.flatMap((t) => flag(cmd, `-${t}`, ...[...letters].filter((x) => x !== t).map((x) => `-${x}*${t}`)));
// Options that make git run a program or write a file: through the transport (upload-pack, receive-pack, exec), a
// configured diff or textconv driver, or --output.
export const GIT_RUNS = ['--upload-pack', '--receive-pack', '--exec', '--output', '--ext-diff', '--textconv'];
// What rebase runs besides: its exec (-x), the interactive editor (-i, --edit-todo) and a merge strategy (a
// git-merge-* on PATH).
export const rebaseRuns = () => [...flag('git rebase', '--interactive', '--strategy', '--edit-todo'), ...short('git rebase', 'CfikmnqrsvxX', 'x', 'i', 's')];
