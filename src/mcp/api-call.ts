import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { fetchWithLimits, type HardenedFetchResult } from '../hardened-fetch.js';
import { estimateTokens } from '../tokens.js';
import { isSensitiveHeaderName, mergeHeaders, parseHeaderArgument, parseHeaderPairs } from '../headers.js';
import { resolveAccessToken, resolveOAuthConfig } from './oauth.js';

/**
 * Arguments of the `api_call` MCP tool.
 *
 * Requests resolve against ONE trusted origin, configured at server start
 * (SWAGGER_DIGEST_API_BASE_URL or an explicit options override). The origin
 * of an OpenAPI specification's `servers` entries is never trusted
 * implicitly: a malicious spec could point at an attacker-controlled host,
 * and configured credentials must never be sent there.
 */
export interface ApiCallArgs {
  /** Absolute URL. Its origin MUST equal the trusted base URL origin. */
  url?: string;
  /** API path (e.g. "/v1/refunds"), resolved against the trusted base URL. */
  path?: string;
  /** HTTP method. Default "get"; writes require SWAGGER_DIGEST_API_METHODS opt-in. */
  method?: string;
  /** Query parameters. Array values are serialized as repeated keys. */
  query?: Record<string, string | number | boolean | Array<string | number | boolean>>;
  /**
   * Extra request headers. Credential-bearing names (authorization, cookie,
   * x-api-key, …) are rejected — authentication comes from the environment.
   */
  headers?: Record<string, string>;
  /** JSON-serializable request body. Only valid for POST/PUT/PATCH/DELETE. */
  body?: unknown;
  /** Trim large response bodies to approximately this token budget. */
  max_tokens?: number;
}

/**
 * Server-wide configuration for `api_call`. Tests pass these explicitly; the
 * stdio entry point derives them from the environment (see resolveApiCallConfig).
 */
export interface ApiCallServerOptions {
  /** Reject URLs resolving to loopback/private/metadata addresses. Defaults to true. */
  blockPrivateNetworks?: boolean;
  /** Trusted API origin. Overrides SWAGGER_DIGEST_API_BASE_URL. */
  baseUrl?: string;
  /** Enabled HTTP methods (lowercase). Overrides SWAGGER_DIGEST_API_METHODS. */
  methods?: string[];
  /** Server-injected authentication headers. Overrides SWAGGER_DIGEST_API_HEADER. */
  authHeaders?: Record<string, string>;
  /** Request timeout in ms. Overrides SWAGGER_DIGEST_API_TIMEOUT_MS (hard max 60 s). */
  timeoutMs?: number;
  /** Maximum response/request body size in bytes. Overrides SWAGGER_DIGEST_API_MAX_BYTES. */
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const HARD_MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MB — live responses, unlike specs, need no 10 MB allowance.

/** Methods api_call can ever be configured to send. */
const ALL_METHODS = new Set(['get', 'head', 'post', 'put', 'patch', 'delete']);
/** Methods that may carry a request body. */
const BODY_METHODS = new Set(['post', 'put', 'patch', 'delete']);

export interface ResolvedApiCallConfig {
  baseUrl: URL;
  methods: Set<string>;
  authHeaders: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  blockPrivateNetworks: boolean;
}

type ResolveResult = { config: ResolvedApiCallConfig; error?: undefined } | { config?: undefined; error: string };

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseMethodsEnv(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Resolves api_call configuration: explicit options win over environment
 * variables (same precedence philosophy as the digest tool's headers).
 * Options are validated too, so test-injected configuration is held to the
 * same rules as production configuration.
 */
export function resolveApiCallConfig(
  options: ApiCallServerOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolveResult {
  const baseUrlRaw = options.baseUrl ?? env.SWAGGER_DIGEST_API_BASE_URL;
  if (baseUrlRaw === undefined || baseUrlRaw.trim() === '') {
    return {
      error:
        'api_call is not configured. Set SWAGGER_DIGEST_API_BASE_URL to the trusted API origin ' +
        '(for example "https://staging.example.com") when starting the MCP server. ' +
        'Requests are only ever sent to this origin — spec-declared server URLs are not trusted implicitly.',
    };
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlRaw);
  } catch {
    return {
      error: `Invalid SWAGGER_DIGEST_API_BASE_URL "${baseUrlRaw}": use an absolute http:// or https:// URL.`,
    };
  }
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    return { error: `Invalid SWAGGER_DIGEST_API_BASE_URL "${baseUrlRaw}": use an http:// or https:// URL.` };
  }

  const methodList = options.methods ?? parseMethodsEnv(env.SWAGGER_DIGEST_API_METHODS) ?? ['get'];
  for (const method of methodList) {
    if (!ALL_METHODS.has(method)) {
      return {
        error: `Unknown method "${method}" in the api_call method list. Allowed: ${[...ALL_METHODS].join(', ')}.`,
      };
    }
  }
  const methods = new Set(methodList);

  let authHeaders: Record<string, string> = {};
  if (options.authHeaders !== undefined) {
    authHeaders = options.authHeaders;
  } else {
    // The header file is read at call time so an external refresher script can
    // rotate credentials (e.g. short-lived Keycloak tokens) without restarting
    // the MCP server. A configured file wins over the inline env var: it is the
    // fresher source by construction.
    const headerFile = env.SWAGGER_DIGEST_API_HEADER_FILE?.trim();
    if (headerFile) {
      let raw: string;
      try {
        raw = readFileSync(headerFile, 'utf8');
      } catch (readError) {
        return {
          error:
            `Could not read SWAGGER_DIGEST_API_HEADER_FILE "${headerFile}": ` +
            `${readError instanceof Error ? readError.message : String(readError)}`,
        };
      }
      const lines = raw.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index]?.trim()) continue;
        try {
          Object.assign(authHeaders, parseHeaderArgument(lines[index] as string));
        } catch (parseError) {
          return {
            error:
              `Invalid SWAGGER_DIGEST_API_HEADER_FILE "${headerFile}" line ${index + 1}: ` +
              `${parseError instanceof Error ? parseError.message : String(parseError)}`,
          };
        }
      }
    } else if (env.SWAGGER_DIGEST_API_HEADER !== undefined) {
      try {
        authHeaders = parseHeaderPairs(env.SWAGGER_DIGEST_API_HEADER);
      } catch (error) {
        return {
          error: `Invalid SWAGGER_DIGEST_API_HEADER: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
  }

  const requestedTimeout =
    options.timeoutMs ?? parsePositiveInt(env.SWAGGER_DIGEST_API_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(requestedTimeout, 1), HARD_MAX_TIMEOUT_MS);
  const maxBytes = options.maxBytes ?? parsePositiveInt(env.SWAGGER_DIGEST_API_MAX_BYTES) ?? DEFAULT_MAX_BYTES;
  const blockPrivateNetworks = options.blockPrivateNetworks ?? env.SWAGGER_DIGEST_ALLOW_PRIVATE !== '1';

  return { config: { baseUrl, methods, authHeaders, timeoutMs, maxBytes, blockPrivateNetworks } };
}

function textContent(text: string): TextContent[] {
  return [{ type: 'text', text }];
}

function asError(message: string): CallToolResult {
  return { content: textContent(message), isError: true };
}

/**
 * Token estimate for live API responses. The shared heuristic is word-based,
 * which badly underestimates JSON payloads with long non-word strings (a
 * 5000-character ID is "one word"), so it is floored by the standard
 * characters/4 approximation for plain text.
 */
function estimateResponseTokens(text: string): number {
  const heuristic = estimateTokens(text).models.claude.tokens;
  return Math.max(heuristic, Math.ceil(text.length / 4));
}

/**
 * Proportional character truncation using the shared token heuristic. The
 * goal is a response that FITS, not a perfect count — same philosophy as the
 * digest auto-trim.
 */
export function trimToTokenBudget(text: string, maxTokens: number): { text: string; trimmed: boolean } {
  const estimated = estimateResponseTokens(text);
  if (estimated <= maxTokens) return { text, trimmed: false };
  const marker = '\n…[response truncated to fit the max_tokens budget]';
  const keep = Math.max(0, Math.floor((text.length * maxTokens) / estimated) - marker.length);
  return { text: text.slice(0, keep) + marker, trimmed: true };
}

/** Replaces every occurrence of configured credential values in response text. */
export function redactSecrets(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 8) result = result.split(secret).join('[REDACTED]');
  }
  return result;
}

/**
 * Runs one API request and renders it as an MCP tool result.
 *
 * Deliberately different from the digest tool: non-2xx HTTP responses are
 * returned as NORMAL results (with status and body), because an error body —
 * a 400 validation message, a 409 conflict — is precisely what an agent needs
 * to see. Only transport-level failures (network, blocked host, timeout) and
 * policy violations (disabled method, foreign origin) become isError results.
 */
export async function runApiCall(
  args: ApiCallArgs,
  options: ApiCallServerOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<CallToolResult> {
  const { config, error } = resolveApiCallConfig(options, env);
  if (error !== undefined || config === undefined) return asError(error ?? 'api_call configuration error.');

  if (args.max_tokens !== undefined && (!Number.isInteger(args.max_tokens) || args.max_tokens <= 0)) {
    return asError(`Invalid max_tokens ${args.max_tokens}: use a positive integer.`);
  }

  const method = (args.method ?? 'get').trim().toLowerCase();
  if (!ALL_METHODS.has(method)) {
    return asError(
      `Unknown method "${method}". Allowed: ${[...ALL_METHODS].join(', ')}. ` +
        'Enabled methods are controlled by SWAGGER_DIGEST_API_METHODS (default: get).',
    );
  }
  if (!config.methods.has(method)) {
    return asError(
      `Method "${method}" is not enabled. Enabled methods: ${[...config.methods].sort().join(', ')}. ` +
        'Write methods require an explicit opt-in: set SWAGGER_DIGEST_API_METHODS (e.g. "get,post") when starting the server.',
    );
  }

  // --- Target URL resolution: the origin check is the security boundary. ---
  let target: URL;
  if (args.url !== undefined && args.path !== undefined) {
    return asError('Provide either `url` or `path`, not both.');
  }
  if (args.url !== undefined) {
    if (!isHttpUrl(args.url)) {
      return asError(`Invalid url "${args.url}": use an http:// or https:// URL.`);
    }
    target = new URL(args.url);
  } else if (typeof args.path === 'string') {
    if (!args.path.startsWith('/')) {
      return asError(
        `Invalid path "${args.path}": paths must start with "/" and are resolved against the configured base URL.`,
      );
    }
    target = new URL(args.path, config.baseUrl);
  } else {
    return asError(
      'Provide a target: `path` (e.g. "/v1/refunds", resolved against SWAGGER_DIGEST_API_BASE_URL) ' +
        'or an absolute `url` on the configured trusted origin.',
    );
  }
  if (target.origin !== config.baseUrl.origin) {
    return asError(
      `Refusing to call ${target.origin}: api_call only sends requests to the configured trusted origin ` +
        `${config.baseUrl.origin} (SWAGGER_DIGEST_API_BASE_URL). Origins declared inside an OpenAPI ` +
        'specification are never trusted implicitly — a malicious spec could otherwise redirect credentials.',
    );
  }

  for (const [key, value] of Object.entries(args.query ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) target.searchParams.append(key, String(item));
    } else {
      target.searchParams.set(key, String(value));
    }
  }

  // --- Request body. ---
  let bodyText: string | undefined;
  if (args.body !== undefined) {
    if (!BODY_METHODS.has(method)) {
      return asError(`Method "${method}" cannot carry a request body.`);
    }
    try {
      bodyText = JSON.stringify(args.body);
    } catch {
      return asError('Invalid body: it must be JSON-serializable.');
    }
    if (bodyText.length > 0 && Buffer.byteLength(bodyText) > config.maxBytes) {
      return asError(
        `Request body is ${Buffer.byteLength(bodyText)} bytes, exceeding the ${config.maxBytes} byte limit ` +
          '(SWAGGER_DIGEST_API_MAX_BYTES).',
      );
    }
  }

  // --- Headers: credentials from the environment only, never from arguments. ---
  for (const name of Object.keys(args.headers ?? {})) {
    if (isSensitiveHeaderName(name)) {
      return asError(
        `Refusing to send "${name}" from tool arguments: authentication headers are injected ` +
          'server-side (SWAGGER_DIGEST_API_HEADER / OAuth) so credentials never enter tool-call transcripts.',
      );
    }
  }

  // OAuth (when configured) supplies the Authorization header from the on-disk
  // token cache, silently refreshing when needed. It never opens a browser.
  const oauthConfig = resolveOAuthConfig(env);
  let secrets = Object.values(config.authHeaders);
  let authHeaders = config.authHeaders;
  if (oauthConfig !== undefined) {
    const token = await resolveAccessToken(oauthConfig, env);
    if (token.kind === 'needs-login' || token.kind === 'error') {
      return asError(token.message);
    }
    // OAuth is the fresher auth source; explicit static auth (e.g. X-Tenant-Id)
    // is preserved on conflicts for non-Authorization names.
    authHeaders = mergeHeaders({ authorization: `Bearer ${token.accessToken}` }, authHeaders);
    secrets = [...secrets, ...token.secrets];
  }

  const requestHeaders = mergeHeaders(authHeaders, args.headers);
  if (bodyText !== undefined) {
    // The serialized body is always JSON; declare it unless the caller did.
    requestHeaders['content-type'] =
      args.headers?.['content-type'] ?? args.headers?.['Content-Type'] ?? 'application/json';
  }

  const warnings: string[] = [];
  let result: HardenedFetchResult;
  try {
    result = await fetchWithLimits(target.toString(), {
      timeoutMs: config.timeoutMs,
      maxBytes: config.maxBytes,
      blockPrivateNetworks: config.blockPrivateNetworks,
      headers: requestHeaders,
      allowedHeaderOrigin: config.baseUrl.origin,
      onCrossOriginHeadersDropped: (origin) =>
        warnings.push(`Request redirected cross-origin to ${origin}; authentication headers were withheld.`),
      method,
      body: bodyText,
      throwOnHttpError: false,
    });
  } catch (requestError) {
    const message = requestError instanceof Error ? requestError.message : String(requestError);
    return asError(`api_call failed: ${message}`);
  }

  // Redact configured credentials and OAuth tokens before anything else touches the body.
  let responseBody = redactSecrets(result.text, secrets);

  let wasTrimmed = false;
  if (args.max_tokens !== undefined) {
    const trimmedResult = trimToTokenBudget(responseBody, args.max_tokens);
    responseBody = trimmedResult.text;
    wasTrimmed = trimmedResult.trimmed;
  }

  const tokens = estimateResponseTokens(responseBody);
  const bytes = Buffer.byteLength(result.text);

  const head: string[] = [`status: ${result.status}${result.statusText ? ` ${result.statusText}` : ''}`];
  head.push(`url: ${result.url}`);
  head.push(`content-type: ${result.contentType || 'unknown'}`);

  const nonOkNote =
    result.status >= 400
      ? `\n\n_Non-OK response returned as a result (not an error) so the body can be inspected._`
      : '';
  const warningBlock = warnings.length > 0 ? `\n\n_Warnings:_\n${warnings.map((w) => `- ${w}`).join('\n')}` : '';
  const metadata =
    `${bytes.toLocaleString('en-US')} bytes · ~${tokens.toLocaleString('en-US')} tokens estimated` +
    (wasTrimmed ? ' · trimmed to max_tokens' : '');

  return {
    content: textContent(
      `${head.join('\n')}\n\n${responseBody}${nonOkNote}\n\n---\n_api_call metadata: ${metadata}_${warningBlock}`,
    ),
  };
}
