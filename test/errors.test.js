import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { errorText, errorHtml, fieldReason } from '../web/errors.js';
import { appSource } from './appsource.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// #151: every error in the UI shows the API's hint, and a place it names is a link.
describe('errors as a person reads them', () => {
  test('"<error>. <hint>", or just the error; sentence case, one full stop', () => {
    assert.equal(errorText({ message: 'not found', hint: 'check the name' }), 'Not found. Check the name');
    assert.equal(errorText({ message: 'Too many requests.', hint: 'Try again in an hour.' }), 'Too many requests. Try again in an hour.');
    assert.equal(errorText({ message: 'gone' }), 'Gone');
    assert.equal(errorText(new Error('boom')), 'Boom');
    assert.equal(errorText({}), 'Something went wrong');
  });

  test('a hint naming a place in the app links there, relative, and nothing else is HTML', () => {
    const html = errorHtml({ message: 'github.com/acme/held is already the project held', hint: 'Open it: /#/p/held' }, esc);
    assert.equal(html, 'github.com/acme/held is already the project held. Open it: <a href="#/p/held">#/p/held</a>', 'a name keeps its own case');
    assert.ok(!errorHtml({ message: '<img src=x>', hint: 'x' }, esc).includes('<img'));
    assert.equal(errorHtml({ message: 'no', hint: 'See #/p/a.' }, esc), 'No. See <a href="#/p/a">#/p/a</a>.');
  });

  test('the duplicate-repository case: the API\'s error and hint, as the toast shows them', async () => {
    const hub = new Hub();
    hub.tx(() => hub.project('held', { create: true }));
    hub.addRemote(hub.project('held'), 'github.com/acme/held', 'you');
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/projects`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'dup', repo: 'github.com/acme/held' }),
      });
      const j = await r.json();
      assert.equal(r.status, 409);
      assert.match(errorHtml({ message: j.error, hint: j.hint }, esc), /already the project held\. Open it: <a href="#\/p\/held">#\/p\/held<\/a>$/);
    } finally { server.close(); }
  });

  test('every toast of a caught error goes through it: no toast(e.message left', () => {
    const app = appSource();
    assert.doesNotMatch(app, /toast\(e\.message/);
    assert.doesNotMatch(app, /esc\(e\.message\)/);
  });
});

// #748: a refused form shows its reason under the field, as one sentence that doesn't repeat the field's hint.
describe('a refused field', () => {
  test('its reason is the error alone, sentence case, one full stop; a name keeps its case', () => {
    assert.equal(fieldReason({ message: 'a channel needs a URL', hint: 'ntfy topic URL (phone push), e.g. https://ntfy.sh/x' }), 'A channel needs a URL.');
    assert.equal(fieldReason({ message: "Type the project's name (api) to delete it" }), "Type the project's name (api) to delete it.");
    assert.equal(fieldReason({}), "That isn't accepted.");
  });

  test('the hub refuses a bad channel or a mistyped name with 400, which the dialog shows at the field', async () => {
    const hub = new Hub();
    hub.tx(() => hub.project('api', { create: true }));
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const post = async (path, body) => {
      const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, ...(await r.json()) };
    };
    try {
      const ftp = await post('/api/notify', { kind: 'ntfy', url: 'ftp://ntfy.sh/x' });
      assert.equal(ftp.status, 400);
      assert.equal(fieldReason({ message: ftp.error }), 'Channel URLs must be http or https.');
      const typo = await post('/api/p/api/human/delete', { confirm: 'apj' });
      assert.equal(typo.status, 400);
      assert.equal(fieldReason({ message: typo.error }), "Type the project's name (api) to delete it.");
    } finally { server.close(); }
  });

  test('dialogs say it at the field, not in a toast', () => {
    const app = appSource();
    assert.doesNotMatch(app, /toast\('Name it'/);
    for (const id of ['np-name', 'fp-name', 'nt-url', 'gh-secret', 'fb-text', 'rm-confirm', 'rm-archived']) assert.match(app, new RegExp(`fieldError\\('${id}'|'${id}'\\)`), id);
  });
});
