import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

// The app's own files are asked for on every load but downloaded again only when they changed (#526): no-cache,
// with an ETag of the file's content, and 304 when the browser's copy is current.

const WEB = join(import.meta.dirname, '..', 'web');
const get = (port, path, headers = {}) => new Promise((resolve, reject) => {
  http.get({ port, path, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

describe("the app's files are cached by their content (#526)", () => {
  let server, port;
  before(async () => {
    server = createServer(new Hub(), {});
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => server.close());

  test('a module comes with no-cache and an ETag of its content; the same tag again gets a 304 and no body', async () => {
    const first = await get(port, '/app.js');
    assert.equal(first.status, 200);
    assert.equal(first.headers['cache-control'], 'no-cache');
    const hash = createHash('sha1').update(readFileSync(join(WEB, 'app.js'))).digest('base64url');
    assert.equal(first.headers.etag, `"${hash}"`, 'the tag is the content: an edit changes it');
    assert.deepEqual(first.body, readFileSync(join(WEB, 'app.js')));

    const again = await get(port, '/app.js', { 'if-none-match': first.headers.etag });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
    assert.equal(again.headers.etag, first.headers.etag);

    const other = await get(port, '/app.js', { 'if-none-match': '"something-else"' });
    assert.equal(other.status, 200, 'a tag that no longer matches gets the file');
  });

  test('a gzipped copy has a tag of its own, and is revalidated too', async () => {
    const gz = await get(port, '/app.js', { 'accept-encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.match(gz.headers.etag, /-gzip"$/);
    const again = await get(port, '/app.js', { 'accept-encoding': 'gzip', 'if-none-match': gz.headers.etag });
    assert.equal(again.status, 304);
  });

  test('pages are cached the same way, and API answers still never are', async () => {
    const page = await get(port, '/');
    assert.equal(page.headers['cache-control'], 'no-cache');
    assert.ok(page.headers.etag);
    assert.equal((await get(port, '/', { 'if-none-match': page.headers.etag })).status, 304);
    const api = await get(port, '/api/projects');
    assert.equal(api.headers['cache-control'], 'no-store');
    assert.equal(api.headers.etag, undefined);
  });
});
