import { load } from 'cheerio';
import { parse as parseYaml } from 'yaml';
import type { FetchOptions, FetchResult, JsonObject } from './types.js';
import { isFailFastFetchError } from './errors.js';
import { fetchWithLimits } from './hardened-fetch.js';
import { bundleExternalRefs } from './bundler.js';

const SPEC_FILE_EXTENSION = /\.(?:json|ya?ml)$/i;
const FALLBACK_PATHS = ['/v3/api-docs', '/swagger/v1/swagger.json', '/swagger.json', '/openapi.json', '/api-docs'];

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isOpenApiSpec(value: unknown): value is JsonObject {
  if (!isRecord(value)) return false;
  const hasVersion = typeof value.openapi === 'string' || typeof value.swagger === 'string';
  const hasInfo = isRecord(value.info) && typeof value.info.title === 'string';
  const hasPaths = value.paths === undefined || isRecord(value.paths);
  return hasVersion && hasInfo && hasPaths;
}

/** Parse JSON or YAML and reject arbitrary documents that are not OpenAPI/Swagger specs. */
export function parseSpecText(text: string, source = 'response'): JsonObject {
  const parsers: Array<() => unknown> = [() => JSON.parse(text), () => parseYaml(text)];
  const errors: string[] = [];

  for (const parser of parsers) {
    try {
      const parsed = parser();
      if (isOpenApiSpec(parsed)) return parsed;
      errors.push('document is not a recognizable OpenAPI/Swagger specification');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(`Could not parse OpenAPI spec from ${source}: ${[...new Set(errors)].join('; ')}`);
}

function isDirectSpecUrl(url: URL): boolean {
  return SPEC_FILE_EXTENSION.test(url.pathname);
}

/** Internal fetch settings threaded through every HTTP request the fetcher makes. */
interface FetchContext {
  timeoutMs: number;
  maxBytes?: number;
  maxRedirects?: number;
  blockPrivateNetworks?: boolean;
  headers?: Record<string, string>;
  allowedHeaderOrigin?: string;
  onCrossOriginHeadersDropped?: (origin: string) => void;
}

async function fetchText(url: string, ctx: FetchContext): Promise<{ text: string; contentType: string }> {
  const response = await fetchWithLimits(url, {
    timeoutMs: ctx.timeoutMs,
    maxBytes: ctx.maxBytes,
    maxRedirects: ctx.maxRedirects,
    blockPrivateNetworks: ctx.blockPrivateNetworks,
    headers: ctx.headers,
    allowedHeaderOrigin: ctx.allowedHeaderOrigin,
    onCrossOriginHeadersDropped: ctx.onCrossOriginHeadersDropped,
  });

  return {
    text: response.text,
    contentType: response.contentType,
  };
}

function extractScripts(html: string): { inline: string[]; external: string[] } {
  const $ = load(html);
  const inline: string[] = [];
  const external: string[] = [];
  for (const element of $('script').toArray()) {
    const body = $(element).html();
    if (body?.trim()) inline.push(body);

    const src = $(element).attr('src');
    if (src?.trim()) external.push(src.trim());
  }
  return { inline, external };
}

function extractSpecUrlFromScripts(scripts: string[], pageUrl: URL): string | undefined {
  return extractSpecUrlsFromScripts(scripts, pageUrl)[0];
}

/**
 * Collects every spec URL referenced by Swagger UI configuration scripts, in
 * document order. Covers both the single `url:` property and the multi-spec
 * `urls: [{ url, name }, …]` dropdown array. The first entry that parses as a
 * valid absolute URL wins; relative URLs are resolved against the page URL.
 */
export function extractSpecUrlsFromScripts(scripts: string[], pageUrl: URL): string[] {
  const found: string[] = [];

  const pushCandidate = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.startsWith('data:')) return;
    try {
      const resolved = new URL(trimmed, pageUrl).toString();
      if (!found.includes(resolved)) found.push(resolved);
    } catch {
      // Not resolvable against the page URL; skip.
    }
  };

  for (const script of scripts) {
    // Multi-spec dropdown: urls: [{ url: "...", name: "..." }, ...]
    const urlsArray = findObjectLiteralArrayAfterKey(script, 'urls');
    if (urlsArray) {
      const entryPattern = /\burl\s*:\s*(["'])(.*?)\1/gs;
      for (const match of urlsArray.matchAll(entryPattern)) {
        pushCandidate(match[2] ?? '');
      }
    }

    // Single `url:` property (skipped when a `urls:` array takes precedence,
    // because Swagger UI ignores `url` whenever `urls` is present).
    if (!urlsArray) {
      const urlPattern = /\burl\s*:\s*(["'])(.*?)\1/s;
      const match = urlPattern.exec(script);
      if (match?.[2]) pushCandidate(match[2]);
    }
  }
  return found;
}

/**
 * Finds the array literal following `key:` in a script, tolerating JS comments
 * and string escapes. Returns the raw `[...]` text or undefined.
 */
function findObjectLiteralArrayAfterKey(source: string, key: string): string | undefined {
  const keyPattern = new RegExp(`\\b${key}\\s*:`);
  const match = keyPattern.exec(source);
  if (!match) return undefined;

  let index = match.index + match[0].length;
  while (/\s/.test(source[index] ?? '')) index += 1;
  if (source[index] !== '[') return undefined;

  const start = index;
  let depth = 0;
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (; index < source.length; index += 1) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return undefined;
}

/** All spec URLs referenced by scripts (document order) plus the ?url= query parameter. */
function extractSpecUrls(scripts: string[], pageUrl: URL): string[] {
  const fromScripts = extractSpecUrlsFromScripts(scripts, pageUrl);

  // Some deployments pass the spec URL using Swagger UI's `?url=` query parameter.
  const queryUrl = pageUrl.searchParams.get('url');
  if (queryUrl) {
    try {
      const resolved = new URL(queryUrl, pageUrl).toString();
      if (!fromScripts.includes(resolved)) fromScripts.push(resolved);
    } catch {
      // Invalid query value; common fallback paths will still be attempted.
    }
  }
  return fromScripts;
}

/**
 * Probes candidate spec URLs in list order, in small concurrent batches. The
 * winner is the first candidate in list order that parsed — deterministic
 * regardless of response timing. When several definitions exist (Swagger UI
 * multi-spec `urls:` dropdown), a notice names the one that was used.
 */
async function probeSpecUrls(
  candidates: string[],
  ctx: FetchContext,
  recordFailure: (label: string, error: unknown, subject?: string) => void,
  onMultiple?: (picked: string, all: string[]) => void,
): Promise<FetchResult | undefined> {
  if (candidates.length === 0) return undefined;
  if (candidates.length > 1) {
    onMultiple?.(candidates[0] ?? '', candidates);
  }
  const batchSize = 4;
  for (let start = 0; start < candidates.length; start += batchSize) {
    const batch = candidates.slice(start, start + batchSize);
    const attempts = await Promise.all(
      batch.map(async (candidate) => {
        try {
          return { candidate, spec: await tryFetchSpec(candidate, ctx) };
        } catch (error) {
          return { candidate, error: error as unknown };
        }
      }),
    );
    const winner = attempts.find(
      (attempt): attempt is { candidate: string; spec: JsonObject } => attempt.spec !== undefined,
    );
    if (winner) {
      return { spec: winner.spec, sourceUrl: winner.candidate, retrievalMethod: 'html-config' };
    }
    for (const attempt of attempts) {
      recordFailure('Configured spec', attempt.error, attempt.candidate);
    }
  }
  return undefined;
}

async function fetchExternalConfigScripts(
  srcs: string[],
  pageUrl: URL,
  ctx: FetchContext,
  errors: string[],
): Promise<string[]> {
  const candidates = srcs
    .map((src) => {
      try {
        return new URL(src, pageUrl);
      } catch {
        return undefined;
      }
    })
    // Swagger UI's runtime config is expected on the page's origin. Ignore third-party
    // bundles and analytics scripts; they cannot describe the protected API reliably.
    .filter((url): url is URL => Boolean(url && url.origin === pageUrl.origin && /\.m?js(?:$|[?#])/i.test(url.href)));

  const priority = (url: URL): number =>
    /swagger[-_]?initializer|swagger[-_]?config|swagger[-_]?ui[-_]?init|openapi[-_]?config|(?:^|[\/_-])config(?:[._/-]|$)/i.test(
      url.pathname,
    )
      ? 0
      : 1;
  candidates.sort((a, b) => priority(a) - priority(b));

  const scripts: string[] = [];
  // Avoid fetching every large JavaScript bundle on complicated pages. The initializer
  // normally contains the spec URL; the first few local scripts cover common variants.
  for (const candidate of candidates.slice(0, 10)) {
    try {
      const response = await fetchText(candidate.toString(), ctx);
      scripts.push(response.text);
      if (
        extractSpecUrlFromScripts(scripts, pageUrl) ||
        scripts.some((script) => findObjectLiteralAfterKey(script, 'spec'))
      ) {
        break;
      }
    } catch (error) {
      errors.push(`Swagger UI script (${candidate}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return scripts;
}

function getFallbackUrls(pageUrl: URL): string[] {
  // Try the Swagger UI's app-relative directory as well as known root-level paths.
  // Many APIs are deployed under a context path such as /appsContentManagement/api/.
  const relativePaths = [
    './v3/api-docs',
    './swagger/v1/swagger.json',
    './swagger.json',
    './openapi.json',
    './api-docs',
    './doc.json',
    '../v3/api-docs',
    '../swagger/v1/swagger.json',
    '../swagger.json',
    '../openapi.json',
    '../api-docs',
  ];
  const absolutePaths = [...relativePaths, ...FALLBACK_PATHS];
  return [...new Set(absolutePaths.map((path) => new URL(path, pageUrl).toString()))];
}

function formatAttemptErrors(errors: string[]): string {
  if (errors.length <= 10) return errors.join('\n  - ');
  // Preserve the first failures (especially the original page request) and the last
  // failures (usually browser fallback), instead of silently hiding the root cause.
  const visible = [...errors.slice(0, 6), `… ${errors.length - 9} additional attempts omitted …`, ...errors.slice(-3)];
  return visible.join('\n  - ');
}

function findObjectLiteralAfterKey(source: string, key: string): string | undefined {
  const keyPattern = new RegExp(`\\b${key}\\s*:`);
  const match = keyPattern.exec(source);
  if (!match) return undefined;

  let index = match.index + match[0].length;
  while (/\s/.test(source[index] ?? '')) index += 1;
  if (source[index] !== '{') return undefined;

  const start = index;
  let depth = 0;
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (; index < source.length; index += 1) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  return undefined;
}

function parseInlineObjectLiteral(literal: string): JsonObject | undefined {
  const candidates = [
    () => JSON.parse(literal),
    () => parseYaml(literal),
    // Swagger config often uses JS object syntax with trailing commas.
    () => JSON.parse(literal.replace(/,\s*([}\]])/g, '$1')),
  ];

  for (const parse of candidates) {
    try {
      const result: unknown = parse();
      if (isOpenApiSpec(result)) return result;
    } catch {
      // Try the next parser.
    }
  }
  return undefined;
}

function extractInlineSpec(scripts: string[]): JsonObject | undefined {
  for (const script of scripts) {
    // Supports `spec: { ... }` configurations without relying on a fragile nested-brace regex.
    const literal = findObjectLiteralAfterKey(script, 'spec');
    if (!literal) continue;
    const spec = parseInlineObjectLiteral(literal);
    if (spec) return spec;
  }
  return undefined;
}

async function tryFetchSpec(url: string, ctx: FetchContext): Promise<JsonObject> {
  const response = await fetchText(url, ctx);
  const parsed = parseSpecText(response.text, url);
  // Best-effort bundling of external $ref documents. Any failure leaves the
  // refs untouched; the transformer degrades them to named identifiers.
  try {
    return await bundleExternalRefs(parsed, url, async (docUrl) => (await fetchText(docUrl, ctx)).text);
  } catch {
    return parsed;
  }
}

/**
 * Decides, for a browser request, which headers to send. Playwright routes every
 * request through this handler: headers are attached only when the request's
 * origin equals the user-supplied URL's origin, so tokens never reach CDNs or
 * other third parties.
 */
export function headersForBrowserRequest(
  requestUrl: string,
  headers: Record<string, string> | undefined,
  allowedOrigin: string,
): Record<string, string> | undefined {
  if (!headers || Object.keys(headers).length === 0) return undefined;
  let requestOrigin: string;
  try {
    requestOrigin = new URL(requestUrl).origin;
  } catch {
    return undefined;
  }
  return requestOrigin === allowedOrigin ? headers : undefined;
}

/** Minimal structural types for the optional Playwright integration (kept any-free). */
interface BrowserRouteRequest {
  url: () => string;
  headers: () => Record<string, string>;
}
interface BrowserRoute {
  request: () => BrowserRouteRequest;
  continue: (options?: { headers?: Record<string, string> }) => Promise<unknown>;
}
interface BrowserPage {
  route: (pattern: string, handler: (route: BrowserRoute) => Promise<void>) => Promise<unknown>;
  goto: (url: string, options?: { waitUntil?: string; timeout?: number }) => Promise<unknown>;
  waitForFunction: (predicate: () => boolean, arg?: unknown, options?: { timeout: number }) => Promise<void>;
  evaluate: <T>(pageFunction: () => T) => Promise<T>;
}
interface Browser {
  newPage: () => Promise<BrowserPage>;
  close: () => Promise<unknown>;
}
interface PlaywrightModule {
  chromium: { launch: (options: { headless: boolean }) => Promise<Browser> };
}

/** The subset of the Swagger UI browser globals the fallback inspects. */
interface SwaggerUiWindow {
  ui?: {
    spec?: () => { openapi?: unknown; swagger?: unknown; toJSON?: () => unknown };
    getSystem?: () => {
      specSelectors?: { specJson?: () => unknown };
    };
  };
  swaggerDoc?: { openapi?: unknown; swagger?: unknown };
}

async function tryBrowserFallback(pageUrl: string, headers?: Record<string, string>): Promise<JsonObject> {
  let playwright: PlaywrightModule;
  try {
    const optionalModuleName: string = 'playwright';
    playwright = (await import(optionalModuleName)) as PlaywrightModule;
  } catch {
    throw new Error(
      'Headless fallback needs optional Playwright. Install it with `npm install playwright` and `npx playwright install chromium`, then rerun.',
    );
  }

  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    // Route-based header injection (NOT context-wide extraHTTPHeaders): custom
    // headers are attached only to requests whose origin matches the page the
    // user asked for, so credentials never reach CDNs or third-party scripts.
    const allowedOrigin = new URL(pageUrl).origin;
    if (headers && Object.keys(headers).length > 0) {
      const browserHeaders = Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
      );
      await page.route('**/*', async (route) => {
        const extra = headersForBrowserRequest(route.request().url(), browserHeaders, allowedOrigin);
        if (!extra) {
          await route.continue();
          return;
        }
        await route.continue({ headers: { ...route.request().headers(), ...extra } });
      });
    }

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page
      .waitForFunction(
        () => {
          const w = window as unknown as SwaggerUiWindow;
          try {
            const candidate = w.ui?.spec?.();
            const document = candidate && typeof candidate.toJSON === 'function' ? candidate.toJSON() : candidate;
            const doc = document as { openapi?: unknown; swagger?: unknown } | undefined;
            return Boolean(doc?.openapi || doc?.swagger || w.swaggerDoc?.openapi || w.swaggerDoc?.swagger);
          } catch {
            return Boolean(w.swaggerDoc?.openapi || w.swaggerDoc?.swagger);
          }
        },
        undefined,
        { timeout: 8_000 },
      )
      .catch(() => undefined);

    const extracted: unknown = await page.evaluate(() => {
      const w = window as unknown as SwaggerUiWindow;
      try {
        const spec = w.ui?.spec?.();
        if (spec) {
          const json = typeof spec.toJSON === 'function' ? spec.toJSON() : spec;
          if (json && typeof json === 'object') return json;
        }
      } catch {
        // Try the other known Swagger UI stores below.
      }
      if (w.swaggerDoc && typeof w.swaggerDoc === 'object') return w.swaggerDoc;
      try {
        const state = w.ui?.getSystem?.().specSelectors?.specJson?.() as { toJS?: () => unknown } | undefined;
        if (state) return typeof state.toJS === 'function' ? state.toJS() : state;
      } catch {
        // No spec in this Swagger UI build.
      }
      return null;
    });

    if (!isOpenApiSpec(extracted)) {
      throw new Error('The page loaded in a browser, but no parsed OpenAPI spec was exposed by Swagger UI.');
    }
    return extracted;
  } finally {
    await browser.close();
  }
}

/** Resolve a Swagger UI page or a direct OpenAPI JSON/YAML URL into a parsed spec. */
export async function fetchOpenApiSpec(input: string, options: FetchOptions = {}): Promise<FetchResult> {
  let pageUrl: URL;
  try {
    pageUrl = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }
  if (!['http:', 'https:'].includes(pageUrl.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are supported.');
  }

  const timeoutMs = options.timeoutMs ?? 15_000;
  const ctx: FetchContext = {
    timeoutMs,
    maxBytes: options.maxBytes,
    maxRedirects: options.maxRedirects,
    blockPrivateNetworks: options.blockPrivateNetworks,
    allowedHeaderOrigin: pageUrl.origin,
    headers: options.headers,
    onCrossOriginHeadersDropped: (origin) =>
      options.warn?.(
        `Custom headers were withheld: ${origin} is a different origin from the URL you supplied. Only tool defaults were sent.`,
      ),
  };
  const errors: string[] = [];
  /** Records an attempt failure, unless the error kind makes all further attempts pointless. */
  const recordFailure = (label: string, error: unknown, subject?: string): void => {
    if (isFailFastFetchError(error)) throw error;
    const prefix = subject ? `${label} (${subject}):` : `${label}:`;
    errors.push(`${prefix} ${error instanceof Error ? error.message : String(error)}`);
  };

  if (isDirectSpecUrl(pageUrl)) {
    try {
      const spec = await tryFetchSpec(pageUrl.toString(), ctx);
      return { spec, sourceUrl: pageUrl.toString(), retrievalMethod: 'direct-spec' };
    } catch (error) {
      recordFailure('Direct spec', error);
    }
  }

  // An explicit --spec URL overrides all discovery: try it before anything else.
  if (options.specUrl) {
    try {
      const spec = await tryFetchSpec(options.specUrl, ctx);
      return { spec, sourceUrl: options.specUrl, retrievalMethod: 'direct-spec' };
    } catch (error) {
      recordFailure('Specified spec (--spec)', error, options.specUrl);
    }
  }

  let html: string | undefined;
  try {
    const response = await fetchText(pageUrl.toString(), ctx);
    // Handles endpoints that serve JSON/YAML without an extension, such as /v3/api-docs.
    try {
      const spec = parseSpecText(response.text, pageUrl.toString());
      return { spec, sourceUrl: pageUrl.toString(), retrievalMethod: 'direct-spec' };
    } catch {
      html = response.text;
    }
  } catch (error) {
    recordFailure('Swagger UI page', error);
  }

  if (html !== undefined) {
    const pageScripts = extractScripts(html);
    const scripts = pageScripts.inline;

    const inlineSpec = extractInlineSpec(scripts);
    if (inlineSpec) {
      return { spec: inlineSpec, sourceUrl: pageUrl.toString(), retrievalMethod: 'inline-spec' };
    }

    const noteMultiple = (picked: string, all: string[]): void => {
      if (all.length > 1) {
        options.warn?.(
          `Multiple spec definitions found (${String(all.length)}); using ${picked}. Others: ${all
            .filter((url) => url !== picked)
            .join(', ')}.`,
        );
      }
    };

    // Spec URLs from inline config first — no extra fetches needed when present.
    const fromInline = await probeSpecUrls(extractSpecUrls(scripts, pageUrl), ctx, recordFailure, noteMultiple);
    if (fromInline) return fromInline;

    // Swagger UI commonly keeps its config in a separate swagger-initializer.js
    // rather than inline in index.html. Fetch those same-origin scripts and inspect them.
    const externalScripts = await fetchExternalConfigScripts(pageScripts.external, pageUrl, ctx, errors);
    const inlineUrls = extractSpecUrls(scripts, pageUrl);
    const externalUrls = extractSpecUrls(externalScripts, pageUrl).filter((url) => !inlineUrls.includes(url));
    const fromExternal = await probeSpecUrls([...inlineUrls, ...externalUrls], ctx, recordFailure, noteMultiple);
    if (fromExternal) return fromExternal;

    for (const script of scripts) {
      const literal = findObjectLiteralAfterKey(script, 'spec');
      if (!literal) continue;
      const spec = parseInlineObjectLiteral(literal);
      if (spec) return { spec, sourceUrl: pageUrl.toString(), retrievalMethod: 'inline-spec' };
    }
  }

  // Probe fallback paths in small concurrent batches. The winner is the first
  // candidate in list order that succeeded — not the first to respond — so the
  // result stays deterministic regardless of response timing. Errors are
  // aggregated in list order, not completion order.
  const probeCtx: FetchContext = { ...ctx, timeoutMs: options.probeTimeoutMs ?? 5_000 };
  const candidates = getFallbackUrls(pageUrl);
  const probeBatchSize = 4;
  for (let start = 0; start < candidates.length; start += probeBatchSize) {
    const batch = candidates.slice(start, start + probeBatchSize);
    const attempts = await Promise.all(
      batch.map(async (candidate) => {
        try {
          return { candidate, spec: await tryFetchSpec(candidate, probeCtx) };
        } catch (error) {
          return { candidate, error: error as unknown };
        }
      }),
    );
    // Deterministic winner: first success in candidate list order.
    const winner = attempts.find(
      (attempt): attempt is { candidate: string; spec: JsonObject } => attempt.spec !== undefined,
    );
    if (winner) {
      return { spec: winner.spec, sourceUrl: winner.candidate, retrievalMethod: 'fallback-path' };
    }
    for (const attempt of attempts) {
      recordFailure(attempt.candidate, attempt.error);
    }
  }
  if (options.useBrowserFallback !== false) {
    try {
      const spec = await tryBrowserFallback(pageUrl.toString(), ctx.headers);
      return { spec, sourceUrl: pageUrl.toString(), retrievalMethod: 'headless-browser' };
    } catch (error) {
      errors.push(`Headless browser: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const details = formatAttemptErrors(errors);
  throw new Error(
    `Unable to extract an OpenAPI definition from ${input}.\n  - ${details}\n\nCheck that the URL is reachable from this terminal and points to a Swagger UI page or OpenAPI spec. If it opens only in a browser, verify that your VPN applies to terminal applications (browser VPN extensions do not automatically route Node.js requests). For JavaScript-only Swagger UI deployments, install Playwright and its Chromium browser; Playwright will also need the same network/VPN access.`,
  );
}
