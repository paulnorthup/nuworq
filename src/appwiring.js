// Whether the hub's GitHub App hears and may do what the hub handles (#220): GitHub says what the App subscribes to
// and may do (GET /app); the hub compares that with APP_EVENTS and the manifest's permissions. The live App once
// went without any events and nothing said so. What's missing reaches the hub's owners as one entry, with the steps.
import { APP_EVENTS, manifest } from './ghapp.js';

const LEVEL = { none: 0, read: 1, write: 2, admin: 3 };

// What GitHub calls them on the App's permissions page, and what doesn't work without them.
const PERMISSIONS = {
  contents: { label: 'Contents', without: "workers can't push their branches" },
  pull_requests: { label: 'Pull requests', without: "accepted work can't land through a pull request" },
  checks: { label: 'Checks', without: "the hub can't see CI on pull requests" },
  metadata: { label: 'Metadata', without: "the hub can't see the repositories" },
  issues: { label: 'Issues', without: "GitHub issues won't come in as work, and the hub can't comment on or close them" },
  vulnerability_alerts: { label: 'Dependabot alerts', without: "Dependabot alerts won't come in as work" },
};
const EVENTS = {
  issues: { label: 'Issues', without: "new GitHub issues won't come in as work" },
  issue_comment: { label: 'Issue comment', without: "reporters' replies on GitHub won't reach the questions asked of them" },
  pull_request: { label: 'Pull request', without: 'the hub hears about merged or closed pull requests only on its once-a-minute check' },
  pull_request_review: { label: 'Pull request review', without: "reviews on landing pull requests won't reach the hub" },
  check_suite: { label: 'Check suite', without: "CI results on pull requests won't reach the hub" },
  check_run: { label: 'Check run', without: "CI results on pull requests won't reach the hub" },
  dependabot_alert: { label: 'Dependabot alert', without: "new Dependabot alerts won't come in as work" },
};

// GitHub's view of the App (GET /app) against what the hub needs. events: whether to check events at all (a hub
// GitHub can't deliver to has none, on purpose). { events: [...], permissions: [{ name, want, have }] }, or null
// when nothing is missing.
export function wiringGaps(gh, { events = true } = {}) {
  const want = manifest('https://hub.invalid', 'nuworq').default_permissions;
  const have = gh?.permissions ?? {};
  const permissions = Object.entries(want).filter(([k, v]) => (LEVEL[have[k]] ?? 0) < LEVEL[v]).map(([name, w]) => ({ name, want: w, have: have[name] ?? 'none' }));
  const subscribed = new Set(gh?.events ?? []);
  const missing = events ? APP_EVENTS.filter((e) => !subscribed.has(e)) : [];
  return permissions.length || missing.length ? { events: missing, permissions } : null;
}

// The App's permissions and events page on GitHub: under its owner's settings, a person's or an organization's.
export function appSettingsUrl(gh, web = 'https://github.com') {
  const slug = gh?.slug;
  if (!slug) return `${web}/settings/apps`;
  const owner = gh.owner;
  return owner?.login && owner.type !== 'User'
    ? `${web}/organizations/${owner.login}/settings/apps/${slug}/permissions`
    : `${web}/settings/apps/${slug}/permissions`;
}

const level = (v) => (v === 'write' ? 'Read and write' : 'Read-only');
const unique = (xs) => [...new Set(xs)];

// The Needs you entry for what's missing: { key, headline, why, how }, how as numbered steps (the steps decision).
export function wiringEntry(w) {
  const { gaps, url, installations, since } = w;
  const broken = unique([...gaps.permissions.map((p) => PERMISSIONS[p.name]?.without), ...gaps.events.map((e) => EVENTS[e]?.without)].filter(Boolean));
  const parts = [
    gaps.permissions.length && `${gaps.permissions.length === 1 ? 'a permission' : `${gaps.permissions.length} permissions`}`,
    gaps.events.length && `${gaps.events.length === 1 ? 'an event' : `${gaps.events.length} events`}`,
  ].filter(Boolean).join(' and ');
  const how = [{ do: "Open the nuworq GitHub App's permissions and events page", where: url }];
  if (gaps.permissions.length) {
    how.push({ do: `Under "Repository permissions", set ${gaps.permissions.map((p) => `${PERMISSIONS[p.name]?.label ?? p.name} to "${level(p.want)}"`).join(', ')}` });
  }
  if (gaps.events.length) {
    how.push({ do: `Under "Subscribe to events", tick ${gaps.events.map((e) => `"${EVENTS[e]?.label ?? e}"`).join(', ')}` });
  }
  how.push({ do: 'Click "Save changes" at the bottom of the page', check: 'GitHub says the app was updated' });
  if (gaps.permissions.length) {
    how.push({
      do: 'On each installation, click "Review request", then "Accept new permissions": GitHub asks every account the App is installed on',
      where: installations,
      check: 'This entry clears within an hour, once GitHub reports the App has them',
    });
  } else {
    how[how.length - 1].check = 'GitHub says the app was updated; this entry clears within an hour, once GitHub reports the events';
  }
  return {
    key: `app-wiring:${[...gaps.permissions.map((p) => p.name), ...gaps.events].sort().join(',')}`,
    at: since,
    headline: `The hub's GitHub App is missing ${parts}: ${broken[0]}${broken.length > 1 ? `, and ${broken.length - 1} more` : ''}`,
    sub: [gaps.permissions.length && `permissions: ${gaps.permissions.map((p) => PERMISSIONS[p.name]?.label ?? p.name).join(', ')}`,
      gaps.events.length && `events: ${gaps.events.map((e) => EVENTS[e]?.label ?? e).join(', ')}`].filter(Boolean).join(' · '),
    why: `Without them:\n${broken.map((b) => `- ${b}`).join('\n')}\n\nThe hub asks GitHub what the App has once a day (hourly while something is missing).`,
    how,
  };
}

// Ask GitHub now. { gaps, url, installations } (gaps null: all there), or null when GitHub didn't answer.
export async function checkWiring(app, { events = true } = {}) {
  let r;
  try { r = await app.call('GET', '/app'); } catch { return null; }
  if (r.status !== 200 || !r.json || typeof r.json !== 'object') return null;
  const web = app.web ?? 'https://github.com';
  const owner = r.json.owner;
  return {
    gaps: wiringGaps(r.json, { events }),
    url: appSettingsUrl(r.json, web),
    installations: owner?.login && owner.type !== 'User' ? `${web}/organizations/${owner.login}/settings/installations` : `${web}/settings/installations`,
  };
}
