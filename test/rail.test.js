import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setState } from '../web/store.js';
import { railHtml } from '../web/views/rail.js';
import { commands, rank } from '../web/launcher.js';
import { NEW } from '../web/new.js';
import { appSource } from './appsource.js';

// #824: the rail is only navigation. Settings move into the workspace menu (its name, at the top), help into the
// help menu (? Help, at the foot), and Menu on a phone shows the three groups in turn. Nothing gets harder to reach.

const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
const pulse = { state: 'calm' };
const owner = () => setState({
  me: { org: 'acme', orgs: [{ workspace: 'acme', role: 'owner', current: true }, { workspace: 'beta', role: 'member', enter: '/w/beta/' }], new_org: '/new', auth: 'required', name: '@ann' },
  person: { person: '@ann', role: 'owner' }, billing: null, feedback: { on: true }, info: { version: '0.9.0', commit: 'abc1234', commit_url: 'https://github.com/acme/nuworq/commit/abc1234def' },
  projects: [{ slug: 'a', name: 'Alpha', needs: 2, pulse }, { slug: 'b', name: 'Beta', needs: 0, pulse }], archived: 0, railOpen: null, slug: null,
});
// The <div> that starts at `at`, to its own closing tag.
function div(html, at) {
  let depth = 0;
  for (const m of html.slice(at).matchAll(/<div\b|<\/div>/g)) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (!depth) return html.slice(at, at + m.index + 6);
  }
  throw new Error('unclosed div');
}
const menu = (html, id) => div(html, html.indexOf(`<div class="rail-menu-list" id="${id}"`));
const between = (html, id) => menu(html, id).replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '');
// The rail's own part: everything outside the two menus and the phone's sheet.
const rail = () => {
  const h = railHtml();
  return h.replace(menu(h, 'ws-menu'), '').replace(menu(h, 'help-menu'), '').replace(/<div class="rail-sheet">[\s\S]*$/, '');
};
const actions = (html) => [...html.matchAll(/data-action="([\w-]+)"/g)].map((m) => m[1]);

describe('the rail is only navigation (#824)', () => {
  test('top to bottom: the workspace name ▾, Search, Home, Projects with +, each project, Connect an agent, ? Help and the version', () => {
    owner();
    const r = rail();
    assert.deepEqual(actions(r), ['rail-open', 'launcher', 'rail-menu', 'new-project', 'connect', 'rail-open']);
    assert.match(r, /class="ws-button" data-action="rail-open" data-menu="ws" aria-expanded="false" aria-controls="ws-menu"[^>]*>.*<span class="org-name">acme<\/span><span class="org-caret">▾<\/span><\/button>/);
    assert.match(r, /href="#\/"[^>]*><span data-new="home">Home<\/span><span class="badge"[^>]*>2<\/span>/, 'Home with its count');
    assert.match(r, /<span>Projects<\/span><button class="rail-add" data-action="new-project"[^>]*aria-label="New project"/);
    assert.ok(r.indexOf('Alpha') < r.indexOf('Beta') && r.indexOf('Beta') < r.indexOf('Connect an agent'));
    assert.match(r, /data-menu="help" aria-expanded="false" aria-controls="help-menu"><span data-new="rail-menus"><span class="help-q" aria-hidden="true">\?<\/span> Help<\/span><\/button>\s*<\/div>\s*<span class="rail-version">v0\.9\.0 · <a href="https:\/\/github\.com\/acme\/nuworq\/commit\/abc1234def"/);
    for (const gone of ['Notifications', 'Guide', 'Shortcuts', 'Feedback', 'Workspace settings', 'Sign out', 'Appearance', 'Archived']) assert.ok(!r.includes(gone), `${gone} left the rail`);
    assert.equal(NEW['rail-menus'], '2026-11-03');
  });

  test('Archived (n) shows, quiet, only when there are archived projects', () => {
    owner();
    assert.ok(!railHtml().includes('data-action="archived"'));
    setState({ archived: 3 });
    assert.match(rail(), /<button class="rail-item rail-quiet" data-action="archived">Archived \(3\)<\/button>/);
  });

  test('without workspaces the menu still has a name to open it by', () => {
    owner();
    setState({ me: { auth: 'local' }, person: { person: 'you', role: 'owner' } });
    assert.match(rail(), /<span class="org-name">nuworq<\/span><span class="org-caret">▾<\/span>/);
    const ws = between(railHtml(), 'ws-menu');
    assert.ok(!ws.includes('New workspace') && !ws.includes('Sign out') && !ws.includes('workspace-settings'));
    assert.match(ws, /data-action="notify"/);
  });
});

describe('the workspace menu and the help menu (#824)', () => {
  test('the workspace menu: workspaces, New workspace, Workspace settings, Notifications, Appearance, Sign out', () => {
    owner();
    const ws = between(railHtml(), 'ws-menu');
    for (const s of ['<span class="org-item on"><span class="org-name">acme', 'href="/w/beta/"', '+ New workspace']) assert.ok(ws.includes(s), s);
    assert.deepEqual(actions(ws), ['workspace-settings', 'notify', 'theme', 'theme', 'theme', 'logout']);
    assert.match(ws, /<span class="name">Workspace settings<\/span>/);
    assert.match(ws, /role="radiogroup" aria-labelledby="appearance-label-ws"/);
  });

  test("a member who isn't an owner sees no Workspace settings", () => {
    owner();
    setState({ person: { person: '@bob', role: 'member' } });
    assert.ok(!railHtml().includes('workspace-settings'));
  });

  test('the help menu: Guide, Keyboard shortcuts, Send feedback where the hub takes it, the version and what changed', () => {
    owner();
    const help = between(railHtml(), 'help-menu');
    assert.match(help, /<a class="rail-item" href="guide"><span data-new="guide">Guide<\/span><\/a>/);
    assert.deepEqual(actions(help), ['shortcuts', 'feedback']);
    assert.match(help, /Keyboard shortcuts<\/span><kbd class="kbd-hint">\?<\/kbd>/);
    assert.match(help, /v0\.9\.0 · <a[^>]*>abc1234<\/a> · <a href="https:\/\/github\.com\/acme\/nuworq\/blob\/abc1234def\/CHANGELOG\.md"[^>]*>What changed<\/a>/);
    setState({ feedback: { on: false } });
    assert.ok(!between(railHtml(), 'help-menu').includes('feedback'));
  });

  test('feedback waiting shows on ? Help too, so a closed menu hides nothing', () => {
    owner();
    setState({ feedback: { on: true, waiting: { pieces: 4 } } });
    assert.match(rail(), /Help<\/span><span class="badge"[^>]*>4<\/span><\/button>/);
  });

  test('closed, both are hidden; S.railOpen opens one, and its button says so', () => {
    owner();
    assert.match(railHtml(), /id="ws-menu" hidden/);
    assert.match(railHtml(), /id="help-menu" hidden/);
    setState({ railOpen: 'help' });
    const h = railHtml();
    assert.match(h, /id="help-menu" >/);
    assert.match(h, /id="ws-menu" hidden/);
    assert.match(h, /data-menu="help" aria-expanded="true"/);
    setState({ railOpen: null });
  });

  test('open by click or keyboard (they are buttons), shut on a pick, a click outside or Escape', () => {
    const app = appSource();
    assert.match(app, /'rail-open': \(el\) => openRailMenu\(el\.dataset\.menu\)/);
    assert.match(readFileSync(new URL('../web/shortcuts.js', import.meta.url), 'utf8'), /\{ id: 'menu-close', where: 'Everywhere', keys: \['Esc'\], does: 'Close the open menu', match: \(e, c\) => e\.key === 'Escape' && c\.menu \}/);
    assert.match(app, /launcher: L\.open, menu: !!S\.railOpen,/);
    assert.match(app, /'menu-close': \(\) => closeRailMenu\(\{ focus: true \}\),/);
    assert.match(app, /if \(!S\.railOpen \|\| e\.target\.closest\?\.\('\[data-action="rail-open"\]'\)\) return;/);
    assert.match(app, /\$\(`#\$\{menu\}-menu`\)\?\.querySelector\('a\[href\], button:not\(\[tabindex="-1"\]\)'\)\?\.focus\(\)/, 'opening focuses its first entry');
    assert.match(css, /\.rail-menu-list\[hidden\] \{ display: none; \}/);
  });
});

describe("on a phone, Menu shows the rail's entries, then the workspace menu's, then the help menu's (#824)", () => {
  test('one sheet, three groups in that order', () => {
    owner();
    setState({ archived: 1 });
    const sheet = railHtml().match(/<div class="rail-sheet">([\s\S]*)$/)[1];
    assert.deepEqual(actions(sheet), ['new-project', 'archived', 'connect', 'workspace-settings', 'notify', 'theme', 'theme', 'theme', 'logout', 'shortcuts', 'feedback']);
    assert.ok(sheet.includes('+ New workspace') && sheet.includes('href="guide"') && sheet.includes('What changed'));
    assert.match(sheet, /aria-labelledby="appearance-label-sheet"/, 'its own Appearance label');
  });
});

describe('⌘K finds whatever left the rail, by its name (#824)', () => {
  const index = { projects: [], items: [], can: [] };
  test('Archived projects, Guide, Send feedback, Appearance, Sign out, Notifications, Keyboard shortcuts, Workspace settings', () => {
    const labels = commands({ index, billingOwner: true, feedback: true, signOut: true }).map((c) => c.label);
    for (const l of ['Archived projects', 'Guide', 'Send feedback', 'Sign out', 'Notifications', 'Keyboard shortcuts', 'Workspace settings', 'Connect an agent', 'Appearance: Dark']) assert.ok(labels.includes(l), l);
    for (const [q, label] of [['archived', 'Archived projects'], ['guide', 'Guide'], ['feedback', 'Send feedback'], ['sign out', 'Sign out'], ['appearance', 'Appearance: Light']]) {
      assert.equal(rank(index, q, { feedback: true, signOut: true })[0].label, label, q);
    }
    assert.deepEqual(commands({ index, signOut: true }).find((c) => c.label === 'Guide').run, { action: 'guide' });
  });
  test('only where they apply: no Send feedback on a hub that takes none, no Sign out without signing in', () => {
    const labels = commands({ index }).map((c) => c.label);
    assert.ok(!labels.includes('Send feedback') && !labels.includes('Sign out'));
    assert.match(appSource(), /feedback: !!S\.feedback\?\.on, signOut: S\.me\?\.auth === 'required'/, 'the app passes both');
  });
});
