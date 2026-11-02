import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appSource } from './appsource.js';

// #711: on a phone (375×812) the project page at 30s put the first Needs you card at y=872, below the mission, the
// pulse, the steer box and + Work. Narrow, Needs you now follows the pulse, the composer follows the cards, and a long
// mission shows two lines until tapped. Wide keeps its two columns as they were.
const app = appSource();
const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
const body = app.slice(app.indexOf('function projectBody('), app.indexOf('function emptyProject('));
const keys = (line) => JSON.parse(line.match(/order\((\[[^\]]*\])\)/)[1].replace(/'/g, '"'));

describe('a phone sees what needs it first (#711)', () => {
  test('narrow: pulse, Needs you and its groups, then the composer and the rest', () => {
    const narrow = keys(body.match(/\n {2}return order\(\[.*\]\);/)[0]);
    assert.deepEqual(narrow.slice(0, 4), ['pulse', 'needs', 'groups', 'composer']);
    assert.ok(narrow.indexOf('needs') < narrow.indexOf('empty'), 'the empty-project hint follows too');
  });

  test('wide is unchanged: the composer heads the main column, the pulse heads the side', () => {
    const [main, side] = [...body.match(/columns\(order\((\[[^\]]*\])\), order\((\[[^\]]*\])\)/).slice(1)].map((s) => JSON.parse(s.replace(/'/g, '"')));
    assert.deepEqual(main.slice(0, 3), ['composer', 'needs', 'groups']);
    assert.equal(side[0], 'pulse');
  });

  test('a long mission shows two lines on a phone; the first tap shows it all, the next edits it', () => {
    assert.match(app, /class="mission \$\{P\.mission \? '' : 'empty'\}\$\{S\.open\.has\(`mission:\$\{P\.slug\}`\) \? '' : ' clamp'\}" data-action="edit-mission"/);
    assert.match(css, /@media \(max-width: 600px\) \{ \.mission\.clamp \{[^}]*-webkit-line-clamp: 2;[^}]*overflow: hidden;/);
    assert.match(app, /'edit-mission': \(el\) => \{[\s\S]*?el\.scrollHeight > el\.clientHeight \+ 1 && !S\.open\.has\(`mission:\$\{S\.slug\}`\)\) \{ addTo\('open', `mission:\$\{S\.slug\}`\);[\s\S]*?return; \}\n {4}setState\(\{ editMission: true \}\)/);
  });
});
