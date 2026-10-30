// Dependabot alerts come in as work (#180), the way issues do (src/issues.js): on install (every open alert of
// the project's repos), and through the dependabot_alert webhook after that. One item per alert, ever. The hub
// writes the acceptance itself, so an alert with a patched version is ready work wherever the project lets
// agents start shaped proposals; one without is a proposal asking for a decision. Severity sets priority.
// GitHub marking the alert fixed or dismissed drops its item while nobody has started it.
// takeAlert() is synchronous (inside the webhook's transaction); syncAlerts() calls GitHub through the app.
import { normRemote } from './core.js';

const ACTOR = 'github';
// What the hub's token for alerts may do: read them.
export const ALERT_PERMISSIONS = { vulnerability_alerts: 'read', metadata: 'read' };
const PRIORITY = { critical: 'now', high: 'now', medium: 'soon', moderate: 'soon', low: 'later' };
const CLOSED = { fixed: 'fixed', dismissed: 'dismissed', auto_dismissed: 'dismissed' };

const repoOf = (full) => normRemote(`github.com/${full}`);
const short = (repo) => repo.replace(/^github\.com\//, '');
const clip = (s, n) => { s = String(s ?? '').trim(); return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; };

// What an item needs to know about one alert, from GitHub's alert object.
export function alertFacts(alert) {
  const vuln = alert.security_vulnerability ?? {};
  const adv = alert.security_advisory ?? {};
  const pkg = alert.dependency?.package ?? vuln.package ?? {};
  return {
    number: alert.number, url: alert.html_url ?? '',
    package: pkg.name ?? 'a dependency', ecosystem: pkg.ecosystem ?? '',
    manifest: alert.dependency?.manifest_path ?? '',
    range: vuln.vulnerable_version_range ?? '',
    patched: vuln.first_patched_version?.identifier ?? '',
    ghsa: adv.ghsa_id ?? '', cve: adv.cve_id ?? '', about: adv.summary ?? '',
    severity: String(adv.severity ?? vuln.severity ?? 'unknown').toLowerCase(),
  };
}

// The item for an alert: { title, summary, acceptance, priority }. No patched version: no acceptance (a proposal),
// and the three ways forward for whoever decides.
export function alertItem(repo, f) {
  const id = f.ghsa || f.cve || `alert #${f.number}`;
  const advisory = f.ghsa ? `https://github.com/advisories/${f.ghsa}` : f.url;
  const facts = [
    `Dependabot alert #${f.number} on ${short(repo)}${f.about ? `: ${f.about}` : ''}`,
    [
      `- Package: ${f.package}${f.ecosystem ? ` (${f.ecosystem})` : ''}${f.manifest ? `, in ${f.manifest}` : ''}`,
      f.range && `- Vulnerable: ${f.range}`,
      `- First patched: ${f.patched || 'none yet'}`,
      `- Advisory: ${[f.ghsa, f.cve].filter(Boolean).join(' / ') || id}${advisory ? ` ${advisory}` : ''}`,
      `- Severity: ${f.severity}`,
    ].filter(Boolean).join('\n'),
  ];
  const priority = PRIORITY[f.severity] ?? 'soon';
  if (!f.patched) {
    return {
      title: clip(`Decide what to do about ${f.package} in ${short(repo)}: no patched version yet (${id}, ${f.severity})`, 160),
      summary: [...facts, `No patched version exists. Decide one of:
1. Replace the package with one that isn't affected.
2. Accept the risk: dismiss alert #${f.number} on GitHub (${f.url || 'the repository\'s Security tab'}) with the reason.
3. Wait for a patched version: GitHub updates the alert when one is published.`, `From ${f.url}`].join('\n\n'),
      acceptance: '', priority,
    };
  }
  return {
    title: clip(`${f.package} is at ${f.patched} or later in ${short(repo)} (${id}, ${f.severity})`, 160),
    summary: [...facts, `From ${f.url}`].join('\n\n'),
    acceptance: `${f.package} resolves to ${f.patched} or later on main (manifest and lockfile), the project's tests pass, and GitHub shows alert #${f.number} as fixed.`,
    priority,
  };
}

// One alert as GitHub says it is now (from a webhook or a listing). Creates, brings back or drops its item.
// Returns what happened, or { ignored } with why.
export function takeAlert(hub, p, repo, alert) {
  if (!alert?.number) return { ignored: 'no alert' };
  repo = normRemote(repo);
  if (!hub.remotesOf(p).includes(repo)) return { ignored: `${repo} isn't one of ${p.name}'s repositories` };
  const row = hub.q('SELECT * FROM alerts WHERE project_id = ? AND repo = ? AND number = ?').get(p.id, repo, alert.number);
  const item = row ? hub.itemById(row.item_id) : null;
  const t = hub.now();
  const closed = CLOSED[alert.state];
  if (closed) {
    if (!row || row.state !== 'open') return { ignored: alert.state };
    hub.q('UPDATE alerts SET state = ?, updated_at = ? WHERE project_id = ? AND repo = ? AND number = ?').run(closed, t, p.id, repo, alert.number);
    if (['proposed', 'ready'].includes(item.stage) && !item.holder) {
      hub.move(item, 'dropped', ACTOR, { holder: null, lease_until: null });
      hub.event(p, { item, actor: ACTOR, type: 'alert', headline: `#${item.seq} dropped: GitHub marked its Dependabot alert ${closed}`, summary: `${row.url} was ${closed} before anyone started on it. If GitHub reopens the alert, the item comes back.`, data: { url: row.url, state: closed } });
      return { item: `#${item.seq}`, dropped: true };
    }
    if (!['done', 'dropped'].includes(item.stage)) {
      hub.event(p, { item, actor: ACTOR, type: 'comment', headline: `GitHub marked Dependabot alert #${alert.number} ${closed}; #${item.seq} goes on`, summary: `${row.url} is ${closed} while #${item.seq} is ${item.stage}. Nothing changed here: check whether the work is still needed.`, data: { url: row.url, state: closed } });
    }
    return { item: `#${item.seq}`, noted: true };
  }
  if (alert.state !== 'open') return { ignored: alert.state || 'no state' };
  if (!row) {
    const shape = alertItem(repo, alertFacts(alert));
    const created = hub.createItem(p, ACTOR, { ...shape, repo });
    hub.q(`INSERT INTO alerts (project_id, repo, number, item_id, state, url, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)`)
      .run(p.id, repo, alert.number, created.id, alert.html_url ?? '', t);
    return { item: `#${created.seq}`, created: true };
  }
  if (row.state === 'open') return { item: `#${item.seq}`, ignored: 'already in' };
  hub.q(`UPDATE alerts SET state = 'open', updated_at = ? WHERE project_id = ? AND repo = ? AND number = ?`).run(t, p.id, repo, alert.number);
  if (item.stage === 'dropped') {
    hub.move(item, item.acceptance && p.autonomy !== 'ask' ? 'ready' : 'proposed', ACTOR);
    hub.event(p, { item, actor: ACTOR, type: 'alert', headline: `#${item.seq} is back: GitHub reopened its Dependabot alert`, data: { url: row.url, state: 'open' } });
  }
  return { item: `#${item.seq}`, reopened: true };
}

// The dependabot_alert webhook: { action, alert, repository }. The alert's own state says what to do.
export function alertEvent(hub, p, body) {
  if (!['created', 'reopened', 'reintroduced', 'auto_reopened', 'fixed', 'dismissed', 'auto_dismissed'].includes(body.action)) return { ignored: body.action || 'no action' };
  return takeAlert(hub, p, repoOf(body.repository?.full_name ?? ''), body.alert);
}

// What a person does when the hub can't read a repository's alerts, as numbered steps (the steps decision).
export function accessSteps(repo, problem, url) {
  if (problem === 'permission') {
    return [
      { do: "Open the nuworq GitHub App's installation settings", where: url },
      { do: 'Click "Review request", then "Accept new permissions" (Dependabot alerts: read)', check: "This line in the project's GitHub dialog turns green" },
    ];
  }
  if (problem === 'off') {
    return [
      { do: `Open ${short(repo)}'s code security settings`, where: url },
      { do: 'Next to "Dependabot alerts", click "Enable"', check: "This line in the project's GitHub dialog turns green, and open alerts arrive as items within a minute" },
    ];
  }
  return [];
}

// Where the app's installation on a repository is managed: a person's own settings, or their GitHub organization's.
const installationUrl = (web, inst) => (!inst.account?.login || inst.account.type === 'User'
  ? `${web}/settings/installations/${inst.id}`
  : `${web}/organizations/${inst.account.login}/settings/installations/${inst.id}`);

// Every open alert of one repository through the app, or { problem, url, detail } when it can't read them.
async function openAlerts(app, repo) {
  const [, owner, name] = repo.match(/^github\.com\/([^/]+)\/([^/]+)$/) ?? [];
  if (!owner) return { problem: 'error', detail: `${repo} isn't a GitHub repository` };
  const web = app.web ?? 'https://github.com';
  const inst = await app.call('GET', `/repos/${owner}/${name}/installation`);
  const perm = { problem: 'permission', url: inst.json?.id ? installationUrl(web, inst.json) : `${web}/settings/installations` };
  if (inst.status === 200 && inst.json.permissions && !inst.json.permissions.vulnerability_alerts) return { ...perm, detail: 'the installation has no "Dependabot alerts" permission' };
  let token;
  try {
    ({ token } = await app.mint(repo, ALERT_PERMISSIONS));
  } catch (e) {
    return /not granted/i.test(e.message) ? { ...perm, detail: e.message } : { problem: 'error', detail: e.message };
  }
  const alerts = [];
  let url = `${app.api}/repos/${owner}/${name}/dependabot/alerts?state=open&per_page=100`;
  for (let page = 0; url && page < 50; page++) {
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'nuworq' }, signal: AbortSignal.timeout(10_000) });
    const json = await r.json().catch(() => null);
    if (r.status !== 200 || !Array.isArray(json)) {
      const detail = `${r.status}${json?.message ? `: ${json.message}` : ''}`;
      if (r.status === 403 && /not accessible by integration/i.test(json?.message ?? '')) return { ...perm, detail };
      if (r.status === 403) return { problem: 'off', url: `${web}/${owner}/${name}/settings/security_analysis`, detail };
      return { problem: 'error', detail: `GitHub listed no alerts (${detail})` };
    }
    alerts.push(...json);
    // GitHub pages alerts by cursor (the Link header); the token only ever goes back to GitHub's API.
    const next = r.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    url = next?.startsWith(`${app.api}/`) ? next : null;
  }
  return { alerts };
}

// Every open alert of these repositories comes in. Never throws: a repository whose alerts it can't read is
// recorded (accessOf shows it with the steps), and the others still come in.
export async function syncAlerts(hub, p, app, repos) {
  let seen = 0;
  const problems = [];
  for (const repo of repos) {
    let r;
    try { r = await openAlerts(app, repo); } catch (e) { r = { problem: 'error', detail: e.message }; }
    hub.q(`INSERT INTO alert_access (project_id, repo, problem, url, detail, at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (project_id, repo) DO UPDATE SET problem = excluded.problem, url = excluded.url, detail = excluded.detail, at = excluded.at`)
      .run(p.id, repo, r.problem ?? '', r.url ?? '', r.detail ?? '', hub.now());
    if (r.problem) { problems.push(`${short(repo)}: ${r.problem}`); continue; }
    hub.tx(() => { for (const alert of r.alerts) takeAlert(hub, p, repo, alert); });
    seen += r.alerts.length;
  }
  hub.changed(p);
  return { alerts: seen, ...(problems.length ? { problems } : {}) };
}

const LINES = {
  '': (repo) => `Dependabot alerts on ${short(repo)} come in as items.`,
  off: (repo) => `Dependabot alerts are off for ${short(repo)}, so none come in.`,
  permission: (repo) => `The nuworq GitHub App can't read ${short(repo)}'s Dependabot alerts: its installation hasn't accepted the new permission.`,
  error: (repo) => `The hub couldn't read ${short(repo)}'s Dependabot alerts.`,
};

// For the project's GitHub dialog: one line per GitHub repository, with the steps when a person has to act.
export function accessOf(hub, p) {
  return hub.remotesOf(p).filter((r) => r.startsWith('github.com/')).map((repo) => {
    const row = hub.q('SELECT * FROM alert_access WHERE project_id = ? AND repo = ?').get(p.id, repo);
    if (!row) return { repo, state: 'unknown', line: `Not checked yet whether ${short(repo)}'s Dependabot alerts can come in.` };
    const state = row.problem || 'on';
    const steps = accessSteps(repo, row.problem, row.url);
    const line = LINES[row.problem](repo) + (row.problem === 'error' && row.detail ? ` GitHub said: ${row.detail}` : '');
    return { repo, state, line,...(steps.length ? { steps } : {}), ...(row.detail ? { detail: row.detail } : {}), checked_at: row.at };
  });
}
