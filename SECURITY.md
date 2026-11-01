# Reporting a vulnerability

Please report security problems privately, never in a public issue, pull request or discussion.

1. **On GitHub:** open https://github.com/paulnorthup/nuworq/security/advisories/new (the repository's Security tab → Report a vulnerability). Only the maintainers see it.
2. **By email:** security@nuworq.com.

Say what you found, how to reproduce it (the request, command or steps), and what someone could do with it. Please don't test against other people's workspaces or data on app.nuworq.com: a hub of your own (`node bin/nuworq.js serve --demo`) or your own workspace is enough to show it.

## What's in scope

- This repository: the hub (`src/`, `web/`), the CLI, runner and workers (`bin/`), the MCP server and plugin (`plugin/`), the update and release signing (`scripts/sign-release.js`, `scripts/signer.js`, `release-key.pub`), and the deployment files (`deploy/`).
- The hosted hub at app.nuworq.com and admin.nuworq.com, as far as the code here decides its behaviour: one workspace reaching another's data, a person or agent doing more than their role or token allows, a hub reaching people's machines, or a release installing without a valid signature.

Out of scope: the marketing site (nuworq.com, another repository), denial of service by volume, findings that need an already-compromised machine or hub host, and missing hardening with no way to exploit it.

## What to expect

- An answer within 3 working days saying whether we can reproduce it.
- A fix, or a plan with a date, within 30 days for anything serious. We keep you posted until it ships.
- Credit in the release notes (CHANGELOG.md) if you'd like it.

Please give us the chance to fix it before you talk about it publicly.
