import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  base64url,
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeAuthorizationCode,
  loadTokenCache,
  refreshAccessToken,
  resolveAccessToken,
  resolveOAuthConfig,
  runInteractiveLogin,
  saveTokenCache,
  tokenCacheFilePath,
} from '../src/mcp/oauth.js';
import { runApiCall, type ApiCallServerOptions } from '../src/mcp/api-call.js';

const VALID_REFRESH = 'initial-refresh-token-123456';
const FIRST_TOKEN = 'initial-access-token-12345678';
const NEW_TOKEN = 'refreshed-access-token-87654321';

let issuedToken: { accessToken: string; refreshToken?: string; expiresIn: number } = {
  accessToken: NEW_TOKEN,
  refreshToken: VALID_REFRESH,
  expiresIn: 3600,
};
let tokenRequests: Array<Record<string, string>> = [];

/** Minimal mock OIDC issuer: discovery + token endpoint (refresh & code exchange). */
const issuer: Server = createServer((request, response) => {
  const url = request.url ?? '/';
  if (url === '/.well-known/openid-configuration') {
    const base = issuerOrigin();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ authorization_endpoint: `${base}/auth`, token_endpoint: `${base}/token` }));
    return;
  }
  if (url === '/token' && request.method === 'POST') {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      tokenRequests.push(Object.fromEntries(form.entries()));
      if (form.get('grant_type') === 'refresh_token') {
        if (form.get('refresh_token') !== VALID_REFRESH) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token is stale' }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            access_token: issuedToken.accessToken,
            ...(issuedToken.refreshToken ? { refresh_token: issuedToken.refreshToken } : {}),
            expires_in: issuedToken.expiresIn,
            scope: 'openid',
          }),
        );
        return;
      }
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'good-code' || !form.get('code_verifier')) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            access_token: 'exchanged-access-token-2468',
            refresh_token: 'exchanged-refresh-token-1357',
            expires_in: 3600,
          }),
        );
        return;
      }
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unsupported_grant_type' }));
    });
    return;
  }
  response.writeHead(404);
  response.end();
});

test.before(async () => {
  issuer.listen(0, '127.0.0.1');
  await once(issuer, 'listening');
});

test.after(async () => {
  issuer.close();
});

function issuerOrigin(): string {
  const address = issuer.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

let cacheDirectory = '';
test.beforeEach(async () => {
  cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'oauth-test-'));
  // runInteractiveLogin derives the cache path from the process environment
  // (production behavior), so point it at the temp dir for the test run.
  process.env.SWAGGER_DIGEST_OAUTH_CACHE_DIR = cacheDirectory;
});
test.afterEach(async () => {
  delete process.env.SWAGGER_DIGEST_OAUTH_CACHE_DIR;
  await rm(cacheDirectory, { recursive: true, force: true });
  issuedToken = { accessToken: NEW_TOKEN, refreshToken: VALID_REFRESH, expiresIn: 3600 };
  tokenRequests = [];
});

function oauthConfig(): { issuer: string; clientId: string } {
  return { issuer: issuerOrigin(), clientId: 'test-client' };
}

function env(): NodeJS.ProcessEnv {
  return { SWAGGER_DIGEST_OAUTH_CACHE_DIR: cacheDirectory } as NodeJS.ProcessEnv;
}

// --- PKCE primitives ---

test('PKCE verifier is base64url and the challenge is its S256 hash', () => {
  const { verifier, challenge } = createPkcePair();
  assert.equal(verifier.length, 43);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.equal(challenge, base64url(createHash('sha256').update(verifier).digest()));
  assert.notEqual(verifier, createPkcePair().verifier);
});

test('state is non-empty base64url', () => {
  assert.match(createState(), /^[A-Za-z0-9_-]+$/);
});

test('authorize URL carries response_type, client, PKCE and state', () => {
  const url = new URL(
    buildAuthorizeUrl({
      authorizationEndpoint: 'https://idp.example.com/auth',
      clientId: 'abc',
      redirectUri: 'http://127.0.0.1:9999/callback',
      state: 'st4te',
      challenge: 'ch4ll',
      scope: 'openid',
    }),
  );
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'abc');
  assert.equal(url.searchParams.get('state'), 'st4te');
  assert.equal(url.searchParams.get('code_challenge'), 'ch4ll');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'openid');
});

// --- Token resolution ---

test('resolveAccessToken with no cache returns a needs-login message naming the command', async () => {
  const result = await resolveAccessToken(oauthConfig(), env());
  assert.equal(result.kind, 'needs-login');
  assert.match(result.message, /swagger-digest login --issuer/);
  assert.match(result.message, /--client-id test-client/);
});

test('a valid cached token is used without touching the issuer', async () => {
  const file = tokenCacheFilePath(oauthConfig().issuer, oauthConfig().clientId, env());
  await saveTokenCache(file, { accessToken: 'cached-token-12345678', expiresAt: Date.now() + 600_000 });
  const hits = tokenRequests.length;
  const result = await resolveAccessToken(oauthConfig(), env());
  assert.equal(result.kind, 'token');
  assert.equal((result as { accessToken: string }).accessToken, 'cached-token-12345678');
  assert.equal(tokenRequests.length, hits);
});

test('an expired token is silently refreshed and the cache is updated', async () => {
  const file = tokenCacheFilePath(oauthConfig().issuer, oauthConfig().clientId, env());
  await saveTokenCache(file, { accessToken: FIRST_TOKEN, refreshToken: VALID_REFRESH, expiresAt: Date.now() - 1000 });
  const result = await resolveAccessToken(oauthConfig(), env());
  assert.equal(result.kind, 'token');
  assert.equal((result as { accessToken: string }).accessToken, NEW_TOKEN);
  const updated = await loadTokenCache(file);
  assert.equal(updated?.accessToken, NEW_TOKEN);
  assert.ok(tokenRequests.some((request) => request.grant_type === 'refresh_token'));
});

test('a failed refresh degrades to needs-login instead of a raw network error', async () => {
  const file = tokenCacheFilePath(oauthConfig().issuer, oauthConfig().clientId, env());
  await saveTokenCache(file, {
    accessToken: FIRST_TOKEN,
    refreshToken: 'stale-refresh-token-000',
    expiresAt: Date.now() - 1000,
  });
  const result = await resolveAccessToken(oauthConfig(), env());
  assert.equal(result.kind, 'needs-login');
  assert.match(result.message, /swagger-digest login/);
});

test('refresh that fails at the network level also degrades to needs-login', async () => {
  const file = tokenCacheFilePath(oauthConfig().issuer, oauthConfig().clientId, env());
  await saveTokenCache(file, { accessToken: FIRST_TOKEN, refreshToken: VALID_REFRESH, expiresAt: Date.now() - 1000 });
  const result = await resolveAccessToken({ issuer: 'http://127.0.0.1:1', clientId: 'test-client' }, env());
  assert.equal(result.kind, 'needs-login');
});

test('cache files are written with 0600 permissions', async () => {
  const file = tokenCacheFilePath(oauthConfig().issuer, oauthConfig().clientId, env());
  await saveTokenCache(file, { accessToken: 'perm-check-token-1', expiresAt: Date.now() + 1000 });
  const stats = await stat(file);
  assert.equal(stats.mode & 0o777, 0o600);
});

test('resolveOAuthConfig reads issuer/client/scope from the environment', () => {
  assert.equal(resolveOAuthConfig({}), undefined);
  const config = resolveOAuthConfig({
    SWAGGER_DIGEST_OAUTH_ISSUER: 'https://idp.example.com/realms/r/',
    SWAGGER_DIGEST_OAUTH_CLIENT_ID: ' cid ',
    SWAGGER_DIGEST_OAUTH_SCOPE: 'openid profile',
  });
  assert.deepEqual(config, { issuer: 'https://idp.example.com/realms/r', clientId: 'cid', scope: 'openid profile' });
});

test('token cache path is deterministic per issuer+client and differs across clients', () => {
  const a = tokenCacheFilePath('https://idp.example.com/realms/r', 'client1', env());
  const a2 = tokenCacheFilePath('https://idp.example.com/realms/r', 'client1', env());
  const b = tokenCacheFilePath('https://idp.example.com/realms/r', 'client2', env());
  assert.equal(a, a2);
  assert.notEqual(a, b);
});

// --- Direct grant helpers against the mock issuer ---

test('exchangeAuthorizationCode sends the verifier and returns tokens', async () => {
  const { verifier } = createPkcePair();
  const tokens = await exchangeAuthorizationCode({
    tokenEndpoint: `${issuerOrigin()}/token`,
    clientId: 'test-client',
    code: 'good-code',
    verifier,
    redirectUri: 'http://127.0.0.1:1/callback',
  });
  assert.equal(tokens.accessToken, 'exchanged-access-token-2468');
});

test('refreshAccessToken rejects on invalid_grant with the issuer message', async () => {
  await assert.rejects(
    () =>
      refreshAccessToken({
        tokenEndpoint: `${issuerOrigin()}/token`,
        clientId: 'test-client',
        refreshToken: 'stale-refresh-token-000',
      }),
    /refresh token is stale/,
  );
});

// --- api_call integration ---

function callOptions(overrides: Partial<ApiCallServerOptions> = {}): ApiCallServerOptions {
  return { baseUrl: 'http://127.0.0.1:1', blockPrivateNetworks: true, ...overrides };
}

test('runApiCall with OAuth configured but no cache returns the login hint without calling the API', async () => {
  const result = await runApiCall({ path: '/things' }, callOptions({ baseUrl: 'https://api.example.com' }), {
    SWAGGER_DIGEST_OAUTH_ISSUER: issuerOrigin(),
    SWAGGER_DIGEST_OAUTH_CLIENT_ID: 'test-client',
    SWAGGER_DIGEST_OAUTH_CACHE_DIR: cacheDirectory,
  } as NodeJS.ProcessEnv);
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match((result as { content: Array<{ text?: string }> }).content[0]?.text ?? '', /swagger-digest login/);
});

test('runApiCall injects the refreshed bearer token and redacts it from the response', async () => {
  const file = tokenCacheFilePath(issuerOrigin(), 'test-client', env());
  await saveTokenCache(file, { accessToken: FIRST_TOKEN, refreshToken: VALID_REFRESH, expiresAt: Date.now() - 1000 });

  let sawAuthorization: string | null = null;
  const api = createServer((request, response) => {
    sawAuthorization = request.headers.authorization ?? null;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ echo: request.headers.authorization ?? null }));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  try {
    const address = api.address();
    assert.ok(address && typeof address === 'object');
    const result = await runApiCall(
      { path: '/things' },
      callOptions({ baseUrl: `http://127.0.0.1:${address.port}`, blockPrivateNetworks: false }),
      {
        SWAGGER_DIGEST_OAUTH_ISSUER: issuerOrigin(),
        SWAGGER_DIGEST_OAUTH_CLIENT_ID: 'test-client',
        SWAGGER_DIGEST_OAUTH_CACHE_DIR: cacheDirectory,
      } as NodeJS.ProcessEnv,
    );
    assert.equal((result as { isError?: boolean }).isError, undefined);
    assert.equal(sawAuthorization, `Bearer ${NEW_TOKEN}`);
    const text = (result as { content: Array<{ text?: string }> }).content[0]?.text ?? '';
    assert.match(text, /\[REDACTED\]/);
    assert.doesNotMatch(text, /refreshed-access-token-87654321/);
  } finally {
    api.close();
  }
});

// --- Interactive login (browser mocked away; callback replayed over real HTTP) ---

test('runInteractiveLogin performs discovery, exchange and cache write end to end', async () => {
  const cacheFile = await driveInteractiveLogin('good-code');
  const cached = await loadTokenCache(cacheFile);
  assert.equal(cached?.accessToken, 'exchanged-access-token-2468');
  assert.equal(cached?.refreshToken, 'exchanged-refresh-token-1357');
  const stats = await stat(cacheFile);
  assert.equal(stats.mode & 0o777, 0o600);
});

test('runInteractiveLogin rejects when the callback carries no valid code', async () => {
  await assert.rejects(() => driveInteractiveLogin('bad-code'), /Authorization response was invalid|invalid_grant/);
});

/**
 * Drives runInteractiveLogin without a browser: captures the authorize URL via
 * the mocked opener, replays the redirect against the real local listener, and
 * verifies the exchange used a verifier matching the challenge.
 */
async function driveInteractiveLogin(code: string): Promise<string> {
  let authorizeUrl = '';
  const login = runInteractiveLogin(oauthConfig(), {
    openUrl: (url) => {
      authorizeUrl = url;
    },
    log: () => {},
    timeoutMs: 5000,
  });
  for (let i = 0; i < 200 && authorizeUrl === ''; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(authorizeUrl.startsWith(`${issuerOrigin()}/auth`), `unexpected authorize URL: ${authorizeUrl}`);
  const authorizeParams = new URL(authorizeUrl);
  const state = authorizeParams.searchParams.get('state');
  const challenge = authorizeParams.searchParams.get('code_challenge');
  assert.ok(state && challenge);

  const redirectUri = authorizeParams.searchParams.get('redirect_uri');
  assert.ok(redirectUri);
  const callbackResponse = await fetch(`${redirectUri}?code=${code}&state=${state}`);
  assert.equal(callbackResponse.status, 200);
  assert.match(await callbackResponse.text(), /Login complete/);

  await login;

  const exchange = tokenRequests.find((request) => request.grant_type === 'authorization_code');
  assert.ok(exchange, 'expected an authorization_code exchange');
  const expectedChallenge = base64url(
    createHash('sha256')
      .update(exchange.code_verifier ?? '')
      .digest(),
  );
  assert.equal(expectedChallenge, challenge);
  return tokenCacheFilePath(oauthConfig().issuer, oauthConfig().clientId, env());
}
