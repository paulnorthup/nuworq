import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routingConfirm, routingConfirmFor, MIN_ATTEMPTS as SAID } from '../web/routingconfirm.js';
import { MIN_ATTEMPTS, QUALITY, pickModel } from '../src/models.js';

// #770: the confirm said building stays on the top model and named only some failures; src/models.js does otherwise.
const said = (o) => routingConfirm({ quality: QUALITY.balanced, trial: 10, race: 0, ...o });

test('the confirm names the chosen bar and when builds move to it', () => {
  assert.equal(SAID, MIN_ATTEMPTS, 'the confirm counts the attempts routing waits for');
  assert.match(said(), /Building starts on the top model/);
  assert.match(said(), new RegExp(`each have ${MIN_ATTEMPTS} finished attempts`));
  assert.match(said(), /cheapest model within your quality bar, Balanced: a cheaper model within 5 points of the best/);
  assert.match(said({ quality: QUALITY.best }), /Best quality: only a model that does as well as the best/);
  assert.doesNotMatch(said(), /Building[^.]*stay on the top model/);
});

test('it says which jobs start where, as pickModel does', () => {
  const list = ['haiku', 'sonnet', 'opus'];
  assert.equal(pickModel(list, { mode: 'work' }).start, 2);
  assert.equal(pickModel(list, { mode: 'land' }).start, 0);
  assert.equal(pickModel(list, { mode: 'review' }).start, 2);
  assert.match(said(), /Landing and tidying start on the cheapest model\. Reviews and shaping stay on the top model\./);
});

test('it says the share of builds tried one model down, and a race when there is one', () => {
  assert.match(said(), /10% of builds try one model down/);
  assert.match(said({ trial: '25', race: '5' }), /25% of builds try one model down, and 5% race a cheaper model against the top one/);
  assert.doesNotMatch(said({ trial: 0 }), /try one model down|race/);
});

test('every failure that steps up is named, a lost lease included', () => {
  assert.match(said(), /sent back, stalls, is handed off or loses its lease, that item's next attempt steps up one model/);
});

test('Settings → Staffing → Cheaper models shows this confirm', () => {
  const src = readFileSync(new URL('../web/actions.js', import.meta.url), 'utf8');
  assert.match(src, /'models-on': \(\) => \{[\s\S]*?confirm\(routingConfirmFor\(S\.view\?\.project\?\.staffing\?\.models\)\)/);
  assert.doesNotMatch(src, /Building, reviews and shaping stay on the top model/);
});

test('the confirm names what is saved, not a bar or share picked but not yet saved', () => {
  // The switch saves only routing and tiers; the bar and shares wait for Save, so the confirm reads the saved ones.
  const saved = { quality: 'best', trial: 25, race: 5, qualities: QUALITY };
  assert.match(routingConfirmFor(saved), /Best quality: only a model that does as well as the best/);
  assert.match(routingConfirmFor(saved), /25% of builds try one model down, and 5% race/);
  assert.match(routingConfirmFor({ qualities: QUALITY }), /Balanced: a cheaper model within 5 points of the best[\s\S]*10% of builds try one model down/);
  const src = readFileSync(new URL('../web/actions.js', import.meta.url), 'utf8');
  const on = src.match(/'models-on': \(\) => \{[\s\S]*?\n  \},/)[0];
  assert.doesNotMatch(on, /st-quality|st-trial|st-race|val\(/, 'nothing unsaved from the dialog');
});
