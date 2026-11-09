import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer, type SwaggerDigestMcpOptions } from '../src/mcp/server.js';
import {
  runApiCall,
  resolveApiCallConfig,
  redactSecrets,
  trimToTokenBudget,
  type ApiCallServerOptions,
} from '../src/mcp/api-call.js';

/** What the test API server observed on the latest request. */
interface ObservedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}
let observed: ObservedRequest | null = null;

/** Configurable response for the test API server. */
let apiResponse: { status: number; body: string; contentType?: string } = {
  status: 200,
  body: JSON.stringify({ ok: true, items: [1, 2, 3] }),
};

const apiServer: Server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    observed = {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: request.headers as Record<string, string>,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    response.writeHead(apiResponse.status, {
      'content-type': apiResponse.contentType ?? 'application/json',
    });
    response.end(apiResponse.body);
  });
});

test.before(async () => {
  apiServer.listen(0, '127.0.0.1');
  await once(apiServer, 'listening');
});

test.after(async () => {
  apiServer.close();
});

function apiOrigin(): string {
  const address = apiServer.address();
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

/** Base options for direct runApiCall calls against the loopback test server. */
function callOptions(overrides: Partial<ApiCallServerOptions> = {}): ApiCallServerOptions {
  return { baseUrl: apiOrigin(), blockPrivateNetworks: false, ...overrides };
}

async function connectMcp(
  options: SwaggerDigestMcpOptions,
): Promise<{ client: import('@modelcontextprotocol/sdk/client/index.js').Client; server: McpServer }> {
  const server: McpServer = createMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test.afterEach(() => {
  observed = null;
  apiResponse = { status: 200, body: JSON.stringify({ ok: true, items: [1, 2, 3] }) };
});

// --- Configuration resolution ---

test('unconfigured api_call returns an error naming the environment variable', async () => {
  const previous = process.env.SWAGGER_DIGEST_API_BASE_URL;
  delete process.env.SWAGGER_DIGEST_API_BASE_URL;
  try {
    const result = await runApiCall({ path: '/widgets' }, {});
    assert.equal(isError(result), true);
    assert.match(textOf(result), /SWAGGER_DIGEST_API_BASE_URL/);
  } finally {
    if (previous !== undefined) process.env.SWAGGER_DIGEST_API_BASE_URL = previous;
  }
});

test('resolveApiCallConfig defaults to GET-only and applies the timeout cap', () => {
  const { config, error } = resolveApiCallConfig({ baseUrl: 'https://api.example.com', timeoutMs: 999_999 }, {});
  assert.equal(error, undefined);
  assert.ok(config);
  assert.deepEqual([...config.methods], ['get']);
  assert.equal(config.timeoutMs, 60_000);
  assert.equal(config.blockPrivateNetworks, true);
});

test('resolveApiCallConfig rejects unknown methods and non-http base URLs', () => {
  assert.match(
    resolveApiCallConfig({ baseUrl: 'https://api.example.com', methods: ['get', 'banana'] }, {}).error ?? '',
    /Unknown method/,
  );
  assert.match(resolveApiCallConfig({ baseUrl: 'ftp://api.example.com' }, {}).error ?? '', /http/);
  assert.match(resolveApiCallConfig({ baseUrl: 'not a url' }, {}).error ?? '', /Invalid SWAGGER_DIGEST_API_BASE_URL/);
});

// --- Happy path ---

test('GET by path resolves against the configured base URL and returns status and body', async () => {
  const result = await runApiCall({ path: '/widgets', query: { page: 2 } }, callOptions());
  assert.equal(isError(result), false);
  const text = textOf(result);
  assert.match(text, /status: 200/);
  assert.match(text, /"ok": true|"ok":true/);
  assert.match(text, /api_call metadata: /);
  assert.ok(observed);
  assert.equal(observed.method, 'GET');
  assert.equal(new URL(`http://x${observed.url}`).pathname, '/widgets');
  assert.equal(new URL(`http://x${observed.url}`).searchParams.get('page'), '2');
});

test('query arrays serialize as repeated keys', async () => {
  await runApiCall({ path: '/widgets', query: { tag: ['a', 'b'], page: 2 } }, callOptions());
  assert.ok(observed);
  const params = new URL(`http://x${observed.url}`).searchParams;
  assert.deepEqual(params.getAll('tag'), ['a', 'b']);
  assert.equal(params.get('page'), '2');
});

test('absolute url on the trusted origin is allowed', async () => {
  const result = await runApiCall({ url: `${apiOrigin()}/widgets` }, callOptions());
  assert.equal(isError(result), false);
  assert.ok(observed);
  assert.equal(observed.url, '/widgets');
});

// --- Non-2xx responses are results, not errors ---

test('a 400 response is returned as a normal result with status and body', async () => {
  apiResponse = { status: 400, body: JSON.stringify({ error: 'amount must be positive' }) };
  const result = await runApiCall({ path: '/refunds' }, callOptions());
  assert.equal(isError(result), false);
  const text = textOf(result);
  assert.match(text, /status: 400/);
  assert.match(text, /amount must be positive/);
  assert.match(text, /Non-OK response returned as a result/);
});

// --- Method gating ---

test('POST is rejected while only GET is enabled', async () => {
  const result = await runApiCall({ path: '/widgets', method: 'POST', body: { name: 'x' } }, callOptions());
  assert.equal(isError(result), true);
  assert.match(textOf(result), /not enabled/);
  assert.match(textOf(result), /SWAGGER_DIGEST_API_METHODS/);
  assert.equal(observed, null);
});

test('POST works when enabled and the body arrives as JSON', async () => {
  const result = await runApiCall(
    { path: '/widgets', method: 'post', body: { name: 'widget-1' } },
    callOptions({ methods: ['get', 'post'] }),
  );
  assert.equal(isError(result), false);
  assert.ok(observed);
  assert.equal(observed.method, 'POST');
  assert.equal(observed.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(observed.body), { name: 'widget-1' });
});

test('GET with a request body is rejected', async () => {
  const result = await runApiCall({ path: '/widgets', body: { name: 'x' } }, callOptions());
  assert.equal(isError(result), true);
  assert.match(textOf(result), /cannot carry a request body/);
});

test('unknown method names are rejected', async () => {
  const result = await runApiCall({ path: '/widgets', method: 'trace' }, callOptions());
  assert.equal(isError(result), true);
  assert.match(textOf(result), /Unknown method/);
});

// --- Origin enforcement ---

test('absolute url on a foreign origin is refused', async () => {
  const result = await runApiCall(
    { url: 'https://evil.example.com/steal' },
    callOptions({ authHeaders: { authorization: 'Bearer secret-token-123' } }),
  );
  assert.equal(isError(result), true);
  assert.match(textOf(result), /trusted origin/);
  assert.equal(observed, null);
});

test('path tricks that change the origin are refused before any request', async () => {
  const result = await runApiCall({ path: '//evil.example.com/steal' }, callOptions());
  assert.equal(isError(result), true);
  assert.match(textOf(result), /trusted origin/);
  assert.equal(observed, null);
});

test('providing both url and path is an argument error', async () => {
  const result = await runApiCall({ url: `${apiOrigin()}/x`, path: '/x' }, callOptions());
  assert.equal(isError(result), true);
  assert.match(textOf(result), /not both/);
});

test('providing neither url nor path is an argument error', async () => {
  const result = await runApiCall({}, callOptions());
  assert.equal(isError(result), true);
  assert.match(textOf(result), /Provide a target/);
});

// --- Credential handling ---

test('credential headers in tool arguments are rejected', async () => {
  const result = await runApiCall({ path: '/widgets', headers: { authorization: 'Bearer arg-token' } }, callOptions());
  assert.equal(isError(result), true);
  assert.match(textOf(result), /Refusing to send/);
  assert.equal(observed, null);
});

test('x-api-key style arguments are rejected too', async () => {
  const result = await runApiCall({ path: '/widgets', headers: { 'X-API-Key': 'k' } }, callOptions());
  assert.equal(isError(result), true);
});

test('server-side auth headers are injected and reach the origin', async () => {
  await runApiCall({ path: '/widgets' }, callOptions({ authHeaders: { authorization: 'Bearer env-token-1' } }));
  assert.ok(observed);
  assert.equal(observed.headers.authorization, 'Bearer env-token-1');
});

test('responses echoing the credential are redacted', async () => {
  apiResponse = { status: 401, body: JSON.stringify({ message: 'bad token Bearer super-secret-token-99' }) };
  const result = await runApiCall(
    { path: '/widgets' },
    callOptions({ authHeaders: { authorization: 'Bearer super-secret-token-99' } }),
  );
  assert.equal(isError(result), false);
  const text = textOf(result);
  assert.match(text, /\[REDACTED\]/);
  assert.doesNotMatch(text, /super-secret-token-99/);
});

// --- Size and token budget ---

test('request bodies above the byte cap are rejected', async () => {
  const result = await runApiCall(
    { path: '/widgets', method: 'post', body: { blob: 'x'.repeat(100) } },
    callOptions({ methods: ['get', 'post'], maxBytes: 64 }),
  );
  assert.equal(isError(result), true);
  assert.match(textOf(result), /byte limit/);
});

test('max_tokens trims large response bodies with a marker', async () => {
  apiResponse = { status: 200, body: JSON.stringify({ items: 'x'.repeat(5000) }) };
  const result = await runApiCall({ path: '/widgets', max_tokens: 50 }, callOptions());
  assert.equal(isError(result), false);
  const text = textOf(result);
  assert.match(text, /truncated to fit the max_tokens budget/);
  assert.match(text, /trimmed to max_tokens/);
});

test('invalid max_tokens is an argument error', async () => {
  const result = await runApiCall({ path: '/widgets', max_tokens: 0 }, callOptions());
  assert.equal(isError(result), true);
  assert.match(textOf(result), /Invalid max_tokens/);
});

// --- SSRF guard ---

test('private-network blocking applies to api_call targets by default', async () => {
  const result = await runApiCall({ path: '/widgets' }, { baseUrl: apiOrigin() });
  assert.equal(isError(result), true);
  assert.match(textOf(result), /private|loopback/i);
});

test('invalid path arguments are rejected', async () => {
  const result = await runApiCall({ path: 'widgets' }, callOptions());
  assert.equal(isError(result), true);
  assert.match(textOf(result), /must start with/);
});

// --- Pure helpers ---

test('redactSecrets only replaces long values and all occurrences', () => {
  assert.equal(redactSecrets('a token-here b token-here', ['token-here']), 'a [REDACTED] b [REDACTED]');
  assert.equal(redactSecrets('short value stays', ['short']), 'short value stays');
});

test('trimToTokenBudget leaves short text untouched', () => {
  assert.deepEqual(trimToTokenBudget('tiny', 100), { text: 'tiny', trimmed: false });
});

// --- End-to-end through the MCP transport ---

test('api_call through the MCP client: unconfigured server yields a configuration error', async () => {
  const previous = process.env.SWAGGER_DIGEST_API_BASE_URL;
  delete process.env.SWAGGER_DIGEST_API_BASE_URL;
  try {
    const { client } = await connectMcp({ blockPrivateNetworks: false });
    const result = await client.callTool({ name: 'api_call', arguments: { path: '/widgets' } });
    await client.close();
    assert.equal(isError(result), true);
    assert.match(textOf(result), /SWAGGER_DIGEST_API_BASE_URL/);
  } finally {
    if (previous !== undefined) process.env.SWAGGER_DIGEST_API_BASE_URL = previous;
  }
});

test('api_call through the MCP client with configured options performs the request', async () => {
  const { client } = await connectMcp({
    blockPrivateNetworks: false,
    apiCall: callOptions({ authHeaders: { authorization: 'Bearer mcp-token-7' } }),
  });
  const result = await client.callTool({ name: 'api_call', arguments: { path: '/widgets' } });
  await client.close();
  assert.equal(isError(result), false);
  assert.match(textOf(result), /status: 200/);
  assert.ok(observed);
  assert.equal(observed.headers.authorization, 'Bearer mcp-token-7');
});
