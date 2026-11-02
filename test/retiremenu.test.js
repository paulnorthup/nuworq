import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NEW } from '../web/new.js';
import { appSource } from './appsource.js';

// #651: Steering & memory had a Retire button on every decision and field note (42 on live nuworq), though the
// distill recommended retiring none. Retire now shows where retiring is recommended, and waits behind the row's ⋯
// everywhere else: one tap away, nothing lost.
const app = appSource();
const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
const newjs = readFileSync(new URL('../web/new.js', import.meta.url), 'utf8');
const steering = app.match(/\nfunction steering\(v\) \{[\s\S]*?\n\}\n/)[0];

describe("Retire shows only on what's recommended for retiring (#651)", () => {
  test('a decision has no Retire in view: it is behind the row\'s ⋯', () => {
    const decisions = steering.match(/const decisions = [\s\S]*?\.join\(''\);/)[0];
    assert.doesNotMatch(decisions, /data-action="retire"/, 'no Retire button on the row');
    assert.match(decisions, /\$\{more\(d\.id,/, 'the ⋯ menu holds it');
  });

  test("a field note shows Retire only with a retire recommendation; otherwise it's behind ⋯", () => {
    const notes = steering.match(/const notes = [\s\S]*?\.join\(''\);/)[0];
    assert.doesNotMatch(notes, /data-action="retire"/, 'no Retire button on the row');
    assert.match(notes, /pending\(n\) && n\.advice\.do === 'retire' \? '' : more\(n\.id,/, 'the menu, unless the advice already offers Retire');
    const advice = steering.match(/const advice = [\s\S]*?\n {2}\};/)[0];
    assert.match(advice, /Recommended: retire\.[\s\S]*data-action="retire"/, 'a retire recommendation keeps its Retire button');
  });

  test('the ⋯ menu holds Retire, one tap away, in a popover the rows never clip', () => {
    const more = steering.match(/const more = [\s\S]*?<\/span>`;/)[0];
    assert.match(more, /<button class="btn ghost small row-more" popovertarget="more-\$\{id\}"[^>]*aria-label="More"[^>]*>⋯<\/button>/);
    assert.match(more, /<div class="row-menu" id="more-\$\{id\}" popover style="position-anchor:--more-\$\{id\}"/, 'a popover: the top layer, light-dismissed, shut by Escape');
    assert.match(more, /<button data-action="retire" data-note="\$\{id\}"[^>]*>Retire<\/button>/);
    assert.match(css, /\.row-menu \{ inset: auto;[^}]*position-area: bottom span-left;/, 'it opens under its ⋯');
    assert.match(app, /\.row-menu:popover-open \[data-action\]'\)\?\.closest\('\.row-menu'\)\.hidePopover\(\)/, 'and shuts once Retire is chosen');
  });

  test("the menu's anchor is never the ⋯ itself, so its new tag can't take it away", () => {
    // markNew anchors the tag to the tagged element by setting that element's anchor-name; on the ⋯ that replaced
    // --more-<id>, and the first tap opened the menu in the window's corner.
    assert.match(newjs, /el\.style\.setProperty\('anchor-name', anchor\)/, 'markNew sets the tagged element\'s anchor-name');
    const more = steering.match(/const more = [\s\S]*?<\/span>`;/)[0];
    assert.match(more, /^const more = \(id, title, isNew\) => `<span class="row-more-at" style="anchor-name:--more-\$\{id\}"><button class="btn ghost small row-more"/, 'the wrapper holds the anchor');
    const button = more.match(/<button class="btn ghost small row-more"[^>]*>/)[0];
    assert.match(button, /data-new="retire-in-menu"/, 'the ⋯ carries the tag');
    assert.doesNotMatch(button, /anchor-name/, 'and no anchor of its own');
  });

  test('the change is tagged new', () => {
    assert.equal(NEW['retire-in-menu'], '2026-11-02');
    assert.match(steering, /data-new="retire-in-menu"/);
  });
});
