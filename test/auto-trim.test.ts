import assert from 'node:assert/strict';
import test from 'node:test';
import { extractEmbeddedSpecUrlsFromScripts } from '../src/fetcher.js';
import { transformOpenApiToMarkdown, DEFAULT_MAX_TOKENS } from '../src/transformer.js';
import { estimateTokens } from '../src/tokens.js';

const pageUrl = new URL('https://petstore3.swagger.io/');

/** Verbatim shape of petstore3's swagger-initializer.js (SmartBear hosted pages). */
const petstore3Initializer = `window.onload = function() {
    const defaultDefinitionUrl = "https://petstore.swagger.io/v2/swagger.json";
    const ossServices = \`petstore3.swagger.io=https://petstore3.swagger.io/api/v3/openapi.json,petstore31.swagger.io=https://petstore31.swagger.io/api/v31/openapi.json,petstore.swagger.io=https://petstore.swagger.io/v2/swagger.json,generator.swagger.io=https://generator.swagger.io/api/swagger.json,validator.swagger.io=https://validator.swagger.io/validator/openapi.json\`;
    const ossServiceMatch = ossServices.split(',').map((ossService) => ossService.split('='))
    const definitionURL = ossServiceMatch ? ossServiceMatch[1] : defaultDefinitionUrl;
    window.ui = SwaggerUIBundle({
        url: definitionURL,
        "dom_id": "#swagger-ui",
        deepLinking: true,
    })
};`;

test('extractEmbeddedSpecUrlsFromScripts finds spec URLs in dynamic initializers', () => {
  const urls = extractEmbeddedSpecUrlsFromScripts([petstore3Initializer], pageUrl);
  // The page's own spec (same-origin) must come first, ahead of the other hosts
  // in the map — mirroring the initializer's own host.includes() resolution.
  assert.equal(urls[0], 'https://petstore3.swagger.io/api/v3/openapi.json');
  assert.ok(urls.includes('https://petstore.swagger.io/v2/swagger.json'));
  assert.ok(urls.length <= 8);
});

test('extractEmbeddedSpecUrlsFromScripts ranks same-origin URLs first', () => {
  const urls = extractEmbeddedSpecUrlsFromScripts([petstore3Initializer], pageUrl);
  const sameOriginCount = urls.filter((url) => new URL(url).origin === pageUrl.origin).length;
  // All same-origin hits precede every cross-origin hit.
  const firstCross = urls.findIndex((url) => new URL(url).origin !== pageUrl.origin);
  if (firstCross !== -1) {
    assert.ok(sameOriginCount === firstCross, `same-origin block (${sameOriginCount}) must end at ${firstCross}`);
  }
});

test('extractEmbeddedSpecUrlsFromScripts ignores non-spec and unparseable URLs', () => {
  const script = `
    fetch("https://example.com/analytics/config, https://example.com/equalities=a=b");
    const spec = "https://example.com/api/openapi.json";
    const notSpec = "https://example.com/assets/logo.png";
    const notExt = "https://example.com/v3/api-docs";
  `;
  const urls = extractEmbeddedSpecUrlsFromScripts([script], new URL('https://example.com/'));
  assert.ok(urls.includes('https://example.com/api/openapi.json'));
  assert.ok(!urls.some((url) => url.includes('logo.png')));
  assert.ok(!urls.some((url) => url.includes('analytics')));
  // The truncated equality URL must not survive as a bogus candidate.
  assert.ok(!urls.some((url) => url.includes('equalities')));
});

test('v3 api-docs without a file extension is skipped by the embedded scan', () => {
  // Extension-less specs are handled by the fallback-path probes, not this scan.
  const script = 'const docs = "https://example.com/v3/api-docs";';
  const urls = extractEmbeddedSpecUrlsFromScripts([script], new URL('https://example.com/'));
  assert.deepEqual(urls, []);
});

const baseSpec = {
  openapi: '3.0.3',
  info: { title: 'Trim Test API', version: '1.0.0' },
  paths: {
    '/ping': {
      get: {
        tags: ['util'],
        summary: 'Ping',
        responses: { '200': { description: 'OK' } },
      },
    },
  },
};

/** Builds a spec whose untrimmed digest estimate exceeds `minTokens`. */
function oversizedSpec(minTokens: number) {
  const paths: Record<string, unknown> = {};
  const perOperation = Math.ceil(minTokens / 4); // words ≈ tokens; 1 description word ≈ 1 token
  for (let i = 0; i < 40; i += 1) {
    paths[`/resource-${i}`] = {
      get: {
        tags: [`tag-${i}`],
        summary: `Operation ${i}`,
        description: Array.from({ length: perOperation }, (_, w) => `word${w}`).join(' '),
        responses: { '200': { description: 'OK' } },
      },
    };
  }
  return { ...baseSpec, paths };
}

test('digests under the default budget are returned untrimmed', () => {
  const markdown = transformOpenApiToMarkdown(baseSpec, 'https://example.com/openapi.json');
  assert.ok(!markdown.includes('## Trimmed'));
  assert.ok(estimateTokens(markdown).models.claude.tokens < DEFAULT_MAX_TOKENS);
});

test('oversized digests are auto-trimmed to the default budget with a warning', () => {
  const warnings: string[] = [];
  const markdown = transformOpenApiToMarkdown(oversizedSpec(600_000), 'https://example.com/openapi.json', {
    onWarning: (message) => warnings.push(message),
  });
  const estimate = estimateTokens(markdown).models.claude.tokens;
  assert.ok(estimate <= DEFAULT_MAX_TOKENS, `expected <= ${DEFAULT_MAX_TOKENS}, got ${estimate}`);
  assert.match(markdown, /## Trimmed/);
  const warning = warnings.join('\n');
  assert.match(warning, /auto-trimming/);
  assert.match(warning, /default budget/);
});

test('autoTrim: false disables the default cap entirely', () => {
  const warnings: string[] = [];
  const markdown = transformOpenApiToMarkdown(oversizedSpec(600_000), 'https://example.com/openapi.json', {
    autoTrim: false,
    onWarning: (message) => warnings.push(message),
  });
  assert.ok(!markdown.includes('## Trimmed'));
  assert.ok(estimateTokens(markdown).models.claude.tokens > DEFAULT_MAX_TOKENS);
  assert.equal(warnings.length, 0);
});

test('an explicit maxTokens still wins over the default cap', () => {
  const warnings: string[] = [];
  const markdown = transformOpenApiToMarkdown(oversizedSpec(300_000), 'https://example.com/openapi.json', {
    maxTokens: 5_000,
    onWarning: (message) => warnings.push(message),
  });
  const estimate = estimateTokens(markdown).models.claude.tokens;
  assert.ok(estimate <= 5_000, `expected <= 5000, got ${estimate}`);
  assert.match(markdown, /## Trimmed/);
  // Explicit budget: no auto-trim notice.
  assert.equal(warnings.length, 0);
});
