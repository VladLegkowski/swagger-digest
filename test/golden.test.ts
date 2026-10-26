import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { transformOpenApiToMarkdown } from '../src/transformer.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const spec = JSON.parse(readFileSync(path.join(fixturesDir, 'petstore.swagger.v2.json'), 'utf8'));
const expected = readFileSync(path.join(fixturesDir, 'petstore.golden.md'), 'utf8');

test('golden snapshot: Petstore 2.0 digest matches the committed reference byte-for-byte', () => {
  const markdown = transformOpenApiToMarkdown(spec, 'https://petstore.swagger.io/v2/swagger.json');
  assert.equal(markdown, expected);
});
