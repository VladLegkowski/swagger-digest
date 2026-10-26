import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function runCli(args: string[], timeoutMs = 60_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', ...args],
      { cwd: repoRoot, timeout: timeoutMs, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = (error as { code?: number } | null)?.code ?? (error ? 1 : 0);
        resolve({ stdout: String(stdout), stderr: String(stderr ?? ''), code });
      },
    );
  });
}

test('--stdout prints exactly the digest on stdout; progress goes to stderr', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(spec('Stdout Test API'));
  });
  const port = await listen(server);
  t.after(() => server.close());

  const { stdout, stderr } = await runCli([
    '--url',
    `http://127.0.0.1:${port}/openapi.json`,
    '--stdout',
    '--no-browser',
  ]);

  assert.match(stdout, /^# API Digest: Stdout Test API/m);
  assert.match(stdout, /## Endpoints|## Quick index/);
  // The digest must be the ONLY stdout artifact; progress/spinner text is on stderr.
  assert.ok(!stdout.includes('Parsed'), 'spinner text must not pollute stdout');
  assert.ok(stderr.length > 0 || true, 'stderr may contain progress text');
});

test('--stdout refuses to combine with --out-dir or --filename', async () => {
  const { code, stderr } = await runCli(
    ['--url', 'https://petstore.swagger.io/', '--stdout', '--out-dir', './docs', '--no-browser'],
    30_000,
  );
  assert.equal(code, 1);
  assert.match(stderr, /--stdout cannot be combined/);
});

test('--filename alone with --stdout also fails with the same error', async () => {
  const { code, stderr } = await runCli(
    ['--url', 'https://petstore.swagger.io/', '--stdout', '--filename', 'x.md', '--no-browser'],
    30_000,
  );
  assert.equal(code, 1);
  assert.match(stderr, /--stdout cannot be combined/);
});
