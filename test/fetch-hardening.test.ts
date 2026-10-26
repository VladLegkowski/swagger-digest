import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { fetchOpenApiSpec } from '../src/fetcher.js';
import { isPrivateAddress } from '../src/hardened-fetch.js';
import { BlockedNetworkError, FetchError, FetchSizeError } from '../src/errors.js';

const sampleSpec = {
  openapi: '3.0.3',
  info: { title: 'Hardening Test API', version: '1.0.0' },
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

test('rejects an honest oversized content-length before reading the body', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(20 * 1024 * 1024) });
    response.end('{}');
  });
  const port = await listen(server);
  t.after(() => server.close());

  await assert.rejects(
    fetchOpenApiSpec(`http://127.0.0.1:${port}/openapi.json`, {
      useBrowserFallback: false,
      timeoutMs: 2_000,
      maxBytes: 1024 * 1024,
    }),
    (error: unknown) => {
      assert.ok(error instanceof FetchSizeError, `expected FetchSizeError, got ${String(error)}`);
      assert.equal(error.kind, 'size');
      return true;
    },
  );
});

test('enforces the size cap on chunked responses without a content-length', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }); // chunked, no content-length
    const chunk = 'x'.repeat(1024 * 1024);
    const writeChunks = (): void => {
      for (let i = 0; i < 12; i += 1) response.write(chunk);
      response.end();
    };
    // Write more than a 2 MB cap slowly enough to be caught mid-stream.
    response.write(chunk);
    setTimeout(() => {
      writeChunks();
    }, 10);
  });
  const port = await listen(server);
  t.after(() => server.close());

  await assert.rejects(
    fetchOpenApiSpec(`http://127.0.0.1:${port}/openapi.json`, {
      useBrowserFallback: false,
      timeoutMs: 5_000,
      maxBytes: 2 * 1024 * 1024,
    }),
    (error: unknown) => {
      assert.ok(error instanceof FetchSizeError);
      assert.equal(error.kind, 'size');
      assert.match(error.message, /byte limit while streaming/);
      return true;
    },
  );
});

test('redirect loops stop at the redirect limit', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(302, { location: '/loop' });
    response.end();
  });
  const port = await listen(server);
  t.after(() => server.close());

  await assert.rejects(
    fetchOpenApiSpec(`http://127.0.0.1:${port}/loop`, {
      useBrowserFallback: false,
      timeoutMs: 2_000,
      maxRedirects: 5,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Too many redirects/);
      return true;
    },
  );
});

test('cross-origin redirects are followed and the final spec is used', async (t) => {
  const specServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(sampleSpec));
  });
  const specPort = await listen(specServer);
  t.after(() => specServer.close());

  const pageServer = createServer((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${specPort}/openapi.json` });
    response.end();
  });
  const pagePort = await listen(pageServer);
  t.after(() => pageServer.close());

  const result = await fetchOpenApiSpec(`http://127.0.0.1:${pagePort}/swagger-ui`, {
    useBrowserFallback: false,
    timeoutMs: 3_000,
  });
  assert.equal(result.retrievalMethod, 'direct-spec');
  assert.equal(result.spec.info.title, 'Hardening Test API');
});

test('redirects beyond the limit across origins surface a clear error', async (t) => {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.writeHead(302, { location: `/hop-${hits}` });
    response.end();
  });
  const port = await listen(server);
  t.after(() => server.close());

  await assert.rejects(
    fetchOpenApiSpec(`http://127.0.0.1:${port}/start`, {
      useBrowserFallback: false,
      timeoutMs: 2_000,
      maxRedirects: 3,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Too many redirects \(limit 3\)/);
      return true;
    },
  );
});

test('blockPrivateNetworks blocks loopback addresses', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(sampleSpec));
  });
  const port = await listen(server);
  t.after(() => server.close());

  await assert.rejects(
    fetchOpenApiSpec(`http://127.0.0.1:${port}/openapi.json`, {
      useBrowserFallback: false,
      timeoutMs: 2_000,
      blockPrivateNetworks: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BlockedNetworkError, `expected BlockedNetworkError, got ${String(error)}`);
      assert.equal(error.kind, 'blocked');
      return true;
    },
  );
});

test('the private address blocklist covers the required ranges', () => {
  const blocked = [
    '0.0.0.0',
    '0.1.2.3',
    '127.0.0.1',
    '127.255.255.255',
    '10.0.0.1',
    '10.255.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.254',
    '169.254.1.1',
    '169.254.169.254',
    '::1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:192.168.1.1',
    '::ffff:169.254.169.254',
  ];
  for (const address of blocked) {
    assert.equal(isPrivateAddress(address), true, `${address} should be blocked`);
  }

  const allowed = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', '2606:4700::1111', '::ffff:8.8.8.8'];
  for (const address of allowed) {
    assert.equal(isPrivateAddress(address), false, `${address} should be allowed`);
  }
});

test('size-cap and network errors carry the right kind for fail-fast decisions', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': '999999999' });
    response.end();
  });
  const port = await listen(server);
  t.after(() => server.close());

  try {
    await fetchOpenApiSpec(`http://127.0.0.1:${port}/openapi.json`, {
      useBrowserFallback: false,
      timeoutMs: 2_000,
      maxBytes: 1024,
    });
    assert.fail('expected rejection');
  } catch (error) {
    assert.ok(error instanceof FetchError);
    assert.equal(error.kind, 'size');
  }
});
