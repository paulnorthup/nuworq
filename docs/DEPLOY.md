# Deploying nuworq

## 30 seconds: which setup?

| You want… | Do this | Login |
|---|---|---|
| Just you, on this machine | `nuworq serve` | none (loopback only) |
| **Homelab: your devices and agents, anywhere you are** | VM + Tailscale ([below](#homelab-vm--tailscale-recommended)) | tokens |
| Homelab, LAN only | VM + `--host 0.0.0.0` | tokens |
| The open internet | VM + Caddy (HTTPS) + `--trust-proxy` | tokens |

One rule: **nuworq only skips login on 127.0.0.1.** Bind anything else, or pass `--auth`, and it needs tokens. It won't start until a human token exists.

Two kinds of token:
- **human**: logs in to the web UI; can do everything.
- **agent**: goes in an agent's `NUWORQ_TOKEN`; can only check in, claim, report, ask and submit.

---

## 5 minutes: the setups

### Homelab VM + Tailscale (recommended)
Nothing is exposed to the internet. Your laptop, phone and agent machines reach the hub over your tailnet with HTTPS.

```bash
# on the VM (Node 24+), from the nuworq folder
node bin/nuworq.js token create paul --role human        # copy it; shown once
node bin/nuworq.js serve --auth --trust-proxy             # listens on 127.0.0.1:4747
tailscale serve --bg 4747                                  # https://<vm>.<tailnet>.ts.net
```
Keep it running with [deploy/nuworq.service](../deploy/nuworq.service) (systemd) or [deploy/docker-compose.yml](../deploy/docker-compose.yml).

### LAN only, no proxy
```bash
node bin/nuworq.js token create paul --role human
node bin/nuworq.js serve --host 0.0.0.0                   # login required automatically
```
Tokens and session cookies travel in plain HTTP on your LAN. That's fine on a home network you trust; otherwise use Tailscale or Caddy.

### Open internet: Caddy + HTTPS
1. Point a DNS name at the VM. Open ports 80 and 443 only; never 4747.
2. Run nuworq on loopback with `--auth --trust-proxy`. The systemd unit already does this.
3. Edit the name in [deploy/Caddyfile](../deploy/Caddyfile) and run Caddy. It gets the certificate and adds HSTS.

`--trust-proxy` makes nuworq believe `X-Forwarded-For/-Proto/-Host`. Use it **only** when a proxy you control is the sole way in. Otherwise anyone can claim to be on HTTPS, or spoof an IP to dodge the login rate limit.

### Docker
```bash
docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml run --rm nuworq node bin/nuworq.js token create paul --role human
docker compose -f deploy/docker-compose.yml run --rm nuworq node bin/nuworq.js token create claude-laptop --role agent
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml ps        # "healthy" after the first check, within ~30s
```
- Create the human token before `up`: in the container login is always required, and without a human token the hub exits (and `restart` keeps retrying).
- The container runs as non-root, read-only, with all capabilities dropped.
- Data and tokens live in the `nuworq-data` volume, so they survive `down` and `up`. `down -v` deletes them.
- The port is published on host loopback; edit `ports` for LAN access. If a hub already runs on this machine at 4747, publish another host port, e.g. `"127.0.0.1:4757:4747"`.
- Token commands run in a one-off container against the volume. `run` doesn't publish ports, so it works while the hub is up.

### Many workspaces on one hub
One process can serve several companies or teams. Each **workspace** has its own SQLite file (`<data-dir>/workspaces/<name>.db`), with its own projects, tokens and sessions. Nothing is shared, and exporting or deleting a workspace is one file.
```bash
nuworq workspace create acme                            # creates ~/.nuworq/workspaces/acme.db
nuworq token create paul --role human --workspace acme  # tokens belong to one workspace
nuworq serve --workspaces --base-domain nuworq.example.com --host 127.0.0.1 --auth --trust-proxy
```
- **Subdomains**: with `--base-domain nuworq.example.com` and wildcard DNS (`*.nuworq.example.com`) plus a wildcard certificate at the proxy, `acme.nuworq.example.com` is the acme workspace.
- **No wildcard DNS?** Every workspace is also at `https://<host>/w/<name>/`. Agents use that as their `NUWORQ_URL` (e.g. `https://nuworq.example.com/w/acme`), and the session cookie is limited to that path.
- Login is always required in this mode, even on loopback. An unknown workspace gets a 404; an address that names none is the hub itself (see Organizations, under sign-in).
- `nuworq workspace list`, and `nuworq workspace remove <name>` (it deletes the file; a running hub stops serving it at once). `--data-dir` or `NUWORQ_DATA_DIR` moves the folder.
- Without `--workspaces`, nothing changes: one database, as above.

### From one hub to workspaces
A hub that already runs as one database (its projects, items, history, people and every agent, runner and human token) becomes one workspace, and nothing is lost. Do it on the hub host, as the hub's user:
1. Stop the hub, so nothing writes while it's copied: `sudo systemctl stop nuworq` (or Ctrl-C). Check: `curl -s https://<your host>/api/health` no longer answers.
2. Adopt the database as a workspace, here named `main`: `nuworq workspace adopt main` (add `--db <file>` if the database isn't at the default `~/.nuworq/nuworq.db`, and the same `--data-dir` the hub uses). It copies the database to `<data-dir>/workspaces/main.db`, writes a dated copy beside the original (`nuworq.db.before-workspaces-<time>`), and leaves the original untouched. It refuses a name that exists or is reserved (www, api, app, admin, w, static, login, auth, hub). Check: `nuworq workspace list` shows `main`.
   If the hub has a GitHub App (`NUWORQ_GITHUB_APP_*` in its environment, or `<data-dir>/github-app.json`), adopt also binds every installation of it to `main` and names them (`Bound GitHub App installation 12345678 to main`). On a hub of workspaces, the app's webhook deliveries reach only the workspace their installation is bound to, so an unbound one is dropped. Run adopt as the hub's user with the same app settings the hub has: the same `--data-dir`, and the `NUWORQ_GITHUB_APP_*` variables from the systemd unit's `Environment=` or `EnvironmentFile=` (`systemctl cat nuworq` shows them). If it says it couldn't list the installations, or there was no app, bind each one yourself: `nuworq workspace bind-installation <id> main`. The id is the number at the end of the installation's page on GitHub: Settings → Applications → Installed GitHub Apps → *Configure*, e.g. `https://github.com/settings/installations/12345678` (for an organization, `https://github.com/organizations/<org>/settings/installations/<id>`). An installation already bound to another workspace stays there; adopt says so.
3. Start the hub with `--workspaces` added to its usual flags (in the systemd unit's `ExecStart`, then `sudo systemctl daemon-reload && sudo systemctl start nuworq`). Check: `https://<your host>/w/main/` shows your projects after you sign in.
4. If the hub has a GitHub App, set its **Setup URL** to the workspace hub's install route: in GitHub, Settings → Developer settings → GitHub Apps → your app → *General*, *Setup URL* `https://<your host>/api/github/installed` (not `https://<your host>/#/`, the single hub's), with *Redirect on update* ticked, then *Save changes*. Installs started from a workspace (`/w/<name>/api/github/install`) come back there and are bound to it; see [GITHUB.md](GITHUB.md) for the client id and secret that check needs. Check that deliveries arrive: open an issue on a repository a project is linked to, e.g. `gh issue create -R <owner>/<repo> -t "nuworq webhook check" -b ""`. Within a minute it shows as a proposal in that project at `https://<your host>/w/main/`, and the app's *Advanced* tab lists the delivery with a 200. Close the issue after (`gh issue close <n> -R <owner>/<repo>`) and drop the proposal.

What keeps working, with nobody editing anything:
- **Agents, runners and the CLI** saved the hub's root address (connect.json, MCP config, `NUWORQ_URL`). A request there that carries a token is served by the adopted workspace in place: no redirect, so a token never goes to another host. The token is checked against that workspace only, and its scope and powers hold as before.
- **People** who had an email on the hub become members of the workspace, so the owner finds it when signing in at the hub's address. Workspaces are listed there, and `/api/orgs/main/enter` signs them in.
- **Old links** like `https://<your host>/#/p/<project>/<n>` open the hub's own page, which sends them on to `/w/main/#/p/<project>/<n>` (it asks `GET /api/root`).

To undo it, stop the hub, start it again without `--workspaces`: it reads the original database, which still has everything up to the switch. Work done after the switch is in `workspaces/main.db` only.

### Sign in with GitHub or Google
People can sign in with an account they already have instead of pasting a token. The login page shows a button for each provider the hub host configures; with none, it is unchanged.
1. Pick the hub's public address, e.g. `https://nuworq.example.com`, and start the hub with `--public-url` set to it (`NUWORQ_PUBLIC_URL`). The callback lives there, at `/auth/<provider>/callback`, whichever workspace someone signs in to, so one app serves every workspace.
2. **GitHub**: Settings → Developer settings → **OAuth Apps** → New OAuth App. Homepage URL: your public address. Authorization callback URL: `https://nuworq.example.com/auth/github/callback`. Generate a client secret.
3. **Google**: Google Cloud console → APIs & Services → **Credentials** → Create credentials → OAuth client ID → *Web application*. Authorized redirect URI: `https://nuworq.example.com/auth/google/callback`. The consent screen needs only the `openid` and `email` scopes.
4. Give the hub the ids and secrets, then restart it:
   ```bash
   NUWORQ_GITHUB_CLIENT_ID=… NUWORQ_GITHUB_CLIENT_SECRET=…
   NUWORQ_GOOGLE_CLIENT_ID=… NUWORQ_GOOGLE_CLIENT_SECRET=…
   ```
   (in the systemd unit, an `EnvironmentFile=` readable only by the hub's user).
5. With an admin host (`--admin-host`, see [The admin host](#the-admin-host-owners-only)), it signs in on its own address, so each provider needs its callback too. See that section for the exact URLs.

Who gets in: the hub asks the provider for a **verified** email (GitHub: the primary verified one; Google: `email_verified`). It signs in the person with that email (`nuworq person add bea --role steward --email bea@example.com`), or uses an open invite bound to that email (`invite create --email`), creating the person with the invite's role. Anyone else is told to ask an owner for an invite. Who someone is comes only from how they signed in: an email a workspace owner types for a person (`POST /api/people`), or one an invite link carries, is a hint for matching their first sign-in, never their identity. It makes no hub membership, so it can't give a workspace the hub owners' unlimited plan or their pushes. A role an owner typed for an email takes effect when an invite bound to it is used; otherwise that person's first sign-in makes them a viewer, and an owner confirms the role with `POST /api/people/role`. The host's own `nuworq person add --email` vouches for the email. A person exists per workspace, so a member of acme can't sign in to globex. The flow uses a signed, 10-minute state bound to the browser by a cookie, and PKCE; the provider's access token is used once and never stored. Token login keeps working.

**Organizations (with `--workspaces`).** People can also sign in to the hub itself, at the address that names no workspace (the base domain, the `--public-url` host, or `/` without subdomains): `/auth/<provider>/start` with no `ws`. There, `GET /api/me` lists their organizations (workspaces where a person has their verified email) with role, address and an `enter` link that signs them in there in one click. `POST /api/orgs {name, slug}` creates a workspace with them as its owner. Each person may create up to 5 (`--workspace-cap`, `NUWORQ_WORKSPACE_CAP`; the older `--org-cap` and `NUWORQ_ORG_CAP` still work). The hub keeps who-belongs-where in `<data-dir>/workspaces/directory.sqlite` and checks it against each workspace's people on every read, so role changes and removals show at once. Reserved names: www, api, app, admin, w, static, login, auth, hub.

### Connecting agents to a remote hub
On the agent's machine, two lines with the hub's public address (the hub's "Connect an agent" dialog gives them ready to copy):
```bash
npm install -g https://nuworq.example.com/nuworq.tgz   # the package of the commit the hub runs
nuworq connect https://nuworq.example.com              # a workspace: its /w/<slug> address
```
`connect` logs in through the browser, gives the machine its own agent token, and registers `nuworq mcp` with Claude Code, Codex and opencode. A hub that serves no package (`/api/info` has `package: null`, e.g. an older version) still works from a checkout of nuworq: `node bin/nuworq.js connect <url>`.

By hand instead, create one agent token per machine or agent, so you can revoke them one at a time:
```bash
node bin/nuworq.js token create claude-laptop          # on the hub's host; role defaults to agent
```
Then give the agent `NUWORQ_URL` and `NUWORQ_TOKEN`, e.g. `claude mcp add nuworq -e NUWORQ_URL=https://nuworq.example.com -e NUWORQ_TOKEN=nwq_… -- nuworq mcp`. Codex, opencode and the plain CLI read the same two variables.

### GitHub: pull requests and CI on items
A signed webhook links pull requests to items and shows CI results on them. When CI fails on work in Verifying, it lands under "Needs you" (and gets pushed, if you set up [notifications](../README.md#getting-pinged-ntfy-slack-or-any-webhook)).
1. In the project (5m view, top right): **Settings**, then **Connect GitHub**. Generate a secret, copy it, and save.
2. In the repo on GitHub: **Settings → Webhooks → Add webhook**:
   - Payload URL: `https://<your hub>/api/hooks/github/<project>` (the dialog shows it)
   - Content type: `application/json`
   - Secret: the one from step 1
   - Events: *Pull requests*, *Check suites*, *Check runs*, *Statuses* (and *Dependabot alerts*, so alerts come in as items)
   - With the GitHub App instead (docs/GITHUB.md), nothing here: its permissions are Contents (read & write), Pull requests (read & write), Checks (read), Issues (read & write), Dependabot alerts (read) and Metadata (read), and its webhook carries Issues, Issue comment, Pull request, Pull request review, Check suite, Check run and Dependabot alert.
3. GitHub sends a `ping`. "Recent Deliveries" should show 200.

How a PR finds its item: `#N` in the PR title first. Then the branch: on `nuworq/<agent>`, it's the item that agent holds, or the one it last submitted. Then `#N` in the PR body. A PR that matches nothing is acknowledged and ignored. Later events for a linked PR (pushes, merge, close) follow it. CI is summarised per head commit: any failed check means failing, all green means passing. Only changes of state go on the item's timeline.

GitHub must be able to reach the hub:
- **Public hub (Caddy):** nothing more to do.
- **Tailscale:** `tailscale serve` is tailnet-only, and GitHub isn't on your tailnet. Expose only the hook path with Funnel, e.g. `tailscale funnel --bg --set-path /api/hooks/github http://127.0.0.1:4747/api/hooks/github` (not yet tried end to end: check that GitHub's ping returns 200).
- **Any tunnel (ngrok, cloudflared) to a loopback hub:** the hook route answers under any host name. Every other route still refuses non-loopback hosts unless login is on.

Deliveries need no token: the HMAC-SHA256 signature (`X-Hub-Signature-256`) is the credential. A missing or wrong signature, an unknown project, or a project without a secret all get the same 401, and nothing is recorded.

---

## 30 minutes: details

### Public HTTPS with a Cloudflare Tunnel (as run for nuworq.com)
No open ports, and Cloudflare provides the certificate. The hub listens on loopback with login, and trusts the tunnel's `X-Forwarded-Proto`, so session cookies are `Secure`:
```bash
cloudflared tunnel login                         # once, as root: open the link, pick the zone
cloudflared tunnel create nuworq
cloudflared tunnel route dns nuworq app.nuworq.com   # the app; nuworq.com itself is served from the nuworq-site repo, not the hub
cloudflared tunnel route dns nuworq admin.nuworq.com # the owners' dashboard (--admin-host)
install -d -m 700 /etc/cloudflared && install -m 600 ~/.cloudflared/<tunnel-id>.json /etc/cloudflared/
cat > /etc/cloudflared/config.yml <<EOF
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  - hostname: app.nuworq.com
    service: http://127.0.0.1:4747
  - hostname: admin.nuworq.com
    service: http://127.0.0.1:4747
  - service: http_status:404
EOF
cloudflared tunnel ingress validate && cloudflared service install && systemctl enable --now cloudflared
```
The hub, as nuworq.com runs it (since 2026-10-31, #205): `deploy/nuworq.service` with signups on. Its `ExecStart`:
```
/usr/local/bin/node /opt/nuworq/bin/nuworq.js serve --follow --host 127.0.0.1 --port 4747 \
  --db /var/lib/nuworq/nuworq.db --auth --trust-proxy --public-url https://app.nuworq.com --site-host nuworq.com \
  --workspaces --early-access --admin-host admin.nuworq.com
```
`--site-host` is left from before nuworq.com moved to nuworq-site; the hub now ignores it with one line at start (#164), and it can go at the next unit change.
Its environment comes from drop-ins in `/etc/systemd/system/nuworq.service.d/`. The files they load are root-only (`chmod 600`), and their values never go in an item or a commit:
```ini
# github-oauth.conf: GitHub sign-in. The OAuth App matches callbacks exactly (subdomains don't match),
# so each sign-in host's is registered, all three:
#   https://nuworq.com/auth/github/callback
#   https://app.nuworq.com/auth/github/callback
#   https://admin.nuworq.com/auth/github/callback
# The file holds NUWORQ_GITHUB_CLIENT_ID=… and NUWORQ_GITHUB_CLIENT_SECRET=…
[Service]
EnvironmentFile=/etc/nuworq/github-oauth.env

# signups.conf: who owns the hub, and the request form's spam check.
# The file holds NUWORQ_TURNSTILE_SITEKEY=… and NUWORQ_TURNSTILE_SECRET=… (a Managed widget for app.nuworq.com)
[Service]
Environment=NUWORQ_HUB_OWNERS=owner@example.com
EnvironmentFile=/etc/nuworq/turnstile.env

# llm-proxy.conf: usage measured by llm-proxy for workers whose model traffic goes through it (#346).
# The file holds NUWORQ_LLM_PROXY_URL=… (llm-proxy's public hostname, https), NUWORQ_LLM_PROXY_KEY=…
# (a key that may read request history), and, because that hostname sits behind Cloudflare Access,
# NUWORQ_LLM_PROXY_ACCESS_ID=… and NUWORQ_LLM_PROXY_ACCESS_SECRET=… (a service token, llm-proxy docs/API.md)
[Service]
EnvironmentFile=/etc/nuworq/llm-proxy.env
```
Check llm-proxy from the hub host, with the file's values loaded: `curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $NUWORQ_LLM_PROXY_KEY" -H "CF-Access-Client-Id: $NUWORQ_LLM_PROXY_ACCESS_ID" -H "CF-Access-Client-Secret: $NUWORQ_LLM_PROXY_ACCESS_SECRET" "$NUWORQ_LLM_PROXY_URL/_/api/requests?client=x&from=0&to=1"` prints `200`. A `302` means Access refused the service token, `401`/`403` the key. On the hub, the project's events say "Usage from llm-proxy is off: <why>" until it answers, and "Usage now comes from llm-proxy" once it does; an item a worker went through the proxy for then lists usage with source `llm-proxy`.

Workers reach llm-proxy another way, with other credentials, on the machine that runs them. On its public hostname, provider routes answer 403. So `nuworq run --agent claude --proxy <url>` (Claude Code, through `/anthropic`) and `--agent codex --proxy <url>` (Codex, through `/openai/v1`, the Responses API) need llm-proxy's LAN or tailnet address (e.g. `http://studio.local:4100`, a `.ts.net` name or a `100.x` address; a public hostname is refused before the worker starts), and its owner token in `NUWORQ_LLM_PROXY_TOKEN` in the runner's environment. That token spends money: keep it off the hub. Workers send no Access token. `--agent opencode --model proxy/<model>` goes to `/v1` with a personal key in `NUWORQ_LLM_PROXY_KEY`. Every worker labels its traffic `x-client-name: nuworq/<project>/<agent>`, which is how the hub's read-only key finds it.
The single hub's database became the workspace `main` (`nuworq workspace adopt main --db /var/lib/nuworq/nuworq.db --data-dir /var/lib/nuworq`, see "From one hub to workspaces"). Agents and runners kept their saved address `https://app.nuworq.com`. `--db` stays in `ExecStart` so that undoing it is only a matter of removing the three flags. Backups from the switch: `/var/lib/nuworq/before-205.db`, `/root/nuworq.service.before-205`, `/root/nuworq.service.d.before-205/`, `/root/cloudflared-config.before-205.yml`.
Verified: a valid certificate, 401 without login, a `Secure` session cookie, and the live stream (`/api/stream`) arriving unbuffered through Cloudflare.

**The app on its own host; nuworq.com is not the hub's.** The hub lives at `--public-url https://app.nuworq.com`, and only the app's hostnames route to it. nuworq.com is served from the nuworq-site repo (Cloudflare Pages), which sends app paths (`/api/…`, `/login.html`, `/auth/…`, `/w/…`, `/agents.md`, and old `#/p/<slug>/12` links) on to the app with a `308`. Every link the hub builds uses the public URL. The site's early-access form calls the app cross-origin: `GET /api/early-access/config` and `POST /api/early-access` answer the public URL's parent domain over https (`https://nuworq.com` for `app.nuworq.com`, and only it) with `Access-Control-Allow-Origin`, without credentials. No flag is needed for it. Check: `curl -si -H 'Origin: https://nuworq.com' https://app.nuworq.com/api/early-access/config | grep -i access-control` shows `access-control-allow-origin: https://nuworq.com`.

**Moving a running hub to a new address.** A redirect is for browsers. A client following one to another host drops its `Authorization` header (Node's fetch does, as the Fetch standard says), and GitHub doesn't follow redirects at all. So when the hub's address moves (as it did from nuworq.com to app.nuworq.com):
1. Route the new host first (DNS and tunnel entry above). Check: `curl -s https://app.nuworq.com/api/health` answers `200`.
2. Point the GitHub App at the new host: on its settings page (`https://github.com/settings/apps/<slug>`, General), set Webhook URL to `https://app.nuworq.com/api/hooks/github-app` and Setup URL to `https://app.nuworq.com/#/`, then Save changes. (The hub never uses the App's Callback URL; leave it.) The webhook URL can also be set with the App's own key: `PATCH /app/hook/config` with `{"url": …}`. Check: Advanced → Recent Deliveries → Redeliver the last one answers `200`.
3. Restart the hub with `--public-url https://app.nuworq.com`. Check: `curl -s https://app.nuworq.com/api/health` shows `"url": "https://app.nuworq.com"`.
4. On each machine with agents: `nuworq connect https://app.nuworq.com` (or set `"url"` in `~/.nuworq/connect.json`), then restart its `nuworq run` and MCP sessions. Until then they get `401`s.

Undo: restart the hub with the old `--public-url`.

**A GitHub App made before its hub was reachable hears nothing.** The one-click app asks GitHub for its events and turns its webhook on only when the hub's address is public (docs/GITHUB.md). One made while the hub was on localhost or a private address has no events, its webhook may be off, and an older one also lacks the Dependabot alerts permission. GitHub then sends it only pings and installation events: issues don't come in, reviews and CI results go unseen, and Dependabot alerts never become items. Landing still works, because the hub's sweep looks at landing pull requests itself.
- Check, on the hub host, with the App's own key: `GET /app` (any script that signs a JWT with the App's key, e.g. a 10-line `node` one). Its `events` must list `issues`, `issue_comment`, `pull_request`, `pull_request_review`, `check_suite`, `check_run` and `dependabot_alert`, and its `permissions` must include `vulnerability_alerts: read`. `GET /app/installations` shows the same for each installation.
- Fix: GitHub only lets a person change these, on the App's settings pages.
  1. Open `https://github.com/settings/apps/<slug>` (General). Under Webhook, tick **Active** and check the URL is `https://<hub>/api/hooks/github-app`. Click **Save changes** if you changed anything.
  2. Open `https://github.com/settings/apps/<slug>/permissions`. Under Repository permissions, set **Dependabot alerts** to Read-only.
  3. On the same page, under Subscribe to events, tick **Check run**, **Check suite**, **Dependabot alert**, **Issue comment**, **Issues**, **Pull request** and **Pull request review**. *Dependabot alert* appears only after step 2. Click **Save changes**, and confirm the permission change.
  4. Each installation has to accept the new permission. Open `https://github.com/settings/installations/<id>` (or `https://github.com/organizations/<org>/settings/installations/<id>`), then click **Review request** and **Accept new permissions**.
  5. Check: `GET /app` lists the seven events. Advanced → Recent Deliveries shows `pull_request` and `check_suite` deliveries answered `200` after the next push to a pull request. An issue opened on a linked repository appears on the hub as a proposal within a minute.
  A `200` alone doesn't prove the hub took a delivery: open it and read the response. `"projects": [{ "project": "<slug>", … }]` means it reached the project. `"projects": []` means it reached none. On a hub of workspaces, that is an installation bound to no workspace: bind it (`nuworq workspace bind-installation <id> <workspace>`, see adopt above), then click **Redeliver** on the delivery.

### Keeping a server up to date: it pulls, nothing pushes to it
`serve --follow` (the systemd unit uses it) fetches `main` from GitHub every 30 seconds and fast-forwards to it. It tests each new commit in a second worktree and moves the hub onto it only if the tests pass. If the new hub doesn't come up healthy, it rolls back. No CI job reaches into your network, and the server only needs read access:
```bash
# on the server, as the hub's user
sudo -u nuworq ssh-keygen -t ed25519 -N "" -C "nuworq server (read-only)" -f /var/lib/nuworq/.ssh/id_ed25519
ssh-keyscan -t ed25519 github.com | sudo -u nuworq tee /var/lib/nuworq/.ssh/known_hosts
#   check: ssh-keygen -lf /var/lib/nuworq/.ssh/known_hosts shows GitHub's published
#   SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU
# then add the .pub to the repo as a deploy key, read-only:
gh repo deploy-key add id_ed25519.pub --repo <owner>/<repo> --title "nuworq server (read-only)"
```
If `main` fails its tests, the hub stays on the last good commit and files one "main fails its tests" item at priority `now`, so the next agent fixes it first.

**With the hub's GitHub App installed on a project's repository, it needs no deploy key**: the hub fetches its mirror with the app's read-only token ([GITHUB.md](GITHUB.md)). Deploy keys are for hubs without an app, and for repositories the app isn't installed on.

**Without the app, each further project's repository needs its own deploy key.** GitHub accepts a deploy key on one repository only, so the key above reads nuworq's repository and nothing else. For projects the hub has no checkout of, it keeps mirrors in `<data dir>/repos`, and it fetches each one with a key of its own when a private key file exists at `<data dir>/keys/<host>/<owner>/<repo>`. Without that file it uses the default key, as before, and a `GIT_SSH_COMMAND` set for the hub still wins over both. For `github.com/acme/api` on the unit above (data dir `/var/lib/nuworq`):
```bash
sudo -u nuworq mkdir -p -m 700 /var/lib/nuworq/keys/github.com/acme
sudo -u nuworq ssh-keygen -t ed25519 -N "" -C "nuworq hub: acme/api (read-only)" -f /var/lib/nuworq/keys/github.com/acme/api
gh repo deploy-key add api.pub --repo acme/api --title "nuworq hub (read-only)"   # the .pub written beside it
```
No restart is needed: the next fetch uses it. In workspaces mode each workspace has its own folder, `keys/<workspace>/<host>/<owner>/<repo>`, as it does for mirrors.

The supervisor itself keeps running the code it started with. When a move changes that code (`bin/nuworq.js`, `src/follow.js` or a module they import), under systemd it stops the hub and exits with code 75, and `Restart=on-failure` starts it again on the new code. In a terminal it logs one line asking you to restart `serve --follow`. This only works if the supervisor runs from a path the move updates: the unit runs `/opt/nuworq/bin/nuworq.js`, the checkout `--follow` fast-forwards. Don't point `ExecStart` at a copy elsewhere, or a restart brings back the old supervisor.

### Signed releases: how installed copies update themselves
A machine that installed nuworq from the hub (`npm install -g https://<hub>/nuworq.tgz`, public: no login) checks the hub at most every 10 minutes, when a command or an MCP server starts. It asks the hub's root, whichever workspace it connected to, at `GET /api/package`: public too, since `/api/info` needs a sign-in on most hubs. That names the package of the commit the hub runs (`commit`, `sha256`, `signed`) and `release`: the newest package the hub keeps in `<data dir>/package/` that carries a valid signature (newest by its signed commit time), served by commit at `/nuworq-<full commit>.tgz` and `.tgz.sig`. That is what installs update to, so a release reaches them however many times main has moved on since. With no signed release, the running package isn't one: the install stays as it is, downloads nothing and prints nothing. It updates only to a package signed by the release key whose public half, `release-key.pub`, shipped in the copy it already has. A sha256 from the hub only proves a download isn't corrupted. The signature is what stops a compromised hub, tunnel or DNS from shipping code. A package with tampered bytes, a missing or foreign signature, or a different `release-key.pub` is refused, and the installed version keeps running. What gets signed is the whole package file (ed25519 over its bytes). That includes `src/commit.txt`, which `git archive` fills with the commit and its committer time (`%H %ct`). So the signature also covers when a release was made. An update must be the commit the hub named, and its signed time must be later than the installed copy's own. An older or same-time release is refused even when validly signed, so a compromised hub can't roll machines back to a release with known bugs. A package that carries no time is refused too. The one exception is an install from before times were recorded: it takes its first timed release, then orders them. If `npm install` fails, the command offered to run by hand installs the verified file the update saved (`npm install -g <update dir>/nuworq-<commit>.tgz`), never a fresh download. `nuworq update` checks now and says what happened. An update made in the background (an MCP server or the operator's listener starting) is said once: the next command a person runs prints `nuworq updated 0.3.0 → 0.4.0:` and up to 10 of its changelog lines on stderr, and the MCP server's next `checkin` carries `updated: { from, to, changes }`. `nuworq changes` prints the installed version's changelog lines again. Updates are off without a pinned key, in a git checkout, with `NUWORQ_NO_UPDATE=1`, and for a plain-http hub that isn't on the same machine.

The private key never goes on the hub. Where the key lives:
```bash
mkdir -m 700 ~/.nuworq-release
node scripts/sign-release.js keygen ~/.nuworq-release   # once: release-key.pem (keep it to yourself) + release-key.pub
cp ~/.nuworq-release/release-key.pub release-key.pub && git add release-key.pub   # commit it: packages pin it from then on
# each release: sign the package of the commit the hub runs now
node scripts/sign-release.js release https://<hub> ~/.nuworq-release/release-key.pem <ssh host>:/var/lib/nuworq/package/
```
`release` signs only what installs will take. It fetches the package the hub serves, checks it is the `sha256` and commit `/api/package` names and that it carries this key's `release-key.pub`, and writes `nuworq-<commit>.tgz.sig`. It then copies that beside the hub's package with scp and checks `/api/package` says `"signed": true`. Leave out the destination to only write the file. You don't have to catch the hub before the next landing: it keeps naming that release in `package.release` after main moves on, and installs take it at their next check if it is newer than what they run. To release an older commit the hub has run, sign its package by hand: `curl -o nuworq.tgz https://<hub>/nuworq-<full commit>.tgz` (404: the hub never ran it and it isn't a tagged release; check `shasum -a 256 nuworq.tgz` against the response's ETag), `node scripts/sign-release.js sign nuworq.tgz <release-key.pem>`, then scp `nuworq.tgz.sig` to `<data dir>/package/nuworq-<full commit>.tgz.sig`. The hub checks each signature against the `release-key.pub` of the commit it runs and ignores a `.sig` that doesn't verify. Copies installed before #254 only follow the package of the commit the hub runs, so they take the first release signed while the hub runs it; from then on they follow `package.release`. Rotating the key takes a reinstall by hand.

#### The signer: releases sign themselves where the key lives
Signing by hand is the last manual step of a release, and agents can't take it over: no session should read the key. Instead, a small service on the machine that holds the key signs each release on its own. Install it once, from a checkout of nuworq on that machine:
```bash
node scripts/sign-release.js watch https://<hub> ~/.nuworq-release/release-key.pem <ssh host>:/var/lib/nuworq/package/ --install
```
Check: it prints `Installed the release signer as a LaunchAgent, and it is up` (a systemd user unit on Linux), and `~/.nuworq/logs/signer.log` gets a line within a minute. Every 5 minutes it fetches origin's main and tags (into `refs/signer/*`, so the checkout's own branches and tags stay as they are). It then signs each `vX.Y.Z` tag the hub doesn't yet serve as its signed release, but only when all of these hold: the tagged commit is on origin's main, its `package.json` says X.Y.Z, its `CHANGELOG.md` begins with that version, its `release-key.pub` is the key's public half, and it is newer than the hub's signed release (by version and commit time), so it never rolls installs back. It builds the package from the tagged commit with `git archive`, exactly as the hub does, and signs those bytes (when the hub's git gzips the same archive differently, it signs the hub's file, but only if its tar is GitHub's build byte for byte). It copies `nuworq-<commit>.tgz.sig` beside the hub's package with scp, and checks that `/api/package` now names that commit as its release. It never signs an untagged commit, nor whatever the hub happens to serve. While the hub has no package of the tagged commit yet, it waits. The hub builds the commits it runs, and also builds a release it skipped (main moved past it, or its tests failed there) when asked for `/nuworq-<full commit>.tgz`: any commit with a `vX.Y.Z` tag in its checkout, on the history it runs. So a skipped release is signed once the hub's checkout has fetched the tag; the log says when the hub skipped one. A failed scp is tried again the next round. The scp destination must work without a prompt (a key in `~/.ssh` or ssh-agent): it runs with `BatchMode=yes`. Each refusal is logged once, when it first appears; a round with nothing new logs one line. When it signs, it comments `Signed v0.3.0 (6373061)` on the release item, if the machine is connected to the hub (`nuworq connect`).

An `ALARM` line in the log means the hub's own package of a release isn't GitHub's build of it, or the hub ignored the signature after the copy (it runs a different `release-key.pub`, or the destination isn't its package folder). That is what a compromised hub would look like. The signer doesn't copy a signature for it, and never tries that release again (the alarms are kept in `~/.nuworq/signer.json`). Find out why before signing it by hand.

What a signature means with the signer: a tagged release on GitHub's main, built from GitHub. It still stops a compromised hub, tunnel or DNS from shipping code: the hub serves a signature only if its own package file is those very bytes. It no longer means a person looked at the release; the release item's review is that look. The key never leaves the machine: the signer reads it there, and only the `.sig` is copied.

Pause it with `node scripts/sign-release.js watch --uninstall`, which stops and removes the service. Signing by hand (`release` or `sign`, above) works the same with or without it.

### Making the repository public
The Claude Code plugin installs from this repository (`claude plugin marketplace add paulnorthup/nuworq`, then `claude plugin install nuworq@nuworq`), so it works for others only once the repository is public. `plugin/` and `.claude-plugin/marketplace.json` are what `nuworq skill --plugin` writes, and test/plugin.test.js fails if they differ.
1. Scan every commit on every ref for secrets: `node scripts/scan-history.js` in a checkout. It makes a fresh `--mirror` clone of origin (every ref, `refs/pull/*` included), and reads every added line (merges too), every commit and tag message, and every added file's name. Check: it prints `No secrets in … added lines, the messages and file names of … refs (… pull request refs)`. On a hit it names the commit, file and kind (never the secret) and exits 1: rotate that secret first, then decide whether to rewrite history.
2. Make it public: `gh repo edit paulnorthup/nuworq --visibility public --accept-visibility-change-consequences`. Check: `gh repo view paulnorthup/nuworq --json visibility` says `PUBLIC`.
3. From a GitHub account with no access before step 2 (or signed out, with `HOME` set to an empty folder): `claude plugin marketplace add paulnorthup/nuworq`, then `claude plugin install nuworq@nuworq`. Check: `claude plugin list` shows nuworq, and the plugin's folder holds the nuworq, shaper and operator skills and `.mcp.json`.
Undo: `gh repo edit paulnorthup/nuworq --visibility private --accept-visibility-change-consequences`. Copies and forks made while it was public stay out there.

### Tokens
```bash
nuworq token create <name> --role human|agent     # prints the token once
nuworq token create <name> --project a,b          # an agent token limited to those projects
nuworq token list                                  # name, role, prefix, created, last used, status, projects
nuworq token revoke <name|id>                      # also logs out that token's browser sessions
```
- An agent token limited with `--project` can't touch other projects or create new ones. The hub won't route it elsewhere, and `/api/route` and `/api/where` don't reveal other projects. Unlimited agent tokens reach every project.
- An agent name belongs to the token that first used it in a project. Another token, or a person's browser session, acting under that name is refused (pick another name). Workers a runner starts share its token, so they still work; once the token is revoked, the name is free again. Only that token gets a push token (`/api/agent/credential`) for the item the agent holds. The UI's agent cards show which tokens have acted under each name.
- People on the agent routes act with their role: a viewer can't use them at all, a member may only `checkin`, `look`, `propose`, `comment`, `signoff` and `feedback`, and stewards and owners may do everything.
- `nuworq worker` and `nuworq run` are your commands, not an agent's: they read the project list, so give them a human token (`NUWORQ_TOKEN`). The agents they start never get it: with `--run` they need an agent token (`--agent-token` or `NUWORQ_AGENT_TOKEN`, ideally limited with `--project`), and they refuse a human token.
- A runner trusts its own machine, not the hub. Its workers get their agent token through a file only you can read (`~/.nuworq/tokens/`, named by `NUWORQ_TOKEN_FILE`), never on a command line or in their environment. Logs and what the runner reports to the hub have tokens redacted. `~/.nuworq` and its logs are made 0700 with 0600 files on every start. Workers work only in folders you chose on that machine (`~/.nuworq/folders.json`): `nuworq run` in a terminal (and `nuworq run --install`) asks about each place it looks for checkouts, and `nuworq run --folder <path>` adds one. A folder the hub names is never used by itself, and only a hub on the same machine may have a path remote cloned.
- These commands work directly on the database file (`--db` or `NUWORQ_DB`; default `~/.nuworq/nuworq.db`), so run them on the hub host, as the user that owns the file.
- Tokens look like `nwq_` followed by 43 random characters (256 bits). Only a SHA-256 hash and an 8-character prefix are stored.
- Every human token belongs to a **person**, who acts on the record as `@handle` with a role: *owner* (everything, including people and settings), *steward* (steer, decide, answer, accept, send back, edit work), *member* (comment and propose) or *viewer* (read only). `token create paul --role human` makes `@paul` an owner if they don't exist yet. Otherwise: `nuworq person add bea --role steward`, then `nuworq token create bea-laptop --role human --person bea`. See also `person list` and `person set-role <handle> <role>`. Human tokens from before people existed become owners. Local loopback mode has no people: the one human is "you".
- **Invites** add people without handing out tokens: `nuworq invite create --role steward [--email bea@example.com] --public-url https://nuworq.example.com` (or POST /api/invites as an owner) prints a single-use link, valid for 7 days. Opening it asks for a handle, creates the person with that role and signs them in. Only a hash of the link is stored. `invite list` and `invite revoke <id>` manage open invites. An invite with an email can also be used by [signing in with GitHub or Google](#sign-in-with-github-or-google) as that email.
- **Device login** gives a machine an agent token without copying one by hand. The CLI calls POST /api/device/start `{machine}` and gets a `user_code` like `WDJB-MJHT` and a link to `/device.html?code=…`. A signed-in person (member or above) opens the link, sees the machine's name and approves it. The CLI polls POST /api/device/poll `{device_code}` every 5 seconds (it gets `slow_down` if it polls faster) and receives the token once, named `<person>@<machine>` and minted by that person. Removing the person revokes it. Codes expire after 10 minutes and are stored only as hashes. Each IP may start 10 device logins per 10 minutes.
- Browser logins exchange a human token for an `HttpOnly; SameSite=Strict` session cookie. It is `Secure` over HTTPS and lasts 30 days.

### Credentials for preconditions
An item can wait on an outside URL (a precondition), and the check may send a credential the hub's host keeps: `NUWORQ_CRED_<NAME>=<value>`. Agents pick the URL, so also say where each credential may go: `NUWORQ_CRED_<NAME>_HOSTS=api.vendor.com,.vendor.io` (a leading dot covers subdomains). Without that list the credential is sent nowhere. It never follows a redirect. A hub with workspaces sends no credentials at all.

### Only the public internet, on a hub with workspaces
Notification channels and precondition URLs are chosen by people and agents, so a hub with workspaces reaches only public addresses with them. It resolves each host once and connects to the address it checked. It refuses loopback, private, link-local, CGNAT and Tailscale (100.64/10), IPv4-mapped private, benchmarking (198.18/15), multicast and unspecified addresses, and it never follows a redirect. People see only "couldn't deliver" or "couldn't check"; the reason goes to the hub's log. To allow a private host anyway, e.g. a LAN ntfy, name it on the hub's host: `NUWORQ_ALLOW_PRIVATE_HOSTS=ntfy.lan,192.168.1.5` (exact names, comma-separated). It is off by default, and nothing in a workspace can set it. A hub of your own (`nuworq serve`) reaches your network as before.

A release precondition (`{ kind: "release", repo: "acme/api", min: "2.1.0" }`) reads the repository's latest GitHub release through the hub's GitHub App when the app is installed there (a read-only token), and through GitHub's public API otherwise. A hub with workspaces uses the app only for the project's own repositories.

### Early access (workspaces hubs)
`serve --workspaces --early-access` means making an organization takes an invitation. People ask at `/early-access` on the hub's own address. The form shows Cloudflare's Turnstile widget with `NUWORQ_TURNSTILE_SITEKEY` (public) and POSTs `{ email, github, building, turnstile }` to `/api/early-access`. It may also send `source`: where the person came from, e.g. a `?ref=` tag like `hn` or the referring site's host. The hub lowercases it and keeps it only if it's at most 64 characters of `a-z 0-9 . - _`. Anything else is dropped, and the request still goes through. A repeat request keeps the first source it had. The owners see each request's source, and the push to them names it ("via hn"). `GET /api/early-access/sources` (owners only) counts, per source, the requests from the last 14 days and from all time, and how many of them were let in, have a workspace where an agent connected, and have one where an item landed. The dashboard's "Where they came from" section shows these counts as bars. The hub checks the token with `NUWORQ_TURNSTILE_SECRET` (it never leaves the hub), takes at most 5 attempts per address per hour, and merges a repeat email into one request. The hub's owners, `--owners` or `NUWORQ_HUB_OWNERS=you@example.com,...` (verified sign-in emails), review requests at `/requests.html`, or, with an admin host, on its dashboard only (next section). Each request is decided once. Approving one shows a link (`/?grant=…`) to send: it lets that person sign in and make one organization, once, within 14 days. Owners need no invitation themselves.

**Being told about a new request.** Each new request (not a repeat from the same email) is pushed to the owners: who asked (email, GitHub handle), the first 140 characters of what they'd build, and a link to the request on the admin host, or to `/requests.html` without one. It goes to each owner's **personal** channels in the workspaces where they are a person with their sign-in email. A workspace's hub-wide channels get it only where the owner is that workspace's only person, since nobody else reads them; once someone else joins, they stop. Each URL gets it once. **Notifications** in the dashboard marks the channels that hear requests, and warns an owner when none does. To receive it:
1. Sign in to the hub once with GitHub or Google as the owner's email, and enter a workspace where you are a person with that email.
2. On the hub host, run `nuworq notify add ntfy <your-secret-topic> --person @<your handle> --workspace <that workspace>`. Check: `nuworq notify list --workspace <that workspace>` shows it with your handle.
3. Test it: `nuworq notify test --workspace <that workspace>` sends a test line. Remove it with `nuworq notify remove <id> --workspace <that workspace>`.

### The admin host (owners only)
`--admin-host admin.example.com` (`NUWORQ_ADMIN_HOST`) gives the hub's owners a dashboard on a host of its own. It needs `--workspaces` and `--public-url` (the app's address; the links it hands out go there), and it can't be the app's host. On the admin host the hub serves only the dashboard (`/`), its sign-in (`/auth/<provider>/…`) and the admin APIs (`GET /api/me`, `POST /api/logout`, `GET /api/early-access`, `GET /api/early-access/sources`, `POST /api/early-access/decide`, `GET /api/feedback/list`, `POST /api/feedback/decide`, `POST /api/feedback/autonomy`, `GET /api/workspaces`, `POST /api/workspaces/plan`). Every other path there is a 404: no workspaces, no app pages, no request form.
- **Feedback about nuworq.** `--feedback-project <workspace>/<project>` (`NUWORQ_FEEDBACK_PROJECT`, e.g. `nuworq/nuworq`) turns it on; it needs `--admin-host`. People get a **Feedback** entry in the rail (on a phone, in Menu): one box, and a list of what's sent with it (the page's address, the app version, the browser). Agents get the `feedback` tool, and the hub adds their name, client, model and its version. Each piece lands in the dashboard's **Feedback** section, newest first, and the owners get one push a minute for whatever came in. **Approve** makes a proposal in that project, tagged feedback on the board and linked back to the dashboard, with their words quoted; it never carries the sender's email. **Decline** asks for an optional note to the sender. Limits: 4000 characters a piece, 10 a day per person or agent. Without the flag, the entry is hidden and the tool answers that feedback is off. Check: send one from the app, then see it under Feedback → New on the admin host.
- **How far feedback goes on its own.** The Feedback section's three levels, the project autonomy levels, start at **Check with me**: each piece waits for Approve or Decline. **Keep moving**: each piece becomes a feedback proposal at once and agents shape it, but the shaped item waits for an owner's Approve in that project before anyone builds it (its parts too). **Run with it**: agents shape, build and land it under that project's own autonomy; the owners still get the push and see it in the project. Switching asks first, says what changes, and applies to feedback from then on. At every level, shaping sends a request to change scope or direction (a new feature, pricing or policy, removing something) to the owners as a blocking question instead of building it (the guide's shaping rules). `POST /api/feedback/autonomy` takes `{ level: "ask" | "balanced" | "full" }`; `GET /api/feedback/list` returns it as `autonomy`.
- **Workspaces and plans.** Below the requests, the dashboard lists every workspace, most recently active first: its plan, the agents holding work now and when it was last active. Tap one for who created it, its people and projects, and whether its plan was set (by whom, when) or is the default. **Switch to Unlimited** / **Switch to Free** asks first, then sets the same plan as `nuworq workspace plan <name> <free|unlimited>`, and `nuworq workspace list` shows it. `GET /api/workspaces` returns `{ enforced, workspaces: [{ name, plan, source, set_by, set_at, creator, people, projects, working, last_active }] }`, where `source` is `set`, `default` or `owners` (a hub owner is in it, so it is always unlimited). `POST /api/workspaces/plan` takes `{ workspace, plan }`. Plans only limit anything with `--plans`; without it the dashboard says so, and changes are still stored. Removing a workspace stays `nuworq workspace remove` on the hub host.
- **Who gets in.** Anyone can sign in with GitHub or Google. Only the emails in `--owners` / `NUWORQ_HUB_OWNERS` see anything; everyone else gets a 403 that names the setting. The session is an `HttpOnly; SameSite=Strict` cookie, `nuworq_admin`, with no `Domain` attribute (host-only), and it lasts 12 hours. App sessions don't open the admin host, and admin sessions don't open the app, even if the cookie is copied across.
- **What moves there.** With `--admin-host` set, `/requests.html` on the app (and on any workspace address) is a `308` to the admin host. `GET /api/early-access`, `GET /api/early-access/sources` and `POST /api/early-access/decide` on the app are refused with a hint naming the admin host. `/api/workspaces` is refused on the app with or without `--admin-host`. The public form (`/early-access`, `POST /api/early-access`) stays on the app. Without `--admin-host`, nothing changes.
- **Callbacks.** The admin host signs in on its own address, so each provider must also accept its callback:
  1. **Google**: in Google Cloud console → APIs & Services → **Credentials**, open the hub's OAuth client and add an Authorized redirect URI: `https://admin.example.com/auth/google/callback`. Click Save. Check: both URIs, the app's and the admin host's, are listed.
  2. **GitHub, OAuth App**: GitHub matches callback URLs exactly, so a subdomain doesn't match the apex's. Register each sign-in host's callback: under Settings → Developer settings → **OAuth Apps** → your app, add `https://admin.example.com/auth/github/callback` next to the app's (e.g. `https://example.com/auth/github/callback` and `https://app.example.com/auth/github/callback`), and click Update application. Check: sign in on each host lands back on that host, not on GitHub's "redirect_uri is not associated" page. A 302 to GitHub proves nothing.
  3. **GitHub, GitHub App** (user sign-in): under Callback URL, click Add callback URL and enter `https://admin.example.com/auth/github/callback`.
  4. Route `admin.example.com` to the hub like the app's host (Caddy site block or tunnel hostname), restart with `--admin-host admin.example.com`, and open `https://admin.example.com/`. Check: it offers Sign in, and after signing in with an owner's email it lists the requests. To undo, remove `--admin-host` and restart: `/requests.html` works on the app again.

### Billing with Stripe (workspaces hubs)
Off unless set, and set from the environment only: `NUWORQ_STRIPE_WEBHOOK_SECRET` (the endpoint's signing secret, `whsec_…`), `NUWORQ_STRIPE_SECRET_KEY` (`sk_…`) and `NUWORQ_STRIPE_PRICES` (`plan=price id` pairs, e.g. `pro=price_123,team=price_456`). Without the webhook secret, `POST /api/stripe/webhook` answers 404 and plans behave as before.
- **What the hub trusts.** Only Stripe's signed webhook, never the redirect back from Checkout. It checks `Stripe-Signature` (HMAC-SHA256 over `t.body`, any `v1`, `t` within 5 minutes); a bad or stale one is a 400 and changes nothing. An event id it has seen is acknowledged (200) and ignored.
- **What it keeps.** Per subscription, in the directory: its workspace (from `checkout.session.completed`'s `client_reference_id`), customer, status, period end and `cancel_at_period_end`, from `customer.subscription.created/updated/deleted`. With prices set, a subscription to none of them is ignored, and one the hub keeps that moves off them pays for nothing from then on. A checkout doesn't say what it sold, so with prices set it only names the workspace: the subscription's own events decide whether it's paid.
- **Upgrade (Checkout).** With the secret key and at least one price set, a Free workspace's owner sees Upgrade, one button per plan: in **Workspace settings** (`#/settings`), linked from the hint of the 402 that refuses a second agent and from the Needs you entry that refusal raises. It opens Stripe Checkout (`POST /api/billing/checkout`, owner only) for the plan's price, with `client_reference_id` and `subscription_data.metadata.workspace` set to the workspace and a line linking https://nuworq.com/terms and https://nuworq.com/privacy; Stripe returns to Workspace settings, which says the plan changes within a minute once Stripe confirms. Without them, Checkout answers 404 and no Upgrade shows; with billing off altogether, `GET /api/billing` answers 404 too.
- **The plan.** A hub owner in the workspace, then a plan set by hand, win as before. Otherwise an `active`, `trialing` or `past_due` subscription, or a cancelled one until its period ends, makes it Unlimited (`source: "billing"`). The admin dashboard shows Stripe's state on each workspace ("paid until 2026-12-01", "cancels 2026-12-01", "payment failed"); `GET /api/workspaces` carries it as `billing`.
- **Managing it (#231).** A workspace's owners get **Workspace settings** in the rail: the billing state in plain words ("Pro, renews 2026-12-01", "Pro until 2026-12-01, then Free", "Payment failed: update your card by 2026-11-08 to keep Pro") and **Manage billing**, which opens Stripe's customer portal for the workspace's customer (`POST /v1/billing_portal/sessions` with `NUWORQ_STRIPE_SECRET_KEY`) and returns to `<workspace>/#/settings`. Others get no button, and the portal route answers them 403. `invoice.payment_failed` puts a Payment failed entry in the owners' Needs you, with the steps, and pushes it once to the owners' own notification channels; `invoice.paid` clears it. The date is Stripe's next retry.
- **Set it up.** 1. In Stripe → Developers → **Webhooks** (https://dashboard.stripe.com/webhooks), click Add endpoint, URL `https://<app host>/api/stripe/webhook`, events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.paid`. 2. Copy its Signing secret into `NUWORQ_STRIPE_WEBHOOK_SECRET` on the hub host and restart the hub. 3. Click Send test webhook. Check: the delivery shows 200. 4. In Stripe → Settings → Billing → **Customer portal** (https://dashboard.stripe.com/settings/billing/portal), turn on Payment methods, Invoice history and Cancel subscriptions with Cancel at end of billing period, then click Save. Check: an owner's Manage billing opens Stripe's page, and cancelling there makes Workspace settings read "Pro until <date>, then Free". To undo, unset the variable and restart: the endpoint answers 404 again.

### Backups
Everything lives in one SQLite file, plus its `-wal` and `-shm` files while running.
```bash
sqlite3 /var/lib/nuworq/nuworq.db ".backup '/backups/nuworq-$(date +%F).db'"   # safe while running
```
Or stop the service and copy the `.db` file. To restore, put the file back and start nuworq. Tokens are in the same file, so a backup is also a credential store: keep it private.

`serve --follow` also copies the database before every move to a new commit, into `<data-dir>/backups/<sha>.db`, named after the commit it left (with `--workspaces`, `backups/<sha>/<workspace>.db`). It keeps the last 10. If the new hub doesn't come up healthy, it puts that copy back before starting the old code, because the new code may have migrated the database. If the copy can't be made (a full disk, say), the hub stays where it is and the log says why. These copies sit on the same disk, so they don't replace off-machine backups.

### Upgrading a deployment from before the rename
nuworq used to be called Trellis, and so did these recipes: the `trellis` user, `/opt/trellis`, `/var/lib/trellis/trellis.db` and `trellis.service`; in Docker, the `trellis` service, the `trellis-data` volume and `/data/trellis.db`. The code still answers to the old names: `bin/trellis.js` runs nuworq, and old tokens (`trl_…`), sessions, `TRELLIS_*` variables and `trellis/<agent>` branches keep working.
- **systemd**: your installed unit keeps running as it is after `git pull`. To move to the new names, stop it and move the database to `/var/lib/nuworq/nuworq.db` (owned by the `nuworq` user) before starting `nuworq.service`.
- **Docker**: the compose file in the repo is the recipe, so after an update `up` would start a new `nuworq` service on an empty `nuworq-data` volume, next to the old container. Stop the old container first and copy `trellis.db` into the new volume as `nuworq.db` (owned by the container's user), or keep using your previous compose file.
- **Operator tags**: work on a project's live infrastructure (servers and VMs, DNS, cloud accounts, deploys) is tagged `infra`. On its first start after the update, the hub rewrites stored `needs` and declared `has` from the old names to `infra`, and keeps accepting the old names from agents and the CLI.

### Threat model (honest version)
**What it protects against**
- Anyone without a token: they can't read projects, steer agents or act as an agent. Static UI files and `/api/health` are public, and contain no data. `/api/hooks/github/<project>` accepts only deliveries signed with that project's secret.
- Agent tokens: they can't open the UI or take human actions (answer, accept, steer, change autonomy).
- Cross-site attacks:
  - Writes authenticated by cookie must carry a matching `Origin` (CSRF).
  - Every browser write from another origin is refused, even in local mode.
  - Without login, nuworq only answers to loopback `Host` names, which blocks DNS rebinding from web pages you visit.
- Login brute force: 10 failures per IP per 10 minutes, then 429. 256-bit tokens make guessing hopeless anyway.
- Oversized requests: bodies over 1MB are refused.
- Clickjacking and injected scripts: strict CSP (`script-src 'self'`), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`.

**What it doesn't (yet)**
- **Per-project scoping.** Any agent token can work in every project and read project data through agent operations (`look`, `checkin`). A leaked agent token exposes all projects' work items, decisions and field notes.
- **A trustworthy agent identity.** Within a token, the agent name (`x-nuworq-agent`) is self-declared. One token can act as many agent names.
- **Prompt injection.** Agents read text written by other agents and by you: steers, notes, item descriptions. A compromised or careless agent can write instructions that others may follow. Treat nuworq content as data, the same way you treat issue text.
- **Strong login.** No passkeys, OAuth/SSO or 2FA. The human token *is* the credential, so guard it like a password.
- **Encryption at rest.** The database isn't encrypted. Rely on disk encryption and file permissions; the systemd unit sets `UMask=0077` and a private state directory.
- **Audit.** There's no separate audit log, though every action lands in the project's event history with its actor.

**Future work:** per-project token scopes, read-only tokens, passkey login, an audit view of token use, and signed agent identities.
