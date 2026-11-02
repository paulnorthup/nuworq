import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { missingProject } from '../web/missing.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// #143: a link to a project that isn't here says so, instead of quietly showing the home.
describe('a link to a project that isn\'t here', () => {
  test('never there (or renamed): one line saying so, with the way out', () => {
    const html = missingProject({ slug: 'does-not-exist', archived: null }, { esc });
    assert.match(html, /No project "does-not-exist": it may have been archived, renamed or never existed\./);
    assert.match(html, /<a href="#\/">Home<\/a>/);
    assert.match(html, /data-action="archived">Archived projects</);
    assert.ok(!html.includes('restore-project'));
  });

  test('archived: names it and restores it from there', () => {
    const html = missingProject({ slug: 'old-api', archived: { slug: 'old-api', name: 'Old API' } }, { esc });
    assert.match(html, /<b>Old API<\/b> is archived: its items and history are kept\./);
    assert.match(html, /data-action="restore-project" data-slug="old-api">Restore it</);
  });

  test('the slug from the address is escaped', () => {
    assert.ok(!missingProject({ slug: '<img src=x>', archived: null }, { esc }).includes('<img'));
  });

  test('the page renders it whenever the address names a project the hub doesn\'t list', () => {
    const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    assert.match(app, /if \(!S\.projects\.some\(\(p\) => p\.slug === slug\)\) \{/);
    assert.match(app, /if \(S\.missing\) return missingProject\(S\.missing, \{ esc \}\);/);
  });
});
