import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { fetchOpenApiSpec } from '../src/fetcher.js';

function spec(title: string): string {
  return JSON.stringify({ openapi: '3.0.3', info: { title, version: '1.0.0' }, paths: {} });
}

function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return address.port;
  });
}

test('a multi-spec urls: array is probed in document order with a notice', async (t) => {
  const requested: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    requested.push(url.pathname);
    if (url.pathname === '/doc') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<html><body><script>
SwaggerUIBundle({
  urls: [{ url: "./specs/first.json", name: "First" }, { url: "./specs/second.json", name: "Second" }],
  dom_id: "#swagger-ui",
});
</script></body></html>`);
      return;
    }
    if (url.pathname === '/specs/first.json') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    if (url.pathname === '/specs/second.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(spec('Second Definition Wins'));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const port = await listen(server);
  t.after(() => server.close());

  const notices: string[] = [];
  const result = await fetchOpenApiSpec(`http://127.0.0.1:${port}/doc`, {
    useBrowserFallback: false,
    timeoutMs: 2_000,
    warn: (message) => notices.push(message),
  });

  assert.equal(result.retrievalMethod, 'html-config');
  assert.equal(result.spec.info.title, 'Second Definition Wins');
  assert.ok(
    notices.some((message) => message.includes('Multiple spec definitions found (2)')),
    `expected a multi-spec notice, got: ${notices.join(' | ')}`,
  );
});

test('the first healthy urls: entry wins even if a later one responds faster', async (t) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/doc') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<html><body><script>
SwaggerUIBundle({
  urls: [
    { url: "./alpha.json", name: "Alpha" },
    { url: "./beta.json", name: "Beta" },
  ],
});
</script></body></html>`);
      return;
    }
    if (url.pathname === '/alpha.json') {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(spec('Alpha'));
      }, 200);
      return;
    }
    if (url.pathname === '/beta.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(spec('Beta'));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const port = await listen(server);
  t.after(() => server.close());

  const result = await fetchOpenApiSpec(`http://127.0.0.1:${port}/doc`, {
    useBrowserFallback: false,
    timeoutMs: 3_000,
  });
  assert.equal(result.spec.info.title, 'Alpha');
});

test('--spec overrides discovery and is fetched directly', async (t) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/doc') {
      response.writeHead(200, { 'content-type': 'text/html' });
      // The page advertises a spec that would fail parsing if used.
      response.end('<html><body><script>SwaggerUIBundle({ url: "./wrong.json" })</script></body></html>');
      return;
    }
    if (url.pathname === '/specs/override.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(spec('Explicit Override'));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const port = await listen(server);
  t.after(() => server.close());

  const result = await fetchOpenApiSpec(`http://127.0.0.1:${port}/doc`, {
    useBrowserFallback: false,
    timeoutMs: 2_000,
    specUrl: `http://127.0.0.1:${port}/specs/override.json`,
  });
  assert.equal(result.retrievalMethod, 'direct-spec');
  assert.equal(result.sourceUrl, `http://127.0.0.1:${port}/specs/override.json`);
  assert.equal(result.spec.info.title, 'Explicit Override');
});
