import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { guidePage } from '../src/userguide.js';
import { commands, rank } from '../web/launcher.js';
import { appSource } from './appsource.js';

// #485: each browser can set the app to Match device, Light or Dark, and no page flashes the other theme.
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

// web/theme.js run as a page would, with this storage.
function runTheme(storage) {
  const root = { dataset: {} };
  vm.runInNewContext(read('web/theme.js'), { localStorage: storage, document: { documentElement: root } });
  return root.dataset.theme;
}
const saved = (v) => ({ getItem: (k) => (k === 'nuworq:theme' ? v : null) });

describe('the appearance a browser chose applies before the first paint (#485)', () => {
  test('Light or Dark sets data-theme; Match device, anything else, or no storage sets none', () => {
    assert.equal(runTheme(saved('dark')), 'dark');
    assert.equal(runTheme(saved('light')), 'light');
    assert.equal(runTheme(saved(null)), undefined, 'Match device is the default');
    assert.equal(runTheme(saved('purple')), undefined);
    assert.equal(runTheme({ getItem: () => { throw new Error('denied'); } }), undefined, 'storage that fails: Match device');
  });

  test('every page loads it in its <head>, before its styles, as a plain blocking script', () => {
    const pages = readdirSync(new URL('../web/', import.meta.url)).filter((n) => n.endsWith('.html'));
    assert.ok(pages.length >= 10);
    for (const f of pages) {
      const html = read(`web/${f}`);
      const head = html.slice(0, html.indexOf('</head>'));
      const at = head.search(/<script src="\/?theme\.js"><\/script>/);
      assert.ok(at > 0, `${f} loads theme.js in its head`);
      assert.ok(at < head.indexOf('rel="stylesheet"'), `${f}: before its styles`);
    }
    const flow = read('src/server.js').match(/const flowPage = [^]*?<\/head>/)[0];
    assert.match(flow, /<script src="\$\{base\}\/theme\.js"><\/script>[^]*rel="stylesheet"/, "the server's flow pages");
    assert.match(guidePage({ base: '/w/acme' }), /<head>[^]*<script src="\/w\/acme\/theme\.js"><\/script>[^]*rel="stylesheet"[^]*<\/head>/, 'the getting started guide');
    assert.doesNotMatch(read('web/theme.js'), /\bimport\b|\bexport\b/, 'not a module: a module waits, and the page would paint first');
  });

  test('the hub serves it wherever those pages are: the app, the hub root and the admin host', async () => {
    const server = createServer(new Hub(), {});
    const port = await listen(server);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/theme.js`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /javascript/);
      assert.match(await r.text(), /nuworq:theme/);
    } finally { server.close(); }
    const src = read('src/server.js');
    assert.match(src, /\['\/admin\.html', '\/admin\.js', [^\]]*'\/theme\.js'\]/, 'the admin host');
    assert.match(src, /\['\/join\.html', '\/join\.js', [^\]]*'\/theme\.js'\]/, 'the hub root (join, requests, early access, the flow pages)');
  });

  test('data-theme wins over the device both ways: light on a dark device, dark on a light one', () => {
    const css = read('web/style.css');
    assert.match(css, /@media \(prefers-color-scheme: dark\) \{\n  :root:not\(\[data-theme="light"\]\) \{/, 'a dark device gets dark unless the browser chose Light');
    assert.match(css, /\n:root\[data-theme="dark"\] \{\n  --bg: #1b1d21;/, 'Dark applies on any device');
    assert.match(css, /:root\[data-theme="light"\] \{ color-scheme: light; \}/, 'and Light keeps the browser\'s own parts light too');
    assert.match(css, /html\.theming \*[^{]*\{ transition-property: none !important; \}/, 'a change applies at once, not eased in');
  });
});

describe('the Appearance setting', () => {
  test('in the rail footer: a named radio group of three, Match device first, the chosen one reached by Tab', () => {
    const app = appSource();
    assert.match(app, /\$\{appearance\(\)\}\n\s*\$\{versionLine\(\)\}\n\s*<\/div>`;/, 'in .rail-foot, which a phone opens with Menu');
    assert.match(app, /role="radiogroup" aria-labelledby="appearance-label"/);
    assert.match(app, /role="radio" aria-checked="\$\{k === now\}" tabindex="\$\{k === now \? 0 : -1\}"/);
    assert.match(app, /radioKeys\(document, '\.appearance \[role="radio"\]', /, 'arrow keys move the choice');
    assert.match(read('web/radiogroup.js'), /\{ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 \}/);
    assert.match(app, /const themeNow = \(\) => \{ const t = store\.get\('theme', 'device'\);/, 'kept in this browser; store reads in try/catch');
    assert.match(read('web/style.css'), /#rail\.menu-open \.appearance \.seg button \{ min-height: 44px;/, '44px choices on a phone');
    assert.match(read('web/new.js'), /appearance: '2026-11-01'/);
  });

  test('the launcher finds it: Appearance, Dark, Light; the current one is not offered', () => {
    const index = { projects: [], items: [], can: [] };
    const set = commands({ index, theme: 'device' }).filter((c) => c.run.theme);
    assert.deepEqual(set.map((c) => [c.label, c.run.theme, c.confirm]), [['Appearance: Light', 'light', 'Appearance: Match device → Light, in this browser only.'], ['Appearance: Dark', 'dark', 'Appearance: Match device → Dark, in this browser only.']]);
    assert.deepEqual(commands({ index, theme: 'dark' }).filter((c) => c.run.theme).map((c) => c.run.theme), ['device', 'light']);
    assert.equal(rank(index, 'Dark', { theme: 'device' })[0].label, 'Appearance: Dark');
    assert.equal(rank(index, 'Light', { theme: 'device' })[0].label, 'Appearance: Light');
    assert.ok(rank(index, 'Appearance', { theme: 'light' }).filter((r) => r.run.theme).length === 2);
  });
});
