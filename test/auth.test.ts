import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { fetchOpenApiSpec, headersForBrowserRequest } from '../src/fetcher.js';
import { mergeHeaders, parseHeaderArgument, parseHeaderPairs } from '../src/headers.js';

const sampleSpec = {
  openapi: '3.0.3',
  info: { title: 'Auth Test API', version: '1.0.0' },
  paths: {},
};

function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return address.port;
  });
}

test('parseHeaderArgument accepts well-formed headers and lowercases names', () => {
  assert.deepEqual(parseHeaderArgument('Authorization: Bearer abc'), { authorization: 'Bearer abc' });
  assert.deepEqual(parseHeaderArgument('X-Custom: v'), { 'x-custom': 'v' });
  // A colon inside the value is preserved.
  assert.deepEqual(parseHeaderArgument('X-Time: 12:30'), { 'x-time': '12:30' });
});

test('malformed header input is rejected without leaking values', () => {
  assert.throws(() => parseHeaderArgument('NoColonHere'), /expected "Name: value"/i);
  assert.throws(() => parseHeaderArgument('X-Key: bad\r\nValue'), /CR\/LF/);
  assert.throws(() => parseHeaderArgument('X-Key: bad\nValue'), /CR\/LF/);
  assert.throws(() => parseHeaderArgument('X-Key\nInjected: value'), /CR\/LF/);
  assert.throws(() => parseHeaderArgument(': value-only'), /Header name must not be empty/i);

  // Values must never appear in error messages.
  try {
    parseHeaderArgument('X-Key: super-secret-value');
    assert.fail('expected throw');
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /super-secret-value/);
  }
});

test('parseHeaderPairs handles newline-separated pairs; mergeHeaders lets later sources win', () => {
  assert.deepEqual(parseHeaderPairs('A: 1\nB: 2\n\nC: 3'), { a: '1', b: '2', c: '3' });
  assert.deepEqual(mergeHeaders({ a: 'env' }, { a: 'flag' }, { c: 'cookie' }), { a: 'flag', c: 'cookie' });
  assert.throws(() => mergeHeaders({ ok: 'fine' }, { bad: 'x\ny' }), /CR\/LF/);
});

test('headers are sent to the same origin as the supplied URL', async (t) => {
  let sawHeader = false;
  const server = createServer((request, response) => {
    sawHeader = request.headers['x-api-key'] === 'expected-key';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(sampleSpec));
  });
  const port = await listen(server);
  t.after(() => server.close());

  const result = await fetchOpenApiSpec(`http://127.0.0.1:${port}/openapi.json`, {
    useBrowserFallback: false,
    timeoutMs: 2_000,
    headers: { 'X-Api-Key': 'expected-key' },
  });
  assert.equal(result.retrievalMethod, 'direct-spec');
  assert.ok(sawHeader, 'the custom header should reach the same-origin server');
});

test('headers are NOT sent cross-origin and a warning names the other origin', async (t) => {
  const receivedApiKeys: Array<string | undefined> = [];
  const specServer = createServer((request, response) => {
    receivedApiKeys.push(
      Array.isArray(request.headers['x-api-key']) ? request.headers['x-api-key'][0] : request.headers['x-api-key'],
    );
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(sampleSpec));
  });
  const specPort = await listen(specServer);
  t.after(() => specServer.close());

  const pageServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      `<html><body><script>SwaggerUIBundle({ url: "http://127.0.0.1:${specPort}/spec.json" })</script></body></html>`,
    );
  });
  const pagePort = await listen(pageServer);
  t.after(() => pageServer.close());

  const warnings: string[] = [];
  const result = await fetchOpenApiSpec(`http://127.0.0.1:${pagePort}/swagger-ui`, {
    useBrowserFallback: false,
    timeoutMs: 3_000,
    headers: { 'X-Api-Key': 'must-not-leak' },
    warn: (message) => warnings.push(message),
  });

  assert.equal(result.retrievalMethod, 'html-config');
  assert.deepEqual(receivedApiKeys, [undefined]);
  assert.ok(
    warnings.some((message) => message.includes(`http://127.0.0.1:${specPort}`)),
    `expected a cross-origin warning naming the other origin, got: ${warnings.join(' | ')}`,
  );
});

test('a 401 without headers is followed by success with headers', async (t) => {
  const server = createServer((request, response) => {
    const auth = request.headers.authorization;
    if (typeof auth !== 'string' || auth !== 'Bearer valid-token') {
      response.writeHead(401, { 'content-type': 'text/plain' });
      response.end('unauthorized');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(sampleSpec));
  });
  const port = await listen(server);
  t.after(() => server.close());
  const specUrl = `http://127.0.0.1:${port}/spec.json`;

  await assert.rejects(fetchOpenApiSpec(specUrl, { useBrowserFallback: false, timeoutMs: 2_000 }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /401/);
    return true;
  });

  const result = await fetchOpenApiSpec(specUrl, {
    useBrowserFallback: false,
    timeoutMs: 2_000,
    headers: { Authorization: 'Bearer valid-token' },
  });
  assert.equal(result.retrievalMethod, 'direct-spec');
  assert.equal(result.spec.info.title, 'Auth Test API');
});

test('a page that requires the header succeeds only when it is sent', async (t) => {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/spec.json') {
      // Same-origin spec fetch: the header must reach it too.
      assert.equal(request.headers['x-api-key'], 'page-only');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(sampleSpec));
      return;
    }
    if (request.headers['x-api-key'] !== 'page-only') {
      response.writeHead(401, { 'content-type': 'text/plain' });
      response.end('unauthorized');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html><body><script>SwaggerUIBundle({ url: "spec.json" })</script></body></html>');
  });
  const port = await listen(server);
  t.after(() => server.close());

  const result = await fetchOpenApiSpec(`http://127.0.0.1:${port}/swagger-ui`, {
    useBrowserFallback: false,
    timeoutMs: 2_000,
    headers: { 'X-Api-Key': 'page-only' },
  });
  assert.equal(result.retrievalMethod, 'html-config');
  assert.equal(result.spec.info.title, 'Auth Test API');
});

test('browser routing helper only grants headers to the allowed origin', () => {
  const headers = { authorization: 'Bearer token' };
  const allowed = 'https://api.example.com';
  assert.deepEqual(headersForBrowserRequest('https://api.example.com/spec.json', headers, allowed), headers);
  assert.deepEqual(headersForBrowserRequest('https://api.example.com/x', headers, allowed), headers);
  // Third-party origins (CDNs, analytics, scripts) never receive headers.
  assert.equal(headersForBrowserRequest('https://cdn.example.com/lib.js', headers, allowed), undefined);
  assert.equal(headersForBrowserRequest('http://api.example.com/spec.json', headers, allowed), undefined);
  assert.equal(headersForBrowserRequest('not a url', headers, allowed), undefined);
  assert.equal(headersForBrowserRequest('https://api.example.com/x', {}, allowed), undefined);
});
