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

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

// NUWORQ_GITHUB_APP_ID and the key: NUWORQ_GITHUB_APP_KEY (PEM) or NUWORQ_GITHUB_APP_KEY_FILE. null when unset.
export function appFromEnv(env = process.env) {
  const id = envVar('GITHUB_APP_ID', env);
  const file = envVar('GITHUB_APP_KEY_FILE', env);
  const key = envVar('GITHUB_APP_KEY', env) || (file ? readFileSync(file, 'utf8') : '');
  return id && key ? { id, key, slug: envVar('GITHUB_APP_SLUG', env) || '' } : null;
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

  async call(method, path, body) {
    const r = await fetch(`${this.api}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.jwt()}`, accept: 'application/vnd.github+json', 'user-agent': 'nuworq', ...(body ? { 'content-type': 'application/json' } : {}) },
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
