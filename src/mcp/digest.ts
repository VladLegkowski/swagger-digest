import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
import { fetchOpenApiSpec } from '../fetcher.js';
import type { FetchOptions } from '../types.js';
import type { JsonObject } from '../types.js';
import { transformOpenApiToMarkdown } from '../transformer.js';
import { estimateTokens } from '../tokens.js';
import { mergeHeaders, parseHeaderPairs } from '../headers.js';
import { writeDigest } from '../writer.js';

/** Arguments of the `swagger_digest` MCP tool (mirrors the zod schema in server.ts). */
export interface McpDigestArgs {
  /** Swagger UI page URL or direct OpenAPI spec URL. */
  url: string;
  /** Explicit spec URL; overrides discovery from the Swagger UI page. */
  spec_url?: string;
  /** Request headers (e.g. Authorization). Sent only to the origin of `url`. */
  headers?: Record<string, string>;
  /** Keep only operations carrying at least one of these tags. */
  include_tags?: string[];
  /** Drop operations carrying any of these tags. */
  exclude_tags?: string[];
  /** Keep only operations whose path starts with this prefix. */
  path_prefix?: string;
  /** Trim the digest until the approximate token estimate fits this budget. */
  max_tokens?: number;
  /**
   * Auto-trim digests exceeding the 250,000-token default budget when
   * max_tokens is not given. Defaults to true.
   */
  auto_trim?: boolean;
  /** Save the digest to a file instead of returning it inline. */
  write_to_file?: { directory: string; filename: string };
}

/**
 * Server-wide behavior switches. Tests pass these explicitly; the stdio entry
 * point derives them from the environment.
 */
export interface DigestServerOptions {
  /**
   * Reject URLs resolving to loopback/private/metadata addresses. Defaults to
   * true: an MCP client supplies URLs on the model's behalf, which is exactly
   * the "server that accepts user-supplied URLs" case from the security notes.
   * Users can opt out per deployment with SWAGGER_DIGEST_ALLOW_PRIVATE=1.
   */
  blockPrivateNetworks?: boolean;
  /**
   * When present, the api_call tool on this server is configured for the given
   * trusted origin. The digest result then tells the agent (and user) that live
   * execution is available and which service prefix spec paths need.
   */
  apiCallHint?: { trustedOrigin: string; methods: string[] };
}

/** Digests whose estimate exceeds this many tokens get a budget hint appended. */
const TOKEN_HINT_THRESHOLD = 80_000;

function textContent(text: string): TextContent[] {
  return [{ type: 'text', text }];
}

function asError(message: string): CallToolResult {
  return { content: textContent(message), isError: true };
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
 * Counts operations and models from the rendered digest (not the source spec),
 * so the metadata reflects the filtered/trimmed output the caller receives.
 */
function countDigestOperations(markdown: string): number {
  return (markdown.match(/^\| \*\*(?:GET|PUT|POST|DELETE|OPTIONS|HEAD|PATCH|TRACE)\*\* \|/gm) ?? []).length;
}

function countDigestModels(markdown: string): number {
  return (markdown.match(/^export (?:interface|type) \w+/gm) ?? []).length;
}

/**
 * Server URLs declared by the spec (OpenAPI 3 `servers`, Swagger 2 `host` +
 * `basePath`). Used ONLY for display hints — api_call never targets them
 * implicitly; the trusted origin is configuration.
 */
function collectDeclaredServerUrls(spec: JsonObject): string[] {
  const urls: string[] = [];
  if (Array.isArray(spec.servers)) {
    for (const server of spec.servers) {
      if (server && typeof (server as JsonObject).url === 'string') {
        urls.push((server as JsonObject).url as string);
      }
    }
  } else if (typeof spec.host === 'string') {
    const schemes = Array.isArray(spec.schemes)
      ? (spec.schemes as unknown[]).filter((s: unknown): s is string => typeof s === 'string')
      : [];
    const scheme = schemes.includes('https') ? 'https' : (schemes[0] ?? 'https');
    const basePath = typeof spec.basePath === 'string' ? spec.basePath : '';
    urls.push(`${scheme}://${spec.host}${basePath}`);
  }
  return urls;
}

/**
 * Hints shown when the digested spec's declared servers match the api_call
 * trusted origin: live execution is available, and the spec's declared path
 * prefix (commonly omitted from spec paths because a gateway adds it) is
 * surfaced so agents don't 404 at the host root.
 */
export function buildApiCallHints(
  spec: JsonObject,
  hint: { trustedOrigin: string; methods: string[] } | undefined,
): string[] {
  if (hint === undefined) return [];
  const hints: string[] = [];
  for (const raw of collectDeclaredServerUrls(spec)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.origin !== hint.trustedOrigin) continue;
    if (hints.length === 0) {
      hints.push(
        `api_call can execute requests against this origin ${hint.trustedOrigin} (methods: ${[...hint.methods].sort().join(', ')})`,
      );
    }
    if (parsed.pathname && parsed.pathname !== '/') {
      hints.push(
        `Spec-declared server path: ${parsed.pathname} — spec paths likely omit it; include this prefix in api_call paths.`,
      );
    }
  }
  return hints;
}

/**
 * Builds the request headers for a digest call: SWAGGER_DIGEST_HEADER
 * environment entries first, then tool-call arguments (arguments win on
 * conflicting names — same precedence as -H flags over the environment in the
 * CLI). Header validation and origin scoping happen in headers.ts / fetcher.ts.
 */
export function buildRequestHeaders(args: Pick<McpDigestArgs, 'headers'>): Record<string, string> {
  const fromEnv = process.env.SWAGGER_DIGEST_HEADER ? parseHeaderPairs(process.env.SWAGGER_DIGEST_HEADER) : {};
  return mergeHeaders(fromEnv, args.headers);
}

/**
 * Runs one digest request and renders it as an MCP tool result. Expected
 * failures (unreachable URLs, unparsable specs, invalid header arguments)
 * become `isError` results carrying the message; unexpected errors propagate
 * to the SDK, which converts them into protocol-level tool errors.
 */
export async function runSwaggerDigest(
  args: McpDigestArgs,
  options: DigestServerOptions = {},
): Promise<CallToolResult> {
  if (!isHttpUrl(args.url)) {
    return asError(`Invalid url "${args.url}": use an http:// or https:// URL.`);
  }
  if (args.spec_url !== undefined && !isHttpUrl(args.spec_url)) {
    return asError(`Invalid spec_url "${args.spec_url}": use an http:// or https:// URL.`);
  }
  if (args.max_tokens !== undefined && (!Number.isInteger(args.max_tokens) || args.max_tokens <= 0)) {
    return asError(`Invalid max_tokens ${args.max_tokens}: use a positive integer.`);
  }

  const blockPrivateNetworks = options.blockPrivateNetworks ?? process.env.SWAGGER_DIGEST_ALLOW_PRIVATE !== '1';

  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
  };

  let fetchResult;
  try {
    const fetchOptions: FetchOptions = {
      useBrowserFallback: false,
      maxBytes: 10_000_000,
      headers: buildRequestHeaders(args),
      specUrl: args.spec_url,
      blockPrivateNetworks,
      warn,
    };
    fetchResult = await fetchOpenApiSpec(args.url, fetchOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return asError(`Could not extract an OpenAPI definition from ${args.url}: ${message}`);
  }

  const markdown = transformOpenApiToMarkdown(fetchResult.spec, fetchResult.sourceUrl, {
    includeTags: args.include_tags,
    excludeTags: args.exclude_tags,
    pathPrefix: args.path_prefix,
    maxTokens: args.max_tokens,
    autoTrim: args.auto_trim !== false,
    onWarning: warn,
  });

  const operationCount = countDigestOperations(markdown);
  const modelCount = countDigestModels(markdown);
  const tokens = estimateTokens(markdown).models.claude.tokens;

  const metadata = [
    `source: ${fetchResult.sourceUrl} (via ${fetchResult.retrievalMethod})`,
    `${operationCount} operation${operationCount === 1 ? '' : 's'}`,
    `${modelCount} data model${modelCount === 1 ? '' : 's'}`,
    `~${tokens.toLocaleString('en-US')} tokens estimated`,
  ].join(' · ');

  const warningBlock = warnings.length > 0 ? `\n\n_Warnings:_\n${warnings.map((w) => `- ${w}`).join('\n')}` : '';
  const budgetHint =
    tokens > TOKEN_HINT_THRESHOLD && args.max_tokens === undefined
      ? '\n\n_This digest is large. Consider re-running with max_tokens, include_tags, exclude_tags or path_prefix to fit it into context._'
      : '';
  const apiCallHints = buildApiCallHints(fetchResult.spec, options.apiCallHint);
  const hintBlock =
    apiCallHints.length > 0 ? `\n\n_api_call hints:_\n${apiCallHints.map((h) => `- ${h}`).join('\n')}` : '';

  if (args.write_to_file) {
    try {
      const outputPath = await writeDigest({
        markdown,
        directory: args.write_to_file.directory,
        filename: args.write_to_file.filename,
      });
      return { content: textContent(`Digest written to ${outputPath}\n\n_${metadata}_${warningBlock}${hintBlock}`) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return asError(`Could not write digest: ${message}`);
    }
  }

  return {
    content: textContent(`${markdown}\n\n---\n_Digest metadata: ${metadata}_${warningBlock}${budgetHint}${hintBlock}`),
  };
}
