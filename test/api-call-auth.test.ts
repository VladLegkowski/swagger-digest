import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../src/mcp/server.js';
import { runApiCall, type ApiCallServerOptions } from '../src/mcp/api-call.js';
import { runSwaggerDigest } from '../src/mcp/digest.js';

const sampleSpec = {
  openapi: '3.0.3',
  info: { title: 'Auth Test API', version: '1.0.0' },
  servers: [{ url: 'https://elsewhere.example.com/v9' }, { url: 'PLACEHOLDER_ORIGIN/ClaimsManagement' }],
  paths: {
    '/things': {
      get: { summary: 'List things', responses: { '200': { description: 'OK' } } },
    },
  },
};

interface ObservedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}
let observed: ObservedRequest | null = null;

/** Echoes what the server observed so redaction can be tested against the body. */
const apiServer: Server = createServer((request, response) => {
  observed = {
    method: request.method ?? 'GET',
    url: request.url ?? '/',
    headers: request.headers as Record<string, string>,
  };
  const echo = JSON.stringify({
    sawAuthorization: request.headers.authorization ?? null,
    sawTenant: request.headers['x-tenant-id'] ?? null,
  });
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(echo);
});

const specServer: Server = createServer((request, response) => {
  const body = JSON.stringify(sampleSpec).replaceAll('PLACEHOLDER_ORIGIN', specOrigin());
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(body);
});

test.before(async () => {
  apiServer.listen(0, '127.0.0.1');
  specServer.listen(0, '127.0.0.1');
  await Promise.all([once(apiServer, 'listening'), once(specServer, 'listening')]);
});

test.after(async () => {
  apiServer.close();
  specServer.close();
});

function apiOrigin(): string {
  const address = apiServer.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function specOrigin(): string {
  const address = specServer.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  assert.ok(Array.isArray(content) && content.length > 0, 'expected text content');
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

function callOptions(overrides: Partial<ApiCallServerOptions> = {}): ApiCallServerOptions {
  return { baseUrl: apiOrigin(), blockPrivateNetworks: false, ...overrides };
}

/** Saves the process environment and restores it after each auth test. */
const envKeys = [
  'SWAGGER_DIGEST_API_HEADER',
  'SWAGGER_DIGEST_API_HEADER_FILE',
  'SWAGGER_DIGEST_OAUTH_ISSUER',
  'SWAGGER_DIGEST_OAUTH_CLIENT_ID',
  'SWAGGER_DIGEST_OAUTH_CLIENT_SECRET',
  'SWAGGER_DIGEST_OAUTH_SCOPE',
  'SWAGGER_DIGEST_OAUTH_CACHE_DIR',
];
let savedEnv: Record<string, string | undefined> = {};
test.beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
});
test.afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  observed = null;
});

// --- Header file ---

test('SWAGGER_DIGEST_API_HEADER_FILE wins over the inline env var', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'api-auth-'));
  const file = path.join(directory, 'headers');
  await writeFile(file, 'Authorization: Bearer file-token-123\nX-Tenant-Id: LaLiga');
  process.env.SWAGGER_DIGEST_API_HEADER = 'Authorization: Bearer inline-token-456';
  process.env.SWAGGER_DIGEST_API_HEADER_FILE = file;
  try {
    await runApiCall({ path: '/things' }, callOptions());
    assert.ok(observed);
    assert.equal(observed.headers.authorization, 'Bearer file-token-123');
    assert.equal(observed.headers['x-tenant-id'], 'LaLiga');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the header file is re-read per call — no restart needed for rotation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'api-auth-'));
  const file = path.join(directory, 'headers');
  await writeFile(file, 'Authorization: Bearer token-one-11111');
  process.env.SWAGGER_DIGEST_API_HEADER_FILE = file;
  try {
    await runApiCall({ path: '/things' }, callOptions());
    assert.ok(observed);
    assert.equal(observed.headers.authorization, 'Bearer token-one-11111');

    await writeFile(file, 'Authorization: Bearer token-two-22222');
    await runApiCall({ path: '/things' }, callOptions());
    assert.ok(observed);
    assert.equal(observed.headers.authorization, 'Bearer token-two-22222');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing header file yields an error naming the path', async () => {
  process.env.SWAGGER_DIGEST_API_HEADER_FILE = '/nonexistent/path/headers';
  const result = await runApiCall({ path: '/things' }, callOptions());
  assert.equal(isError(result), true);
  assert.match(textOf(result), /Could not read SWAGGER_DIGEST_API_HEADER_FILE "\/nonexistent\/path\/headers"/);
  assert.equal(observed, null);
});

test('invalid header file line errors with the line number but never the value', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'api-auth-'));
  const file = path.join(directory, 'headers');
  await writeFile(file, 'X-Ok: fine\nBAD LINE WITHOUT COLON super-secret-value');
  process.env.SWAGGER_DIGEST_API_HEADER_FILE = file;
  try {
    const result = await runApiCall({ path: '/things' }, callOptions());
    assert.equal(isError(result), true);
    const text = textOf(result);
    assert.match(text, /line 2/);
    assert.doesNotMatch(text, /super-secret-value/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('explicit options.authHeaders still override the header file (test injection)', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'api-auth-'));
  const file = path.join(directory, 'headers');
  await writeFile(file, 'Authorization: Bearer file-token-123');
  process.env.SWAGGER_DIGEST_API_HEADER_FILE = file;
  try {
    await runApiCall({ path: '/things' }, callOptions({ authHeaders: { authorization: 'Bearer option-token-789' } }));
    assert.ok(observed);
    assert.equal(observed.headers.authorization, 'Bearer option-token-789');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file-supplied tokens echoed by the API are redacted', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'api-auth-'));
  const file = path.join(directory, 'headers');
  await writeFile(file, 'Authorization: Bearer echo-me-token-999');
  process.env.SWAGGER_DIGEST_API_HEADER_FILE = file;
  try {
    const result = await runApiCall({ path: '/things' }, callOptions());
    assert.equal(isError(result), false);
    const text = textOf(result);
    assert.match(text, /\[REDACTED\]/);
    assert.doesNotMatch(text, /echo-me-token-999/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('no auth configured sends no credentials', async () => {
  await runApiCall({ path: '/things' }, callOptions());
  assert.ok(observed);
  assert.equal(observed.headers.authorization, undefined);
});

// --- Digest hints (api_call availability + spec prefix) ---

test('digest gets api_call hints when a declared server matches the trusted origin', async () => {
  const result = await runSwaggerDigest(
    { url: `${specOrigin()}/openapi.json` },
    { blockPrivateNetworks: false, apiCallHint: { trustedOrigin: specOrigin(), methods: ['get'] } },
  );
  const text = textOf(result);
  assert.match(text, /api_call can execute requests against this origin/);
  assert.match(text, /Spec-declared server path: \/ClaimsManagement/);
});

test('digest gets no hints when no declared server matches the trusted origin', async () => {
  const result = await runSwaggerDigest(
    { url: `${specOrigin()}/openapi.json` },
    { blockPrivateNetworks: false, apiCallHint: { trustedOrigin: 'https://other.example.com', methods: ['get'] } },
  );
  assert.doesNotMatch(textOf(result), /api_call hints/);
});

test('digest without api_call configured has no hints', async () => {
  const result = await runSwaggerDigest({ url: `${specOrigin()}/openapi.json` }, { blockPrivateNetworks: false });
  assert.doesNotMatch(textOf(result), /api_call hints/);
});

test('hints flow through the MCP transport from createMcpServer apiCall options', async () => {
  const server: McpServer = createMcpServer({
    blockPrivateNetworks: false,
    apiCall: { baseUrl: specOrigin(), blockPrivateNetworks: false, methods: ['get', 'post'] },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({
      name: 'swagger_digest',
      arguments: { url: `${specOrigin()}/openapi.json` },
    });
    const text = textOf(result);
    assert.match(text, /api_call can execute requests against this origin/);
    assert.match(text, /methods: get, post/);
    assert.match(text, /Spec-declared server path: \/ClaimsManagement/);
  } finally {
    await client.close();
  }
});

test('Swagger 2.0 host/basePath specs produce matching hints too', async () => {
  const server: Server = createServer(() => {
    // Handler is registered after the port is known (the spec embeds it).
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const spec = {
      swagger: '2.0',
      info: { title: 'Legacy API', version: '1.0.0' },
      host: new URL(origin).host,
      schemes: ['http'],
      basePath: '/Legacy',
      paths: { '/things': { get: { responses: { 200: { description: 'OK' } } } } },
    };
    server.removeAllListeners('request');
    server.on('request', (request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(spec));
    });
    const result = await runSwaggerDigest(
      { url: `${origin}/swagger.json` },
      { blockPrivateNetworks: false, apiCallHint: { trustedOrigin: origin, methods: ['get'] } },
    );
    const text = textOf(result);
    assert.match(text, /api_call can execute requests against this origin/);
    assert.match(text, /Spec-declared server path: \/Legacy/);
  } finally {
    server.close();
  }
});
