import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * OAuth2 Authorization Code + PKCE support for `api_call`.
 *
 * Design principles:
 * - The MCP server NEVER opens a browser and never runs interactive flows.
 *   Interactive login is a deliberate foreground CLI action (`swagger-digest
 *   login`); the server only performs SILENT refresh from the on-disk cache.
 * - Tokens live in a 0600-permission cache file keyed by issuer+client, and
 *   are redacted from tool results by the caller.
 * - The issuer is operator configuration (env), not model-supplied input, so
 *   plain fetch is appropriate here — hardened-fetch's SSRF guard would
 *   reject loopback mock issuers used by tests and internal realms alike.
 */

export interface OAuthConfig {
  /** Issuer base URL, e.g. https://keycloak.example.com/realms/my-realm (no trailing slash). */
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
}

export interface TokenCache {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms after which the access token is considered expired. */
  expiresAt: number;
  scope?: string;
}

export type AccessTokenResult =
  | { kind: 'token'; accessToken: string; secrets: string[] }
  | { kind: 'needs-login'; message: string }
  | { kind: 'error'; message: string };

export function normalizeIssuer(issuer: string): string {
  return issuer.trim().replace(/\/+$/, '');
}

export function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/** RFC 7636 PKCE pair: verifier (base64url) and S256 challenge. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** CSRF protection token for the authorization redirect. */
export function createState(): string {
  return base64url(randomBytes(16));
}

/** Cache directory override exists for tests; production uses ~/.cache/swagger-digest. */
export function tokenCacheDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.SWAGGER_DIGEST_OAUTH_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'swagger-digest');
}

export function tokenCacheFilePath(issuer: string, clientId: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = createHash('sha256')
    .update(`${normalizeIssuer(issuer)}|${clientId}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(tokenCacheDirectory(env), `oauth-${key}.json`);
}

export async function loadTokenCache(file: string): Promise<TokenCache | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TokenCache>;
    if (typeof parsed.accessToken !== 'string' || typeof parsed.expiresAt !== 'number') return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : undefined,
      expiresAt: parsed.expiresAt,
      scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
    };
  } catch {
    return null;
  }
}

export async function saveTokenCache(file: string, cache: TokenCache): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  // mode only applies at creation; enforce for pre-existing files too.
  await chmod(file, 0o600);
}

/** Values that must be redacted from any tool output mentioning the response body. */
export function tokenSecrets(cache: Pick<TokenCache, 'accessToken' | 'refreshToken'>): string[] {
  return [cache.accessToken, cache.refreshToken].filter(
    (value): value is string => typeof value === 'string' && value.length >= 8,
  );
}

export interface OpenIdDiscovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new Error(`Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${url} but got HTTP ${response.status} with a non-JSON body.`);
  }
  if (!response.ok) {
    const detail = (parsed as { error_description?: string; error?: string; message?: string }) ?? {};
    throw new Error(
      `Request to ${url} failed with HTTP ${response.status}: ${detail.error_description ?? detail.error ?? detail.message ?? 'unknown error'}`,
    );
  }
  return parsed as Record<string, unknown>;
}

/** Resolves authorization/token endpoints from the issuer's OIDC discovery document. */
export async function discoverEndpoints(issuer: string): Promise<OpenIdDiscovery> {
  const normalized = normalizeIssuer(issuer);
  const document = await fetchJson(`${normalized}/.well-known/openid-configuration`);
  const authorizationEndpoint = document.authorization_endpoint;
  const tokenEndpoint = document.token_endpoint;
  if (typeof authorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string') {
    throw new Error(`Issuer ${normalized} discovery document is missing authorization/token endpoints.`);
  }
  return { authorizationEndpoint, tokenEndpoint };
}

export function buildAuthorizeUrl(options: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scope?: string;
}): string {
  const url = new URL(options.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('state', options.state);
  url.searchParams.set('code_challenge', options.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (options.scope) url.searchParams.set('scope', options.scope);
  return url.toString();
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

function tokenFromResponse(parsed: TokenResponse): {
  accessToken: string;
  refreshToken?: string;
  expiresInMs: number;
  scope?: string;
} {
  if (typeof parsed.access_token !== 'string' || parsed.access_token === '') {
    throw new Error('Token endpoint response is missing access_token.');
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : undefined,
    expiresInMs: typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in * 1000 : 300_000,
    scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
  };
}

async function postTokenRequest(
  tokenEndpoint: string,
  params: Record<string, string>,
): Promise<{ accessToken: string; refreshToken?: string; expiresInMs: number; scope?: string }> {
  const parsed = (await fetchJson(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })) as TokenResponse;
  return tokenFromResponse(parsed);
}

export async function exchangeAuthorizationCode(options: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<{ accessToken: string; refreshToken?: string; expiresInMs: number; scope?: string }> {
  return postTokenRequest(options.tokenEndpoint, {
    grant_type: 'authorization_code',
    code: options.code,
    client_id: options.clientId,
    ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
    code_verifier: options.verifier,
    redirect_uri: options.redirectUri,
  });
}

export async function refreshAccessToken(options: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}): Promise<{ accessToken: string; refreshToken?: string; expiresInMs: number; scope?: string }> {
  return postTokenRequest(options.tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    client_id: options.clientId,
    ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
  });
}

/** Reads SWAGGER_DIGEST_OAUTH_* env vars; undefined when OAuth is not configured. */
export function resolveOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig | undefined {
  const issuer = env.SWAGGER_DIGEST_OAUTH_ISSUER?.trim();
  const clientId = env.SWAGGER_DIGEST_OAUTH_CLIENT_ID?.trim();
  if (!issuer || !clientId) return undefined;
  const clientSecret = env.SWAGGER_DIGEST_OAUTH_CLIENT_SECRET?.trim();
  const scope = env.SWAGGER_DIGEST_OAUTH_SCOPE?.trim();
  const config: OAuthConfig = { issuer: normalizeIssuer(issuer), clientId };
  if (clientSecret) config.clientSecret = clientSecret;
  if (scope) config.scope = scope;
  return config;
}

/**
 * Returns a valid access token: cache hit → cached; expired → silent refresh;
 * otherwise a needs-login result whose message names the login command.
 * The server-side path of this function never opens a browser.
 */
export async function resolveAccessToken(
  config: OAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AccessTokenResult> {
  const file = tokenCacheFilePath(config.issuer, config.clientId, env);
  const cached = await loadTokenCache(file);
  const now = Date.now();

  if (cached && cached.expiresAt - 30_000 > now) {
    return { kind: 'token', accessToken: cached.accessToken, secrets: tokenSecrets(cached) };
  }

  if (cached?.refreshToken) {
    try {
      const discovery = await discoverEndpoints(config.issuer);
      const refreshed = await refreshAccessToken({
        tokenEndpoint: discovery.tokenEndpoint,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken: cached.refreshToken,
      });
      const next: TokenCache = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? cached.refreshToken,
        expiresAt: Date.now() + refreshed.expiresInMs,
        scope: refreshed.scope,
      };
      await saveTokenCache(file, next);
      return { kind: 'token', accessToken: next.accessToken, secrets: tokenSecrets(next) };
    } catch {
      // Refresh failed (expired refresh token, unreachable issuer, …) — fall
      // through to needs-login rather than failing with a raw network error.
    }
  }

  return {
    kind: 'needs-login',
    message:
      'api_call is configured for OAuth login but has no valid cached token. ' +
      `Run in a terminal: npx swagger-digest login --issuer ${config.issuer} --client-id ${config.clientId} — then retry this call.`,
  };
}

export interface InteractiveLoginOptions {
  /** Opens the authorization URL (cli.ts supplies the platform opener). */
  openUrl: (url: string) => void;
  /** Progress messages, e.g. to an ora spinner. */
  log: (message: string) => void;
  timeoutMs?: number;
}

function listenOnRandomPort(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.close();
      reject(error);
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address && typeof address === 'object') resolve(`http://127.0.0.1:${address.port}`);
      else reject(new Error('Local callback listener could not determine its port.'));
    });
  });
}

/** Waits for the authorization redirect; rejects on error params, state mismatch or timeout. */
function waitForCallbackCode(server: Server, state: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for the browser authorization redirect.`),
      );
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      server.close();
    }

    server.on('request', (request, response) => {
      const incoming = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (incoming.pathname !== '/callback') {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('Not found');
        return;
      }
      const error = incoming.searchParams.get('error');
      if (error) {
        response.writeHead(400, { 'content-type': 'text/plain' });
        response.end('Authorization failed — you can close this tab.');
        cleanup();
        reject(
          new Error(
            `Authorization was rejected: ${error}${incoming.searchParams.get('error_description') ? ` (${incoming.searchParams.get('error_description')})` : ''}`,
          ),
        );
        return;
      }
      const code = incoming.searchParams.get('code');
      const returnedState = incoming.searchParams.get('state');
      if (!code || returnedState !== state) {
        response.writeHead(400, { 'content-type': 'text/plain' });
        response.end('Invalid authorization response — you can close this tab.');
        cleanup();
        reject(new Error('Authorization response was invalid (missing code or state mismatch).'));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('Login complete — you can close this tab and return to the terminal.');
      cleanup();
      resolve(code);
    });
  });
}

/**
 * Full interactive login: discovery → local callback listener → browser →
 * code exchange → cache write. Foreground-only: invoked by `swagger-digest login`.
 */
export async function runInteractiveLogin(
  config: OAuthConfig,
  options: InteractiveLoginOptions,
): Promise<{ cacheFile: string }> {
  const issuer = normalizeIssuer(config.issuer);
  options.log(`Discovering ${issuer}/.well-known/openid-configuration…`);
  const discovery = await discoverEndpoints(issuer);

  const callbackServer = createServer();
  const callbackOrigin = await listenOnRandomPort(callbackServer);
  const redirectUri = `${callbackOrigin}/callback`;

  const { verifier, challenge } = createPkcePair();
  const state = createState();
  const authorizeUrl = buildAuthorizeUrl({
    authorizationEndpoint: discovery.authorizationEndpoint,
    clientId: config.clientId,
    redirectUri,
    state,
    challenge,
    scope: config.scope ?? 'openid',
  });

  options.log('Opening your browser for authorization…');
  options.openUrl(authorizeUrl);
  options.log(`If the browser did not open, paste this URL into a browser:\n${authorizeUrl}`);

  const code = await waitForCallbackCode(callbackServer, state, options.timeoutMs ?? 120_000);

  options.log('Exchanging the authorization code for tokens…');
  const tokens = await exchangeAuthorizationCode({
    tokenEndpoint: discovery.tokenEndpoint,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    code,
    verifier,
    redirectUri,
  });

  const cache: TokenCache = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + tokens.expiresInMs,
    scope: tokens.scope,
  };
  const cacheFile = tokenCacheFilePath(issuer, config.clientId);
  await saveTokenCache(cacheFile, cache);
  return { cacheFile };
}
