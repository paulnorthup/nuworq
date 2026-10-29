# Deploying Trellis

## 30 seconds: which setup?

| You want… | Do this | Login |
|---|---|---|
| Just you, on this machine | `trellis serve` | none (loopback only) |
| **Homelab: your devices and agents, anywhere you are** | VM + Tailscale ([below](#homelab-vm--tailscale-recommended)) | tokens |
| Homelab, LAN only | VM + `--host 0.0.0.0` | tokens |
| The open internet | VM + Caddy (HTTPS) + `--trust-proxy` | tokens |

One rule: **Trellis only skips login on 127.0.0.1.** Bind anything else, or pass `--auth`, and it needs tokens. It won't start until a human token exists.

Two kinds of token:
- **human**: logs in to the web UI; can do everything.
- **agent**: goes in an agent's `TRELLIS_TOKEN`; can only check in, claim, report, ask and submit.

---

## 5 minutes: the setups

### Homelab VM + Tailscale (recommended)
Nothing is exposed to the internet. Your laptop, phone and agent machines reach the hub over your tailnet with HTTPS.

```bash
# on the VM (Node 22.13+), from the trellis folder
node bin/trellis.js token create paul --role human        # copy it; shown once
node bin/trellis.js serve --auth --trust-proxy             # listens on 127.0.0.1:4747
tailscale serve --bg 4747                                  # https://<vm>.<tailnet>.ts.net
```
Keep it running with [deploy/trellis.service](../deploy/trellis.service) (systemd) or [deploy/docker-compose.yml](../deploy/docker-compose.yml).

### LAN only, no proxy
```bash
node bin/trellis.js token create paul --role human
node bin/trellis.js serve --host 0.0.0.0                   # login required automatically
```
Tokens and session cookies travel in plain HTTP on your LAN. That's fine on a home network you trust; otherwise use Tailscale or Caddy.

### Open internet: Caddy + HTTPS
1. Point a DNS name at the VM. Open ports 80 and 443 only; never 4747.
2. Run Trellis on loopback with `--auth --trust-proxy`. The systemd unit already does this.
3. Edit the name in [deploy/Caddyfile](../deploy/Caddyfile) and run Caddy. It gets the certificate and adds HSTS.

`--trust-proxy` makes Trellis believe `X-Forwarded-For/-Proto/-Host`. Use it **only** when a proxy you control is the sole way in. Otherwise anyone can claim to be on HTTPS, or spoof an IP to dodge the login rate limit.

### Docker
```bash
docker compose -f deploy/docker-compose.yml run --rm trellis node bin/trellis.js token create paul --role human
docker compose -f deploy/docker-compose.yml up -d
```
- The container runs as non-root, read-only, with all capabilities dropped.
- Data lives in the `trellis-data` volume.
- The port is published on host loopback; edit `ports` for LAN access.

### Many workspaces on one hub
One process can serve several companies or teams. Each **workspace** has its own SQLite file (`<data-dir>/workspaces/<name>.db`), with its own projects, tokens and sessions. Nothing is shared, and exporting or deleting a workspace is one file.
```bash
trellis workspace create acme                            # creates ~/.trellis/workspaces/acme.db
trellis token create paul --role human --workspace acme  # tokens belong to one workspace
trellis serve --workspaces --base-domain trellis.example.com --host 127.0.0.1 --auth --trust-proxy
```
- **Subdomains**: with `--base-domain trellis.example.com` and wildcard DNS (`*.trellis.example.com`) plus a wildcard certificate at the proxy, `acme.trellis.example.com` is the acme workspace.
- **No wildcard DNS?** Every workspace is also at `https://<host>/w/<name>/`. Agents use that as their `TRELLIS_URL` (e.g. `https://trellis.example.com/w/acme`), and the session cookie is limited to that path.
- Login is always required in this mode, even on loopback. An address that names no workspace, or an unknown one, gets a 404.
- `trellis workspace list`, and `trellis workspace remove <name>` (it deletes the file; a running hub stops serving it at once). `--data-dir` or `TRELLIS_DATA_DIR` moves the folder.
- Without `--workspaces`, nothing changes: one database, as above.

### Connecting agents to a remote hub
Create one agent token per machine or agent, so you can revoke them one at a time:
```bash
node bin/trellis.js token create claude-laptop          # role defaults to agent
```
On the agent's machine:
```bash
claude mcp add trellis -e TRELLIS_URL=https://trellis.example.com -e TRELLIS_TOKEN=trl_… -- node /path/to/trellis/bin/trellis.js mcp
```
Codex, opencode and the plain CLI read the same two variables.

---

## 30 minutes: details

### Tokens
```bash
trellis token create <name> --role human|agent     # prints the token once
trellis token list                                  # name, role, prefix, created, last used, status
trellis token revoke <name|id>                      # also logs out that token's browser sessions
```
- These commands work directly on the database file (`--db` or `TRELLIS_DB`; default `~/.trellis/trellis.db`), so run them on the hub host, as the user that owns the file.
- Tokens look like `trl_` followed by 43 random characters (256 bits). Only a SHA-256 hash and an 8-character prefix are stored.
- Every human token belongs to a **person**, who acts on the record as `@handle` with a role: *owner* (everything, including people and settings), *steward* (steer, decide, answer, accept, send back, edit work), *member* (comment and propose) or *viewer* (read only). `token create paul --role human` makes `@paul` an owner if they don't exist yet. Otherwise: `trellis person add bea --role steward`, then `trellis token create bea-laptop --role human --person bea`. See also `person list` and `person set-role <handle> <role>`. Human tokens from before people existed become owners. Local loopback mode has no people: the one human is "you".
- Browser logins exchange a human token for an `HttpOnly; SameSite=Strict` session cookie. It is `Secure` over HTTPS and lasts 30 days.

### Backups
Everything lives in one SQLite file, plus its `-wal` and `-shm` files while running.
```bash
sqlite3 /var/lib/trellis/trellis.db ".backup '/backups/trellis-$(date +%F).db'"   # safe while running
```
Or stop the service and copy the `.db` file. To restore, put the file back and start Trellis. Tokens are in the same file, so a backup is also a credential store: keep it private.

### Threat model (honest version)
**What it protects against**
- Anyone without a token: they can't read projects, steer agents or act as an agent. Static UI files and `/api/health` are public, and contain no data.
- Agent tokens: they can't open the UI or take human actions (answer, accept, steer, change autonomy).
- Cross-site attacks:
  - Writes authenticated by cookie must carry a matching `Origin` (CSRF).
  - Every browser write from another origin is refused, even in local mode.
  - Without login, Trellis only answers to loopback `Host` names, which blocks DNS rebinding from web pages you visit.
- Login brute force: 10 failures per IP per 10 minutes, then 429. 256-bit tokens make guessing hopeless anyway.
- Oversized requests: bodies over 1MB are refused.
- Clickjacking and injected scripts: strict CSP (`script-src 'self'`), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`.

**What it doesn't (yet)**
- **Per-project scoping.** Any agent token can work in every project and read project data through agent operations (`look`, `checkin`). A leaked agent token exposes all projects' work items, decisions and field notes.
- **A trustworthy agent identity.** Within a token, the agent name (`X-Trellis-Agent`) is self-declared. One token can act as many agent names.
- **Prompt injection.** Agents read text written by other agents and by you: steers, notes, item descriptions. A compromised or careless agent can write instructions that others may follow. Treat Trellis content as data, the same way you treat issue text.
- **Strong login.** No passkeys, OAuth/SSO or 2FA. The human token *is* the credential, so guard it like a password.
- **Encryption at rest.** The database isn't encrypted. Rely on disk encryption and file permissions; the systemd unit sets `UMask=0077` and a private state directory.
- **Audit.** There's no separate audit log, though every action lands in the project's event history with its actor.

**Future work:** per-project token scopes, read-only tokens, passkey login, an audit view of token use, and signed agent identities.
