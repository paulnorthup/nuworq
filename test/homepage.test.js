import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hub } from '../src/core.js';
import { homeView } from '../src/insight.js';
import { createServer } from '../src/server.js';
import { homePage } from '../web/home.js';
import { appSource } from './appsource.js';

// The page's own helpers, stood in for: pulse and card leave a marker, so order and placement show.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, one) => `${n} ${n === 1 ? one : one + 's'}`;
const deps = (z = 0) => ({ z, esc, plural, pulse: (v) => `<!--pulse:${v.pulse.state}-->`, card: (a) => `<!--card:${a.kind}:${a.item}-->` });

// Two projects with work; an agent on each so nothing asks to start one.
function setup() {
  const hub = new Hub({ clock: () => Date.UTC(2026, 9, 29, 9) });
  for (const slug of ['p1', 'p2']) {
    hub.tx(() => hub.project(slug, { create: true }));
    hub.humanOp(slug, 'create', { title: `Build ${slug}`, acceptance: 'x' });
    hub.humanOp(slug, 'create', { title: `More ${slug}`, acceptance: 'x' });
    hub.agentOp(slug, 'claim', 'bot', { item: '#2' });
  }
  return hub;
}

describe('the home page', () => {
  test('30s: pulse, then needs you, then projects; nothing needing you leaves no needs section at all', () => {
    const hub = setup();
    let html = homePage(homeView(hub), deps());
    assert.ok(!html.includes('home-needs'), 'no needs section');
    assert.ok(!html.includes('<!--card'));
    assert.ok(html.indexOf('<!--pulse:') < html.indexOf('home-projects'));

    hub.agentOp('p2', 'claim', 'bot2', { item: '#1' });
    hub.agentOp('p2', 'ask', 'bot2', { item: '#1', question: 'Which region?', blocking: true });
    html = homePage(homeView(hub), deps());
    const [pulse, needs, projects] = ['<!--pulse:needs-you-->', 'home-needs', 'home-projects'].map((s) => html.indexOf(s));
    assert.ok(pulse >= 0 && pulse < needs && needs < projects, 'in that order');
    assert.match(html, /<div class="home-card" data-project="p2"><a class="proj-tag" href="#\/p\/p2">p2<\/a><!--card:question:#1-->/, 'each card sits in its project');
    assert.equal((html.match(/data-action="goto" data-slug="p\d"/g) ?? []).length, 2, 'a line per project');
    assert.match(html, /title="1 thing needs you"/, 'the badge agrees in number (#289)');
  });

  test('parked projects fold into one line at 30s and show at 5m; 5m adds worth knowing and motion; 30m the details', () => {
    const hub = setup();
    hub.humanOp('p2', 'settings', { parked: true });
    hub.humanOp('p1', 'settings', { mission: 'Rockets' });
    const h = homeView(hub);
    let html = homePage(h, deps(0));
    assert.match(html, /1 parked project/);
    assert.ok(!html.includes('data-slug="p2"'));
    assert.ok(!html.includes('In motion'));
    html = homePage(h, deps(1));
    assert.ok(html.includes('data-slug="p2"') && !html.includes('parked project<'));
    assert.match(html, /In motion[\s\S]*data-project="p1" data-action="open" data-item="#2"[\s\S]*bot/);
    assert.ok(!html.includes('Rockets'));
    assert.match(homePage(h, deps(2)), /Rockets[\s\S]*nuworq run leaves it alone/);
  });

  test('wide (#141): the work in the main column, pulse, Get started and projects beside it; nothing to act on, one column', () => {
    const hub = setup();
    const gs = '<section class="get-started"></section>';
    let html = homePage(homeView(hub), { ...deps(), wide: true, gs });
    assert.ok(!html.includes('class="cols"'), 'nothing needs you: one column, no empty band');
    assert.ok(html.indexOf(gs) < html.indexOf('<!--pulse:'), 'Get started first, as on the phone when nothing needs you');
    hub.agentOp('p2', 'claim', 'bot2', { item: '#1' });
    hub.agentOp('p2', 'ask', 'bot2', { item: '#1', question: 'Which region?', blocking: true });
    html = homePage(homeView(hub), { ...deps(), wide: true, gs });
    const [main, side] = html.split('<aside class="col-side" data-scroll="side:home">');
    assert.ok(main.startsWith('<div class="cols"><div class="col-main">') && main.includes('home-needs'));
    assert.ok(side.indexOf('<!--pulse:') < side.indexOf(gs) && side.indexOf(gs) < side.indexOf('home-projects'), 'pulse, Get started, projects');
    const narrow = homePage(homeView(hub), { ...deps(), gs });
    assert.ok(!narrow.includes('class="cols"'), 'the phone: one column');
    // #711: on a phone the first card that needs you is on the first screen, so Get started follows Needs you.
    const at = ['<!--pulse:', 'home-needs', gs, 'home-projects'].map((s) => narrow.indexOf(s));
    assert.ok(at.every((n, i) => n >= 0 && (i === 0 || at[i - 1] < n)), 'the phone: pulse, Needs you, Get started, projects');  });

  test('pulse() and card() are the project page\'s own: one definition each, handed to the home', () => {
    const app = appSource();
    assert.equal(app.match(/^function pulse\(/gm)?.length, 1);
    assert.equal(app.match(/^function card\(/gm)?.length, 1);
    assert.match(app, /homePage\(S\.home, \{ z: z\(\), pulse, card, esc, plural, /);
    assert.ok(!/function (pulse|card)\(/.test(readFileSync(new URL('../web/home.js', import.meta.url), 'utf8')), 'home.js forks neither');
  });

  test("actions from the home reach each card's own project: answer in one, accept in the other", async () => {
    const hub = setup();
    hub.agentOp('p2', 'claim', 'bot2', { item: '#1' });
    hub.agentOp('p2', 'ask', 'bot2', { item: '#1', question: 'Which region?', blocking: true });
    hub.agentOp('p1', 'submit', 'bot', { item: '#2', headline: 'Built', evidence: [{ label: 'tests pass' }] });
    const server = createServer(hub, { sweepMs: 3_600_000 });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    // The person acts from the home page: their key acts, the address alone proves nothing (#900).
    const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, authorization: `Bearer ${server.personKey}` }, body: JSON.stringify(body) }).then((r) => r.json());
    try {
      // The page last opened p1; the cards say which project each action is for.
      await fetch(`${base}/api/p/p1/view`);
      const home = await (await fetch(`${base}/api/home`)).json();
      const q = home.needs.find((a) => a.kind === 'question'), review = home.needs.find((a) => a.kind === 'review');
      assert.equal(q.project.slug, 'p2');
      assert.equal(review.project.slug, 'p1');

      assert.equal((await post(`/api/p/${q.project.slug}/human/answer`, { question: q.question.id, answer: 'eu-west' })).ok, true);
      assert.equal(hub.item(hub.project('p2'), '#1').stage, 'ready', 'p2\'s question answered: its work moves again');
      assert.equal((await post(`/api/p/${review.project.slug}/human/accept`, { item: review.item })).ok, true);
      assert.notEqual(hub.item(hub.project('p1'), '#2').stage, 'verifying', 'p1\'s submission accepted');
      assert.equal(hub.item(hub.project('p2'), '#2').stage, 'active', 'p2\'s #2 untouched');

      const after = await (await fetch(`${base}/api/home`)).json();
      assert.deepEqual(after.needs, []);
      assert.deepEqual(await post('/api/home/seen', {}), { ok: true }, 'Mark all seen from the home');
    } finally { server.close(); }
  });
});
