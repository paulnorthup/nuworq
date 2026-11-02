// A GitHub App as the only door to a repository: the hub holds the app's private key, and for each
// worker that needs to push it mints an installation token restricted to the one repository the
// item lands in, with only the permissions work needs. GitHub expires it after an hour. Agents never
// hold a long-lived GitHub credential; git asks for the token through `nuworq git-credential`.
// fetch and node:crypto only.
import { createSign, createPrivateKey, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { UserError } from './core.js';
import { envVar } from './names.js';

// What a worker's token may do: push branches, open pull requests, read CI. Nothing else.
export const WORK_PERMISSIONS = { contents: 'write', pull_requests: 'write', checks: 'read', metadata: 'read' };
// What a worker's token may do to clone a project's repository before it holds an item, and the hub's
// token for its own mirror of it: read it.
export const CLONE_PERMISSIONS = { contents: 'read', metadata: 'read' };

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

// Every page of a GitHub list, 100 at a time (at most 50 pages). what: what is listed, for the error.
async function pages(what, get, pick) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const r = await get(`per_page=100&page=${page}`);
    if (r.status !== 200) throw new UserError(`GitHub didn't list the app's ${what} (${r.status}${r.json?.message ? `: ${r.json.message}` : ''})`, { status: 502, hint: 'Check the app id and private key the hub uses; try again in a minute.' });
    const batch = pick(r.json) ?? [];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

// NUWORQ_GITHUB_APP_ID and the key: NUWORQ_GITHUB_APP_KEY (PEM) or NUWORQ_GITHUB_APP_KEY_FILE. null when unset.
export function appFromEnv(env = process.env) {
  const id = envVar('GITHUB_APP_ID', env);
  const file = envVar('GITHUB_APP_KEY_FILE', env);
  const key = envVar('GITHUB_APP_KEY', env) || (file ? readFileSync(file, 'utf8') : '');
  return id && key ? {
    id, key, slug: envVar('GITHUB_APP_SLUG', env) || '', webhook_secret: envVar('GITHUB_APP_WEBHOOK_SECRET', env) || '',
    client_id: envVar('GITHUB_APP_CLIENT_ID', env) || '', client_secret: envVar('GITHUB_APP_CLIENT_SECRET', env) || '',
  } : null;
}

// The app the hub made for itself (one click, below), kept in a file only the hub's user can read. null if none.
export function appFromFile(file) {
  try {
    const a = JSON.parse(readFileSync(file, 'utf8'));
    return a.id && a.key ? a : null;
  } catch { return null; }
}

// The events the app's webhook delivers (installation events always come): what per-project webhooks carried.
export const APP_EVENTS = ['issues', 'issue_comment', 'pull_request', 'pull_request_review', 'check_suite', 'check_run', 'dependabot_alert'];

// What the hub asks GitHub to create: the permissions work needs, nothing more. The webhook is on when
// GitHub can reach the hub (not a loopback address); redirect_url brings the owner back here.
export function manifest(base, name) {
  const reachable = !/^https?:\/\/(localhost|127\.|\[::1\])/i.test(base);
  return {
    name: String(name).slice(0, 34), url: base, public: false,
    hook_attributes: { url: `${base}/api/hooks/github-app`, active: reachable },
    redirect_url: `${base}/api/github/app/callback`,
    // After installing (or changing which repositories it sees), GitHub sends the person back to the hub.
    setup_url: `${base}/#/`, setup_on_update: true,
    // members (an organization permission): whether the person installing on an organization is its admin (#478).
    default_permissions: { contents: 'write', pull_requests: 'write', checks: 'read', actions: 'read', metadata: 'read', issues: 'write', vulnerability_alerts: 'read', members: 'read' },
    default_events: reachable ? APP_EVENTS : [],
  };
}

// GitHub's side of the one click: trade the code it sent back for the new app's id, key and secrets.
export async function convert(code, { api = 'https://api.github.com' } = {}) {
  const r = await fetch(`${api.replace(/\/+$/, '')}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST', headers: { accept: 'application/vnd.github+json', 'user-agent': 'nuworq' }, signal: AbortSignal.timeout(10_000),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status !== 201 || !j.id || !j.pem) throw new UserError(`GitHub didn't hand over the new app (${r.status}${j.message ? `: ${j.message}` : ''})`, { status: 502, hint: 'The code works once and for an hour: start again from the hub.' });
  return { id: String(j.id), slug: j.slug ?? '', key: j.pem, webhook_secret: j.webhook_secret ?? '', client_id: j.client_id ?? '', client_secret: j.client_secret ?? '', owner: j.owner?.login ?? '' };
}

export class GitHubApp {
  // id: the app's id. key: its private key (PEM). slug: its name in github.com/apps/<slug>, for install links.
  // client_id, client_secret: its OAuth credentials, to learn who installed it (installedBy). webhook_secret:
  // what GitHub signs the app's webhook deliveries with (receiveApp in src/github.js). api, web:
  // GitHub's REST API and site (tests point them at a stub). now: for tests.
  constructor({ id, key, slug = '', client_id = '', client_secret = '', webhook_secret = '', api = 'https://api.github.com', web = 'https://github.com', now = () => Date.now() }) {
    this.id = String(id);
    this.key = createPrivateKey(key);
    this.slug = slug;
    this.webhookSecret = webhook_secret;
    this.clientId = client_id;
    this.clientSecret = client_secret;
    this.api = api.replace(/\/+$/, '');
    this.web = web.replace(/\/+$/, '');
    this.now = now;
  }

  // Whether the person who just installed the app can see installation id, by their own word to GitHub:
  // the OAuth code GitHub sends with the setup redirect ("Request user authorization during installation")
  // becomes a user token, and GET /user/installations lists what that person can reach. The redirect's
  // installation_id alone can be forged; this can't. Throws a UserError when it can't be checked.
  async installedBy(code, id) {
    if (!this.clientId || !this.clientSecret) {
      throw new UserError("this hub can't check who installed the app: it has no client id and secret for it", { status: 424, hint: 'Set NUWORQ_GITHUB_APP_CLIENT_ID and NUWORQ_GITHUB_APP_CLIENT_SECRET from the app\'s settings page (docs/GITHUB.md), then install again.' });
    }
    if (!code) {
      throw new UserError("GitHub didn't say who installed the app", { hint: 'In the app\'s settings, tick "Request user authorization (OAuth) during installation", then install again from your workspace.' });
    }
    const t = await fetch(`${this.web}/login/oauth/access_token`, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'nuworq' },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, code }), signal: AbortSignal.timeout(10_000),
    });
    const tok = (await t.json().catch(() => ({}))).access_token;
    if (!tok) throw new UserError("GitHub didn't accept the install's authorization code (it works once, for 10 minutes)", { hint: 'Install again from your workspace.' });
    for (let page = 1; page <= 10; page++) {
      const r = await this.call('GET', `/user/installations?per_page=100&page=${page}`, null, tok);
      if (r.status !== 200) throw new UserError(`GitHub didn't list your installations (${r.status})`, { status: 502, hint: 'Try the install again in a minute.' });
      const list = r.json.installations ?? [];
      const found = list.find((i) => Number(i.id) === Number(id));
      if (found) return this.manages(found.account, tok);
      if (list.length < 100) return false;
    }
    return false;
  }

  // Seeing an installation isn't owning it (#478): /user/installations lists ones a person can merely read. The
  // installer must be the account it's on, or an active admin of that organization, as GitHub says to their token.
  async manages(account, tok) {
    const login = String(account?.login ?? '');
    if (!login) return false;
    if (account.type !== 'User') {
      const r = await this.call('GET', `/user/memberships/orgs/${encodeURIComponent(login)}`, null, tok);
      return r.status === 200 && r.json?.state === 'active' && r.json?.role === 'admin';
    }
    const r = await this.call('GET', '/user', null, tok);
    return r.status === 200 && String(r.json?.login ?? '').toLowerCase() === login.toLowerCase();
  }

  // The app's own credential: a JWT signed with its key, good for ~10 minutes (backdated a minute for clock skew).
  jwt() {
    const t = Math.floor(this.now() / 1000);
    const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: t - 60, exp: t + 540, iss: this.id })}`;
    return `${body}.${createSign('RSA-SHA256').update(body).sign(this.key).toString('base64url')}`;
  }

  // token: an installation token, to act on a repository; the app's JWT otherwise.
  // GitHub derives the app's address (github.com/apps/<slug>) from its name, which the owner can change:
  // ask GitHub rather than trust the slug saved when the app was created. True when it changed.
  async refreshSlug() {
    const r = await this.call('GET', '/app');
    if (r.status !== 200 || !r.json.slug || r.json.slug === this.slug) return false;
    this.slug = r.json.slug;
    return true;
  }

  async call(method, path, body, token = this.jwt()) {
    const r = await fetch(`${this.api}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'nuworq', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }

  // A metadata-only token for one installation, reused until 5 minutes before it expires (memory only).
  async installationToken(id) {
    this._inst ??= new Map();
    const have = this._inst.get(id);
    if (have && Date.parse(have.expires_at) - 5 * 60_000 > this.now()) return have.token;
    const tok = await this.call('POST', `/app/installations/${id}/access_tokens`, { permissions: { metadata: 'read' } });
    if (tok.status !== 201 || !tok.json.token) throw new UserError(`GitHub didn't issue a token for installation ${id} (${tok.status})`, { status: 502 });
    this._inst.set(id, { token: tok.json.token, expires_at: tok.json.expires_at });
    return tok.json.token;
  }

  // Every installation of the app, as GitHub lists them to the app itself: [{ id, account: { login } }, ...].
  async installations(what = 'installations') {
    return pages(what, (q) => this.call('GET', `/app/installations?${q}`), (j) => j);
  }

  // Every repository the app's installations can see: [{ repo: "github.com/o/r", name, description, private }].
  async repos() {
    const installs = await this.installations('repositories');
    const all = [];
    for (const inst of installs) {
      const token = await this.installationToken(inst.id);
      const list = await pages('repositories', async (q) => {
        const r = await fetch(`${this.api}/installation/repositories?${q}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'nuworq' }, signal: AbortSignal.timeout(10_000) });
        return { status: r.status, json: await r.json().catch(() => ({})) };
      }, (j) => j.repositories);
      for (const r of list) all.push({ repo: `github.com/${r.full_name}`.toLowerCase(), name: r.name, description: r.description ?? '', private: !!r.private });
    }
    return all.sort((a, b) => a.repo.localeCompare(b.repo));
  }

  // Whether the app is installed anywhere, or (repo given) on that one repository. Scoped, only through
  // an installation this organization may use, and always for one repository.
  async installed(repo) {
    if (!repo) {
      if (this.allows) return false;
      const r = await this.call('GET', '/app/installations?per_page=1&page=1');
      return r.status === 200 && Array.isArray(r.json) && r.json.length > 0;
    }
    const [, owner, name] = String(repo).match(/^github\.com\/([^/]+)\/([^/]+)$/) ?? [];
    if (!owner) return false;
    const r = await this.call('GET', `/repos/${owner}/${name}/installation`);
    return r.status === 200 && (!this.allows || (!!r.json.id && !!this.allows(r.json.id)));
  }

  installUrl() {
    return this.slug ? `https://github.com/apps/${this.slug}/installations/new` : 'the app\'s page on GitHub (Settings → Developer settings → GitHub Apps → Install App)';
  }

  // A token for one repository ("github.com/acme/api"): { token, expires_at, repo }. Throws a UserError
  // in plain words when the app isn't installed there (or was uninstalled, or suspended).
  async mint(repo, permissions = WORK_PERMISSIONS) {
    const m = String(repo).match(/^github\.com\/([^/]+)\/([^/]+)$/);
    if (!m) throw new UserError(`${repo || 'This project'} isn't a GitHub repository, so there is no GitHub token for it`, { hint: 'Link the project to its GitHub repository (github.com/owner/name).' });
    const [, owner, name] = m;
    const inst = await this.call('GET', `/repos/${owner}/${name}/installation`);
    if (inst.status === 404) {
      throw new UserError(`The nuworq GitHub App isn't installed on ${owner}/${name} (or was uninstalled), so the hub can't give out tokens for it`, {
        status: 424, hint: `An owner of ${owner} installs it for that repository: ${this.installUrl()}. Until then, nobody can push there through the hub.`,
      });
    }
    if (inst.status !== 200 || !inst.json.id) throw new UserError(`GitHub didn't say whether the app can reach ${owner}/${name} (${inst.status})`, { status: 502, hint: 'Check the app id and private key the hub was started with; try again in a minute.' });
    // On a shared hub, one organization's view of the app reaches only installations bound to it (scoped).
    if (this.allows && !this.allows(inst.json.id)) {
      throw new UserError(`The nuworq GitHub App on ${owner}/${name} was installed for another workspace, not this one`, {
        status: 403, hint: `An owner of ${owner} installs the app for this workspace, starting from its Connect page, so the hub knows the installation is yours.`,
      });
    }
    const tok = await this.call('POST', `/app/installations/${inst.json.id}/access_tokens`, { repositories: [name], permissions });
    if (tok.status === 403 || tok.status === 404) {
      throw new UserError(`GitHub refused a token for ${owner}/${name}: the app's installation there is suspended or removed`, {
        status: 424, hint: `An owner of ${owner} re-enables it: ${this.installUrl()}.`,
      });
    }
    if (tok.status !== 201 || !tok.json.token) throw new UserError(`GitHub didn't issue a token for ${owner}/${name} (${tok.status}${tok.json.message ? `: ${tok.json.message}` : ''})`, { status: 502 });
    return { token: tok.json.token, expires_at: tok.json.expires_at, repo: `github.com/${owner}/${name}` };
  }

  // This app as one organization on a shared hub sees it: the same app, minting only for installations
  // allows(installationId) says are that organization's.
  scoped(allows) {
    return Object.create(this, { allows: { value: allows } });
  }
}

// Installing the app from inside an organization: GitHub carries `state` through to the setup page,
// so the hub learns which organization the installation is for. Signed with the app's key, so it can't
// be forged; good for an hour.
export function installState(app, workspace, now = Date.now()) {
  const body = `${workspace}.${now + 3600_000}`;
  return `${body}.${createHmac('sha256', app.key.export({ type: 'pkcs8', format: 'pem' })).update(body).digest('base64url')}`;
}
export function readInstallState(app, state, now = Date.now()) {
  const [workspace, until, sig] = String(state ?? '').split('.');
  if (!workspace || !sig || !(Number(until) > now)) return null;
  const want = installState(app, workspace, Number(until) - 3600_000).split('.')[2];
  return want.length === sig.length && timingSafeEqual(Buffer.from(want), Buffer.from(sig)) ? workspace : null;
}

// What GitHub says of one check (CI's required `test`) on a commit of repo ("github.com/acme/api"), for serve
// --follow (#543): { state: 'passed' }, { state: 'failed', failed }, { state: 'pending' } while it runs or
// ({ missing: true }) before GitHub has heard of it, or null when it ended without a verdict (skipped, neutral,
// stale, or cancelled: someone stopped it, nothing failed). Read with an actions:read token for the repository,
// from the hub's own GitHub App. Only GitHub Actions' run counts (#621): any app with checks:write on the repository
// can post a check named "test", and a passing one of theirs must never pass for CI's. And only the job of the
// repository's own CI workflow, run on this very commit for main (#648): any workflow posts as GitHub Actions, so one
// added on another branch (a worker's, say) could post a passing "test" check run on main's commit, and it would
// sit in a suite on that commit, even CI's own. A job is a check run the workflow itself made; one posted through the
// API never is. So the verdict is the "test" job of the newest test.yml run on sha, pushed to main or a pull request
// into it. That needs actions:read: without it the token isn't minted, and the hub runs the suite itself, as it does
// whenever GitHub can't say.
const FAILED = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
export const CI_APP = 'github-actions';
export const CI_WORKFLOW = '.github/workflows/test.yml';
export async function checkOn(app, repo, sha, name = 'test', branch = 'main') {
  const [, owner, nm] = String(repo).match(/^github\.com\/([^/]+)\/([^/]+)$/) ?? [];
  if (!owner) return null;
  const { token } = await app.mint(repo, { actions: 'read', metadata: 'read' });
  const get = async (path, what) => {
    const r = await app.call('GET', `/repos/${owner}/${nm}${path}`, undefined, token);
    if (r.status !== 200) throw new Error(`GitHub answered ${r.status} about ${what} on ${sha.slice(0, 7)}`);
    return r.json;
  };
  // Newest first. Its definition is the one on sha: a push to main, or a pull request into main (not one into
  // another branch, whose merge commit could carry that branch's test.yml).
  const ci = (wr) => wr.path === CI_WORKFLOW && wr.head_sha === sha && (wr.event === 'push'
    ? wr.head_branch === branch : wr.event === 'pull_request' && !!wr.pull_requests?.some((p) => p.base?.ref === branch));
  const wr = ((await get(`/actions/workflows/${CI_WORKFLOW.split('/').pop()}/runs?head_sha=${sha}&per_page=20`, `CI's runs`)).workflow_runs ?? []).find(ci);
  if (!wr) return { state: 'pending', missing: true };
  const run = ((await get(`/actions/runs/${wr.id}/jobs?per_page=100`, `the jobs of ${name}`)).jobs ?? []).find((j) => j.name === name);
  if (!run) return wr.status === 'completed' ? { state: 'pending', missing: true } : { state: 'pending' };
  if (run.status !== 'completed') return { state: 'pending' };
  if (run.conclusion === 'success') return { state: 'passed' };
  if (FAILED.has(run.conclusion)) return { state: 'failed', failed: `CI's ${name} check: ${run.conclusion}${run.html_url ? `, ${run.html_url}` : ''}` };
  return null;
}

// GitHub won't turn auto-merge on for a pull request with nothing left to wait for (no required checks, or
// they already passed). It says "Pull request Pull request is in clean status": the PR can merge as it is.
export const CLEAN = /\bis in clean status\b/i;

// What the hub does on GitHub to land accepted work through a pull request (#63), as the app, on the one
// repository: open the PR (or find the one already open for the branch) and turn on auto-merge (squash),
// or squash-merge it at once when it is already ready; and look at it again on the hub's periodic pass.
// Also a read-only token for the hub's own mirror of the repository, fetched over HTTPS from web.
export function prClient(app, { web = 'https://github.com' } = {}) {
  const parts = (repo) => String(repo).match(/^github\.com\/([^/]+)\/([^/]+)$/)?.slice(1) ?? [];
  const shape = (pr) => ({ number: pr.number, url: pr.html_url, node_id: pr.node_id, head_ref: pr.head?.ref, head_sha: pr.head?.sha });
  // The repository's work token, reused until 5 minutes before it expires (memory only): the periodic pass
  // looks at every landing PR once a minute.
  const tokens = new Map();
  const tokenFor = async (repo) => {
    const have = tokens.get(repo);
    if (have && Date.parse(have.expires_at) - 5 * 60_000 > app.now()) return have.token;
    const fresh = await app.mint(repo);
    tokens.set(repo, fresh);
    return fresh.token;
  };
  const said = (r) => `${r.status}${r.json.message ? `: ${r.json.message}` : ''}`;
  return {
    app,
    web: web.replace(/\/+$/, ''),
    covers: (repo) => parts(repo).length === 2, // GitHub repositories only
    readToken: (repo) => app.mint(repo, CLONE_PERMISSIONS),
    async openPr({ repo, head, base, title, body }) {
      const [owner, name] = parts(repo);
      const token = await tokenFor(repo);
      const r = await app.call('POST', `/repos/${owner}/${name}/pulls`, { title, head, base, body }, token);
      if (r.status === 201) return shape(r.json);
      // Already open for this branch (opened by hand, or by an earlier try): use that one.
      if (r.status === 422) {
        const open = await app.call('GET', `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`, null, token);
        if (open.status === 200 && open.json[0]) return shape(open.json[0]);
      }
      throw new Error(`GitHub didn't open the pull request (${said(r)}${r.json.errors?.[0]?.message ? `; ${r.json.errors[0].message}` : ''})`);
    },
    // { ready: true } when GitHub won't turn it on because the PR has nothing left to wait for: merge it instead.
    // sha (#605): the head that was reviewed; GitHub refuses if the PR's head is anything else by then.
    async autoMerge({ repo, id, sha = '' }) {
      const r = await app.call('POST', '/graphql', sha ? {
        query: 'mutation($id: ID!, $sha: GitObjectID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH, expectedHeadOid: $sha }) { clientMutationId } }',
        variables: { id, sha },
      } : {
        query: 'mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { clientMutationId } }',
        variables: { id },
      }, await tokenFor(repo));
      const error = r.json.errors?.[0]?.message;
      if (error && CLEAN.test(error)) return { ready: true };
      if (r.status !== 200 || error) throw new Error(error ?? `GitHub answered ${r.status}`);
      return { ready: false };
    },
    // Auto-merge off again (#605): its head moved after review. Already off is fine.
    async disableAutoMerge({ repo, id }) {
      const r = await app.call('POST', '/graphql', {
        query: 'mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }',
        variables: { id },
      }, await tokenFor(repo));
      const error = r.json.errors?.[0]?.message;
      if (r.status !== 200 || (error && !/not enabled|isn't enabled|is not enabled/i.test(error))) throw new Error(error ?? `GitHub answered ${r.status}`);
    },
    // Squash-merge it now: { sha } of the commit it made on the base branch. head (#605): the reviewed head; GitHub
    // refuses (409) when the PR's head is anything else, and the error says moved.
    async merge({ repo, number, head = '' }) {
      const [owner, name] = parts(repo);
      const r = await app.call('PUT', `/repos/${owner}/${name}/pulls/${number}/merge`, { merge_method: 'squash', ...(head ? { sha: head } : {}) }, await tokenFor(repo));
      if (r.status === 409 && head) throw Object.assign(new Error(`GitHub didn't merge PR #${number}: its head isn't the reviewed ${head.slice(0, 7)} (${said(r)})`), { moved: true });
      if (r.status !== 200 || !r.json.merged) throw new Error(`GitHub didn't merge PR #${number} (${said(r)})`);
      return { sha: r.json.sha ?? '' };
    },
    // Tag a commit (#400): refs/tags/<tag> at sha, lightweight. A tag already there on that commit is fine.
    async tag({ repo, tag, sha }) {
      const [owner, name] = parts(repo);
      const token = await tokenFor(repo);
      const r = await app.call('POST', `/repos/${owner}/${name}/git/refs`, { ref: `refs/tags/${tag}`, sha }, token);
      if (r.status === 201) return { sha };
      if (r.status === 422) {
        const have = await app.call('GET', `/repos/${owner}/${name}/git/ref/tags/${encodeURIComponent(tag)}`, null, token);
        if (have.status === 200 && have.json.object?.sha === sha) return { sha };
        if (have.status === 200) throw new Error(`${tag} is already on ${String(have.json.object?.sha ?? '').slice(0, 7)}`);
      }
      throw new Error(`GitHub didn't tag ${sha.slice(0, 7)} as ${tag} (${said(r)})`);
    },
    // Delete a landed item's branch (#444). Already gone (422/404) is fine.
    async deleteBranch({ repo, branch }) {
      const [owner, name] = parts(repo);
      const r = await app.call('DELETE', `/repos/${owner}/${name}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, null, await tokenFor(repo));
      if (r.status === 204 || r.status === 422 || r.status === 404) return { deleted: r.status === 204 };
      throw new Error(`GitHub didn't delete ${branch} (${said(r)})`);
    },
    // The PR as GitHub has it now: { state: open | merged | closed, mergeable_state (clean: it can merge as
    // it is; dirty: it conflicts with its base), auto_merge, base, sha (of the merge, once merged) }.
    async pull({ repo, number }) {
      const [owner, name] = parts(repo);
      const r = await app.call('GET', `/repos/${owner}/${name}/pulls/${number}`, null, await tokenFor(repo));
      if (r.status !== 200) throw new Error(`GitHub didn't show PR #${number} (${said(r)})`);
      const pr = r.json;
      return {
        state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open', mergeable_state: pr.mergeable_state ?? 'unknown',
        auto_merge: !!pr.auto_merge, base: pr.base?.ref ?? 'main', sha: pr.merge_commit_sha ?? '', head_sha: pr.head?.sha ?? '', node_id: pr.node_id ?? '',
      };
    },
  };
}
