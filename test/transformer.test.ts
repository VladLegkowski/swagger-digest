import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { fetchOpenApiSpec, parseSpecText } from '../src/fetcher.js';
import { transformOpenApiToMarkdown } from '../src/transformer.js';
import { defaultFilename, normalizeFilename, resolveOutputDirectory, writeDigest } from '../src/writer.js';

const sampleSpec = {
  openapi: '3.0.3',
  info: { title: 'Example Payments API', version: '2.1.0', description: 'Sample API for payments.' },
  servers: [{ url: 'https://api.example.test/v2' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    schemas: {
      CreatePaymentDto: {
        type: 'object',
        required: ['amount', 'currency'],
        properties: {
          amount: { type: 'number', description: 'Amount in minor units.' },
          currency: { type: 'string', enum: ['EUR', 'GBP'] },
          note: { type: 'string' },
        },
      },
      Payment: {
        type: 'object',
        required: ['id', 'status'],
        properties: { id: { type: 'string' }, status: { type: 'string', enum: ['pending', 'paid'] } },
      },
      Error: { type: 'object', properties: { message: { type: 'string' } } },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/payments/{paymentId}': {
      parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        tags: ['Payments'],
        summary: 'Get a payment',
        operationId: 'getPayment',
        parameters: [{ name: 'expand', in: 'query', required: false, schema: { type: 'boolean' } }],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Payment' } } },
          },
          '404': {
            description: 'Payment not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
      post: {
        tags: ['Payments'],
        summary: 'Create a payment',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreatePaymentDto' } } },
        },
        responses: {
          '201': {
            description: 'Created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Payment' } } },
          },
        },
      },
    },
  },
};

test('parses JSON OpenAPI documents', () => {
  const parsed = parseSpecText(JSON.stringify(sampleSpec), 'test fixture');
  assert.equal(parsed.info.title, 'Example Payments API');
});

test('parses YAML OpenAPI documents', () => {
  const parsed = parseSpecText('openapi: 3.0.0\ninfo:\n  title: YAML API\n  version: 1.0.0\npaths: {}', 'test fixture');
  assert.equal(parsed.info.title, 'YAML API');
});

test('creates a compact endpoint index, parameters, auth and schema interfaces', () => {
  const markdown = transformOpenApiToMarkdown(sampleSpec, 'https://example.test/openapi.json');
  assert.match(markdown, /# API Digest: Example Payments API/);
  assert.match(markdown, /\| \*\*GET\*\* \| `\/payments\/\{paymentId\}` \| Get a payment \| Payments \|/);
  assert.match(markdown, /\*\*Authentication:\*\* bearerAuth/);
  assert.match(markdown, /- `paymentId` \(`path`, required\) · `string`/);
  assert.match(markdown, /- `expand` \(`query`\) · `boolean`/);
  assert.match(markdown, /`application\/json` → `CreatePaymentDto` \(required\)/);
  assert.match(markdown, /\*\*404 Payment not found\*\* — `Error`/);
  assert.match(markdown, /interface CreatePaymentDto/);
  assert.match(markdown, /amount: number;/);
  assert.match(markdown, /note\?: string;/);
  assert.match(markdown, /interface Payment/);
  assert.match(markdown, /interface Error\s*\{/);
});

test('promotes inline OpenAPI 3 payloads to named interfaces and redacts sensitive source query values', () => {
  const spec = {
    openapi: '3.1.0',
    info: { title: 'Inline Payloads', version: '1.0.0' },
    paths: {
      '/items': {
        post: {
          operationId: 'createItem',
          summary: 'Create an item',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 2 } } },
              },
            },
          },
          responses: {
            '201': {
              description: 'Created',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { id: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
    },
  };
  const markdown = transformOpenApiToMarkdown(spec, 'https://example.test/openapi.json?api_key=top-secret');
  assert.match(markdown, /`application\/json` → `createItemRequest` \(required\)/);
  assert.match(markdown, /`createItem201Response`/);
  assert.match(markdown, /interface createItemRequest/);
  assert.match(markdown, /minLength: 2/);
  assert.match(markdown, /api_key=%5Bredacted%5D/);
  assert.doesNotMatch(markdown, /top-secret/);
  assert.doesNotMatch(markdown, /\| body \|/);
});

test('suppresses synthetic response examples and keeps model interfaces instead', () => {
  const spec = {
    openapi: '3.0.3',
    info: { title: 'Monitoring API', version: '1.0.0' },
    components: {
      schemas: {
        Capture: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            capturedAt: { type: 'string', format: 'date-time' },
          },
        },
        MonitoredApp: {
          type: 'object',
          properties: {
            id: { type: 'string', example: '42' },
            name: { type: 'string', example: 'Acme Live TV' },
            environment: { type: 'string', enum: ['android', 'ios'] },
          },
        },
        Monitoring: {
          type: 'object',
          properties: {
            id: { type: 'string', example: '42' },
            stage: { type: 'string', enum: ['pending', 'complete'] },
            app: { $ref: '#/components/schemas/MonitoredApp' },
            homeEvidenceCaptures: { type: 'array', items: { $ref: '#/components/schemas/Capture' } },
          },
        },
        GetEventAppMonitoringCollectionResponse: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { $ref: '#/components/schemas/Monitoring' } },
            page: { type: 'integer', default: 1 },
            pageSize: { type: 'integer', default: 10 },
            totalItems: { type: 'integer', example: 42 },
          },
        },
      },
    },
    paths: {
      '/api/v1/events/{eventId}/app-monitorings': {
        get: {
          summary: 'List the app monitorings of an event',
          responses: {
            '200': {
              description: 'Paginated collection of app monitorings.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/GetEventAppMonitoringCollectionResponse' },
                },
              },
            },
          },
        },
      },
    },
  };

  const markdown = transformOpenApiToMarkdown(spec);
  // Synthetic (schema-derived) examples are never rendered — interfaces carry the structure
  assert.doesNotMatch(markdown, /Example Value/);
  assert.doesNotMatch(markdown, /"items": \[/);
  assert.doesNotMatch(markdown, /"name": "Acme Live TV"/);
  // The referenced models still render as TypeScript declarations in a single consolidated block
  assert.match(markdown, /export interface GetEventAppMonitoringCollectionResponse/);
  assert.match(markdown, /page\?: number;/);
  assert.match(markdown, /pageSize\?: number;/);
  assert.match(markdown, /totalItems\?: number;/);
  // All models share one unified ```typescript fence
  assert.equal((markdown.match(/```typescript/g) ?? []).length, 1);
});

test('preserves explicit response Example Value exactly as declared in the spec', () => {
  const spec = {
    openapi: '3.0.3',
    info: { title: 'Explicit Examples', version: '1.0.0' },
    paths: {
      '/status': {
        get: {
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { status: { type: 'string' } } },
                  example: { status: 'ready', sequence: 17 },
                },
              },
            },
          },
        },
      },
    },
  };
  const markdown = transformOpenApiToMarkdown(spec);
  assert.match(markdown, /\*\*Example Value\*\* \*\(declared in the spec\)\*/);
  assert.match(markdown, /"status": "ready"/);
  assert.match(markdown, /"sequence": 17/);
  assert.doesNotMatch(markdown, /generated from schema; illustrative only/);
});

test('includes request-body examples when available', () => {
  const spec = {
    openapi: '3.0.3',
    info: { title: 'Request Examples', version: '1.0.0' },
    paths: {
      '/items': {
        post: {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { name: { type: 'string' } } },
                example: { name: 'Example item' },
              },
            },
          },
          responses: { '204': { description: 'No content' } },
        },
      },
    },
  };
  const markdown = transformOpenApiToMarkdown(spec);
  assert.match(markdown, /\*\*Request Example Value\*\* \*\(declared in the spec\)\*/);
  assert.match(markdown, /"name": "Example item"/);
});

test('supports Swagger 2.0 host/basePath and body parameters', () => {
  const spec = {
    swagger: '2.0',
    info: { title: 'Legacy', version: '1.0' },
    host: 'legacy.example.test',
    basePath: '/api',
    schemes: ['https'],
    consumes: ['application/json'],
    paths: {
      '/items': {
        post: {
          summary: 'Create an item',
          parameters: [
            {
              in: 'body',
              name: 'body',
              required: true,
              schema: { type: 'object', properties: { label: { type: 'string' } } },
            },
          ],
          responses: {
            '201': { description: 'Created', schema: { type: 'object', properties: { id: { type: 'string' } } } },
          },
        },
      },
    },
  };
  const markdown = transformOpenApiToMarkdown(spec);
  assert.match(markdown, /`https:\/\/legacy\.example\.test\/api`/);
  assert.match(markdown, /`application\/json` → `PostItemsRequest` \(required\)/);
  assert.match(markdown, /\*\*201 Created\*\* — `PostItems201Response`/);
  assert.match(markdown, /interface PostItemsRequest/);
  assert.match(markdown, /interface PostItems201Response/);
});

test('collapses standard error responses and suppresses synthetic error examples', () => {
  const spec = {
    openapi: '3.0.3',
    info: { title: 'Error Collapse', version: '1.0.0' },
    components: {
      schemas: { Error: { type: 'object', properties: { message: { type: 'string' } } } },
    },
    paths: {
      '/things/{id}': {
        get: {
          summary: 'Get a thing',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' },
                  example: { message: 'all good' },
                },
              },
            },
            '400': {
              description: 'Bad request',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            '401': { description: 'Unauthorized' },
            '403': {
              description: 'Forbidden',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            '404': {
              description: 'Not found',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            '502': { description: 'Bad gateway' },
            '409': {
              description: 'Conflict: version mismatch',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          },
        },
      },
    },
  };
  const markdown = transformOpenApiToMarkdown(spec);
  // Standard errors with generic descriptions collapse into a single line regardless of schema identity
  assert.match(markdown, /- \*\*Errors:\*\* `400` \(`Error`\), `401`, `403` \(`Error`\), `404` \(`Error`\), `502`/);
  // Custom description with a non-standard code keeps its detailed block
  assert.match(markdown, /\*\*409 Conflict: version mismatch\*\* — `Error`/);
  // Synthetic (schema-derived) example JSON is suppressed for error responses
  assert.doesNotMatch(markdown, /\*\*400[^']*Example Value/);
  assert.doesNotMatch(markdown, /"message": "string"/);
  // Success example still renders
  assert.match(markdown, /"message": "all good"/);
  // Parameter list format with compact uuid type display
  assert.match(markdown, /- `id` \(`path`, required\) · `string \(uuid\)`/);
  assert.doesNotMatch(markdown, /\| In \| Name \|/);
});

test('renders allOf, oneOf and anyOf compositions as TypeScript unions and intersections', () => {
  const spec = {
    openapi: '3.0.3',
    info: { title: 'Compositions', version: '1.0.0' },
    components: {
      schemas: {
        Cat: { type: 'object', required: ['meow'], properties: { meow: { type: 'string' } } },
        Dog: { type: 'object', required: ['bark'], properties: { bark: { type: 'string' } } },
        CatDog: { allOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }] },
        Pet: { oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }] },
        Contact: { anyOf: [{ type: 'string' }, { type: 'object', properties: { email: { type: 'string' } } }] },
      },
    },
    paths: {
      '/pets': {
        get: {
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      combined: { $ref: '#/components/schemas/CatDog' },
                      either: { $ref: '#/components/schemas/Pet' },
                      contact: { $ref: '#/components/schemas/Contact' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  const markdown = transformOpenApiToMarkdown(spec);
  assert.match(markdown, /export type CatDog = Cat & Dog;/);
  assert.match(markdown, /export type Pet = Cat \| Dog;/);
  assert.match(markdown, /export type Contact = string \| \{ email\?: string; \}/);
  assert.match(markdown, /combined\?: CatDog;/);
});

test('renders OpenAPI 3.0 nullable as a null union', () => {
  const spec = {
    openapi: '3.0.3',
    info: { title: 'Nullable', version: '1.0.0' },
    components: {
      schemas: {
        Thing: {
          type: 'object',
          properties: {
            nickname: { type: 'string', nullable: true },
            score: { type: 'number', nullable: true, description: 'nullable number' },
          },
        },
      },
    },
    paths: {
      '/things': {
        get: {
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } },
            },
          },
        },
      },
    },
  };
  const markdown = transformOpenApiToMarkdown(spec);
  assert.match(markdown, /nickname\?: string \| null;/);
  assert.match(markdown, /score\?: number \| null;/);
});

test('renders OpenAPI 3.1 type arrays as null unions', () => {
  const spec = {
    openapi: '3.1.0',
    info: { title: 'Type Arrays', version: '1.0.0' },
    components: {
      schemas: {
        Node: {
          type: 'object',
          properties: {
            value: { type: ['string', 'null'] },
            mixed: { type: ['number', 'string'] },
          },
        },
      },
    },
    paths: {
      '/nodes': {
        get: {
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } },
            },
          },
        },
      },
    },
  };
  const markdown = transformOpenApiToMarkdown(spec);
  assert.match(markdown, /value\?: string \| null;/);
  assert.match(markdown, /mixed\?: number;/);
});

test('renders enums as string literal unions and additionalProperties as index signatures', () => {
  const spec = {
    openapi: '3.0.3',
    info: { title: 'Enums and maps', version: '1.0.0' },
    components: {
      schemas: {
        Color: { type: 'string', enum: ['red', 'green', 'blue'], description: 'Primary colors' },
        NumericEnum: { type: 'integer', enum: [1, 2, 3] },
        Labeled: { type: 'string', enum: ['a', 'b'] },
        StringMap: { type: 'object', additionalProperties: { type: 'integer' } },
        FreeForm: { type: 'object', additionalProperties: true },
        Wrapper: {
          type: 'object',
          properties: {
            color: { $ref: '#/components/schemas/Color' },
            count: { $ref: '#/components/schemas/NumericEnum' },
            labels: { type: 'array', items: { $ref: '#/components/schemas/Labeled' } },
            attrs: { $ref: '#/components/schemas/StringMap' },
            extras: { $ref: '#/components/schemas/FreeForm' },
          },
        },
      },
    },
    paths: {
      '/wrapper': {
        get: {
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Wrapper' } } },
            },
          },
        },
      },
    },
  };
  const markdown = transformOpenApiToMarkdown(spec);
  assert.match(markdown, /export type Color = "red" \| "green" \| "blue";/);
  assert.match(markdown, /export type NumericEnum = 1 \| 2 \| 3;/);
  assert.match(markdown, /interface StringMap \{[^]*\[key: string\]: number;/);
  assert.match(markdown, /interface FreeForm \{[^]*\[key: string\]: unknown;/);
  assert.match(markdown, /color\?: Color;/);
  assert.match(markdown, /count\?: NumericEnum;/);
  assert.match(markdown, /labels\?: Labeled\[\];/);
});

test('handles circular $refs without hanging or throwing', () => {
  const spec = {
    openapi: '3.0.3',
    info: { title: 'Circular', version: '1.0.0' },
    components: {
      schemas: {
        Node: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
            child: { $ref: '#/components/schemas/Node' },
            parent: { $ref: '#/components/schemas/Node' },
          },
        },
        Tree: {
          type: 'object',
          properties: {
            root: { $ref: '#/components/schemas/Node' },
            nodes: { type: 'array', items: { $ref: '#/components/schemas/Node' } },
          },
        },
      },
    },
    paths: {
      '/trees/{id}': {
        get: {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Tree' } } },
            },
          },
        },
      },
    },
  };
  const markdown = transformOpenApiToMarkdown(spec);
  assert.match(markdown, /export interface Tree/);
  assert.match(markdown, /child\?: Node;/);
  assert.match(markdown, /parent\?: Node;/);
  assert.match(markdown, /export interface Node/);
});

test('degrades unresolved external $refs to named references without throwing', () => {
  const spec = {
    openapi: '3.0.3',
    info: { title: 'External refs', version: '1.0.0' },
    paths: {
      '/widgets': {
        get: {
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      meta: { $ref: 'https://schemas.example.org/meta.json' },
                      local: { $ref: '#/components/schemas/Widget' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Widget: { type: 'object', properties: { name: { type: 'string' } } },
      },
    },
  };
  const markdown = transformOpenApiToMarkdown(spec);
  assert.match(markdown, /interface Widget/);
  // External refs degrade to a named identifier, never throw and never emit the raw URL type
  assert.doesNotMatch(markdown, /schemas\.example\.org/);
  assert.match(markdown, /meta\?: meta_json;/);
});

test('normalizes output filenames and directories', () => {
  assert.equal(defaultFilename('Payments API'), 'payments-api-digest.md');
  assert.equal(normalizeFilename('report'), 'report.md');
  assert.equal(normalizeFilename('../report.MD'), 'report.MD');
  assert.equal(resolveOutputDirectory('./docs', '/tmp/project'), '/tmp/project/docs');
});

test('writeDigest blocks path traversal in filenames', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'swagger-digest-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const outputPath = await writeDigest({ markdown: '# hi', directory, filename: '../../escaped.md' });
  const realDirectory = await realpath(directory);
  const realOutput = await realpath(outputPath);
  assert.ok(realOutput.startsWith(realDirectory + path.sep), `output escaped directory: ${outputPath}`);
  assert.equal(path.basename(outputPath), 'escaped.md');
  await access(outputPath); // throws if the file was not written inside the directory
});

test('writeDigest expands ~ in the output directory', async (t) => {
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'swagger-digest-home-'));
  t.after(() => rm(fakeHome, { recursive: true, force: true }));

  assert.equal(resolveOutputDirectory('~', '/tmp/project'), os.homedir());
  const expanded = resolveOutputDirectory(path.join('~', 'docs'), '/tmp/project');
  assert.equal(expanded, path.join(os.homedir(), 'docs'));

  // End-to-end: a ~ directory resolves inside the (stubbed) home directory.
  const originalHome = os.homedir;
  os.homedir = () => fakeHome;
  try {
    const outputPath = await writeDigest({ markdown: '# hi', directory: '~/digests', filename: 'report.md' });
    assert.ok(outputPath.startsWith(fakeHome + path.sep), `output not under home: ${outputPath}`);
    await access(outputPath);
  } finally {
    os.homedir = originalHome;
  }
});

test('writeDigest appends a missing .md extension', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'swagger-digest-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const outputPath = await writeDigest({ markdown: '# hi', directory, filename: 'digest' });
  assert.equal(path.basename(outputPath), 'digest.md');
  await access(outputPath);
});

test('discovers spec URLs in an external swagger-initializer.js under a context path', async (t) => {
  const server: Server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/appsContentManagement/api/doc') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        '<!doctype html><html><head></head><body><div id="swagger-ui"></div><script src="./swagger-initializer.js"></script></body></html>',
      );
      return;
    }
    if (pathname === '/appsContentManagement/api/swagger-initializer.js') {
      response.writeHead(200, { 'content-type': 'application/javascript' });
      response.end('window.ui = SwaggerUIBundle({ url: "./openapi.json" });');
      return;
    }
    if (pathname === '/appsContentManagement/api/openapi.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(sampleSpec));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const result = await fetchOpenApiSpec(`http://127.0.0.1:${address.port}/appsContentManagement/api/doc`, {
    useBrowserFallback: false,
    timeoutMs: 1_000,
  });
  assert.equal(result.retrievalMethod, 'html-config');
  assert.equal(result.sourceUrl, `http://127.0.0.1:${address.port}/appsContentManagement/api/openapi.json`);
  assert.equal(result.spec.info.title, 'Example Payments API');
});

test('preserves the original page access error in extraction diagnostics', async (t) => {
  const server: Server = createServer((request, response) => {
    if (request.url === '/private-doc') {
      response.writeHead(403, { 'content-type': 'text/plain' });
      response.end('VPN required');
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await assert.rejects(
    fetchOpenApiSpec(`http://127.0.0.1:${address.port}/private-doc`, { useBrowserFallback: false, timeoutMs: 1_000 }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Swagger UI page: HTTP 403 Forbidden/);
      return true;
    },
  );
});
