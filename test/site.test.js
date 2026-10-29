import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// nuworq.com (#111): one static page, fast on mobile, honest, in light and dark.
const SITE = fileURLToPath(new URL('../site/', import.meta.url));
const html = readFileSync(join(SITE, 'index.html'), 'utf8');
const css = readFileSync(join(SITE, 'style.css'), 'utf8');
const FORM = 'https://app.nuworq.com/early-access'; // #112's form

describe('the landing page', () => {
  test('small, with nothing from third parties', () => {
    const bytes = readdirSync(SITE).reduce((n, f) => n + statSync(join(SITE, f)).size, 0);
    assert.ok(bytes < 60_000, `${bytes} bytes`);
    // One small inline script (#119: old #/ links go on to the app), allowed by hash; nothing loaded from anywhere.
    assert.equal(html.match(/<script/gi).length, 1, 'one script');
    assert.match(html, /<script>[^<]{1,300}<\/script>/, 'inline and small');
    assert.doesNotMatch(html, /<script[^>]*\ssrc=/i, 'no external scripts');
    for (const [, href] of html.matchAll(/<link[^>]+href="([^"]+)"/g)) assert.ok(!/^(https?:)?\/\//.test(href), `no external stylesheet or font: ${href}`);
    assert.doesNotMatch(css, /@import|url\((['"]?)https?:/, 'no external CSS resources');
  });

  test('mobile viewport, light and dark', () => {
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<meta name="color-scheme" content="light dark">/);
    assert.match(css, /color-scheme: light dark/);
    assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  });

  test('promise, how it works, why it is different, pricing, FAQ, in that order; the button reaches the form', () => {
    const order = ['promise', 'how', 'why', 'pricing', 'faq'].map((id) => html.indexOf(`<section id="${id}"`));
    assert.ok(order.every((i) => i > 0), `all sections present: ${order}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(html, new RegExp(`<a class="button" id="request" href="${FORM}">Request early access</a>`));
    assert.ok(html.indexOf('id="request"') < html.indexOf('<section id="how"'), 'the button is in the first screen');
  });

  test('pricing: three plans, marked planned, nothing charged in early access, the free limit marked coming', () => {
    const pricing = html.slice(html.indexOf('<section id="pricing"'), html.indexOf('<section id="faq"'));
    assert.match(pricing, /<span class="tag">planned<\/span>/);
    assert.match(pricing, /Nothing is charged during early access/);
    assert.match(pricing, /<h3>Free<\/h3>.*One person.*Every feature.*One agent working at a time <span class="tag">coming<\/span>/s);
    assert.match(pricing, /<h3>Pro<\/h3><p class="price">~\$20<span>\/month<\/span>.*Any number of agents at once/s);
    assert.match(pricing, /<h3>Team<\/h3><p class="price">~\$20<span>\/person\/month<\/span>/);
  });

  test('no claim the product contradicts: the hub does read a mirror of your code', () => {
    assert.doesNotMatch(html, /code never touches|never sees your code/i);
    assert.match(html, /model keys never touch nuworq/);
    assert.match(html, /reads a mirror of it only to confirm that work landed/);
  });
});
