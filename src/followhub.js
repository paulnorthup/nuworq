// What serve --follow asks of the hub's own code, run as a short child process (#546): the supervisor
// (src/follow.js) loads only node: modules, so a commit that changes the client never restarts it.
// `node src/followhub.js red <json>` files "fix main" (see redMain in follow.js), and `ci <json>` asks GitHub whether
// CI passed a commit (#543); each prints its answer as JSON.
import { createClient, repoRemote, HubError } from './client.js';
import { findWorkspace } from './follow.js';
import { appFromEnv, appFromFile, GitHubApp, checkOn } from './ghapp.js';

const short = (sha) => String(sha).slice(0, 7);

// Main is red: one "fix main" item at priority now, in the project that lives in this repo, through the
// hub's human API (on a hub with login, that needs a human NUWORQ_TOKEN). { where: "#12 in nuworq" } or { where: null }.
// running: the commit the hub runs (the red one itself when the supervisor just started on it).
// With workspaces, every API path names one (#561): the workspace whose project lives in this repo, from their
// databases (findWorkspace), its hub at /w/<workspace>/, with a human token of that workspace in NUWORQ_TOKEN.
export async function redMain({ url, repo, sha, failed, running, workspaces = null, workspace = null, app = null }) {
  let hub, project, ws = null;
  if (workspaces) {
    const remote = repoRemote(repo);
    // When several workspaces link the repository, the one its App installation is bound to owns it (#614).
    const installation = workspace ? null : await installationOf(remote, app);
    const found = findWorkspace({ workspaces, workspace, repo, remote, installation });
    if (!found) {
      throw new Error(`no ${workspace ? `project in workspace ${workspace}` : `workspace in ${workspaces} has a project`} for ${remote || repo}. Link the repository to its project there, or name the workspace with serve --follow --workspace <name>`);
    }
    ({ workspace: ws, project } = found);
    hub = createClient({ url: `${url}/w/${encodeURIComponent(ws)}`, cwd: repo });
  } else {
    hub = createClient({ url, cwd: repo });
    project = hub.settings.project ?? (await hub.where()).project;
    if (!project) return { where: null };
  }
  const hubIs = running === sha
    ? 'The hub runs it anyway, since it just started and had nothing older to run.'
    : `The hub stays on ${short(running)}, the last commit that passed.`;
  let r;
  try {
    r = await hub.post(`/api/p/${encodeURIComponent(project)}/human/create`, {
      title: `main fails its tests at ${short(sha)}: ${failed}`.slice(0, 160),
      summary: `\`npm test\` fails on main at ${sha} (${failed}). ${hubIs} Fix main before anything else: everything that lands next builds on it.`,
      acceptance: '`npm test` passes on main, and the hub moves onto it by itself.',
      priority: 'now',
    });
  } catch (e) {
    if (ws && e instanceof HubError && [401, 403].includes(e.status)) {
      throw new Error(`workspace ${ws} refused it (${e.message}): give serve --follow a human token of that workspace in NUWORQ_TOKEN, e.g. from nuworq token create follow --role human --workspace ${ws}`);
    }
    throw e;
  }
  return { where: `${r.item} in ${ws ? `${ws}/` : ''}${project}` };
}

// The id of the hub's GitHub App installation on remote (github.com/owner/name), asked of GitHub with the App
// (NUWORQ_GITHUB_APP_*, else the app file), or null: no app, not on GitHub, not installed, or GitHub didn't answer.
async function installationOf(remote, app) {
  const conf = appFromEnv() ?? appFromFile(app);
  const m = String(remote).match(/^github\.com\/([^/]+)\/([^/]+)$/);
  if (!conf || !m) return null;
  try {
    const r = await new GitHubApp(conf).call('GET', `/repos/${m[1]}/${m[2]}/installation`);
    return r.status === 200 ? r.json?.id ?? null : null;
  } catch { return null; }
}

// CI's required `test` check on sha, from GitHub with the hub's own App: NUWORQ_GITHUB_APP_*, else the app file
// (its github-app.json). checkOn's answer, or null when there is no app or the repo isn't on GitHub.
export async function ciCheck({ repo, sha, app }) {
  const conf = appFromEnv() ?? appFromFile(app);
  return conf ? checkOn(new GitHubApp(conf), repoRemote(repo), sha) : null;
}

const OPS = { red: redMain, ci: ciCheck };

if (import.meta.filename === process.argv[1]) {
  const [op, input] = process.argv.slice(2);
  try {
    if (!OPS[op]) throw new Error(`unknown op ${op}`);
    process.stdout.write(JSON.stringify(await OPS[op](JSON.parse(input))) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e.message.split('\n')[0] }) + '\n');
    process.exitCode = 1;
  }
}
