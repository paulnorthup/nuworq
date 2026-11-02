// Memory distilled for people (#552): the field-notes review also writes Direction today, a gist for each decision
// and field note, and a recommendation for each field note. Under "Run with it" its retires happen; otherwise a
// person decides with one tap, and making a note a decision always waits for one.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { view } from '../src/insight.js';
import { distillDue, DISTILL_EVERY, DIRECTION_MAX } from '../src/fieldnotes.js';

function setup({ autonomy = 'full' } = {}) {
  let now = Date.UTC(2026, 10, 1, 9);
  const hub = new Hub({ clock: () => now });
  hub.tx(() => hub.project('p', { create: true, name: 'App' }));
  const human = (op, args) => hub.humanOp('p', op, args);
  const agent = (op, name, args = {}) => { if (op === 'next' && args.claim !== false) hub.tidyAll(); return hub.agentOp('p', op, name, args); };
  human('settings', { autonomy });
  human('decide', { body: 'Design for agents as the primary users of the protocol: low ceremony, small responses, forgiving inputs, every error carries a hint.' });
  agent('checkin', 'a1');
  const built = agent('learn', 'a1', { note: 'In this setup git push --force-with-lease needs approval, so after a rebase push with origin first: git push origin HEAD:refs/heads/b --force-with-lease=b:<sha>.' }).note;
  const rule = agent('learn', 'a1', { note: 'Never put git push in the same batch as git rebase: a stopped rebase pushes main to your branch.' }).note;
  const ok = agent('learn', 'a1', { note: 'test/seedhub.js builds a 500-item hub in 5s for perf checks.' }).note;
  const decision = hub.decisions(hub.project('p'))[0].id;
  const p = () => hub.project('p');
  return { hub, human, agent, ids: { built, rule, ok, decision }, p, tick: (ms) => { now += ms; } };
}

// The review job: what next offers once the sweep sees memory needs distilling.
function review(s, name = 'r1') {
  s.tick(DISTILL_EVERY);
  s.agent('checkin', name);
  const job = s.agent('next', name);
  assert.equal(job.mode, 'tidy', 'the review is offered as a tidy job');
  return job;
}

const distillArgs = (ids) => ({
  direction: [
    { line: 'Agents are the primary users: small responses, a hint with every error.', source: `decision ${ids.decision}` },
    { line: 'Rebase, test and push one step at a time.', source: `note ${ids.rule}` },
  ],
  notes: [
    { note: ids.decision, gist: 'Agents come first: low ceremony and a hint on every error.' },
    { note: ids.built, gist: 'Force pushes need a special form here.', recommend: 'retire', why: 'The lesson is now in the runner allowlist, bin/nuworq.js.' },
    { note: ids.rule, gist: 'Push only after a rebase finishes.', recommend: 'decide', why: 'Every agent rebases; it should bind them all.', draft: 'Never push in the same step as a rebase.' },
    { note: ids.ok, gist: 'A quick big hub for perf checks: test/seedhub.js.' },
  ],
});

describe('memory distilled for people (#552)', () => {
  test('a review opens when the inputs change, at most hourly, and its summary asks to distill', () => {
    const s = setup();
    assert.equal(distillDue(s.hub, s.p()), true, 'nothing distilled yet');
    const job = review(s);
    assert.match(job.summary ?? s.agent('look', 'r1', { item: job.item }).summary, /distill/);
    s.agent('distill', 'r1', distillArgs(s.ids));
    assert.equal(distillDue(s.hub, s.p()), false, 'just distilled');
    s.agent('learn', 'a1', { note: 'A new lesson about exports.' });
    assert.equal(distillDue(s.hub, s.p()), false, 'changed, but within the hour');
    s.tick(DISTILL_EVERY);
    assert.equal(distillDue(s.hub, s.p()), true, 'an hour on, the change is due');
  });

  test("the hub's own notices aren't steering to distill (#550): only what a person wrote is", () => {
    const s = setup();
    review(s);
    s.agent('distill', 'r1', distillArgs(s.ids));
    s.human('settings', { autonomy: 'balanced' }); // the hub tells agents "Autonomy is now …"
    s.tick(DISTILL_EVERY);
    assert.equal(distillDue(s.hub, s.p()), false, 'a notice changes nothing a person reads as direction');
    s.human('steer', { body: 'Keep the public API unchanged' });
    assert.equal(distillDue(s.hub, s.p()), true, "a person's steer is");
  });

  test('gists, Direction today and recommendations are stored and shown; agents still get the full text', () => {
    const s = setup({ autonomy: 'balanced' });
    review(s);
    const r = s.agent('distill', 'r1', distillArgs(s.ids));
    assert.deepEqual(r.waiting.sort(), [s.ids.built, s.ids.rule].sort(), 'retire and decide wait for a person under lower autonomy');
    const v = view(s.hub, 'p');
    assert.deepEqual(v.direction.map((d) => d.source), [`decision ${s.ids.decision}`, `note ${s.ids.rule}`]);
    assert.equal(v.decisions[0].gist, 'Agents come first: low ceremony and a hint on every error.');
    assert.match(v.decisions[0].body, /^Design for agents/, 'the full text stays behind it');
    const note = (id) => v.notes.find((n) => n.id === id);
    assert.deepEqual(note(s.ids.built).advice, { do: 'retire', why: 'The lesson is now in the runner allowlist, bin/nuworq.js.' });
    assert.equal(note(s.ids.rule).advice.draft, 'Never push in the same step as a rebase.');
    assert.equal(note(s.ids.ok).gist, 'A quick big hub for perf checks: test/seedhub.js.');
    const notes = s.agent('look', 'a1', { notes: 'all' }).field_notes.map((n) => n.note);
    assert.ok(notes.some((n) => n.startsWith('In this setup git push')), 'agents get the agent\'s words, not the gist');
    assert.match(s.agent('checkin', 'a1').decisions[0], /^Design for agents/);
  });

  test('under Run with it, a retire it recommends is carried out, with its reason on the record', () => {
    const s = setup({ autonomy: 'full' });
    review(s);
    const r = s.agent('distill', 'r1', distillArgs(s.ids));
    assert.deepEqual(r.retired, [s.ids.built]);
    assert.deepEqual(r.waiting, [s.ids.rule], 'a decision still waits for a person');
    const v = view(s.hub, 'p');
    assert.equal(v.notes.find((n) => n.id === s.ids.built), undefined, 'retired');
    assert.ok(v.activity.some((e) => e.type === 'retired' && /bin\/nuworq\.js/.test(e.summary ?? '')), 'with its reason');
  });

  // #633: #611 stops retire from turning off a note a person pinned; distill's own retire mustn't either.
  test('a memory distill never retires a pinned field note', () => {
    const s = setup({ autonomy: 'full' });
    s.human('always', { note: s.ids.built }); // a person pinned it to every agent
    review(s);
    const r = s.agent('distill', 'r1', distillArgs(s.ids));
    assert.deepEqual(r.retired, [], 'not retired, even under Run with it');
    assert.deepEqual(r.waiting.sort(), [s.ids.built, s.ids.rule].sort(), 'its retire advice waits for the person, as under lower autonomy');
    const note = view(s.hub, 'p').notes.find((n) => n.id === s.ids.built);
    assert.ok(note, 'still active');
    assert.deepEqual(note.advice, { do: 'retire', why: 'The lesson is now in the runner allowlist, bin/nuworq.js.' }, 'the person sees why, with one tap');
    assert.equal(note.gist, 'Force pushes need a special form here.');
  });

  test('under lower autonomy a retire waits: the person retires or keeps it with one tap', () => {
    const s = setup({ autonomy: 'balanced' });
    review(s);
    s.agent('distill', 'r1', distillArgs(s.ids));
    assert.ok(view(s.hub, 'p').notes.find((n) => n.id === s.ids.built), 'still active');
    s.human('keep', { note: s.ids.built });
    assert.equal(view(s.hub, 'p').notes.find((n) => n.id === s.ids.built).advice.by, 'you', 'kept by the person: nothing left to decide');
    s.human('retire', { note: s.ids.ok });
    assert.equal(view(s.hub, 'p').notes.find((n) => n.id === s.ids.ok), undefined);
  });

  test('"make it a decision" waits for a person, who accepts the draft or edits it', () => {
    for (const autonomy of ['full', 'balanced']) {
      const s = setup({ autonomy });
      review(s);
      s.agent('distill', 'r1', distillArgs(s.ids));
      assert.equal(s.hub.decisions(s.p()).length, 1, `${autonomy}: no agent makes a decision`);
      s.human('promote', { note: s.ids.rule });
      const decisions = s.hub.decisions(s.p()).map((d) => d.body);
      assert.deepEqual(decisions.slice(1), ['Never push in the same step as a rebase.']);
      assert.equal(view(s.hub, 'p').notes.find((n) => n.id === s.ids.rule), undefined, 'the note retires into the decision');
    }
  });

  test('only the review distills, Direction today stays short and names real sources, and a retire or decide says why', () => {
    const s = setup({ autonomy: 'balanced' });
    assert.throws(() => s.agent('distill', 'a1', distillArgs(s.ids)), /Only a field-notes tidy/);
    review(s);
    const lines = Array.from({ length: DIRECTION_MAX + 1 }, () => ({ line: 'x', source: `decision ${s.ids.decision}` }));
    assert.throws(() => s.agent('distill', 'r1', { direction: lines }), /at most 7 lines/);
    assert.throws(() => s.agent('distill', 'r1', { direction: [{ line: 'x', source: 'decision 999' }] }), /No active decision 999/);
    assert.throws(() => s.agent('distill', 'r1', { direction: [{ line: 'x', source: 'somewhere' }] }), /Not a source/);
    assert.throws(() => s.agent('distill', 'r1', { notes: [{ note: s.ids.ok, gist: 'g', recommend: 'retire' }] }), /Say why/);
    assert.throws(() => s.agent('distill', 'r1', { notes: [{ note: s.ids.ok, gist: 'g', recommend: 'decide', why: 'w' }] }), /draft/);
  });

  // With #501, 5m sends only the first field notes: one waiting for a person, or named in Direction today, still comes.
  test("at 5m the page gets every note waiting for a person's tap and every note Direction today names", () => {
    const s = setup({ autonomy: 'balanced' });
    review(s);
    s.agent('distill', 'r1', distillArgs(s.ids));
    for (let i = 0; i < 4; i++) { s.tick(1000); s.agent('learn', 'a1', { note: `Newer lesson ${i}.` }); }
    const sent = view(s.hub, 'p', { depth: '5m' }).notes.map((n) => n.id);
    assert.ok(sent.includes(s.ids.built), 'its retire waits for a person');
    assert.ok(sent.includes(s.ids.rule), 'its decision draft waits, and Direction today names it');
    assert.ok(!sent.includes(s.ids.ok), 'a kept note older than the first three stays at 30m');
    assert.equal(view(s.hub, 'p', { depth: '5m' }).counts.notes, 7);
  });
});
