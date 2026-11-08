import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../src/mcp/server.js';
import { runSwaggerDigest, buildRequestHeaders } from '../src/mcp/digest.js';

const sampleSpec = {
  openapi: '3.0.3',
  info: { title: 'MCP Test API', version: '2.1.0' },
  servers: [{ url: 'https://api.example.com/v2' }],
  tags: [{ name: 'alpha' }, { name: 'beta' }],
  paths: {
    '/widgets': {
      get: {
        tags: ['alpha'],
        summary: 'List widgets',
        responses: { '200': { description: 'OK' } },
      },
      post: {
        tags: ['beta'],
        summary: 'Create widget',
        responses: { '201': { description: 'Created' } },
      },
    },
  },
};

/** Headers the test HTTP server observed on the latest request. */
let observedHeaders: Record<string, string> = {};
let specResponse: { status: number; body: string } = {
  status: 200,
  body: JSON.stringify(sampleSpec),
};

const httpServer: Server = createServer((request, response) => {
  observedHeaders = request.headers as Record<string, string>;
  response.writeHead(specResponse.status, { 'content-type': 'application/json' });
  response.end(specResponse.body);
});

test.before(async () => {
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
});

test.after(async () => {
  httpServer.close();
});

function baseUrl(): string {
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

/** Connects a fresh in-memory client to a fresh server instance (loopback allowed for tests). */
async function connect(): Promise<Client> {
  const server: McpServer = createMcpServer({ blockPrivateNetworks: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  assert.ok(Array.isArray(content) && content.length > 0, 'expected text content');
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}

test('lists the swagger_digest tool with a description', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, 'swagger_digest');
  assert.match(tools[0]?.description ?? '', /OpenAPI/i);
  await client.close();
});

test('returns a digest containing the API title and metadata footer', async () => {
  const client = await connect();
  const result = await client.callTool({ name: 'swagger_digest', arguments: { url: `${baseUrl()}/openapi.json` } });
  assert.notEqual((result as { isError?: boolean }).isError, true);
  const text = textOf(result);
  assert.match(text, /# API Digest: MCP Test API/);
  assert.match(text, /List widgets/);
  assert.match(text, /Digest metadata: .+ \(via direct-spec\)/);
  assert.match(text, /2 operations/);
  await client.close();
});

test('include_tags filters operations and drops untagged ones from detail', async () => {
  const client = await connect();
  const result = await client.callTool({
    name: 'swagger_digest',
    arguments: { url: `${baseUrl()}/openapi.json`, include_tags: ['alpha'] },
  });
  const text = textOf(result);
  assert.match(text, /List widgets/);
  assert.doesNotMatch(text, /Create widget/);
  assert.match(text, /1 operation/);
  await client.close();
});

test('tool-call headers reach the origin, merged over SWAGGER_DIGEST_HEADER', async () => {
  const previous = process.env.SWAGGER_DIGEST_HEADER;
  process.env.SWAGGER_DIGEST_HEADER = 'X-Env: env-value';
  try {
    const client = await connect();
    await client.callTool({
      name: 'swagger_digest',
      arguments: {
        url: `${baseUrl()}/openapi.json`,
        headers: { Authorization: 'Bearer test-token', 'X-Env': 'arg-value' },
      },
    });
    await client.close();
    assert.equal(observedHeaders.authorization, 'Bearer test-token');
    assert.equal(observedHeaders['x-env'], 'arg-value');
  } finally {
    if (previous === undefined) delete process.env.SWAGGER_DIGEST_HEADER;
    else process.env.SWAGGER_DIGEST_HEADER = previous;
  }
});

test('buildRequestHeaders merges environment first and arguments second', () => {
  const previous = process.env.SWAGGER_DIGEST_HEADER;
  process.env.SWAGGER_DIGEST_HEADER = 'Authorization: Bearer env-token\nX-Tenant: acme';
  try {
    assert.deepEqual(buildRequestHeaders({ headers: { authorization: 'Bearer arg-token' } }), {
      authorization: 'Bearer arg-token',
      'x-tenant': 'acme',
    });
  } finally {
    if (previous === undefined) delete process.env.SWAGGER_DIGEST_HEADER;
    else process.env.SWAGGER_DIGEST_HEADER = previous;
  }
});

test('write_to_file saves the digest and returns the path', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'swagger-digest-mcp-'));
  try {
    const client = await connect();
    const result = await client.callTool({
      name: 'swagger_digest',
      arguments: {
        url: `${baseUrl()}/openapi.json`,
        write_to_file: { directory, filename: 'digest.md' },
      },
    });
    await client.close();
    const text = textOf(result);
    assert.match(text, /Digest written to .+digest\.md/);
    const written = await readFile(path.join(directory, 'digest.md'), 'utf8');
    assert.match(written, /# API Digest: MCP Test API/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid url argument returns an isError result', async () => {
  const client = await connect();
  const result = await client.callTool({ name: 'swagger_digest', arguments: { url: 'ftp://example.com/spec' } });
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(textOf(result), /Invalid url/);
  await client.close();
});

test('failed fetch returns an isError result naming the failure', async () => {
  specResponse = { status: 404, body: 'not found' };
  try {
    const client = await connect();
    const result = await client.callTool({ name: 'swagger_digest', arguments: { url: `${baseUrl()}/openapi.json` } });
    await client.close();
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(textOf(result), /Could not extract an OpenAPI definition/);
  } finally {
    specResponse = { status: 200, body: JSON.stringify(sampleSpec) };
  }
});

test('runSwaggerDigest can be driven directly without a transport', async () => {
  const result = await runSwaggerDigest({ url: `${baseUrl()}/openapi.json` }, { blockPrivateNetworks: false });
  assert.notEqual(result.isError, true);
  assert.match(textOf(result), /# API Digest: MCP Test API/);
});
