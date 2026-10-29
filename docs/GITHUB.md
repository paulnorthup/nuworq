# GitHub: one app is the only door to your repositories

The hub holds a GitHub App's private key, and nothing else holds a GitHub credential. When a worker pushes, git asks the hub for a password. The hub then mints an installation token that works for **one repository** (the one the agent's item lands in), with only the permissions work needs, and GitHub expires it **after an hour**. Each mint goes on the item's record: which agent, which item, which repository, until when. The token itself is never stored or shown to the agent.

## 30 seconds

1. In the hub, as an owner: **Connect an agent → Create GitHub App**. Then install the app on the repositories your projects live in.
2. Start workers as usual (`nuworq worker` / `nuworq run`). Pushes over `https://github.com/…` just work.
3. Turn on the ruleset below so that only pull requests change `main`, whoever pushes.

## 5 minutes: set it up

**Create the app in one click.** In the hub's UI, an owner opens **Connect an agent** and clicks **Create GitHub App** (or opens `/api/github/app/new`; add `?org=<name>` to create it in an organization). The page posts GitHub's app manifest, with exactly the permissions below and the hub's webhook and return addresses. Confirm on GitHub, and you're sent back to the hub. The hub trades GitHub's one-time code for the app's id, private key and webhook secret, saves them to `<data dir>/github-app.json` (mode 0600, readable only by the hub's user), and uses the app at once. `serve` picks the file up on every start, with no environment variables. This works on a single hub. With `--workspaces`, the host sets the app up as below.

**Or by hand** (the fallback, and the way for workspaces hubs). On GitHub, go to Settings → Developer settings → **GitHub Apps** → New GitHub App (for an organization: its Settings → Developer settings). Then:
- Name: e.g. `nuworq-<your-org>`. Homepage URL: your hub's public address.
- Webhook: leave it off for now. Pull requests and CI still reach items through each project's webhook (see DEPLOY.md, "GitHub: pull requests and CI on items").
- Repository permissions: **Contents: read & write**, **Pull requests: read & write**, **Checks: read**, **Issues: read & write**, **Metadata: read**. Nothing else, and no account permissions.
- Where can it be installed: *Only on this account*.
- Create it, note the **App ID**, and under *Private keys* generate one (a `.pem` download).

**Install it** (left menu: Install App) on the repositories your projects live in. Choose *Only select repositories*.

**Give the hub the app** (by hand only; environment variables win over the saved file), then restart the hub:
```bash
NUWORQ_GITHUB_APP_ID=123456
NUWORQ_GITHUB_APP_KEY_FILE=/etc/nuworq/github-app.pem   # chmod 600, owned by the hub's user
NUWORQ_GITHUB_APP_SLUG=nuworq-acme                      # its name in github.com/apps/<slug>: install links in errors
```
(`NUWORQ_GITHUB_APP_KEY` takes the PEM itself, if a file doesn't suit.) In the systemd unit, put them in an `EnvironmentFile=` readable only by the hub's user.

**Issues come in as proposals.** In the project's webhook (DEPLOY.md), also tick **Issues** and **Installation repositories**. When the app is installed on a project's repository, each open issue there becomes a proposal linked to it (`look` shows the issue). Pull requests are skipped. After that, every issue opened, reopened or labelled comes in through the webhook. The hub posts one comment on each issue with the item's link, and nothing else goes back to GitHub. Closing an issue drops its item if nobody has started on it; if the work is under way, the item only gets a note. Reopening brings the same item back. To take only some issues, set a label in the project settings (`issue_label`, e.g. `nuworq`); adding that label to an issue later brings it in. `POST /api/p/<project>/github/resync` (an owner or steward) lists the open issues again; ones already in are skipped.

**Workers.** `nuworq worker` sets git's credential helper in the worker's own environment (`GIT_CONFIG_*`, no config file changes) to `nuworq git-credential --as <worker>`. When git pushes to `https://github.com/<owner>/<repo>`, the helper asks the hub for a token for the item that worker holds. It answers only for that item's repository, so a push anywhere else gets nothing. With no checkout of a project on the machine, `nuworq run` and `nuworq worker` clone it over HTTPS into the first folder in `NUWORQ_REPOS` (else beside the repo they start in). The clone uses a read-only token the hub mints for that project's repository (`git-credential --project`, on the record as `credential` with purpose `clone`); without an App they skip the project with the clone command, as before. A clone whose origin is `git@github.com:…` (SSH) uses SSH keys instead; switch it to HTTPS to go through the app: `git remote set-url origin https://github.com/<owner>/<repo>.git`.

## The recommended ruleset on `main`

With the app as the only writer, a ruleset makes sure `main` changes only through a pull request with green checks. That holds even for the app's own tokens, so an agent can push `nuworq/*` branches and open pull requests, but a push to `main` is refused.

Repository → Settings → Rules → **Rulesets** → New branch ruleset:
- Name `main`, Enforcement **Active**, Target: *Include default branch*.
- **Bypass list: empty.** Don't add the app.
- Rules: **Restrict deletions**, **Block force pushes**, **Require a pull request before merging** (1 approval if humans review, 0 if agents do), **Require status checks to pass** (your CI job, e.g. `test`).

**Landing through a pull request.** A hub with the app lands accepted work in GitHub repositories it has no checkout of through a pull request. On accept, the hub opens the PR as the app (head: the item's branch, base: `main`; the body links the item and names its builder, model, reviewer and evidence, plus `Fixes #N` when the item was created with `issue: N`) and turns on auto-merge (squash). The item waits in landing, linked to the PR, and no agent gets a land job for it. When GitHub merges it after the checks pass, the project's `pull_request` webhook marks the item done (a `landed` event naming the PR). Closing the PR unmerged sends the item back to ready with a note. If the branch isn't on origin yet, an agent gets a land job that only pushes it; then the hub opens the PR. If GitHub refuses the PR, the refusal goes on the record (`pr_failed`) and the item becomes an ordinary land job. If auto-merge can't be turned on (it is off in the repository's settings), the PR is still opened, and merging it by hand lands the item the same way. Without the app, workers land by fast-forwarding `main` themselves (`git push origin <branch>:main`), as before.

## 30 minutes: details

- **What a token can do.** Contents write (push branches), pull requests write, checks read and metadata read, on one repository, for one hour. It is minted when git first asks, not at claim time, so claims that never push cost nothing. Git asks on every fetch and push. The same agent, item and repository reuse the token until 5 minutes before it expires: one mint and one event, not one per git command. The reused token is kept in the hub's memory only, never in its database.
- **When there is no token.**
  - The agent holds no item: 409, "claim one, then push".
  - The project isn't on GitHub: the hub says so.
  - The app isn't installed on the repository, was uninstalled, or is suspended: 424, *"The nuworq GitHub App isn't installed on acme/api (or was uninstalled), so the hub can't give out tokens for it"*, with the install link. The refusal goes on the item's record too.
  - A hub without an app answers 404, and the helper steps aside so git uses whatever else is set up.
- **On the record.** Each mint is an event on the item, `credential`, with `{agent, item, repo, expires_at, token}`, where `token` is the name of the agent token that asked (null on a hub without login). Refusals are `credential_refused`.
- **Not yet.** Receiving webhooks through the app instead of per-project secrets: the one-click app registers its webhook address but leaves it off. Signing people in through the app's user authorization isn't done either.
