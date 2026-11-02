// Widening the window keeps the project page whole (#747). Crossing 1024px re-renders the page as two columns; the
// sections that read the same as before (the pulse, Flow, Agents) came through as <!--same:…--> stand-ins inside the
// new side column, and nothing drew them: the column stayed empty until a reload. This drives the real project page
// through a stubbed matchMedia and paints it the way web/ui.js does, with its memory of each section.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { view, itemView, projectList } from '../src/insight.js';
import { morph } from '../web/morph.js';
import { untimed } from '../web/ago.js';
import { documentOf } from './minidom.js';

// The window's width, as web/views/html.js reads it: WIDE is matchMedia('(min-width: 1024px)').
const wide = { matches: false, addEventListener() {} };
globalThis.matchMedia = (q) => (q.includes('1024px') ? wide : { matches: false, addEventListener() {} });

describe('the project page survives the window crossing 1024px (#747)', () => {
  let ui, store, html;
  before(async () => {
    const el = () => ({ querySelectorAll: () => [], classList: { toggle() {}, add() {}, remove() {} }, hidden: false });
    const els = { '#rail': el(), '#main': el(), '#drawer': el(), '#scrim': el() };
    globalThis.document = { activeElement: null, scrollingElement: null, hidden: false, querySelectorAll: () => [], querySelector: (s) => els[s] ?? null };
    const hub = new Hub();
    hub.tx(() => hub.project('a', { create: true }));
    hub.humanOp('a', 'create', { title: 'Build a', acceptance: 'x' });
    hub.humanOp('a', 'create', { title: 'Build b', acceptance: 'x' });
    hub.agentOp('a', 'claim', 'bot', { item: '#1' });
    hub.agentOp('a', 'submit', 'bot', { item: '#1', headline: 'Built', evidence: [{ label: 'tests pass' }] });
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
    const { mainHtml } = await import('../web/views/main.js');
    for (const r of ['rail', 'drawer']) ui.REGIONS[r] = () => els[`#${r}`];
    ui.REGIONS.main = () => { html = mainHtml(); return els['#main']; };
  });

  const sections = (markup) => [...markup.matchAll(/<!--sec:([\w:-]+)-->/g)].map((m) => m[1]);
  for (const zoom of ['30s', '5m', '30m']) {
    test(`at ${zoom}: narrow, wide, narrow, wide, each section drawn once, the side column whole`, async () => {
      store.setState({ slug: 'a', itemRef: null, zoom });
      const { body: page } = documentOf('');
      const memory = new Map();
      let fetched = false; // each depth brings its own view: fetched once, then only re-laid out
      const paint = async (isWide) => {
        wide.matches = isWide;
        if (!fetched) { fetched = true; await ui.refresh({ force: true }); } else ui.render({ force: true, also: ['main'] });
        morph(page, html, { memory, alike: untimed });
        return page.innerHTML;
      };
      let wideKeys;
      for (const isWide of [false, true, false, true]) {
        const drawn = await paint(isWide);
        assert.doesNotMatch(drawn, /<!--same:/, 'no stand-in is left undrawn');
        assert.deepEqual(sections(drawn), sections(html), 'every section of the markup, once');
        if (isWide) {
          const side = drawn.slice(drawn.indexOf('<aside class="col-side"'));
          for (const k of ['pulse', 'flow']) assert.match(side, new RegExp(`<!--sec:${k}-->`), `${k} in the side column`);
          if (zoom !== '30s') assert.match(side, /<!--sec:agents-->/, 'Agents in the side column');
          assert.match(side, /Needs you/, "the side column's Needs you summary");
          wideKeys ??= sections(drawn);
          assert.deepEqual(sections(drawn), wideKeys, 'the same sections each time it widens');
        }
      }
    });
  }
});
