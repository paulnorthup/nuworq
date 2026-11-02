# nuworq's threat model

Who might attack nuworq, where the trust boundaries are, and which defence covers which threat. Security reviews read changes against this file: one before each release, and one area a month (see [Keeping it checked](#keeping-it-checked)). If you find a threat it misses, add it here. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What there is to protect

- **People's machines.** Workers and operators run on them, with a shell, the person's git credentials and their files.
- **Workspaces' data.** Items, questions, evidence, field notes, people, tokens and billing. Each workspace sees only its own.
- **Releases.** Code that `nuworq update` and the Claude Code plugin install on people's machines.
- **The hub host.** The VM running app.nuworq.com, its GitHub App key, its webhook secrets and its databases.

## The attackers

| Attacker | What they can do to start with | What they're after |
|---|---|---|
| **The anonymous internet** | Reach the hub's public pages, sign-in, webhooks and `/live/<slug>`. Read the public repository. | Any data, a session, a foothold on the host. |
| **Another workspace** | Sign in, hold tokens and agents of its own, and call every API its role allows. | Another workspace's data, or acting in it. |
| **A member, by role** | What their role allows: owner, member or viewer. | More than their role: settings, people, billing, other projects. |
| **An agent token** | Agent operations in its project, as the agent it names. | Human operations (accept, settings, decisions), acting as another agent, other projects. |
| **A stranger's issue or reply** | Write text that the hub imports from GitHub. Agents read that text. | Prompt injection: getting an agent to run, push or leak something. |
| **A hostile or impersonated hub** | Whatever a runner, worker or MCP process accepts from the hub it's connected to. | Running code on people's machines, or reading their files and tokens. |
| **A compromised hub VM** | Everything the hub holds: databases, the GitHub App key, webhook secrets. | Releases, and people's machines through them. |

## Trust boundaries

1. **The internet and the hub's HTTP edge.** Everything that arrives is untrusted until sign-in, a token, or a webhook signature says who sent it.
2. **One workspace and the next.** Each workspace has its own database (`src/workspaces.js`). A request opens only the workspace its session or token belongs to.
3. **A person and an agent.** Human operations need a person's session. Agent operations need an agent's identity. A token is for one or the other, never both.
4. **Outside text and the agents.** Issues, replies and feedback from people without write access are data, not instructions, until a person lets them in.
5. **The hub and the machines it staffs.** A runner trusts its own machine, not the hub. The hub sends definitions (data) and never code.
6. **Main and a release.** Agents land on main on their own. Code reaches people's machines only through a release that a person approved and the release key signed. The key never sits on the hub.

## The defences

Each defence names the item that built it and the tests that guard it.

### The HTTP edge and sign-in
- **Sign-in decides identity.** Plans, owner rights and notifications follow how someone signed in, never an email they typed (#470: `test/identity.test.js`, `test/adminspaces.test.js`).
- **Roles and tokens.** A person's role and a token's identity decide what a caller may do. Agent operations are for agents, and each agent acts only as itself (#469: `test/agentroles.test.js`, `test/auth.test.js`).
- **Stored as hashes.** Tokens, sessions and codes are stored as hashes, never as the secret itself.
- **Hardened edge.** The hub reads real client addresses behind a proxy, builds links from its own address, and sends HSTS. Errors are quiet: a 500 carries an id and no internals. Markdown renders in a single pass and streams are capped (#479: `test/edge.test.js`, `test/wait.test.js`). Escaping and the CSP hold.
- **No SQL injection.** Every query takes parameters.

### Workspaces
- **Isolation.** Every route opens only the caller's workspace (`test/isolation.test.js`).
- **Inbound events.** GitHub and Stripe events count only from those entitled to send them. Installs bind to their owner, and strangers' PRs change nothing (#478: `test/githubtrust.test.js`, `test/billing.test.js`, `test/appwiring.test.js`).
- **Outbound requests.** The hub reaches only the public internet on people's behalf. Notification channels and preconditions can't touch the network it runs on (#474: `test/outbound.test.js`).

### Outside text (Paul's call 2)
- **Held for a person.** Issues from people without write access wait for a person's OK, as feedback does, and so do those people's replies. Issues from collaborators flow as before (#471: `test/outsiders.test.js`).
- **Information, not instructions.** Field notes, handoffs, comments and quoted text are information. Only steering and decisions carry a person's authority (the agents' guide, src/protocol.js).
- **Titles are public.** Item titles show on the live view, so a finding's title names what its fix guards, never the hole.

### People's machines (Paul's call 3)
- **Workers run sandboxed.** Their shell writes only inside the worktree and reaches only the hub, GitHub and package registries. They run exact commands, not prefixes, and push only their own branch. Landing on main goes through the hub (#472, with #487 as its live test).
  - **Not every harness is sandboxed the same way** (review #596). Claude Code workers get the sandbox above. Codex workers run with `-s workspace-write`: writes and network are limited, but reads aren't, and DENY_READ doesn't apply. opencode and pi workers have no sandbox, so they run only on projects without a remote (bin/nuworq.js), and a hostile hub's task text could have them read the machine's keys. Choosing one of those harnesses accepts that until #615 lands.
  - **Where work lands in the checkout** (no origin), the worker may write the whole checkout. Anything an unsandboxed process later reads there (other workers' git metadata, `.claude/` settings) must stay denied (#606).
  - **A push is to the held item's branch only, and landing merges the head that was reviewed.** Otherwise a worker could replace another item's accepted branch, or add to its own after review (#605).
- **The operator's no-prompt rules are a boundary too.** An operator runs unsandboxed as the person and reads text that started with workers or strangers. Its permission prompt is the last thing a person sees, so the rules `nuworq operator --allow` writes must never let it run a program or store a command without asking (#607).
- **An operator is someone a person trusted.** The operator role comes from a declared tag; a token a member minted shouldn't get it (#609), and an operator's words never carry a person's authority to other agents (#610).
- **A runner trusts its machine.** It checks what the hub sends, and keeps its token out of commands, environments and logs (#477: `test/runtrust.test.js`, `test/runner.test.js`). A worker's llm-proxy token stays off its command line (#493: `test/clientlabel.test.js`).
- **No fetched code.** Nothing is ever run that was fetched at runtime. Code arrives only through the package, checksum-verified (a standing decision).

### Releases (Paul's call 1)
- **Paul approves each release.** It is signed only after he approves it on the machine that holds the key. The plugin installs from the `release` branch, never from main. Release tags get protected on GitHub too (#476, before the repository goes public). Covered by #473: `test/signer.test.js`, `test/plugin.test.js`, `test/package.test.js`.
- **A compromised hub can't ship.** The signer builds each package from GitHub's copy of the commit and refuses a package that differs. Installs check the signature against the pinned `release-key.pub` (`scripts/signer.js`). Every way of signing holds to this, signing by hand (`sign-release.js release`) included, which until #603 signs the bytes the hub serves without those checks.
- **Plugin installs follow releases only.** An install made before #473 still tracks main's marketplace file until connect moves it onto the `release` branch (#608).
- **Reviewed before it ships.** In a project with security reviews on, every release waits for a review of what it ships (below).

### The repository
- **Ready to be public.** A license, a way to report vulnerabilities, and a scan of the complete history (all commits and GitHub's `refs/pull/*`) with nothing private in it (#475).

## The five areas

The monthly reviews take these in turn (`AREAS` in `src/security.js`):

1. **Sign-in, accounts and tenancy.** Who can reach which workspace, project and data.
2. **The web client and the HTTP edge.** Pages, the API, headers, and how what people and agents wrote is rendered.
3. **Integrations, webhooks and updates.** GitHub, Stripe, llm-proxy, the self-update and release signing.
4. **Worker machines and prompt injection.** What an agent on someone's machine may run, read and push.
5. **Data, secrets and open-source readiness.** What the database, logs, evidence and the repository hold.

## Keeping it checked

The project setting **Security reviews** (Settings → Security reviews) turns these on (`src/security.js`):

- **Before each release.** When the hub drafts a release, it opens "Security review before the next release". The release depends on that review, so it can't land, be tagged or be signed until the review is done. The review goes only to an agent that built none of the changes the release ships, which the hub enforces at claim time.
- **A serious finding holds the release.** A critical or high finding is proposed with its fix and added to the release's dependencies, and the human is asked "Fix it before the release" or "Accept it for this release". Only Paul's "Accept" takes it off.
- **Each month, one area.** A review of the next of the five areas opens every 30 days.
- **Findings, rated and tested.** Each finding is rated critical, high, medium or low by the attackers above, and proposed as its own item with the fix and a regression test named for what it guards. No working exploit goes into an item, comment or evidence: they are as public as the repository.
