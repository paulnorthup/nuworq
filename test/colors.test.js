import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

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

  test('every Needs you card is orange, and priority uses no state color (#189)', () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
    const colors = (body) => [...body.matchAll(/(?:^|;)\s*(?:color|background(?:-color)?|border(?:-left)?(?:-color)?)\s*:\s*([^;]+)/g)].map((m) => m[1]);
    const kinds = rules.filter((r) => /\.kind-/.test(r.sel));
    for (const r of kinds) for (const c of colors(r.body)) assert.match(c, /^var\(--you\)$|^\d+px solid var\(--you\)$/, `${r.sel} sets ${c}`);
    const base = rules.find((r) => r.sel === '.card');
    assert.match(base.body, /border-left: 3px solid var\(--you\)/, 'a card is orange by default, so a new kind is too');
    const now = rules.filter((r) => /\.tag\.now\b/.test(r.sel));
    assert.ok(now.length, '.tag.now exists');
    for (const r of now) for (const t of STATE) assert.doesNotMatch(r.body, new RegExp(`var\\(${t}(-tint)?\\)`), `${r.sel} uses ${t}`);
  });

  test('buttons show emphasis, not state, and peer choices look alike (#193)', () => {
    const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    for (const [f, src] of [['web/style.css', css], ['web/app.js', app]]) assert.doesNotMatch(src, /btn[ .](go|you)\b/, `${f} has no .btn.go or .btn.you`);
    for (const sel of ['.opt', '.opt:hover', '.pick', '.pick:hover']) {
      const body = css.match(new RegExp(`(?:^|\\n)${sel.replace('.', '\\.')} \\{([^}]*)\\}`))[1];
      for (const t of STATE) assert.doesNotMatch(body, new RegExp(`var\\(${t}(-tint|-line)?\\)`), `${sel} uses ${t}`);
    }
    assert.match(app, /class="btn small" data-action="keep"/, 'race "Keep this one" buttons are peers');
  });

  test('text that carries information is at least 4.5:1 on the backgrounds it sits on (#195)', () => {
    const pairs = [
      ['--muted', '--bg'], ['--muted', '--panel'], ['--muted', '--sunken'], ['--muted', '--queue-tint'],
      ['--muted', '--you-tint'], ['--muted', '--agents-tint'], // a Flow stage's label on its court's tint
      ['--you', '--you-tint'], ['--agents', '--agents-tint'], ['--ok', '--ok-tint'], ['--bad', '--bad-tint'],
    ];
    for (const [fg, bg] of pairs) assert.ok(contrast(root[fg], root[bg]) >= 4.5, `${fg} on ${bg}: ${contrast(root[fg], root[bg]).toFixed(2)}`);
    // Labels inside the courtbar and lifecycle bar segments: white on the colored ones, ink on the grey queue.
    for (const bg of ['--agents', '--you', '--ok', '--muted']) assert.ok(contrast('#ffffff', root[bg]) >= 4.5, `white on ${bg}`);
    assert.ok(contrast(root['--ink'], root['--queue']) >= 4.5, `ink on --queue: ${contrast(root['--ink'], root['--queue']).toFixed(2)}`);
    assert.match(css, /\.seg-c\.queue, \.lifebar \.queue \{ color: var\(--ink\); \}/);
  });

  test('Outside\'s labels are at least 4.5:1 on every stripe of its hatch, and it still looks unlike Ready (#209)', () => {
    const stripes = (token) => [...css.match(new RegExp(`${token}: repeating-linear-gradient\\(([^;]*)\\);`))[1].matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
    const bar = stripes('--hatch'), tint = stripes('--hatch-tint');
    assert.ok(bar.length >= 2 && tint.length >= 2, 'both hatches are stripes of :root tokens');
    // Courtbar and lifecycle bar segments: white labels (no color override on .external).
    assert.doesNotMatch(css, /(\.seg-c\.external|\.lifebar \.external)[^{]*\{[^}]*(^|[^-])color:/);
    for (const s of bar) assert.ok(contrast('#ffffff', root[s]) >= 4.5, `white on --hatch stripe ${s}: ${contrast('#ffffff', root[s]).toFixed(2)}`);
    // The Outside pill and Flow tile label: ink on --hatch-tint.
    assert.match(css, /\.stage-pill\.court-external \{ background: var\(--hatch-tint\); color: var\(--ink\); \}/);
    assert.match(css, /\.stage\.court-external \.l \{ color: var\(--ink\); \}/);
    // Its count stays ink at 0 too: the tile is always shown, and zero-count would draw it --muted.
    assert.match(css, /\.stage\.court-external\.zero-count \.n \{ color: var\(--ink\); \}/);
    for (const s of tint) assert.ok(contrast(root['--ink'], root[s]) >= 4.5, `ink on --hatch-tint stripe ${s}: ${contrast(root['--ink'], root[s]).toFixed(2)}`);
    // Stripes, not a solid fill, so Outside never reads as Ready's grey.
    assert.ok(!bar.includes('--queue') && new Set(bar).size >= 2, '--hatch is two-tone and not --queue');
    assert.ok(!tint.includes('--queue-tint') && new Set(tint).size >= 2, '--hatch-tint is two-tone and not --queue-tint');
    assert.ok(contrast('#ffffff', root['--faint']) < 4.5, 'the old --faint stripe would fail this rule');
  });

  test('--faint is decoration only: no text anywhere in web/ is drawn in it (#195)', () => {
    for (const f of readdirSync(new URL('../web/', import.meta.url)).filter((n) => /\.(css|js|html)$/.test(n))) {
      const src = readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
      assert.doesNotMatch(src, /(^|[^-])color:\s*var\(--faint\)/, `${f} draws text in --faint`);
    }
  });

  test('a project state dot says its state in words, not by color alone (#195)', async () => {
    const { stateDot } = await import('../web/home.js');
    for (const [state, label] of [['needs-you', 'Needs you'], ['flowing', 'Flowing'], ['stalled', 'Stalled'], ['idle', 'Idle'], ['parked', 'Parked']]) {
      const dot = stateDot(state);
      assert.match(dot, new RegExp(`class="dot ${state}"`));
      assert.match(dot, new RegExp(`role="img" aria-label="${label}" title="${label}"`));
    }
    const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    const home = readFileSync(new URL('../web/home.js', import.meta.url), 'utf8');
    assert.doesNotMatch(app + home, /<span class="dot \$\{\w+\.pulse\.state\}/, 'the rail, home and pulse draw their dots with stateDot');
  });

  test('blue means agents are on it (#190): flowing and working are blue; links, focus and "new" carry no state color', () => {
    const rule = (sel) => { const m = css.match(new RegExp(`(?:^|\\n)([^{}\\n]*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{}\\n]*)\\{([^}]*)\\}`)); assert.ok(m, `a rule for ${sel}`); return m[2]; };
    assert.match(rule('.dot.flowing '), /var\(--agents\)/);
    assert.match(rule('.state-flowing .state-chip'), /var\(--agents\)/);
    assert.match(rule('.status.working'), /var\(--agents\)/);
    assert.match(rule('.agent-strip .st.working'), /var\(--agents\)/);
    const states = /var\(--(you|agents|queue|ok|warn|bad)(-tint)?\)/;
    assert.doesNotMatch(css.match(/\na \{([^}]*)\}/)[1], states, 'a uses no state color');
    for (const sel of ['a:not([class]), a.step-where, .link', 'input:focus', '.composer .box:focus-within', '.is-new::after', '.missing-links .link', '.zoom-more button']) {
      assert.doesNotMatch(rule(sel), states, `${sel} uses no state color`);
    }
    const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    assert.match(app, /class="st \$\{a\.status\.split\(' '\)\[0\]\}"/, 'the agent strip marks a working agent');
  });

  test('the closing pass (#187): plans and an unknown provider carry no state color, and agents working on the admin host are blue', () => {
    const rule = (sel) => { const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`)); assert.ok(m, `a rule for ${sel}`); return m[1]; };
    const states = /var\(--(you|agents|queue|ok|warn|bad)(-tint|-line)?\)/;
    for (const sel of ['.plan', '.plan-free', '.plan-unlimited', '.agent i']) assert.doesNotMatch(rule(sel), states, `${sel} uses no state color`);
    assert.match(rule('.admin-space .working'), /color: var\(--agents\)/);
    assert.match(css, /\.status\.quiet, \.agent-strip \.st\.quiet \{ color: var\(--warn\); \}/, 'a quiet agent is amber in the agent strip too, as in Agents');
    const admin = readFileSync(new URL('../web/admin.js', import.meta.url), 'utf8');
    assert.match(admin, /<b class="working">\$\{w\.working\.length\} working<\/b>/, 'a workspace\'s working agents are drawn as agents, not as done');
  });

  test('a token change that brings two meanings too close fails', () => {
    assert.ok(dE('#c4520f', '#b42318') < 30, 'today\'s --bad next to --you would fail the state rule');
    assert.ok(dE('#c96442', '#c4520f') < 30, 'the old Anthropic mark next to --you would fail the provider rule');
  });
});
