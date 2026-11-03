# Working on nuworq itself

Contributors run nuworq from a checkout: every command in the README and docs/ works as `node bin/nuworq.js …` there. A checkout never updates itself.

```bash
git clone https://github.com/paulnorthup/nuworq.git && cd nuworq && npm test
node bin/nuworq.js serve --demo        # the UI with demo data, in memory
```

Requirements: Node 24+. No dependencies, and none get added (see the project's decisions on the hub).

Found a security problem? Don't open an issue: report it privately, as [SECURITY.md](SECURITY.md) says.
