// Names in one form, with no database behind them: a project's slug and a repository's remote. The client side
// (src/client.js, the MCP server, git's credential helper) needs only these, and importing them from core.js
// loaded node:sqlite with them, which Node 22 announces with an ExperimentalWarning on every command (#257).
const str = (v) => (v == null ? '' : String(v).trim());

// A git remote in the one form every clone shares: host/owner/repo. ssh, scp-style and https forms
// of the same repository compare equal (git@github.com:Acme/api.git → github.com/acme/api). A path
// (a repository on this machine) keeps its case: unlike GitHub, a filesystem may care.
export function normRemote(url) {
  let s = str(url);
  if (!s) return '';
  const scp = !/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && s.match(/^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):\d*(?=\/|$)/, '$1');
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return s.startsWith('/') ? s : s.toLowerCase();
}

export function slugify(s) {
  return str(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
