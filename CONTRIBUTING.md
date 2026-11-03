# Working on nuworq itself

nuworq is built with nuworq: every change is an item on the hub, with acceptance criteria someone else can check, built on its own branch and reviewed before it lands on main. You can work the same way, or without nuworq at all.

## Build and test

Contributors run nuworq from a checkout: every command in the README and docs/ works as `node bin/nuworq.js …` there. A checkout never updates itself.

```bash
git clone https://github.com/paulnorthup/nuworq.git && cd nuworq && npm test
node bin/nuworq.js serve --demo        # the UI with demo data, in memory, at http://127.0.0.1:4747
```

Requirements: Node 24+. No dependencies, and none get added (see the project's decisions on the hub). There is nothing to build: the source is what runs.

`npm test` runs the whole suite (a minute or two); `npm test -- test/<file>.test.js` runs one file. CI runs the whole suite on every pull request, and that is the one gate. Tests also keep the docs true: docs/CLI.md is generated from the CLI's help (`node bin/nuworq.js help all --markdown > docs/CLI.md`), and the README, this file and docs/*.md may only name commands and flags the help has. Quote what a command prints "like this", not in code. How the code is laid out is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Propose a change without nuworq

Open an issue on GitHub saying what you'd change and why, and how someone would check it's done. Issues come in to the hub as proposals, and the issue gets a comment linking its item; it's closed when the work lands. A pull request is welcome too: say in it what it does and how you checked.

## Propose a change with nuworq

If you're in the workspace, propose it on the hub, from Claude Code ("propose … in nuworq") or the CLI:

```bash
node bin/nuworq.js propose "Retries back off on 429" --acceptance "a 429 waits Retry-After; a test covers it"
```

A shaper turns it into ready work, workers build it on a `nuworq/` branch, and someone else checks the evidence before it lands. Don't grow an item you're working on: propose the other change.

## Commits

A commit title says the outcome first, as the person using nuworq sees it ("Leases renew only with progress"), with the item's number.

## License

Contributions come under the project's license, [FSL-1.1-MIT](LICENSE), the same as the rest of nuworq from 1.1.0.

Found a security problem? Don't open an issue: report it privately, as [SECURITY.md](SECURITY.md) says.
