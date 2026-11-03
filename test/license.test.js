import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('LICENSE, package.json and the README name the same license', () => {
  const id = JSON.parse(read('package.json')).license;
  assert.equal(id, 'FSL-1.1-MIT');
  assert.match(read('LICENSE'), /^# Functional Source License, Version 1\.1, MIT Future License/);
  assert.ok(read('LICENSE').includes(`## Abbreviation\n\n${id}\n`));
  assert.match(read('LICENSE'), /Copyright 2026 Paul Northup/);
  assert.ok(read('README.md').includes(id));
  assert.ok(read('CONTRIBUTING.md').includes(id));
  assert.match(read('CHANGELOG.md'), /1\.1\.0[\s\S]*FSL-1\.1-MIT[\s\S]*stay MIT/);
});
