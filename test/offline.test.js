import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appSource } from './appsource.js';

// The hub out of reach (#142). The page is browser code, so this reads it: every way the page learns the hub is
// gone (a request that can't connect, the live stream dropping) marks it offline, and every way it learns the hub
// is back clears it. The browser check (bar, stale pulse, recovery) is in the item's evidence.
const app = appSource();
const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');

describe('when the hub can\'t be reached', () => {
  test('a request that can\'t connect marks the page offline and fails in plain words, never "Failed to fetch"', () => {
    const api = app.slice(app.indexOf('async function api('), app.indexOf('\n}\n', app.indexOf('async function api(')));
    assert.match(api, /catch \{\s*offline\(\);\s*throw new Error\(OFFLINE\)/);
    assert.match(api, /online\(\);/, 'any answer at all means the hub is back');
    assert.match(app, /const OFFLINE = "Couldn't reach the hub; nothing was changed\. Try again when it's back\."/);
  });

  test('the live stream dropping marks it offline; reconnecting clears it and refreshes', () => {
    const listen = app.slice(app.indexOf('function listen()'), app.indexOf('\n}\n', app.indexOf('function listen()')));
    assert.match(listen, /onerror = \(\) => \{ es\.close\(\); offline\(\);/);
    assert.match(listen, /onopen = async \(\) => \{\s*online\(\);/);
    const online = app.slice(app.indexOf('function online()'), app.indexOf('\n}\n', app.indexOf('function online()')));
    assert.match(online, /\$\('#offline'\)\?\.remove\(\)/);
    assert.match(online, /scheduleRefresh\(\)/);
  });

  test('the bar says since when, and the pulse is marked out of date while it shows', () => {
    assert.match(app, /Can't reach the hub since \$\{at\}; what you see may be out of date\./);
    assert.match(css, /body\.offline \.pulse \{/);
    assert.match(css, /body\.offline \.pulse \.state-chip::after \{ content: '· out of date'/);
  });
});
