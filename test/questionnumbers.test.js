// A question named by its number is easy to find (#710): agents and the hub say "question 207", so each question
// shows its number, and ⌘K opens it by "q207" or "question 207", whatever its status.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hub, PERSON_CAN } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { view, itemView, projectList } from '../src/insight.js';
import { rank, resultsHtml, questionHtml } from '../web/launcher.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const index = (extra = {}) => ({
  projects: [{ slug: 'nuworq', name: 'nuworq' }, { slug: 'site', name: 'nuworq-site' }],
  items: [{ p: 'nuworq', n: 207, t: 'Item two-oh-seven', s: 'ready', pr: 'soon' }],
  questions: [
    { id: 207, p: 'nuworq', n: 9, t: 'Cap spend per day or per item?', st: 'open', a: '', by: 'claude-1' },
    { id: 208, p: 'site', n: 3, t: 'Which font?', st: 'answered', a: 'Inter', by: 'claude-2' },
    { id: 209, p: 'nuworq', n: null, t: 'Add the key to the runner', st: 'answered', a: 'Done', by: 'claude-3' },
  ],
  needs: [{ key: 'q:207', kind: 'question', item: '#9', headline: 'Cap spend per day or per item?', project: 'nuworq', question: 207 }],
  can: PERSON_CAN.owner, stages: {}, ...extra,
});

describe('⌘K finds a question by its number (#710)', () => {
  test('"q207", "Q207", "question 207" and "question #207" put that question first, and make nothing', () => {
    for (const typed of ['q207', 'Q207', 'question 207', 'question #207', 'Question207']) {
      const r = rank(index(), typed, { current: 'nuworq' });
      assert.equal(r[0].kind, 'question', typed);
      assert.equal(r[0].ref, 'Q207');
      assert.equal(r[0].label, 'Cap spend per day or per item?');
      assert.ok(!r.some((x) => x.kind === 'create'), `${typed}: looking a question up proposes nothing`);
    }
    assert.equal(rank(index(), '207', { current: 'nuworq' })[0].ref, '#207', 'a bare number is still an item');
    assert.ok(!rank(index(), 'q999', { current: 'nuworq' }).some((x) => x.kind === 'question'), 'no such question');
  });

  test('an open question goes to its card; an answered one to its item; one with no item opens on its own', () => {
    const open = rank(index(), 'q207', { current: 'nuworq' })[0];
    assert.equal(open.run.question.card, true, 'its Needs you card');
    assert.equal(open.hint, '#9 · Open');
    const other = rank(index(), 'q208', { current: 'nuworq' })[0];
    assert.equal(other.run.question.card, false);
    assert.equal(other.run.question.n, 3, "its item's flyout");
    assert.equal(other.hint, '#3 · nuworq-site · Answered', "another project's is labeled with its name");
    const alone = rank(index(), 'q209', { current: 'nuworq' })[0];
    assert.equal(alone.run.question.n, null);
    const html = questionHtml(alone.run.question, { esc });
    assert.match(html, /<h2>Q209 · Answered<\/h2>/);
    assert.match(html, /Add the key to the runner/);
    assert.match(html, /Answer: <b>Done<\/b>/);
    assert.match(html, /data-action="question-project" data-slug="nuworq"/);
    // An operator card holds its questions by number too.
    const op = index({ needs: [{ key: 'operator:209', kind: 'operator-missing', item: null, project: 'nuworq', question: null, questions: [209] }] });
    assert.equal(rank(op, 'q209', { current: 'nuworq' })[0].run.question.card, true);
  });

  test('the row shows the number where an item shows its ref', () => {
    const html = resultsHtml(rank(index(), 'q207', { current: 'nuworq' }), { esc });
    assert.match(html, /<span class="ln-ref">Q207<\/span><span class="ln-label">Cap spend per day or per item\?<\/span><span class="ln-hint">#9 · Open<\/span>/);
  });

  test('GET /api/launcher lists every question, light: number, project, item, words, status, answer, asker', async () => {
    const hub = new Hub();
    const auth = new Auth(hub.db);
    hub.tx(() => hub.project('a', { create: true }));
    hub.humanOp('a', 'create', { title: 'Build a', acceptance: 'x' });
    hub.agentOp('a', 'claim', 'bot', { item: '#1' });
    const asked = hub.agentOp('a', 'ask', 'bot', { item: '#1', question: 'Per day or per item?', options: ['Per day', 'Per item'], blocking: true });
    const loose = hub.agentOp('a', 'ask', 'bot', { question: 'Is the runner up?', assumption: 'It is' });
    hub.humanOp('a', 'answer', { question: asked.question, answer: 'Per day' });
    const owner = auth.createToken('o', 'human');
    const server = createServer(hub, { auth: 'required' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const json = await fetch(`http://127.0.0.1:${server.address().port}/api/launcher`, { headers: { authorization: `Bearer ${owner}` } }).then((r) => r.json());
      assert.deepEqual(json.questions, [
        { id: asked.question, p: 'a', n: 1, t: 'Per day or per item?', st: 'answered', a: 'Per day', by: 'bot' },
        { id: loose.question, p: 'a', n: null, t: 'Is the runner up?', st: 'open', a: '', by: 'bot' },
      ]);
    } finally { server.close(); }
  });
});

describe('each question shows its number (#710)', () => {
  let hub, ui, store, html, asked;
  before(async () => {
    // The page's elements, stood in for (as in regions.test.js): nothing focused, nothing scrolled, no "new" tags.
    const el = () => ({ querySelectorAll: () => [], classList: { toggle() {}, add() {}, remove() {} }, hidden: false });
    const els = { '#rail': el(), '#main': el(), '#drawer': el(), '#scrim': el() };
    globalThis.document = { activeElement: null, scrollingElement: null, hidden: false, querySelectorAll: () => [], querySelector: (s) => els[s] ?? null };
    hub = new Hub();
    hub.tx(() => hub.project('a', { create: true }));
    hub.humanOp('a', 'create', { title: 'Build a', acceptance: 'x' });
    hub.agentOp('a', 'claim', 'bot', { item: '#1' });
    asked = hub.agentOp('a', 'ask', 'bot', { item: '#1', question: 'Per day or per item?', options: ['Per day', 'Per item'], blocking: true });
    globalThis.fetch = async (path) => {
      const u = new URL(path, 'http://hub/');
      const m = u.pathname.match(/^\/api\/p\/([^/]+)\/(view|items\/(\d+))$/);
      const body = u.pathname === '/api/projects' ? projectList(hub)
        : m?.[2] === 'view' ? view(hub, 'a', { depth: u.searchParams.get('depth') })
        : m?.[3] ? itemView(hub, 'a', `#${m[3]}`) : {};
      return { status: 200, ok: true, json: async () => JSON.parse(JSON.stringify(body)) };
    };
    store = await import('../web/store.js');
    ui = await import('../web/ui.js');
    const views = { rail: (await import('../web/views/rail.js')).railHtml, main: (await import('../web/views/main.js')).mainHtml, drawer: (await import('../web/views/drawer.js')).drawerHtml };
    html = {};
    for (const r of Object.keys(views)) ui.REGIONS[r] = () => { html[r] = views[r](); return els[`#${r}`]; };
  });

  test('the Needs you card and the drawer row show Q<n> beside the item, and ⌘K lands on them', async () => {
    store.setState({ slug: 'a', itemRef: '#1', zoom: '30s' });
    await ui.refresh({ force: true });
    const q = asked.question;
    assert.match(html.main, new RegExp(`<article class="card kind-question" data-qs="${q}" tabindex="-1">`));
    assert.match(html.main, new RegExp(`data-item="#1">#1</a><span class="qref" title="Question ${q}: ⌘K finds it as q${q}">Q${q}</span>`));
    assert.match(html.drawer, new RegExp(`data-qs="${q}" tabindex="-1">\\s*<div class="meta"><span class="qref"[^>]*>Q${q}</span> · `));
  });

  test("an operator's waiting questions are listed by number: on their own card, or on the one line", () => {
    // With steps, and no operator here, it's a card of its own (#712), numbered like any question.
    const steps = hub.agentOp('a', 'ask', 'bot', { question: 'Add the API key to the runner machine', blocking: true, to: 'operator',
      steps: [{ do: 'Run nuworq secrets set KEY', where: 'nuworq secrets set KEY' }] });
    const attention = () => view(hub, 'a', { depth: '30s' }).attention;
    const own = attention().find((a) => a.kind === 'question' && a.question.id === steps.question);
    assert.equal(own.operator, true);
    // The rest wait on the one line, by number.
    const loose = hub.agentOp('a', 'ask', 'bot', { question: 'Is the runner machine up?', assumption: 'It is', to: 'operator' });
    const line = attention().find((a) => a.kind === 'operator-missing');
    assert.deepEqual(line.questions, [loose.question]);
    assert.equal(line.sub, `Q${loose.question}: Is the runner machine up?`);
  });

  test('it is new, and the guide says how to find a question by its number', () => {
    assert.match(readFileSync(new URL('../web/new.js', import.meta.url), 'utf8'), /'question-numbers': '2026-11-02'/);
    assert.match(readFileSync(new URL('../src/userguide.js', import.meta.url), 'utf8'), /type `q207`: it opens that question/);
  });
});
