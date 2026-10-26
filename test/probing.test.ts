import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
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

test('probe winner is the first candidate in list order, not the first to respond', async (t) => {
  // The page lives at /app/doc, so fallback candidates are probed under /app/.
  // './v3/api-docs' is first in the list but slow; './swagger.json' responds
  // immediately. The deterministic winner must still be v3/api-docs.
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/app/doc') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html><body><div id="swagger-ui"></div></body></html>');
      return;
    }
    if (pathname === '/app/v3/api-docs') {
      void delay(400).then(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(spec('Slow First Candidate'));
      });
      return;
    }
    if (pathname === '/app/swagger.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(spec('Fast Second Candidate'));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });
  const port = await listen(server);
  t.after(() => server.close());

  const result = await fetchOpenApiSpec(`http://127.0.0.1:${port}/app/doc`, {
    useBrowserFallback: false,
    timeoutMs: 3_000,
    probeTimeoutMs: 2_000,
  });
  assert.equal(result.retrievalMethod, 'fallback-path');
  assert.equal(result.spec.info.title, 'Slow First Candidate');
});

test('a probe that times out is skipped in favor of the next working candidate', async (t) => {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/app/v3/api-docs') {
      // Hangs longer than the probe timeout.
      void delay(1_500).then(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(spec('Never Selected'));
      });
      return;
    }
    if (pathname === '/app/swagger.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(spec('Fast Winner'));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });
  const port = await listen(server);
  t.after(() => server.close());

  const startedAt = Date.now();
  const result = await fetchOpenApiSpec(`http://127.0.0.1:${port}/app/doc`, {
    useBrowserFallback: false,
    timeoutMs: 3_000,
    probeTimeoutMs: 200,
  });
  assert.equal(result.spec.info.title, 'Fast Winner');
  assert.equal(result.retrievalMethod, 'fallback-path');
  // With the default 15s per-probe timeout and sequential probing this would
  // exceed 1.5s; the short probe timeout keeps the whole run well under that.
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 5_000, `probing took too long: ${elapsed}ms`);
});

test('a network-level failure on the base page fails fast instead of probing fallbacks', async () => {
  // Connection refused: nothing listens on this port.
  const deadPort = 59999;
  const startedAt = Date.now();
  await assert.rejects(
    fetchOpenApiSpec(`http://127.0.0.1:${deadPort}/swagger-ui`, {
      useBrowserFallback: false,
      timeoutMs: 2_000,
      probeTimeoutMs: 2_000,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /refused|ECONNREFUSED|fetch failed/i);
      return true;
    },
  );
  const elapsed = Date.now() - startedAt;
  // 16 fallback paths at ~2s each would take ~30s+; failing fast must stay fast.
  assert.ok(elapsed < 10_000, `fail-fast took ${elapsed}ms`);
});

test('errors from batched probes are aggregated in deterministic list order', async (t) => {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/app/doc') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html><body><div id="swagger-ui"></div></body></html>');
      return;
    }
    void delay(200).then(() => {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    });
  });
  const port = await listen(server);
  t.after(() => server.close());

  await assert.rejects(
    fetchOpenApiSpec(`http://127.0.0.1:${port}/app/doc`, {
      useBrowserFallback: false,
      timeoutMs: 2_000,
      probeTimeoutMs: 2_000,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const errorLines = error.message.split('\n').filter((line) => line.includes(' - http://'));
      const firstIndex = errorLines.findIndex((line) => line.includes('/app/v3/api-docs'));
      const secondIndex = errorLines.findIndex((line) => line.includes('/app/swagger.json'));
      assert.ok(firstIndex !== -1 && secondIndex !== -1, 'both candidate failures should be reported');
      assert.ok(firstIndex < secondIndex, 'errors must follow candidate list order, not completion order');
      return true;
    },
  );
});
