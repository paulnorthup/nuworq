import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trialNote } from '../web/trialnote.js';

test('the Staffing dialog says when a trial share cannot run (#725)', () => {
  assert.match(trialNote({ on: true, trial: 20, tiers: { claude: [], codex: [] } }), /two or more models.*cheaper Claude model/);
  assert.match(trialNote({ on: true, trial: 10, tiers: { claude: ['claude-opus-5-5'] } }), /two or more models/);
  assert.match(trialNote({ on: true, trial: '20', tiers: { claude: 'claude-opus-5-5, ' } }), /two or more models/);
});

test('the line is gone once two models are listed, or when nothing needs it (#725)', () => {
  assert.equal(trialNote({ on: true, trial: 20, tiers: { claude: ['claude-haiku-5-5', 'claude-opus-5-5'] } }), '');
  assert.equal(trialNote({ on: true, trial: 20, tiers: { claude: 'claude-haiku-5-5, claude-opus-5-5' } }), '');
  assert.equal(trialNote({ on: true, trial: 20, tiers: { claude: [], codex: ['a', 'b'] } }), '');
  assert.equal(trialNote({ on: true, trial: 0, tiers: {} }), '');
  assert.equal(trialNote({ on: false, trial: 20, tiers: {} }), '');
});
