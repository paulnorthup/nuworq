import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appSource } from './appsource.js';

// Every color means one thing (#188): the state colors and the provider marks stay clearly apart.
const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
const hexes = (body) => Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2].toLowerCase()]));
const root = hexes(css.match(/:root \{([^}]*)\}/)[1]);
// Dark (#484): the device's preference and the forced choice hold the same values, over the light ones.
const DARK_MEDIA = css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}\s*\}/);
const DARK_FORCED = css.match(/:root\[data-theme="dark"\] \{([^}]*)\}/);
const dark = { ...root, ...hexes(DARK_FORCED?.[1] ?? '') };
const THEMES = { light: root, dark };

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

  for (const [name, t] of Object.entries(THEMES)) {
    test(`${name}: the five state colors are at least ΔE 30 apart, and readable as text and behind --on-fill text`, () => {
      for (const [a, b] of pairs(STATE)) assert.ok(dE(t[a], t[b]) >= 30, `${a} vs ${b}: ΔE ${dE(t[a], t[b]).toFixed(1)}`);
      for (const k of STATE) {
        assert.ok(contrast(t[k], t['--panel']) >= 4.5, `${k} on --panel: ${contrast(t[k], t['--panel']).toFixed(2)}`);
        assert.ok(contrast(t[k], t['--on-fill']) >= 4.5, `--on-fill text on ${k}: ${contrast(t[k], t['--on-fill']).toFixed(2)}`);
      }
    });

    test(`${name}: each provider mark is at least ΔE 30 from every state color and every other provider, and 3:1 on --panel`, () => {
      for (const p of PROVIDER) {
        for (const s of STATE) assert.ok(dE(t[p], t[s]) >= 30, `${p} vs ${s}: ΔE ${dE(t[p], t[s]).toFixed(1)}`);
        assert.ok(contrast(t[p], t['--panel']) >= 3, `${p} on --panel`);
      }
      for (const [a, b] of pairs(PROVIDER)) assert.ok(dE(t[a], t[b]) >= 30, `${a} vs ${b}`);
    });

    test(`${name}: the citron brand stands apart from every meaning and carries a readable mark (#319)`, () => {
      for (const s of STATE) assert.ok(dE(t['--brand'], t[s]) >= 30, `--brand vs ${s}: ΔE ${dE(t['--brand'], t[s]).toFixed(1)}`);
      for (const p of PROVIDER) assert.ok(dE(t['--brand'], t[p]) >= 25, `--brand vs ${p}: ΔE ${dE(t['--brand'], t[p]).toFixed(1)}`);
      assert.ok(contrast(t['--brand-ink'], t['--brand']) >= 4.5, `the mark (--brand-ink) on --brand: ${contrast(t['--brand-ink'], t['--brand']).toFixed(2)}`);
    });

    test(`${name}: text that carries information is at least 4.5:1 on the backgrounds it sits on (#195)`, () => {
      const on = [
        ['--muted', '--bg'], ['--muted', '--panel'], ['--muted', '--sunken'], ['--muted', '--queue-tint'],
        ['--muted', '--you-tint'], ['--muted', '--agents-tint'], // a Flow stage's label on its court's tint
        ['--you', '--you-tint'], ['--agents', '--agents-tint'], ['--ok', '--ok-tint'], ['--bad', '--bad-tint'],
        ['--panel', '--ink'], // text on an --ink fill (the "now" tag, a primary button)
      ];
      for (const [fg, bg] of on) assert.ok(contrast(t[fg], t[bg]) >= 4.5, `${fg} on ${bg}: ${contrast(t[fg], t[bg]).toFixed(2)}`);
      // Labels inside the courtbar and lifecycle bar segments: --on-fill on the colored ones, --on-queue on the grey.
      for (const bg of ['--agents', '--you', '--ok', '--muted']) assert.ok(contrast(t['--on-fill'], t[bg]) >= 4.5, `--on-fill on ${bg}`);
      assert.ok(contrast(t['--on-queue'], t['--queue']) >= 4.5, `--on-queue on --queue: ${contrast(t['--on-queue'], t['--queue']).toFixed(2)}`);
    });

    test(`${name}: Outside's labels are at least 4.5:1 on every stripe of its hatch (#209)`, () => {
      const stripes = (token) => [...css.match(new RegExp(`${token}: repeating-linear-gradient\\(([^;]*)\\);`))[1].matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
      for (const s of stripes('--hatch')) assert.ok(contrast(t['--on-fill'], t[s]) >= 4.5, `--on-fill on --hatch stripe ${s}: ${contrast(t['--on-fill'], t[s]).toFixed(2)}`);
      for (const s of stripes('--hatch-tint')) assert.ok(contrast(t['--ink'], t[s]) >= 4.5, `ink on --hatch-tint stripe ${s}: ${contrast(t['--ink'], t[s]).toFixed(2)}`);
    });
  }

  test('dark is calm (#484): a graphite background, text in a comfortable band, softer state colors', () => {
    assert.ok(DARK_MEDIA && DARK_FORCED, 'dark follows the device, and the theme choice can force it');
    assert.deepEqual(hexes(DARK_MEDIA[1]), hexes(DARK_FORCED[1]), 'the device\'s dark and the forced dark hold the same values');
    assert.match(css, /:root \{[^}]*color-scheme: light dark;/);
    const L = lab(dark['--bg'])[0];
    assert.ok(L >= 9 && L <= 14, `--bg L* ${L.toFixed(1)} is graphite, not near-black`);
    const c = contrast(dark['--ink'], dark['--panel']);
    assert.ok(c >= 10 && c <= 12.5, `--ink on --panel ${c.toFixed(2)}:1, comfortable rather than glaring`);
    const chroma = STATE.map((k) => Math.hypot(lab(dark[k])[1], lab(dark[k])[2]));
    const mean = chroma.reduce((a, b) => a + b, 0) / chroma.length;
    assert.ok(mean <= 45, `mean state chroma ${mean.toFixed(1)}`);
    assert.equal(dark['--brand'], root['--brand'], 'the citron stays');
    assert.equal(dark['--brand-ink'], root['--brand-ink'], 'the q stays dark on it');
  });

  test('every color comes from the theme blocks: no hex, rgb() or rgba() elsewhere in web/ or the server (#484)', () => {
    const outside = css.replace(/:root \{[^}]*\}/, '').replace(DARK_MEDIA[0], '').replace(DARK_FORCED[0], '');
    // A three-character hex with a letter (#fff) counts anywhere; an all-digit one (#000) only as a value, after ":",
    // so issue refs like "(#141)" or ", #228" aren't taken for colors.
    const COLOR = /#[0-9a-f]{6}\b|#(?=\d*[a-f])[0-9a-f]{3}\b(?![\w-])|:\s*#\d{3}\b(?![\w-])|rgba?\(/gi;
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.deepEqual(strip(outside).match(COLOR) ?? [], [], 'web/style.css');
    for (const dir of ['web', 'src']) {
      for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url), { recursive: dir === 'web' }).filter((n) => /\.(css|js|html)$/.test(n) && n !== 'style.css' && n !== 'logo.js')) {
        if (dir === 'src' && f !== 'server.js') continue;
        const src = strip(readFileSync(new URL(`../${dir}/${f}`, import.meta.url), 'utf8'));
        assert.deepEqual(src.match(COLOR) ?? [], [], `${dir}/${f}`);
      }
    }
  });

  test('the logo is the brand, not a state: the q in ink on the citron tile, from one source (#319, #322)', async () => {
    const { LOGO, FAVICON, BRAND, INK, withLogo } = await import('../web/logo.js');
    const q = '<circle cx="15" cy="14.5" r="5.5"/><path d="M20.5 9.5V23.5q0 2 2 2h1"/>';
    assert.ok(LOGO.includes(`rx="8" fill="var(--brand)"/><g fill="none" stroke="var(--brand-ink)" stroke-width="3.2" stroke-linecap="round">${q}</g>`), 'the mark: the q in --brand-ink on --brand, dark in both themes (#484)');
    // A favicon can't read CSS variables, so it carries the same two colors as hexes, and a heavier stroke for 16px.
    assert.deepEqual([BRAND, INK], [root['--brand'], root['--brand-ink']], 'logo.js keeps the hexes of --brand and --brand-ink');
    const icon = decodeURIComponent(FAVICON.replace('data:image/svg+xml,', ''));
    assert.ok(icon.includes(`rx="8" fill="${BRAND}"/><g fill="none" stroke="${INK}" stroke-width="3.6" stroke-linecap="round">${q}</g>`), 'the favicon is the same q on --brand');
    // Every logo the hub draws uses that one source; no page keeps its own copy.
    const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(appSource(), /import \{ LOGO \} from '\.\/logo\.js';/);
    assert.match(read('src/server.js'), /<link rel="icon" href="\$\{FAVICON\}">[^`]*<div class="brand">\$\{LOGO\}<span>nuworq<\/span>/, 'the flow pages');
    // Every page has the favicon (#318), and the sign-in style pages the logo above their card.
    for (const f of readdirSync(new URL('../web/', import.meta.url), { recursive: true }).filter((n) => n.endsWith('.html'))) {
      const html = read(`web/${f}`);
      assert.match(html, /<link rel="icon" href="<!--favicon-->">/, `${f}'s favicon`);
      if (['login.html', 'device.html', 'invite.html', 'early-access.html'].includes(f)) assert.match(html, /<div class="brand">\s*<!--logo-->\s*<span>nuworq<\/span>/, `${f}'s logo`);
      assert.ok(withLogo(html).includes(FAVICON) && !withLogo(html).includes('<!--'), `${f} is filled in`);
    }
    for (const dir of ['web', 'src']) {
      for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url), { recursive: dir === 'web' }).filter((n) => /\.(css|js|html)$/.test(n) && n !== 'logo.js')) {
        const src = read(`${dir}/${f}`);
        assert.doesNotMatch(src, /<svg viewBox="0 0 32 32"|rx="8" fill=|rx='8'/, `${dir}/${f} draws its own mark`);
        assert.ok(!src.includes('M8 24L24 8'), `${dir}/${f} still has the lattice`);
        assert.doesNotMatch(src, /rgba\(20, ?20, ?18/, `${dir}/${f} still has the old warm shade (#318)`);
      }
    }
  });

  test('the hub serves its pages with the logo and favicon filled in (#322)', async () => {
    const { Hub } = await import('../src/core.js');
    const { createServer } = await import('../src/server.js');
    const { LOGO, FAVICON } = await import('../web/logo.js');
    const server = createServer(new Hub());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      for (const page of ['/', '/login.html', '/device.html', '/invite.html']) {
        const html = await (await fetch(`http://127.0.0.1:${server.address().port}${page}`)).text();
        assert.ok(html.includes(`<link rel="icon" href="${FAVICON}">`), `${page} has the favicon`);
        if (page !== '/') assert.ok(html.includes(LOGO), `${page} has the logo`);
        assert.ok(!html.includes('<!--logo-->') && !html.includes('<!--favicon-->'), `${page} is filled in`);
      }
    } finally { server.close(); }
  });

  test('the admin host and the hub\'s own address serve their pages with the favicon too (#318)', async () => {
    const { Workspaces } = await import('../src/workspaces.js');
    const { createServer } = await import('../src/server.js');
    const { FAVICON } = await import('../web/logo.js');
    // With an admin host it serves the dashboard; without one, the hub's own address serves the request list.
    for (const [adminHost, pages] of [['admin.example.test', [['admin.example.test', '/'], ['app.example.test', '/join.html']]], ['', [['app.example.test', '/requests.html']]]]) {
      const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-logo-')), owners: ['paul@example.com'] });
      const server = createServer(spaces, { publicUrl: 'http://app.example.test', adminHost });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const get = (host, path) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path, headers: { host } }, (res) => {
          let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b));
        }).on('error', reject);
      });
      try {
        for (const [host, page] of pages) {
          const html = await get(host, page);
          assert.ok(html.includes(`<link rel="icon" href="${FAVICON}">`), `${host}${page} has the favicon`);
          assert.ok(!html.includes('<!--favicon-->'), `${host}${page} is filled in`);
        }
      } finally { server.close(); }
    }
  });

  test('the citron brand is never text, and a light mark on it would fail (#319)', () => {
    assert.ok(contrast('#ffffff', root['--brand']) < 4.5, 'a white mark on citron would fail the mark rule');
    assert.ok(contrast(dark['--ink'], root['--brand']) < 4.5, 'so would dark\'s --ink: the mark is --brand-ink');
    for (const dir of ['web', 'src']) {
      for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url), { recursive: dir === 'web' }).filter((n) => /\.(css|js|html)$/.test(n))) {
        const src = readFileSync(new URL(`../${dir}/${f}`, import.meta.url), 'utf8');
        assert.doesNotMatch(src, /(^|[^-])color:\s*var\(--brand\)/, `${dir}/${f} draws text in --brand`);
      }
    }
  });

  test('every Needs you card is magenta, and priority uses no state color (#189)', () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
    const colors = (body) => [...body.matchAll(/(?:^|;)\s*(?:color|background(?:-color)?|border(?:-left)?(?:-color)?)\s*:\s*([^;]+)/g)].map((m) => m[1]);
    const kinds = rules.filter((r) => /\.kind-/.test(r.sel));
    for (const r of kinds) for (const c of colors(r.body)) assert.match(c, /^var\(--you\)$|^var\(--accent\) solid var\(--you\)$/, `${r.sel} sets ${c}`);
    const base = rules.find((r) => r.sel === '.card');
    assert.match(base.body, /border-left: var\(--accent\) solid var\(--you\)/, 'a card is magenta by default, so a new kind is too');
    const now = rules.filter((r) => /\.tag\.now\b/.test(r.sel));
    assert.ok(now.length, '.tag.now exists');
    for (const r of now) for (const t of STATE) assert.doesNotMatch(r.body, new RegExp(`var\\(${t}(-tint)?\\)`), `${r.sel} uses ${t}`);
  });

  test('the feedback tag is a label, not the person\'s move: no magenta on the board (#336)', () => {
    const fb = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => /\.fb-tag\b/.test(m[1]));
    assert.ok(fb.length, '.tag.fb-tag exists');
    for (const [, sel, body] of fb) assert.doesNotMatch(body, /var\(--you(-tint|-line)?\)/, `${sel.trim()} uses --you`);
  });

  test('buttons show emphasis, not state, and peer choices look alike (#193)', () => {
    const app = appSource();
    for (const [f, src] of [['web/style.css', css], ['web/app.js', app]]) assert.doesNotMatch(src, /btn[ .](go|you)\b/, `${f} has no .btn.go or .btn.you`);
    for (const sel of ['.opt', '.opt:hover', '.pick', '.pick:hover']) {
      const body = css.match(new RegExp(`(?:^|\\n)${sel.replace('.', '\\.')} \\{([^}]*)\\}`))[1];
      for (const t of STATE) assert.doesNotMatch(body, new RegExp(`var\\(${t}(-tint|-line)?\\)`), `${sel} uses ${t}`);
    }
    assert.match(app, /class="btn small" data-action="keep"/, 'race "Keep this one" buttons are peers');
  });

  test('bar labels use the label tokens: --on-fill on a state, --on-queue on Ready\'s grey (#195, #484)', () => {
    assert.match(css, /\.seg-c\.queue, \.lifebar \.queue \{ color: var\(--on-queue\); \}/);
    assert.match(css, /\.courtbar \.seg-c \{[^}]*color: var\(--on-fill\)/);
    assert.match(css, /\.lifebar span \{[^}]*color: var\(--on-fill\)/);
  });

  test('Outside still looks unlike Ready, with its labels on the hatch (#209)', () => {
    const stripes = (token) => [...css.match(new RegExp(`${token}: repeating-linear-gradient\\(([^;]*)\\);`))[1].matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
    const bar = stripes('--hatch'), tint = stripes('--hatch-tint');
    assert.ok(bar.length >= 2 && tint.length >= 2, 'both hatches are stripes of :root tokens');
    // Courtbar and lifecycle bar segments: --on-fill labels (no color override on .external).
    assert.doesNotMatch(css, /(\.seg-c\.external|\.lifebar \.external)[^{]*\{[^}]*(^|[^-])color:/);
    // The Outside pill and Flow tile label: ink on --hatch-tint.
    assert.match(css, /\.stage-pill\.court-external \{ background: var\(--hatch-tint\); color: var\(--ink\); \}/);
    assert.match(css, /\.stage\.court-external \.l \{ color: var\(--ink\); \}/);
    // Its count stays ink at 0 too: the tile is always shown, and zero-count would draw it --muted.
    assert.match(css, /\.stage\.court-external\.zero-count \.n \{ color: var\(--ink\); \}/);
    // Stripes, not a solid fill, so Outside never reads as Ready's grey.
    assert.ok(!bar.includes('--queue') && new Set(bar).size >= 2, '--hatch is two-tone and not --queue');
    assert.ok(!tint.includes('--queue-tint') && new Set(tint).size >= 2, '--hatch-tint is two-tone and not --queue-tint');
    assert.ok(contrast('#ffffff', root['--faint']) < 4.5, 'the old --faint stripe would fail this rule');
  });

  test('--faint is decoration only: no text anywhere in web/ is drawn in it (#195)', () => {
    for (const f of readdirSync(new URL('../web/', import.meta.url), { recursive: true }).filter((n) => /\.(css|js|html)$/.test(n))) {
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
    const app = appSource();
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
    const app = appSource();
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

  test('an error or a failure is red, never amber (#187): admin errors, a failed payment, a failing channel, join', () => {
    const web = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
    assert.match(web('admin.html'), /<p id="error" class="bad" role="alert" hidden>/);
    const admin = web('admin.js');
    assert.doesNotMatch(admin, /class="warn">\$\{esc\(e\.message\)\}/, 'an error from the hub is not amber');
    assert.equal(admin.match(/class="bad">\$\{esc\(e\.message\)\}/g)?.length, 4, 'requests, sources (#356), feedback (#295), workspaces');
    assert.match(admin, /'payment failed' \? 'bad'/);
    assert.match(appSource(), /<span class="bad">⚠ failing: \$\{esc\(c\.last_error\)\}/);
    assert.doesNotMatch(web('join.js'), /className = [^;]*'warn'/, 'join shows the hub\'s refusals and errors in red');
    // What can still go wrong stays amber: missing evidence, a name used by two tokens, a git warning.
    assert.match(appSource(), /<div class="warn">⚠ No evidence attached<\/div>/);
  });

  test('a token change that brings two meanings too close fails', () => {
    assert.ok(dE('#c4520f', '#b42318') < 30, 'today\'s --bad next to --you would fail the state rule');
    assert.ok(dE('#c96442', '#c4520f') < 30, 'the old Anthropic mark next to --you would fail the provider rule');
  });
});
