# GitHub: one app is the only door to your repositories

The hub holds a GitHub App's private key, and nothing else holds a GitHub credential. When a worker pushes, git asks the hub for a password. The hub then mints an installation token that works for **one repository** (the one the agent's item lands in), with only the permissions work needs, and GitHub expires it **after an hour**. Each mint goes on the item's record: which agent, which item, which repository, until when. The token itself is never stored or shown to the agent.

## 30 seconds

1. Create a GitHub App (below), install it on the repositories your projects live in, and give the hub its id and key.
2. Start workers as usual (`nuworq worker` / `nuworq run`). Pushes over `https://github.com/…` just work.
3. Turn on the ruleset below so that only pull requests change `main`, whoever pushes.

## 5 minutes: set it up

**Create the app.** On GitHub, go to Settings → Developer settings → **GitHub Apps** → New GitHub App (for an organization: its Settings → Developer settings). Then:
- Name: e.g. `nuworq-<your-org>`. Homepage URL: your hub's public address.
- Webhook: leave it off for now. Pull requests and CI still reach items through each project's webhook (see DEPLOY.md, "GitHub: pull requests and CI on items").
- Repository permissions: **Contents: read & write**, **Pull requests: read & write**, **Checks: read**, **Issues: read & write**, **Metadata: read**. Nothing else, and no account permissions.
- Where can it be installed: *Only on this account*.
- Create it, note the **App ID**, and under *Private keys* generate one (a `.pem` download).

**Install it** (left menu: Install App) on the repositories your projects live in. Choose *Only select repositories*.

**Give the hub the app**, then restart the hub:
```bash
NUWORQ_GITHUB_APP_ID=123456
NUWORQ_GITHUB_APP_KEY_FILE=/etc/nuworq/github-app.pem   # chmod 600, owned by the hub's user
NUWORQ_GITHUB_APP_SLUG=nuworq-acme                      # its name in github.com/apps/<slug>: install links in errors
```
(`NUWORQ_GITHUB_APP_KEY` takes the PEM itself, if a file doesn't suit.) In the systemd unit, put them in an `EnvironmentFile=` readable only by the hub's user.

**Workers.** `nuworq worker` sets git's credential helper in the worker's own environment (`GIT_CONFIG_*`, no config file changes) to `nuworq git-credential --as <worker>`. When git pushes to `https://github.com/<owner>/<repo>`, the helper asks the hub for a token for the item that worker holds. It answers only for that item's repository, so a push anywhere else gets nothing. A clone whose origin is `git@github.com:…` (SSH) uses SSH keys instead; switch it to HTTPS to go through the app: `git remote set-url origin https://github.com/<owner>/<repo>.git`.

## The recommended ruleset on `main`

With the app as the only writer, a ruleset makes sure `main` changes only through a pull request with green checks. That holds even for the app's own tokens, so an agent can push `nuworq/*` branches and open pull requests, but a push to `main` is refused.

Repository → Settings → Rules → **Rulesets** → New branch ruleset:
- Name `main`, Enforcement **Active**, Target: *Include default branch*.
- **Bypass list: empty.** Don't add the app.
- Rules: **Restrict deletions**, **Block force pushes**, **Require a pull request before merging** (1 approval if humans review, 0 if agents do), **Require status checks to pass** (your CI job, e.g. `test`).

With this on, landing goes through GitHub: the lander opens or updates the pull request, and merging it (by a person, or by auto-merge once checks pass) puts the work on `main`. The hub sees `main` contains the branch and marks the item done. Without the ruleset, workers land by fast-forwarding `main` themselves (`git push origin <branch>:main`), as before.

## 30 minutes: details

- **What a token can do.** Contents write (push branches), pull requests write, checks read and metadata read, on one repository, for one hour. It is minted when git asks (at the first push of a session, then again after it expires). It isn't minted at claim time, so claims that never push cost nothing.
- **When there is no token.**
  - The agent holds no item: 409, "claim one, then push".
  - The project isn't on GitHub: the hub says so.
  - The app isn't installed on the repository, was uninstalled, or is suspended: 424, *"The nuworq GitHub App isn't installed on acme/api (or was uninstalled), so the hub can't give out tokens for it"*, with the install link. The refusal goes on the item's record too.
  - A hub without an app answers 404, and the helper steps aside so git uses whatever else is set up.
- **On the record.** Each mint is an event on the item, `credential`, with `{agent, item, repo, expires_at, token}`, where `token` is the name of the agent token that asked (null on a hub without login). Refusals are `credential_refused`.
- **Not yet.** Creating the app through GitHub's app-manifest flow from the hub's own page (one click per self-hosted hub), receiving webhooks through the app instead of per-project secrets, and signing people in through the app's user authorization. Today the app is created by hand as above.
