import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { fetchOpenApiSpec } from '../src/fetcher.js';
import { bundleExternalRefs } from '../src/bundler.js';

function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return address.port;
  });
}

function schemaBucket(spec: { components?: { schemas?: unknown }; definitions?: unknown }): Record<string, unknown> {
  const bucket = spec.components?.schemas ?? spec.definitions;
  return bucket && typeof bucket === 'object' ? (bucket as Record<string, unknown>) : {};
}

test('external $refs are fetched and bundled into the local schema bucket', async (t) => {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/main.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          openapi: '3.0.3',
          info: { title: 'Bundling API', version: '1.0.0' },
          components: { schemas: {} },
          paths: {
            '/meta': {
              get: {
                responses: {
                  '200': {
                    description: 'OK',
                    content: {
                      'application/json': {
                        schema: { $ref: 'meta.json#/components/schemas/SharedMeta' },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      );
      return;
    }
    if (pathname === '/meta.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          components: {
            schemas: {
              SharedMeta: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
            },
          },
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const port = await listen(server);
  t.after(() => server.close());

  const result = await fetchOpenApiSpec(`http://127.0.0.1:${port}/main.json`, {
    useBrowserFallback: false,
    timeoutMs: 2_000,
  });
  const bucket = schemaBucket(result.spec);
  const bundledNames = Object.keys(bucket).filter((name) => name.startsWith('meta'));
  assert.ok(bundledNames.length > 0, `expected a bundled schema, got: ${Object.keys(bucket).join(', ')}`);
  const bundled = bucket[bundledNames[0] ?? ''] as { properties?: { id?: unknown } } | undefined;
  assert.ok(bundled?.properties?.id !== undefined, 'bundled schema must carry the external properties');
  // The raw external URL must no longer appear as a $ref target.
  assert.ok(!JSON.stringify(result.spec).includes('meta.json#/'), 'external ref must be rewritten');
});

test('unreachable external documents degrade gracefully instead of failing', async (t) => {
  const mainSpec = {
    openapi: '3.0.3',
    info: { title: 'Degrading API', version: '1.0.0' },
    paths: {
      '/meta': {
        get: {
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: { $ref: 'https://unreachable.invalid/meta.json#/Meta' },
                },
              },
            },
          },
        },
      },
    },
  };
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(mainSpec));
  });
  const port = await listen(server);
  t.after(() => server.close());

  const result = await fetchOpenApiSpec(`http://127.0.0.1:${port}/main.json`, {
    useBrowserFallback: false,
    timeoutMs: 2_000,
  });
  assert.equal(result.spec.info.title, 'Degrading API');
});

test('unit: bundleExternalRefs inlines pointed schemas and rewrites refs', async () => {
  const spec = {
    openapi: '3.0.3',
    info: { title: 'T', version: '1' },
    components: { schemas: {} },
    paths: {
      '/a': {
        get: {
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: { $ref: 'https://docs.example.com/shared.json#/components/schemas/Thing' },
                },
              },
            },
          },
        },
      },
    },
  };
  const result = await bundleExternalRefs(spec, 'https://docs.example.com/shared.json', async () =>
    JSON.stringify({
      components: { schemas: { Thing: { type: 'object', properties: { a: { type: 'string' } } } } },
    }),
  );
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('https://docs.example.com/shared.json#/'), 'external ref must be rewritten');
  const bucket = schemaBucket(result);
  assert.ok(
    Object.values(bucket).some((schema) => JSON.stringify(schema).includes('"a"')),
    'the external schema body must be inlined',
  );
  assert.match(serialized, /#\/components\/schemas\/shared_Thing/);
});

test('unit: a spec without external refs passes through unchanged', async () => {
  const spec = {
    openapi: '3.0.3',
    info: { title: 'No external refs', version: '1' },
    components: { schemas: { Local: { type: 'object' } } },
    paths: {},
  };
  const result = await bundleExternalRefs(spec, 'https://example.com/spec.json', async () => {
    throw new Error('must not be called');
  });
  assert.equal(result, spec);
});
