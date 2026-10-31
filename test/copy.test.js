import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { copyBlock, commandBlocks, copyText } from '../web/copy.js';
import { connectCommands } from '../web/connect.js';

// A document just big enough for the synchronous copy: execCommand('copy') copies the selected textarea.
function fakeDoc({ works = true } = {}) {
  const doc = {
    copied: null, focused: 'button', appended: 0,
    activeElement: { focus: () => { doc.focused = 'button'; } },
    body: { appendChild: () => { doc.appended++; } },
    createElement: () => {
      const ta = { value: '', style: {}, setAttribute() {}, select: () => { doc.focused = 'textarea'; doc.selected = ta.value; }, remove: () => { doc.appended--; } };
      return ta;
    },
    execCommand: (cmd) => { if (!works || cmd !== 'copy') return false; doc.copied = doc.selected; return true; },
  };
  return doc;
}
const fakeClipboard = ({ works = true } = {}) => ({ text: null, async writeText(t) { if (!works) throw new DOMException('denied', 'NotAllowedError'); this.text = t; } });

// The text a copyBlock's button carries, decoded as the browser's dataset would.
const dataText = (html) => html.match(/data-text="([^"]*)"/)?.[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

describe('copy buttons (#89)', () => {
  test('the synchronous copy runs inside the click and leaves nothing behind', async () => {
    const doc = fakeDoc();
    const clip = fakeClipboard();
    assert.equal(await copyText('node bin/nuworq.js mcp', { doc, clipboard: clip }), true);
    assert.equal(doc.copied, 'node bin/nuworq.js mcp');
    assert.equal(clip.text, null, 'no need for the async API');
    assert.equal(doc.appended, 0, 'the helper textarea is gone');
    assert.equal(doc.focused, 'button', 'focus goes back where it was');
  });

  test('where the synchronous copy is refused, the clipboard API; where both are, false (the UI selects the text)', async () => {
    const clip = fakeClipboard();
    assert.equal(await copyText('abc', { doc: fakeDoc({ works: false }), clipboard: clip }), true);
    assert.equal(clip.text, 'abc');
    assert.equal(await copyText('abc', { doc: {}, clipboard: fakeClipboard() }), true, 'no execCommand at all');
    assert.equal(await copyText('abc', { doc: fakeDoc({ works: false }), clipboard: fakeClipboard({ works: false }) }), false);
    assert.equal(await copyText('abc', { doc: fakeDoc({ works: false }), clipboard: undefined }), false, 'no clipboard API: refused, not a crash');
    assert.equal(await copyText('', { doc: fakeDoc(), clipboard: fakeClipboard() }), false);
  });

  test('a Copy button carries exactly its text, and there is none without text', () => {
    const text = `[mcp_servers.nuworq]\nargs = ["/a b/nuworq.js", "mcp"]\nenv = { X = "<it's & that>" }`;
    assert.equal(dataText(copyBlock(text)), text);
    assert.equal(copyBlock(''), '');
    assert.equal(copyBlock(null), '');
    assert.equal(copyBlock(' \n'), '');
  });

  test('every Copy button on the site has non-empty data-text', () => {
    const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    assert.ok(!app.includes('data-action="copy"'), 'every Copy button is made by copyBlock');
    // What the modals pass to copyBlock, for every kind of hub.
    const infos = [
      { bin: '/srv/nuworq/bin/nuworq.js', url: 'https://nuworq.com', auth: 'required', source: 'github.com/paulnorthup/nuworq' },
      { bin: '/srv/nuworq/bin/nuworq.js', url: 'https://nuworq.com', auth: 'required', source: null },
      { bin: '/Users/me/nuworq/bin/nuworq.js', url: 'http://127.0.0.1:4747', auth: 'local' },
      { bin: '/Users/me/nuworq/bin/nuworq.js', url: 'http://127.0.0.1:4747', auth: 'required' },
    ];
    // Commands go through commandBlocks (#379), one Copy each; configs and URLs through copyBlock, verbatim.
    const used = [...app.matchAll(/(copyBlock|commandBlocks)\((?:c\.)?(\w+)\)/g)].map((m) => [m[1], m[2]]);
    assert.ok(used.length >= 8, `found the copyBlock and commandBlocks calls: ${used}`);
    for (const info of infos) {
      const c = connectCommands(info, null, 'demo');
      for (const [fn, k] of used.filter(([, k]) => k in c)) {
        const html = c[k] == null ? '' : (fn === 'copyBlock' ? copyBlock : commandBlocks)(c[k]);
        // null fields are only rendered behind a check, so they show no block; anything rendered has text.
        if (html) assert.ok(dataText(html).trim(), `${info.url} ${info.auth}: ${k}`);
      }
    }
  });
});
