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
# on the VM (Node 22.13+), from the nuworq folder
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

Who gets in: the hub asks the provider for a **verified** email (GitHub: the primary verified one; Google: `email_verified`). It signs in the person with that email (`nuworq person add bea --role steward --email bea@example.com`), or uses an open invite bound to that email (`invite create --email`), creating the person with the invite's role. Anyone else is told to ask an owner for an invite. A person exists per workspace, so a member of acme can't sign in to globex. The flow uses a signed, 10-minute state bound to the browser by a cookie, and PKCE; the provider's access token is used once and never stored. Token login keeps working.

**Organizations (with `--workspaces`).** People can also sign in to the hub itself, at the address that names no workspace (the base domain, the `--public-url` host, or `/` without subdomains): `/auth/<provider>/start` with no `ws`. There, `GET /api/me` lists their organizations (workspaces where a person has their verified email) with role, address and an `enter` link that signs them in there in one click. `POST /api/orgs {name, slug}` creates a workspace with them as its owner. Each person may create up to 5 (`--org-cap`, `NUWORQ_ORG_CAP`). The hub keeps who-belongs-where in `<data-dir>/workspaces/directory.sqlite` and checks it against each workspace's people on every read, so role changes and removals show at once. Reserved names: www, api, app, admin, w, static, login, auth, hub.

### Connecting agents to a remote hub
Create one agent token per machine or agent, so you can revoke them one at a time:
```bash
node bin/nuworq.js token create claude-laptop          # role defaults to agent
```
On the agent's machine:
```bash
claude mcp add nuworq -e NUWORQ_URL=https://nuworq.example.com -e NUWORQ_TOKEN=nwq_… -- node /path/to/nuworq/bin/nuworq.js mcp
```
Codex, opencode and the plain CLI read the same two variables.

### GitHub: pull requests and CI on items
A signed webhook links pull requests to items and shows CI results on them. When CI fails on work in Verifying, it lands under "Needs you" (and gets pushed, if you set up [notifications](../README.md#getting-pinged-ntfy-slack-or-any-webhook)).
1. In the project (5m view, top right): **Connect GitHub**. Generate a secret, copy it, and save.
2. In the repo on GitHub: **Settings → Webhooks → Add webhook**:
   - Payload URL: `https://<your hub>/api/hooks/github/<project>` (the dialog shows it)
   - Content type: `application/json`
   - Secret: the one from step 1
   - Events: *Pull requests*, *Check suites*, *Check runs*, *Statuses*
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
cloudflared tunnel route dns nuworq nuworq.com   # an apex name works; Cloudflare flattens the CNAME
install -d -m 700 /etc/cloudflared && install -m 600 ~/.cloudflared/<tunnel-id>.json /etc/cloudflared/
cat > /etc/cloudflared/config.yml <<EOF
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  - hostname: nuworq.com
    service: http://127.0.0.1:4747
  - service: http_status:404
EOF
cloudflared service install && systemctl enable --now cloudflared
# the hub: deploy/nuworq.service as is, plus --public-url https://nuworq.com (links in push messages)
```
Verified: a valid certificate, 401 without login, a `Secure` session cookie, and the live stream (`/api/stream`) arriving unbuffered through Cloudflare.

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
A machine that installed nuworq from the hub (`npm install -g https://<hub>/nuworq.tgz`) checks the hub at most every 10 minutes, when a command or an MCP server starts. It updates only to a package signed by the release key whose public half, `release-key.pub`, shipped in the copy it already has. A sha256 from the hub only proves a download isn't corrupted. The signature is what stops a compromised hub, tunnel or DNS from shipping code. A package with tampered bytes, a missing or foreign signature, or a different `release-key.pub` is refused, and the installed version keeps running. What gets signed is the whole package file (ed25519 over its bytes). That includes `src/commit.txt`, which `git archive` fills with the commit and its committer time (`%H %ct`). So the signature also covers when a release was made. An update must be the commit the hub named, and its signed time must be later than the installed copy's own. An older or same-time release is refused even when validly signed, so a compromised hub can't roll machines back to a release with known bugs. A package that carries no time is refused too. The one exception is an install from before times were recorded: it takes its first timed release, then orders them. If `npm install` fails, the command offered to run by hand installs the verified file the update saved (`npm install -g <update dir>/nuworq-<commit>.tgz`), never a fresh download. `nuworq update` checks now and says what happened. Updates are off without a pinned key, in a git checkout, with `NUWORQ_NO_UPDATE=1`, and for a plain-http hub that isn't on the same machine.

The private key never goes on the hub. Where the key lives:
```bash
node scripts/sign-release.js keygen ~/keys            # once: release-key.pem (keep offline) + release-key.pub
cp ~/keys/release-key.pub release-key.pub && git add release-key.pub   # commit it: packages pin it from then on
# each release, once the hub runs the commit: fetch its package, check it, sign it
curl -o nuworq.tgz https://<hub>/nuworq.tgz            # compare its sha256 with /api/info's package.sha256
node scripts/sign-release.js sign nuworq.tgz ~/keys/release-key.pem   # writes nuworq.tgz.sig
# put the signature beside the hub's package, <data dir>/package/nuworq-<full commit>.tgz.sig
scp nuworq.tgz.sig <hub>:/var/lib/nuworq/package/nuworq-$(git rev-parse HEAD).tgz.sig
```
The hub serves it at `/nuworq.tgz.sig` straight away. Until a package is signed, installed copies keep their version. Rotating the key takes a reinstall by hand.

### Tokens
```bash
nuworq token create <name> --role human|agent     # prints the token once
nuworq token create <name> --project a,b          # an agent token limited to those projects
nuworq token list                                  # name, role, prefix, created, last used, status, projects
nuworq token revoke <name|id>                      # also logs out that token's browser sessions
```
- An agent token limited with `--project` can't touch other projects or create new ones. The hub won't route it elsewhere, and `/api/route` and `/api/where` don't reveal other projects. Unlimited agent tokens reach every project.
- Each agent records the tokens that have acted under its name. The UI's agent cards show it, and flag a name used by more than one token.
- `nuworq worker` and `nuworq run` are your commands, not an agent's: they read the project list, so give them a human token (`NUWORQ_TOKEN`). The agents they start never get it: with `--run` they need an agent token (`--agent-token` or `NUWORQ_AGENT_TOKEN`, ideally limited with `--project`), and they refuse a human token.
- These commands work directly on the database file (`--db` or `NUWORQ_DB`; default `~/.nuworq/nuworq.db`), so run them on the hub host, as the user that owns the file.
- Tokens look like `nwq_` followed by 43 random characters (256 bits). Only a SHA-256 hash and an 8-character prefix are stored.
- Every human token belongs to a **person**, who acts on the record as `@handle` with a role: *owner* (everything, including people and settings), *steward* (steer, decide, answer, accept, send back, edit work), *member* (comment and propose) or *viewer* (read only). `token create paul --role human` makes `@paul` an owner if they don't exist yet. Otherwise: `nuworq person add bea --role steward`, then `nuworq token create bea-laptop --role human --person bea`. See also `person list` and `person set-role <handle> <role>`. Human tokens from before people existed become owners. Local loopback mode has no people: the one human is "you".
- **Invites** add people without handing out tokens: `nuworq invite create --role steward [--email bea@example.com] --public-url https://nuworq.example.com` (or POST /api/invites as an owner) prints a single-use link, valid for 7 days. Opening it asks for a handle, creates the person with that role and signs them in. Only a hash of the link is stored. `invite list` and `invite revoke <id>` manage open invites. An invite with an email can also be used by [signing in with GitHub or Google](#sign-in-with-github-or-google) as that email.
- **Device login** gives a machine an agent token without copying one by hand. The CLI calls POST /api/device/start `{machine}` and gets a `user_code` like `WDJB-MJHT` and a link to `/device.html?code=…`. A signed-in person (member or above) opens the link, sees the machine's name and approves it. The CLI polls POST /api/device/poll `{device_code}` every 5 seconds (it gets `slow_down` if it polls faster) and receives the token once, named `<person>@<machine>` and minted by that person. Removing the person revokes it. Codes expire after 10 minutes and are stored only as hashes. Each IP may start 10 device logins per 10 minutes.
- Browser logins exchange a human token for an `HttpOnly; SameSite=Strict` session cookie. It is `Secure` over HTTPS and lasts 30 days.

### Credentials for preconditions
An item can wait on an outside URL (a precondition), and the check may send a credential the hub's host keeps: `NUWORQ_CRED_<NAME>=<value>`. Agents pick the URL, so also say where each credential may go: `NUWORQ_CRED_<NAME>_HOSTS=api.vendor.com,.vendor.io` (a leading dot covers subdomains). Without that list the credential is sent nowhere. It never follows a redirect. A hub with workspaces sends no credentials at all.

A release precondition (`{ kind: "release", repo: "acme/api", min: "2.1.0" }`) reads the repository's latest GitHub release through the hub's GitHub App when the app is installed there (a read-only token), and through GitHub's public API otherwise. A hub with workspaces uses the app only for the project's own repositories.

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
