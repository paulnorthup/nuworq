// A GitHub App as the only door to a repository: the hub holds the app's private key, and for each
// worker that needs to push it mints an installation token restricted to the one repository the
// item lands in, with only the permissions work needs. GitHub expires it after an hour. Agents never
// hold a long-lived GitHub credential; git asks for the token through `nuworq git-credential`.
// fetch and node:crypto only.
import { createSign, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { UserError } from './core.js';
import { envVar } from './names.js';

// What a worker's token may do: push branches, open pull requests, read CI. Nothing else.
export const WORK_PERMISSIONS = { contents: 'write', pull_requests: 'write', checks: 'read', metadata: 'read' };
// What a worker's token may do to clone a project's repository before it holds an item: read it.
export const CLONE_PERMISSIONS = { contents: 'read', metadata: 'read' };

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

// NUWORQ_GITHUB_APP_ID and the key: NUWORQ_GITHUB_APP_KEY (PEM) or NUWORQ_GITHUB_APP_KEY_FILE. null when unset.
export function appFromEnv(env = process.env) {
  const id = envVar('GITHUB_APP_ID', env);
  const file = envVar('GITHUB_APP_KEY_FILE', env);
  const key = envVar('GITHUB_APP_KEY', env) || (file ? readFileSync(file, 'utf8') : '');
  return id && key ? { id, key, slug: envVar('GITHUB_APP_SLUG', env) || '' } : null;
}

// The app the hub made for itself (one click, below), kept in a file only the hub's user can read. null if none.
export function appFromFile(file) {
  try {
    const a = JSON.parse(readFileSync(file, 'utf8'));
    return a.id && a.key ? a : null;
  } catch { return null; }
}

// What the hub asks GitHub to create: the permissions work needs, nothing more. The webhook URL is
// registered but off until the hub receives app webhooks; redirect_url brings the owner back here.
export function manifest(base, name) {
  return {
    name: String(name).slice(0, 34), url: base, public: false,
    hook_attributes: { url: `${base}/api/hooks/github-app`, active: false },
    redirect_url: `${base}/api/github/app/callback`,
    default_permissions: { contents: 'write', pull_requests: 'write', checks: 'read', metadata: 'read', issues: 'write' },
    default_events: [],
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
  // api: GitHub's REST API (tests point it at a stub). now: for tests.
  constructor({ id, key, slug = '', api = 'https://api.github.com', now = () => Date.now() }) {
    this.id = String(id);
    this.key = createPrivateKey(key);
    this.slug = slug;
    this.api = api.replace(/\/+$/, '');
    this.now = now;
  }

  // The app's own credential: a JWT signed with its key, good for ~10 minutes (backdated a minute for clock skew).
  jwt() {
    const t = Math.floor(this.now() / 1000);
    const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: t - 60, exp: t + 540, iss: this.id })}`;
    return `${body}.${createSign('RSA-SHA256').update(body).sign(this.key).toString('base64url')}`;
  }

  // token: an installation token, to act on a repository; the app's JWT otherwise.
  async call(method, path, body, token = this.jwt()) {
    const r = await fetch(`${this.api}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'nuworq', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
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
    const tok = await this.call('POST', `/app/installations/${inst.json.id}/access_tokens`, { repositories: [name], permissions });
    if (tok.status === 403 || tok.status === 404) {
      throw new UserError(`GitHub refused a token for ${owner}/${name}: the app's installation there is suspended or removed`, {
        status: 424, hint: `An owner of ${owner} re-enables it: ${this.installUrl()}.`,
      });
    }
    if (tok.status !== 201 || !tok.json.token) throw new UserError(`GitHub didn't issue a token for ${owner}/${name} (${tok.status}${tok.json.message ? `: ${tok.json.message}` : ''})`, { status: 502 });
    return { token: tok.json.token, expires_at: tok.json.expires_at, repo: `github.com/${owner}/${name}` };
  }
}

// What the hub does on GitHub to land accepted work through a pull request (#63), as the app, on the one
// repository: open the PR (or find the one already open for the branch) and turn on auto-merge (squash).
export function prClient(app) {
  const parts = (repo) => String(repo).match(/^github\.com\/([^/]+)\/([^/]+)$/)?.slice(1) ?? [];
  const shape = (pr) => ({ number: pr.number, url: pr.html_url, node_id: pr.node_id, head_ref: pr.head?.ref, head_sha: pr.head?.sha });
  return {
    app,
    covers: (repo) => parts(repo).length === 2, // GitHub repositories only
    async openPr({ repo, head, base, title, body }) {
      const [owner, name] = parts(repo);
      const { token } = await app.mint(repo);
      const r = await app.call('POST', `/repos/${owner}/${name}/pulls`, { title, head, base, body }, token);
      if (r.status === 201) return shape(r.json);
      // Already open for this branch (opened by hand, or by an earlier try): use that one.
      if (r.status === 422) {
        const open = await app.call('GET', `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`, null, token);
        if (open.status === 200 && open.json[0]) return shape(open.json[0]);
      }
      throw new Error(`GitHub didn't open the pull request (${r.status}${r.json.message ? `: ${r.json.message}` : ''}${r.json.errors?.[0]?.message ? `; ${r.json.errors[0].message}` : ''})`);
    },
    async autoMerge({ repo, id }) {
      const { token } = await app.mint(repo);
      const r = await app.call('POST', '/graphql', {
        query: 'mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { clientMutationId } }',
        variables: { id },
      }, token);
      const error = r.json.errors?.[0]?.message;
      if (r.status !== 200 || error) throw new Error(error ?? `GitHub answered ${r.status}`);
    },
  };
}
