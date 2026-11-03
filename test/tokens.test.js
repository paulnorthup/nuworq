import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { FOLD, isFold } from './foldmotion.js';

// One strict set of tokens (#391): every size, space, radius, shadow and border in the web app comes from :root.
const read = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const css = read('style.css');
const rootBody = css.match(/:root \{([^}]*)\}/)[1];
const tokens = Object.fromEntries([...rootBody.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const names = (re) => Object.keys(tokens).filter((k) => re.test(k));

// The declarations of a stylesheet (or an inline style), outside :root, comments dropped, each with its rule's selector.
const decls = (src) => [...src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/:root \{[^}]*\}/, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)]
  .flatMap((b) => [...b[2].matchAll(/(?:^|[;"])\s*([a-z-]+)\s*:\s*([^;{}"]+)/g)].map((m) => ({ sel: b[1].trim(), prop: m[1], value: m[2].trim() })));

// The one transition allowed past 100ms is a section folding (#809): see test/foldmotion.js.
const capOf = (sel) => (isFold(sel) ? FOLD.ms : 100);

// What a value may be once its tokens are taken out: nothing numeric but 0 (and %, vh, vw for layout).
const bare = (v) => v.replace(/calc\(-1 \* var\(--[\w-]+\)\)/g, '').replace(/var\(--[\w-]+\)/g, '');
const RAW = /(^|[\s,(/-])\d*\.?\d+(px|rem|pt|em)?(?![\w%])/;
const raw = (v) => [...bare(v).matchAll(new RegExp(RAW, 'g'))].map((m) => m[0].trim()).filter((x) => !/^[-(/,]?0(px|rem|pt|em)?$/.test(x));

export function problems(src) {
  const out = [];
  for (const { sel, prop, value } of decls(src)) {
    const bad = (why) => out.push(`${prop}: ${value} (${why})`);
    if (prop === 'font-size') {
      if (!/^(var\(--fs-[1-6]\)|inherit|smaller)$/.test(value)) bad('a --fs-* token');
    } else if (prop === 'font') {
      if (raw(value.replace(/^\d{3}\s+/, '').replace(/\/1(\.\d+)?\b/, '')).length) bad('--fs-* and --lh-* tokens');
    } else if (/^(padding|margin)(-(top|right|bottom|left))?$|^(row-|column-)?gap$/.test(prop)) {
      if (raw(value).length) bad('--sp-* tokens');
      for (const t of value.matchAll(/var\((--[\w-]+)\)/g)) if (!/^--sp-(h|\d+)$/.test(t[1])) bad(`${t[1]} isn't a space token`);
    } else if (/radius$/.test(prop)) {
      if (!value.split(/\s+/).every((v) => v === '0' || /^var\(--r-(s|m|full)\)$/.test(v))) bad('--r-s, --r-m or --r-full');
    } else if (prop === 'box-shadow') {
      if (!/^(none|var\(--e-[12]\))$/.test(value)) bad('--e-1 or --e-2');
    } else if (/^border(-(top|right|bottom|left))?(-width)?$/.test(prop)) {
      if (raw(value).length) bad('--rule (or --accent for a state stripe)');
    } else if (prop === 'transition') {
      const cap = capOf(sel);
      for (const [, n, unit] of value.matchAll(/(\d*\.?\d+)(ms|s)\b/g)) if (Number(n) * (unit === 's' ? 1000 : 1) > cap) bad(`${cap}ms at most`);
    } else if (/^animation/.test(prop)) bad('no animation');
    if (/gradient\(/.test(value)) bad('no gradients but --hatch');
  }
  if (/@keyframes/.test(src)) out.push('@keyframes (no animation)');
  return out;
}

const inline = (html) => [...html.matchAll(/style="([^"]*)"/g)].map((m) => `{${m[1]}}`).join('\n') + [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');

describe('one strict set of tokens (#391)', () => {
  test(':root has at most 6 type sizes, each with a line height and weight; a 4px space scale; 3 radii; 2 elevations; one rule', () => {
    const sizes = names(/^--fs-/);
    assert.ok(sizes.length >= 1 && sizes.length <= 6, `${sizes.length} type sizes`);
    for (const s of sizes) {
      const n = s.slice(5);
      assert.match(tokens[s], /^\d+px$/);
      assert.match(tokens[`--lh-${n}`] ?? '', /^\d(\.\d+)?$/, `--lh-${n}`);
      assert.match(tokens[`--fw-${n}`] ?? '', /^\d00$/, `--fw-${n}`);
    }
    for (const s of names(/^--sp-/)) {
      const px = parseFloat(tokens[s]);
      if (s === '--sp-h') assert.equal(tokens[s], '2px');
      else assert.equal(px, Number(s.slice(5)) * 4, `${s} is ${s.slice(5)}×4px`);
    }
    assert.deepEqual(names(/^--r-/), ['--r-s', '--r-m', '--r-full']);
    assert.deepEqual(names(/^--e-/), ['--e-1', '--e-2']);
    assert.equal(tokens['--rule'], '1px');
    assert.equal(tokens['--accent'], '3px');
    const head = css.slice(0, css.indexOf(':root'));
    for (const t of ['--fs-1..6', '--sp-*', '--r-s', '--e-1', '--rule', '--accent', 'tabular-nums', '/styleguide']) assert.ok(head.includes(t), `the map documents ${t}`);
  });

  test('every rule in the stylesheets and the pages uses only tokens for size, space, radius, shadow and borders; no decoration', () => {
    for (const f of readdirSync(new URL('../web/', import.meta.url), { recursive: true }).filter((n) => n.endsWith('.css'))) assert.deepEqual(problems(read(f)), [], f);
    for (const f of readdirSync(new URL('../web/', import.meta.url), { recursive: true }).filter((n) => n.endsWith('.html'))) assert.deepEqual(problems(inline(read(f))), [], f);
    // The scripts' inline styles too (#394): a static one is held to the same tokens; a computed one (${…}) is a measure, not a token.
    for (const f of readdirSync(new URL('../web/', import.meta.url), { recursive: true }).filter((n) => n.endsWith('.js'))) {
      assert.deepEqual(problems([...read(f).matchAll(/style="([^"$]*)"/g)].map((m) => `{${m[1]}}`).join('\n')), [], f);
    }
    assert.equal((css.match(/gradient\(/g) ?? []).length, 2, 'only --hatch and --hatch-tint are gradients');
  });

  test('the check catches raw values, gradients, animation and slow transitions', () => {
    assert.deepEqual(problems('.a { font-size: 12.5px; }').length, 1);
    assert.deepEqual(problems('.a { padding: 6px var(--sp-2); }').length, 1);
    assert.deepEqual(problems('.a { margin: calc(-1 * var(--sp-3)) 0; gap: var(--sp-h) var(--sp-4); }'), []);
    assert.deepEqual(problems('.a { margin: var(--r-m); }').length, 1);
    assert.deepEqual(problems('.a { border-radius: 10px; }').length, 1);
    assert.deepEqual(problems('.a { box-shadow: 0 1px 2px #000; }').length, 1);
    assert.deepEqual(problems('.a { border: 2px solid var(--line); }').length, 1);
    assert.deepEqual(problems('.a { border-left: var(--accent) solid var(--you); }'), []);
    assert.deepEqual(problems('.a { background: linear-gradient(red, blue); }').length, 1);
    assert.deepEqual(problems('.a { transition: opacity .2s; }').length, 1);
    assert.deepEqual(problems('.a { transition: opacity .1s; }'), []);
    // A section folding (#809) may take 150ms, and only it.
    assert.deepEqual(problems('.sec.foldable > .fold-body, .sec.folded > .fold-body { transition: grid-template-rows 150ms ease-out; }'), []);
    assert.deepEqual(problems('.sec.foldable > .fold-body { transition: grid-template-rows 200ms; }').length, 1);
    assert.deepEqual(problems('.sec.foldable > .fold-body, .a { transition: opacity 150ms; }').length, 1);
    assert.deepEqual(problems('@media (x) { .a { transition: opacity 150ms; } }').length, 1);
    assert.deepEqual(problems('.a { animation: spin 1s; } @keyframes spin {}').length, 2);
  });

  test('compared figures use tabular numerals', () => {
    const rule = css.match(/([^{}]*)\{ font-variant-numeric: tabular-nums; \}/);
    for (const sel of ['.badge', '.count', '.age', '.stage .n', '.g-count', '.an-figs']) assert.ok(rule[1].includes(sel), sel);
  });

  test('the style guide shows every token and every component, and nuworq-only, so not in the agents\' guide (#527)', async () => {
    const sg = read('styleguide.html');
    for (const t of [...names(/^--(fs|sp|r|e)-/), '--rule', '--accent']) assert.ok(sg.includes(`var(${t})`), `the style guide shows ${t}`);
    for (const c of ['btn primary', 'btn ghost', 'disabled', 'class="seg"', 'class="switch"', '<input', '<textarea', '<select', 'class="card"', 'class="tag now"',
      'stage-pill', 'courtbar', 'g-bar', 'lifebar', 'class="steps"', 'class="dialog"', 'class="toast"', 'toast err']) assert.ok(sg.includes(c), `the style guide shows ${c}`);
    const { guide } = await import('../src/protocol.js');
    assert.doesNotMatch(guide(), /\/styleguide/, 'a rule for nuworq\'s own repository is a decision of that project, not the guide');
  });

  test('/styleguide is for signed-in people: the page with its logo for them, 401 for anyone else', async () => {
    const { Hub } = await import('../src/core.js');
    const { createServer } = await import('../src/server.js');
    const server = createServer(new Hub(), { auth: 'required' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      for (const path of ['/styleguide', '/styleguide.html']) assert.equal((await fetch(`${url}${path}`)).status, 401, `${path} signed out`);
      const res = await fetch(`${url}/styleguide`, { headers: { authorization: `Bearer ${server.auth.createToken('paul', 'human')}` } });
      const html = await res.text();
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/html/);
      assert.ok(html.includes('<h1>Style guide</h1>') && !html.includes('<!--'), 'filled in');
    } finally { server.close(); server.closeAllConnections(); }
  });
});
