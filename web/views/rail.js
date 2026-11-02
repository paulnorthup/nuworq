// The rail (#602): the projects, the workspace and the app's own actions, as markup from the state. Pure: it reads
// the store (fields marked 'rail' in web/store.js) and this browser's theme, and touches no page.
import { stateDot } from '../home.js';
import { THEMES } from '../launcher.js';
import { LOGO } from '../logo.js';
import { S } from '../store.js';
import { themeNow } from '../prefs.js';
import { MAC, esc, needYou } from './html.js';

export function railHtml() {
  const projects = S.projects.map((p) => `
    <a class="rail-item ${p.slug === S.slug ? 'on' : ''}" href="#/p/${encodeURIComponent(p.slug)}">
      ${stateDot(p.pulse.state)}<span class="name">${esc(p.name)}</span>
      ${p.needs ? `<span class="badge" title="${needYou(p.needs)}">${p.needs}</span>` : ''}
    </a>`).join('');
  const total = S.projects.reduce((n, p) => n + p.needs, 0);
  return `
    <div class="brand">${LOGO}<span>nuworq</span></div>
    ${orgSwitcher()}
    <button class="rail-item rail-search" data-action="launcher" data-new="launcher" title="Quick launcher: go to an item, a project or a setting"><span>Search</span><kbd class="kbd-hint">${MAC ? '⌘K' : 'Ctrl K'}</kbd></button>
    <button class="rail-item rail-menu" data-action="rail-menu" aria-expanded="${!!S.railMenu}"><span data-new="phone-menu">${S.railMenu ? 'Close' : 'Menu'}</span></button><span class="rail-break"></span>
    <a class="rail-label rail-head ${!S.slug && !S.analytics ? 'on' : ''}" href="#/" title="All projects"><span data-new="home">Projects</span>${total ? `<span class="badge" title="${needYou(total)}">${total}</span>` : ''}</a>
    ${projects || '<div class="rail-item rail-empty">No projects yet</div>'}
    <div class="rail-foot">
      <button class="rail-item" data-action="new-project">+ New project</button>
      <button class="rail-item" data-action="archived">Archived projects</button>
      <button class="rail-item" data-action="connect">Connect an agent</button>
      <button class="rail-item" data-action="notify">Notifications</button>
      <a class="rail-item" href="guide"><span data-new="guide">Getting started guide</span></a>
      <button class="rail-item kbd-hint" data-action="shortcuts"><span data-new="shortcuts"><kbd>?</kbd> Shortcuts</span></button>
      ${S.feedback?.on ? `<button class="rail-item" data-action="feedback"><span data-new="feedback">Feedback</span>${S.feedback.waiting ? `<span class="badge" title="${S.feedback.waiting.pieces} waiting for you: the home's line opens them">${S.feedback.waiting.pieces}</span>` : ''}</button>` : ''}
      ${S.billing?.owner ? `<button class="rail-item" data-action="workspace-settings"><span class="name">Workspace settings</span>${S.billing.plans?.length ? '<span class="tag now">Upgrade</span>' : ''}</button>` : ''}
      ${S.me?.auth === 'required' ? `<button class="rail-item" data-action="logout" title="Signed in as ${esc(S.me.name ?? '')}">Sign out</button>` : ''}
      ${appearance()}
      ${versionLine()}
    </div>`;
}

// Appearance (#485): Match device unless this browser chose Light or Dark (web/prefs.js themeNow).
function appearance() {
  const now = themeNow();
  return `<div class="appearance"><span class="seg-label" id="appearance-label" data-new="appearance">Appearance</span>
    <div class="seg" role="radiogroup" aria-labelledby="appearance-label">${THEMES.map(([k, label]) =>
      `<button role="radio" aria-checked="${k === now}" tabindex="${k === now ? 0 : -1}" class="${k === now ? 'on' : ''}" data-action="theme" data-appearance="${k}">${label}</button>`).join('')}</div></div>`;
}
// On a hub with workspaces: which one this is, the others you belong to (one click signs you in there),
// and making a new one.
function orgSwitcher() {
  if (!S.me?.org) return '';
  const orgs = S.me.orgs ?? [];
  const row = (o) => `<span class="org-name">${esc(o.workspace)}</span><span class="org-role">${esc(o.role)}</span>`;
  return `<details class="org-switch" ${S.orgOpen ? 'open' : ''}><summary title="Switch workspace"><span class="org-name">${esc(S.me.org)}</span><span class="org-caret">▾</span></summary>
    <div class="org-menu">${orgs.length > 1 ? orgs.map((o) => o.current ? `<span class="org-item on">${row(o)}</span>` : `<a class="org-item" href="${esc(o.enter)}">${row(o)}</a>`).join('') : ''}
    <a class="org-item" href="${esc(S.me.new_org)}">+ New workspace</a></div></details>`;
}

// What is live, e.g. "v0.2.0 · c3a3008", the commit linked to GitHub when the hub's code came from there.
function versionLine() {
  const { version, commit, commit_url: url } = S.info ?? {};
  if (!version && !commit) return '';
  const sha = commit ? (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(commit)}</a>` : esc(commit)) : '';
  return `<div class="rail-version">${[version && `v${esc(version)}`, sha].filter(Boolean).join(' · ')}</div>`;
}
