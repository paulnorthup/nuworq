import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hub, HOUR } from '../src/core.js';
import { view } from '../src/insight.js';
import { milestonesSection } from '../web/milestones.js';
import { NEW } from '../web/new.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
// What a person reads: text between tags, and the attributes a person sees (placeholder, title, aria-label).
const visible = (html) => [
  ...html.replace(/<[^>]*>/g, '\n').split('\n'),
  ...[...html.matchAll(/\b(?:placeholder|title|aria-label)="([^"]*)"/g)].map((m) => m[1]),
].map((s) => s.trim()).filter(Boolean);

// A "now" milestone (#1) whose next step needs infra, past 4 hours with nobody who has it, and one loose item.
function setup() {
  let t = Date.UTC(2026, 10, 2, 9);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('site', { create: true, name: 'Site' }));
  hub.humanOp('site', 'create', { title: 'Signup website', acceptance: 'people can sign up', priority: 'now' });
  hub.humanOp('site', 'create', { title: 'Point the DNS at the hub', acceptance: 'resolves', priority: 'soon', parent: '#1', needs: ['infra'] });
  hub.humanOp('site', 'create', { title: 'Write the copy', acceptance: 'written', priority: 'soon', parent: '#1' });
  hub.humanOp('site', 'create', { title: 'Loose end', acceptance: 'tied', priority: 'soon' });
  hub.agentOp('site', 'checkin', 'w1', { has: ['macos'] });
  t += 5 * HOUR;
  return view(hub, 'site');
}

describe('groups are called milestones wherever a person reads them (#269)', () => {
  test('the project view with a milestone and a stalled-milestone card says milestone, never group', () => {
    const v = setup();
    const section = milestonesSection(v, { esc });
    const card = v.attention.find((a) => a.kind === 'group-stalled');
    assert.ok(card, 'a stalled-milestone card');
    const label = app.match(/'group-stalled': '([^']*)'/)[1];
    const texts = [...visible(section), label, card.headline, card.sub, card.why, ...card.how.flatMap((s) => [s.do, s.check])];
    assert.ok(texts.includes('Milestones'), 'the section is titled Milestones');
    assert.ok(texts.includes('Not in a milestone (1)'));
    assert.equal(label, 'A "now" milestone is stalled');
    assert.deepEqual(texts.filter((s) => /group/i.test(s)), [], 'no visible text says group');
  });

  test('the edit form, the rank tooltip and the priority toast say milestone; the section is tagged new', () => {
    assert.match(app, /placeholder="e\.g\. #12: the milestone it belongs to; empty for none"/);
    assert.match(app, /title="Agents take it at this priority: its milestone, or work waiting on it, ranks higher"/);
    assert.match(app.match(/'group-priority': [^\n]*/)[0], /everything in the milestone ranks at least/);
    assert.ok(NEW.milestones, 'web/new.js lists it');
    assert.match(milestonesSection({ groups: [{ item: '#1', title: 'x', state: 'queued', done: 0, total: 1, reason: '', priority: 'soon' }] }, { esc }), /data-new="milestones"/);
  });
});
