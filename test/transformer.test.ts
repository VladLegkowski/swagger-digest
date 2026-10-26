import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { fetchOpenApiSpec, parseSpecText } from '../src/fetcher.js';
import { transformOpenApiToMarkdown } from '../src/transformer.js';
import { defaultFilename, normalizeFilename, resolveOutputDirectory } from '../src/writer.js';

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

test('normalizes output filenames and directories', () => {
  assert.equal(defaultFilename('Payments API'), 'payments-api-digest.md');
  assert.equal(normalizeFilename('report'), 'report.md');
  assert.equal(normalizeFilename('../report.MD'), 'report.MD');
  assert.equal(resolveOutputDirectory('./docs', '/tmp/project'), '/tmp/project/docs');
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
