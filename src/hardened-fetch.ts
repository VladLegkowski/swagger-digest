import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BlockedNetworkError, FetchError, FetchHttpError, FetchNetworkError, FetchSizeError } from './errors.js';
import { USER_AGENT } from './version.js';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_REDIRECTS = 5;

export interface HardenedFetchOptions {
  timeoutMs: number;
  /** Maximum response body size in bytes. Default 10 MB. */
  maxBytes?: number;
  /** Maximum number of redirects followed manually. Default 5. */
  maxRedirects?: number;
  /**
   * Opt-in protection against SSRF-style access to internal networks. When
   * true, the hostname is resolved before each request and loopback,
   * link-local, private and cloud-metadata addresses are rejected, including
   * after redirects.
   *
   * Limitation: the DNS result is checked once per request and the actual TCP
   * connection happens afterwards, so a malicious authoritative DNS server can
   * still return a different address between check and connect (TOCTOU DNS
   * rebinding). This check is a guard rail, not a sandbox.
   */
  blockPrivateNetworks?: boolean;
  /**
   * Extra headers to send. They are only transmitted when the request origin
   * equals `allowedHeaderOrigin`, so credentials never leak to other hosts —
   * including across manually followed redirects.
   */
  headers?: Record<string, string>;
  /** The only origin allowed to receive `headers`. */
  allowedHeaderOrigin?: string;
  /** Called when headers were withheld because a hop crossed origins. */
  onCrossOriginHeadersDropped?: (origin: string) => void;
}

export interface HardenedFetchResult {
  text: string;
  contentType: string;
  status: number;
  /** Final URL after redirects. */
  url: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Checks whether an IP address is loopback, link-local, private, or otherwise
 * internal (including the cloud-metadata address 169.254.169.254).
 * IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are checked against the IPv4 list.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIPv4(address);

  if (family === 6) {
    const normalized = address.toLowerCase();
    // IPv4-mapped IPv6 (::ffff:0:0/96) — inspect the embedded IPv4 address.
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateIPv4(mapped[1]);
    if (normalized === '::1' || normalized === '::') return true;
    // fc00::/7 unique-local (fc00::–fdff::)
    if (/^f[cd][0-9a-f]{2}(?::|$)/.test(normalized)) return true;
    // fe80::/10 link-local (fe80::–febf::)
    if (/^fe[89ab][0-9a-f](?::|$)/.test(normalized)) return true;
    return false;
  }
  // Not a parseable IP literal; treat as private so unknown formats fail closed.
  return true;
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 ("this network")
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  return false;
}

/** Resolves the hostname and rejects private, loopback and metadata addresses. */
export async function assertPublicHost(hostname: string): Promise<void> {
  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) {
      throw new BlockedNetworkError(
        `Blocked request to private network address (host resolved to a loopback/private/metadata address). Enable this only for hosts you trust; use it against internal corporate APIs without this option.`,
      );
    }
    return;
  }
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new FetchNetworkError(
      `DNS resolution failed for ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!addresses.length) {
    throw new FetchNetworkError(`DNS resolution returned no addresses for ${hostname}`);
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new BlockedNetworkError(
        `Blocked request to ${hostname}: it resolves to a private/loopback/metadata address while blockPrivateNetworks is enabled.`,
      );
    }
  }
}

function normalizeHeaders(headers?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
}

/**
 * Hardened fetch: manual redirect handling with a cap, per-hop private-network
 * checks, response size enforcement that does not trust content-length, and
 * origin-scoped headers. All internal swagger-digest fetches go through here.
 */
export async function fetchWithLimits(url: string, options: HardenedFetchOptions): Promise<HardenedFetchResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  // Tool defaults (accept + user-agent) are always safe to send. User-supplied
  // headers are kept separate so they can be withheld on other origins.
  const defaultHeaders = normalizeHeaders({
    accept: 'application/json, application/yaml, text/yaml, text/plain, text/html;q=0.8, */*;q=0.5',
    'user-agent': USER_AGENT,
  });
  const userHeaders = normalizeHeaders(options.headers ?? {});

  return await follow(url, defaultHeaders, userHeaders, options, maxBytes, maxRedirects);
}

async function follow(
  url: string,
  defaultHeaders: Record<string, string>,
  userHeaders: Record<string, string>,
  options: HardenedFetchOptions,
  maxBytes: number,
  redirectsLeft: number,
): Promise<HardenedFetchResult> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new FetchNetworkError(`Invalid URL: ${url}`);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new FetchNetworkError(`Only HTTP and HTTPS URLs are supported: ${url}`);
  }

  if (options.blockPrivateNetworks) {
    await assertPublicHost(target.hostname);
  }

  // Headers are scoped to the allowed origin. On any other origin (including
  // after a cross-origin redirect) only the tool defaults are sent.
  const sameOrigin = !options.allowedHeaderOrigin || !options.headers || target.origin === options.allowedHeaderOrigin;
  if (!sameOrigin && options.allowedHeaderOrigin && options.headers && Object.keys(options.headers).length > 0) {
    options.onCrossOriginHeadersDropped?.(target.origin);
  }
  const requestHeaders: Record<string, string> = sameOrigin ? { ...defaultHeaders, ...userHeaders } : defaultHeaders;

  const controller = new AbortController();
  const timeout = AbortSignal.timeout(options.timeoutMs);
  timeout.addEventListener('abort', () => controller.abort(), { once: true });

  let response: Response;
  try {
    response = await fetch(target, {
      headers: requestHeaders,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof FetchError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new FetchNetworkError(`Request to ${target} failed: ${describeNetworkError(reason)}`);
  }

  if (REDIRECT_STATUSES.has(response.status)) {
    const location = response.headers.get('location');
    if (!location) {
      throw new FetchNetworkError(`Redirect response without a Location header from ${target}`);
    }
    if (redirectsLeft <= 0) {
      throw new FetchNetworkError(`Too many redirects (limit ${options.maxRedirects ?? 5}) while fetching ${url}`);
    }
    // Drain the (tiny) redirect body before moving on.
    try {
      await response.arrayBuffer();
    } catch {
      // Body is irrelevant for redirects.
    }
    const next = new URL(response.headers.get('location') ?? '', target);
    return follow(next.toString(), defaultHeaders, userHeaders, options, maxBytes, redirectsLeft - 1);
  }

  if (!response.ok) {
    await discardBodySafely(response);
    throw new FetchHttpError(`HTTP ${response.status} ${response.statusText} for ${url}`, response.status);
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await discardBodySafely(response);
      throw new FetchSizeError(
        `Response from ${target} is ${declared} bytes, exceeding the ${maxBytes} byte limit (content-length). Increase --max-bytes if the spec is genuinely large.`,
      );
    }
  }

  const text = await readBodyWithCap(response, target.toString(), maxBytes);
  return {
    text,
    contentType: response.headers.get('content-type') ?? '',
    status: response.status,
    url: target.toString(),
  };
}

function describeNetworkError(reason: string): string {
  if (/timeouterror|timed out|aborted/i.test(reason)) return 'request timed out';
  if (/enotfound|getaddrinfo/i.test(reason)) return 'host not found (DNS)';
  if (/econnrefused/i.test(reason)) return 'connection refused';
  return reason;
}

async function readBodyWithCap(response: Response, url: string, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total > maxBytes) {
        // A missing or lying content-length cannot bypass the cap: enforce it
        // while streaming. Cancel the stream to stop further transfer.
        try {
          await body.cancel();
        } catch {
          // Body may already be closed.
        }
        throw new FetchSizeError(
          `Response body from ${url} exceeded the ${maxBytes} byte limit while streaming (content-length was ${response.headers.get('content-length') ?? 'not declared'}). Use --max-bytes to raise the cap if the spec is genuinely large.`,
        );
      }
    }
  } catch (error) {
    if (error instanceof FetchSizeError) throw error;
    throw new FetchNetworkError(`Failed to read response body from ${url}: ${describeNetworkError(String(error))}`);
  }
  const decoder = new TextDecoder('utf-8');
  const parts: string[] = [];
  for (const chunk of chunks) parts.push(decoder.decode(chunk, { stream: true }));
  parts.push(decoder.decode());
  return parts.join('');
}

async function discardBodySafely(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // The body of an error response is irrelevant.
  }
}
