import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Every color means one thing (#188): the state colors and the provider marks stay clearly apart.
const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
const root = Object.fromEntries([...css.match(/:root \{([^}]*)\}/)[1].matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2].toLowerCase()]));

// WCAG relative luminance and contrast; CIE76 ΔE in Lab (D65).
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
const lum = (h) => { const [r, g, b] = rgb(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const lab = (h) => {
  const [r, g, b] = rgb(h);
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [x, y, z] = [(0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * b, (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883].map(f);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};
const dE = (a, b) => { const [p, q] = [lab(a), lab(b)]; return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const pairs = (keys) => keys.flatMap((a, i) => keys.slice(i + 1).map((b) => [a, b]));

const STATE = ['--you', '--agents', '--ok', '--warn', '--bad'];
const PROVIDER = ['--p-anthropic', '--p-openai', '--p-open', '--p-google'];

describe('the color map keeps meanings apart (#188)', () => {
  test('the map is written at the top of the stylesheet, one line per meaning', () => {
    const head = css.slice(0, css.indexOf(':root'));
    for (const token of [...STATE, '--queue', 'external', '--ink', '--p-*', '--brand']) assert.ok(head.includes(token), `the map says what ${token} means`);
    assert.match(head, /Links, focus rings and highlights such as "new" use no state color/);
    for (const k of [...STATE, ...PROVIDER, '--panel', '--brand']) assert.ok(root[k], `${k} is a hex color in :root`);
  });

  test('the five state colors are at least ΔE 30 apart, and readable as text and behind white text', () => {
    for (const [a, b] of pairs(STATE)) assert.ok(dE(root[a], root[b]) >= 30, `${a} vs ${b}: ΔE ${dE(root[a], root[b]).toFixed(1)}`);
    for (const k of STATE) {
      assert.ok(contrast(root[k], root['--panel']) >= 4.5, `${k} on --panel: ${contrast(root[k], root['--panel']).toFixed(2)}`);
      assert.ok(contrast(root[k], '#ffffff') >= 4.5, `white text on ${k}`);
    }
  });

  test('each provider mark is at least ΔE 30 from every state color and every other provider, and 3:1 on --panel', () => {
    for (const p of PROVIDER) {
      for (const s of STATE) assert.ok(dE(root[p], root[s]) >= 30, `${p} vs ${s}: ΔE ${dE(root[p], root[s]).toFixed(1)}`);
      assert.ok(contrast(root[p], root['--panel']) >= 3, `${p} on --panel`);
    }
    for (const [a, b] of pairs(PROVIDER)) assert.ok(dE(root[a], root[b]) >= 30, `${a} vs ${b}`);
  });

  test('the logo is the brand, not a state', () => {
    // Every logo the hub draws, including the flow pages the server renders itself (src/server.js flowPage).
    for (const f of ['web/app.js', 'web/login.html', 'web/device.html', 'web/invite.html', 'web/early-access.html', 'src/server.js']) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
      assert.match(src, /rx="8" fill="var\(--brand\)"/, f);
      assert.doesNotMatch(src, /rx="8" fill="var\(--agents\)"/, f);
    }
  });

  test('a token change that brings two meanings too close fails', () => {
    assert.ok(dE('#c4520f', '#b42318') < 30, 'today\'s --bad next to --you would fail the state rule');
    assert.ok(dE('#c96442', '#c4520f') < 30, 'the old Anthropic mark next to --you would fail the provider rule');
  });
});
