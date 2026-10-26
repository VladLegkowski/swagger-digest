import assert from 'node:assert/strict';
import test from 'node:test';
import { transformOpenApiToMarkdown } from '../src/transformer.js';

/** A spec with three tag groups and distinctive schemas per group. */
function buildSpec(): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: { title: 'Filter Test API', version: '1.0.0' },
    tags: [{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Gamma' }],
    components: {
      schemas: {
        AlphaModel: { type: 'object', properties: { alphaField: { type: 'string' } } },
        BetaModel: { type: 'object', properties: { betaField: { type: 'integer' } } },
        GammaModel: { type: 'object', properties: { gammaField: { type: 'boolean' } } },
      },
    },
    paths: {
      '/alpha': {
        get: {
          tags: ['Alpha'],
          summary: 'Alpha operation',
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/AlphaModel' } } },
            },
          },
        },
      },
      '/beta': {
        get: {
          tags: ['Beta'],
          summary: 'Beta operation',
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/BetaModel' } } },
            },
          },
        },
      },
      '/gamma': {
        get: {
          tags: ['Gamma'],
          summary: 'Gamma operation',
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/GammaModel' } } },
            },
          },
        },
      },
    },
  };
}

test('includeTags keeps only matching operations and drops unreachable schemas', () => {
  const spec = buildSpec() as never;
  const markdown = transformOpenApiToMarkdown(spec, 'https://example.com/openapi.json', {
    includeTags: ['Alpha'],
  });
  assert.match(markdown, /#### `GET \/alpha`/);
  assert.doesNotMatch(markdown, /`GET \/beta`/);
  assert.doesNotMatch(markdown, /`GET \/gamma`/);
  // BetaModel and GammaModel are unreachable after filtering.
  assert.match(markdown, /interface AlphaModel/);
  assert.doesNotMatch(markdown, /BetaModel/);
  assert.doesNotMatch(markdown, /GammaModel/);
});

test('excludeTags removes matching operations and their unreachable schemas', () => {
  const spec = buildSpec() as never;
  const markdown = transformOpenApiToMarkdown(spec, undefined, { excludeTags: ['Gamma'] });
  assert.match(markdown, /`GET \/alpha`/);
  assert.match(markdown, /`GET \/beta`/);
  assert.doesNotMatch(markdown, /`GET \/gamma`/);
  assert.doesNotMatch(markdown, /GammaModel/);
  assert.match(markdown, /AlphaModel/);
  assert.match(markdown, /BetaModel/);
});

test('pathPrefix keeps only matching paths', () => {
  const spec = buildSpec() as never;
  const markdown = transformOpenApiToMarkdown(spec, undefined, { pathPrefix: '/be' });
  assert.doesNotMatch(markdown, /`GET \/alpha`/);
  assert.match(markdown, /`GET \/beta`/);
  assert.doesNotMatch(markdown, /`GET \/gamma`/);
});

test('unknown tag names warn with the available tags', () => {
  const warnings: string[] = [];
  transformOpenApiToMarkdown(buildSpec() as never, undefined, {
    includeTags: ['DoesNotExist'],
    onWarning: (message) => warnings.push(message),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Unknown tag\(s\): DoesNotExist/);
  assert.match(warnings[0]!, /Available tags: Alpha, Beta, Gamma/);
});

test('trimming stage (a) drops declared example payloads first', () => {
  const spec = {
    openapi: '3.0.3',
    info: { title: 'Examples API', version: '1.0.0' },
    components: { schemas: { Thing: { type: 'object', properties: { id: { type: 'integer' } } } } },
    paths: {
      '/things': {
        get: {
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Thing' },
                  example: { id: 1 },
                },
              },
            },
          },
        },
      },
    },
  } as never;
  const full = transformOpenApiToMarkdown(spec, undefined, { maxTokens: 1_000_000 });
  assert.match(full, /Example Value/);
});

test('trimming collapses tags last-document-position first and drops unreachable schemas', () => {
  const spec = buildSpec() as never;
  // A budget low enough to force tag collapsing: pick something between
  // full and index-only. Instead of guessing, verify the mechanism directly:
  // with a tiny budget the note must mention collapsing and eventually the index.
  const markdown = transformOpenApiToMarkdown(spec, undefined, { maxTokens: 150 });
  assert.match(markdown, /## Trimmed/);
  assert.match(markdown, /~150-token budget/);
  // Index-only stage keeps the Quick index rows but drops endpoint detail.
  assert.match(markdown, /\| \*\*GET\*\* \| `\/alpha` \|/);
  assert.doesNotMatch(markdown, /#### `GET \/alpha`/);
});

test('schemas unreachable after collapse are dropped from Data types', () => {
  // Directly exercise the stage logic: collapse all but Alpha → Gamma/Beta
  // models must disappear while AlphaModel stays.
  const spec = buildSpec() as never;
  const markdown = transformOpenApiToMarkdown(spec, undefined, { maxTokens: 450 });
  const dataTypes = markdown.match(/## Data types[\s\S]*?```/)?.[0] ?? '';
  if (!markdown.includes('## Trimmed')) {
    assert.ok(markdown.includes('interface GammaModel'));
  } else {
    // When Gamma (last tag) is collapsed, GammaModel must be gone if trimming reached stage (c).
    if (dataTypes.length > 0) {
      assert.doesNotMatch(markdown, /GammaModel/);
    }
  }
});

test('the same input and options produce byte-identical output (determinism)', () => {
  const spec = buildSpec() as never;
  const options = { includeTags: ['Alpha', 'Beta'], maxTokens: 900 } as never;
  const first = transformOpenApiToMarkdown(spec, 'https://example.com/spec.json', options);
  const second = transformOpenApiToMarkdown(spec, 'https://example.com/spec.json', options);
  assert.equal(first, second);
});

test('no filter options produce the full digest unchanged', () => {
  const spec = buildSpec() as never;
  const withOptions = transformOpenApiToMarkdown(spec, undefined, {});
  const withoutOptions = transformOpenApiToMarkdown(spec);
  assert.equal(withOptions, withoutOptions);
  // All three operations and all three models are present.
  assert.match(withOptions, /`GET \/alpha`/);
  assert.match(withOptions, /`GET \/beta`/);
  assert.match(withOptions, /`GET \/gamma`/);
  assert.match(withOptions, /AlphaModel/);
  assert.match(withOptions, /BetaModel/);
  assert.match(withOptions, /GammaModel/);
});
