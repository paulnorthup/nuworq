// The rail (#602): the projects, the workspace and the app's own actions, as markup from the state. Pure: it reads
// the store (fields marked 'rail' in web/store.js) and this browser's theme, and touches no page.
// Only navigation sits in it (#824): Search, Home, the projects, Archived and Connect an agent. Settings live in the
// workspace menu (its name, at the top) and help in the help menu (? Help, at the bottom); on a phone, Menu shows all
// three groups in turn. Both menus are drawn closed (hidden) until S.railOpen names one, so a repaint keeps it open.
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
  const open = S.railOpen;
  return `
    <div class="rail-pop ws-pop">
      <button class="ws-button" data-action="rail-open" data-menu="ws" aria-expanded="${open === 'ws'}" aria-controls="ws-menu" title="Your workspace: settings, notifications, appearance">${LOGO}<span class="org-name">${esc(S.me?.org ?? 'nuworq')}</span><span class="org-caret">▾</span></button>
      <div class="rail-menu-list" id="ws-menu" ${open === 'ws' ? '' : 'hidden'}>${wsMenu('ws')}</div>
    </div>
    <button class="rail-item rail-search" data-action="launcher" data-new="launcher" title="Quick launcher: go to an item, a project or a setting"><span>Search</span><kbd class="kbd-hint">${MAC ? '⌘K' : 'Ctrl K'}</kbd></button>
    <button class="rail-item rail-menu" data-action="rail-menu" aria-expanded="${!!S.railMenu}"><span data-new="phone-menu">${S.railMenu ? 'Close' : 'Menu'}</span></button><span class="rail-break"></span>
    <a class="rail-label rail-head ${!S.slug && !S.analytics ? 'on' : ''}" href="#/" title="Home: every project"><span data-new="home">Home</span>${total ? `<span class="badge" title="${needYou(total)}">${total}</span>` : ''}</a>
    <div class="rail-label rail-projects"><span>Projects</span><button class="rail-add" data-action="new-project" title="New project" aria-label="New project"><span data-new="one-name">+</span></button></div>
    ${projects || '<div class="rail-item rail-empty">No projects yet</div>'}
    <div class="rail-nav">${navMore()}</div>
    <div class="rail-foot">
      <div class="rail-pop help-pop">
        <div class="rail-menu-list" id="help-menu" ${open === 'help' ? '' : 'hidden'}>${helpMenu()}</div>
        <button class="rail-item help-button" data-action="rail-open" data-menu="help" aria-expanded="${open === 'help'}" aria-controls="help-menu"><span data-new="rail-menus"><span class="help-q" aria-hidden="true">?</span> Help</span>${waiting()}</button>
      </div>
      ${version() ? `<span class="rail-version">${version()}</span>` : ''}
    </div>
    <div class="rail-sheet">
      <div class="sheet-group"><button class="rail-item" data-action="new-project">+ Project</button>${navMore()}</div>
      <div class="sheet-group">${wsMenu('sheet')}</div>
      <div class="sheet-group">${helpMenu()}</div>
    </div>`;
}

// The rail's navigation below the projects: Archived only when there are archived projects, quiet.
const navMore = () => `${S.archived ? `<button class="rail-item rail-quiet" data-action="archived">Archived (${S.archived})</button>` : ''}
  <button class="rail-item" data-action="connect">Connect an agent</button>`;

// Workspace settings are for a workspace's owners (#799), on any hub with workspaces, payments or not.
export const wsOwner = () => !!S.billing?.owner || (!!S.me?.org && S.person?.role === 'owner');

// The workspace menu: your workspaces (one click signs you in there) and making one, on a hub with workspaces;
// then Workspace settings for its owners, Notifications, Appearance and Sign out. at: 'ws' or 'sheet', its place.
function wsMenu(at) {
  const orgs = S.me?.orgs ?? [];
  const row = (o) => `<span class="org-name">${esc(o.workspace)}</span><span class="org-role">${esc(o.role)}</span>`;
  const spaces = S.me?.org ? `<div class="menu-group">${orgs.length > 1 ? orgs.map((o) => o.current ? `<span class="org-item on">${row(o)}</span>` : `<a class="org-item" href="${esc(o.enter)}">${row(o)}</a>`).join('') : ''}
    <a class="org-item" href="${esc(S.me.new_org)}">+ New workspace</a></div>` : '';
  return `${spaces}<div class="menu-group">
    ${wsOwner() ? `<button class="rail-item" data-action="workspace-settings"><span class="name">Workspace settings</span>${S.billing?.plans?.length ? '<span class="tag now">Upgrade</span>' : ''}</button>` : ''}
    <button class="rail-item" data-action="notify">Notifications</button>
    ${appearance(at)}
    ${S.me?.auth === 'required' ? `<button class="rail-item" data-action="logout" title="Signed in as ${esc(S.me.name ?? '')}">Sign out</button>` : ''}</div>`;
}

// Appearance (#485): Match device unless this browser chose Light or Dark (web/prefs.js themeNow).
function appearance(at) {
  const now = themeNow();
  return `<div class="appearance"><span class="seg-label" id="appearance-label-${at}" data-new="appearance">Appearance</span>
    <div class="seg" role="radiogroup" aria-labelledby="appearance-label-${at}">${THEMES.map(([k, label]) =>
      `<button role="radio" aria-checked="${k === now}" tabindex="${k === now ? 0 : -1}" class="${k === now ? 'on' : ''}" data-action="theme" data-appearance="${k}">${label}</button>`).join('')}</div></div>`;
}

// The help menu: the guide, the shortcuts (? opens them anywhere), feedback on a hub that takes it, and the version.
function helpMenu() {
  const v = version();
  const changes = changelog();
  return `<div class="menu-group">
    <a class="rail-item" href="guide"><span data-new="guide">Guide</span></a>
    <button class="rail-item" data-action="shortcuts"><span class="name" data-new="shortcuts">Keyboard shortcuts</span><kbd class="kbd-hint">?</kbd></button>
    ${S.feedback?.on ? `<button class="rail-item" data-action="feedback"><span class="name" data-new="feedback">Send feedback</span>${waiting()}</button>` : ''}
    ${v ? `<div class="menu-version">${v}${changes ? ` · <a href="${esc(changes)}" target="_blank" rel="noopener">What changed</a>` : ''}</div>` : ''}</div>`;
}

// Feedback waiting for the maintainer: a count on Help too, so closing the menu hides nothing.
const waiting = () => S.feedback?.on && S.feedback.waiting
  ? `<span class="badge" title="${S.feedback.waiting.pieces} waiting for you: the home's line opens them">${S.feedback.waiting.pieces}</span>` : '';

// What is live, e.g. "v0.2.0 · c3a3008", the commit linked to GitHub when the hub's code came from there.
function version() {
  const { version: v, commit, commit_url: url } = S.info ?? {};
  if (!v && !commit) return '';
  const sha = commit ? (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(commit)}</a>` : esc(commit)) : '';
  return [v && `v${esc(v)}`, sha].filter(Boolean).join(' · ');
}
// What changed in it: the changelog as of the commit that is live, when that came from GitHub.
const changelog = () => S.info?.commit_url?.replace(/\/commit\/([0-9a-f]+)$/, '/blob/$1/CHANGELOG.md') ?? null;
