import { load } from 'cheerio';
import { parse as parseYaml } from 'yaml';
import type { FetchOptions, FetchResult, JsonObject } from './types.js';

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

async function fetchText(url: string, timeoutMs: number): Promise<{ text: string; contentType: string }> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json, application/yaml, text/yaml, text/plain, text/html;q=0.8, */*;q=0.5',
      'user-agent': 'swagger-digest/0.1.0',
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }

  return {
    text: await response.text(),
    contentType: response.headers.get('content-type') ?? '',
  };
}

function extractScripts(html: string): { inline: string[]; external: string[] } {
  const $ = load(html);
  const inline: string[] = [];
  const external: string[] = [];
  $('script').each((_index: number, element: any) => {
    const body = $(element).html();
    if (body?.trim()) inline.push(body);

    const src = $(element).attr('src');
    if (src?.trim()) external.push(src.trim());
  });
  return { inline, external };
}

function extractSpecUrlFromScripts(scripts: string[], pageUrl: URL): string | undefined {
  // Swagger UI configuration is commonly in an inline script or an external
  // swagger-initializer.js file. The first non-empty `url` property wins.
  const urlPattern = /\burl\s*:\s*(["'])(.*?)\1/s;

  for (const script of scripts) {
    const match = urlPattern.exec(script);
    if (!match?.[2]) continue;
    const candidate = match[2].trim();
    if (!candidate || candidate.startsWith('data:')) continue;
    try {
      return new URL(candidate, pageUrl).toString();
    } catch {
      // Continue looking through any other configuration scripts.
    }
  }
  return undefined;
}

function extractSpecUrl(scripts: string[], pageUrl: URL): string | undefined {
  const fromScript = extractSpecUrlFromScripts(scripts, pageUrl);
  if (fromScript) return fromScript;

  // Some deployments pass the spec URL using Swagger UI's `?url=` query parameter.
  const queryUrl = pageUrl.searchParams.get('url');
  if (queryUrl) {
    try {
      return new URL(queryUrl, pageUrl).toString();
    } catch {
      // Invalid query value; common fallback paths will still be attempted.
    }
  }
  return undefined;
}

async function fetchExternalConfigScripts(
  srcs: string[],
  pageUrl: URL,
  timeoutMs: number,
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
      const response = await fetchText(candidate.toString(), timeoutMs);
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

async function tryFetchSpec(url: string, timeoutMs: number): Promise<JsonObject> {
  const response = await fetchText(url, timeoutMs);
  return parseSpecText(response.text, url);
}

async function tryBrowserFallback(pageUrl: string): Promise<JsonObject> {
  let playwright: { chromium: any };
  try {
    const optionalModuleName: string = 'playwright';
    playwright = (await import(optionalModuleName)) as { chromium: any };
  } catch {
    throw new Error(
      'Headless fallback needs optional Playwright. Install it with `npm install playwright` and `npx playwright install chromium`, then rerun.',
    );
  }

  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page
      .waitForFunction(
        () => {
          const w = window as any;
          try {
            const candidate = w.ui?.spec?.();
            const document = candidate && typeof candidate.toJSON === 'function' ? candidate.toJSON() : candidate;
            return Boolean(document?.openapi || document?.swagger || w.swaggerDoc?.openapi || w.swaggerDoc?.swagger);
          } catch {
            return Boolean(w.swaggerDoc?.openapi || w.swaggerDoc?.swagger);
          }
        },
        undefined,
        { timeout: 8_000 },
      )
      .catch(() => undefined);

    const extracted: unknown = await page.evaluate(() => {
      const w = window as any;
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
        const state = w.ui?.getSystem?.().specSelectors?.specJson?.();
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
  const errors: string[] = [];

  if (isDirectSpecUrl(pageUrl)) {
    try {
      const spec = await tryFetchSpec(pageUrl.toString(), timeoutMs);
      return { spec, sourceUrl: pageUrl.toString(), retrievalMethod: 'direct-spec' };
    } catch (error) {
      errors.push(`Direct spec: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let html: string | undefined;
  try {
    const response = await fetchText(pageUrl.toString(), timeoutMs);
    // Handles endpoints that serve JSON/YAML without an extension, such as /v3/api-docs.
    try {
      const spec = parseSpecText(response.text, pageUrl.toString());
      return { spec, sourceUrl: pageUrl.toString(), retrievalMethod: 'direct-spec' };
    } catch {
      html = response.text;
    }
  } catch (error) {
    errors.push(`Swagger UI page: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (html !== undefined) {
    const pageScripts = extractScripts(html);
    let scripts = pageScripts.inline;
    let specUrl = extractSpecUrl(scripts, pageUrl);

    const inlineSpec = extractInlineSpec(scripts);
    if (inlineSpec) {
      return { spec: inlineSpec, sourceUrl: pageUrl.toString(), retrievalMethod: 'inline-spec' };
    }

    if (specUrl) {
      try {
        const spec = await tryFetchSpec(specUrl, timeoutMs);
        return { spec, sourceUrl: specUrl, retrievalMethod: 'html-config' };
      } catch (error) {
        errors.push(`Configured spec (${specUrl}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Swagger UI commonly keeps its config in a separate swagger-initializer.js
    // rather than inline in index.html. Fetch those same-origin scripts and inspect them.
    const externalScripts = await fetchExternalConfigScripts(pageScripts.external, pageUrl, timeoutMs, errors);
    scripts = [...scripts, ...externalScripts];
    specUrl = extractSpecUrl(scripts, pageUrl);
    if (specUrl && specUrl !== pageUrl.searchParams.get('url')) {
      try {
        const spec = await tryFetchSpec(specUrl, timeoutMs);
        return { spec, sourceUrl: specUrl, retrievalMethod: 'html-config' };
      } catch (error) {
        errors.push(`Configured spec (${specUrl}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    for (const script of scripts) {
      const literal = findObjectLiteralAfterKey(script, 'spec');
      if (!literal) continue;
      const spec = parseInlineObjectLiteral(literal);
      if (spec) return { spec, sourceUrl: pageUrl.toString(), retrievalMethod: 'inline-spec' };
    }
  }

  for (const candidate of getFallbackUrls(pageUrl)) {
    try {
      const spec = await tryFetchSpec(candidate, timeoutMs);
      return { spec, sourceUrl: candidate, retrievalMethod: 'fallback-path' };
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (options.useBrowserFallback !== false) {
    try {
      const spec = await tryBrowserFallback(pageUrl.toString());
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
