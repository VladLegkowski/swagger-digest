import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VERSION } from '../version.js';
import { runSwaggerDigest, type DigestServerOptions } from './digest.js';
import { resolveApiCallConfig, runApiCall, type ApiCallArgs, type ApiCallServerOptions } from './api-call.js';

/** Options for the whole MCP server: shared behavior plus per-tool overrides. */
export interface SwaggerDigestMcpOptions extends DigestServerOptions {
  /**
   * Configuration overrides for the `api_call` tool. Tests inject these;
   * production derives them from SWAGGER_DIGEST_API_* environment variables.
   */
  apiCall?: ApiCallServerOptions;
}

/**
 * When api_call is configured (options or environment), digest results get a
 * hint that live execution is available for that origin and which service
 * prefix spec paths need. Resolved per call so env-based configuration works.
 */
function withApiCallHint(options: SwaggerDigestMcpOptions): DigestServerOptions {
  const resolved = resolveApiCallConfig(options.apiCall ?? {});
  if (resolved.error !== undefined || resolved.config === undefined) return options;
  return {
    ...options,
    apiCallHint: { trustedOrigin: resolved.config.baseUrl.origin, methods: [...resolved.config.methods] },
  };
}

/**
 * Builds the MCP server exposing the `swagger_digest` and `api_call` tools.
 *
 * The instance is transport-agnostic: `src/mcp/index.ts` connects it to a
 * StdioServerTransport, while tests connect it to an InMemoryTransport pair.
 * No I/O happens at module scope or during construction.
 */
export function createMcpServer(options: SwaggerDigestMcpOptions = {}): McpServer {
  const server = new McpServer({ name: 'swagger-digest', version: VERSION });

  server.registerTool(
    'swagger_digest',
    {
      title: 'Generate API digest',
      description:
        'Fetch a Swagger UI page or an OpenAPI/Swagger spec (JSON or YAML, versions 2.0/3.0/3.1) and convert it ' +
        'into a compact Markdown API reference optimized for LLM context: endpoint index, request/response details, ' +
        'authentication schemes, and TypeScript-like data types. Handles Swagger UI discovery automatically ' +
        '(initializer scripts, multi-spec dropdowns, common spec paths). Use this whenever the user asks to ' +
        'understand, summarize, or work against an API documented with Swagger/OpenAPI.',
      inputSchema: {
        url: z.string().describe('Swagger UI page URL or direct OpenAPI spec URL (http/https)'),
        spec_url: z
          .string()
          .optional()
          .describe('Explicit OpenAPI spec URL; overrides discovery from the Swagger UI page'),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Request headers (e.g. Authorization or Cookie). Sent ONLY to the origin of url; cross-origin requests never receive them. Values are not logged.',
          ),
        include_tags: z
          .array(z.string())
          .optional()
          .describe('Keep only operations carrying at least one of these tags'),
        exclude_tags: z.array(z.string()).optional().describe('Drop operations carrying any of these tags'),
        path_prefix: z.string().optional().describe('Keep only operations whose path starts with this prefix'),
        max_tokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Trim the digest until an approximate token estimate fits this budget (heuristic, not tokenizer-accurate)',
          ),
        auto_trim: z
          .boolean()
          .optional()
          .describe(
            'Auto-trim digests exceeding the 250,000-token default budget when max_tokens is not given. Defaults to true.',
          ),
        write_to_file: z
          .object({ directory: z.string(), filename: z.string() })
          .optional()
          .describe('Save the digest to a file instead of returning it inline'),
      },
    },
    (args) => runSwaggerDigest(args, withApiCallHint(options)),
  );

  server.registerTool(
    'api_call',
    {
      title: 'Execute an API request',
      description:
        'Execute an HTTP request against the trusted API origin configured via SWAGGER_DIGEST_API_BASE_URL ' +
        '(set when the MCP server starts; the tool returns a clear configuration error when it is unset). ' +
        'Use it after swagger_digest to verify how the real API behaves: send GET (default) or, when write ' +
        'methods were enabled via SWAGGER_DIGEST_API_METHODS, POST/PUT/PATCH/DELETE. Provide either `path` ' +
        '(resolved against the trusted origin) or an absolute `url` on that same origin — other origins are ' +
        'refused, and server URLs declared inside an OpenAPI spec are never trusted implicitly. Authentication ' +
        'headers are injected server-side; credential headers in arguments are rejected. Non-2xx responses are ' +
        'returned as results (not errors) so error bodies can be inspected. Responses are size- and token-capped.',
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe('Absolute http(s) URL whose origin must equal the configured trusted API origin'),
        path: z
          .string()
          .optional()
          .describe('API path starting with "/", e.g. "/v1/refunds" — resolved against SWAGGER_DIGEST_API_BASE_URL'),
        method: z
          .string()
          .optional()
          .describe('HTTP method (default "get"). Write methods require SWAGGER_DIGEST_API_METHODS opt-in'),
        query: z
          .record(
            z.string(),
            z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]),
          )
          .optional()
          .describe('Query parameters; array values become repeated keys'),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Extra request headers. Credential-bearing names (authorization, cookie, x-api-key, …) are rejected; authentication comes from SWAGGER_DIGEST_API_HEADER',
          ),
        body: z.unknown().optional().describe('JSON-serializable request body (POST/PUT/PATCH/DELETE only)'),
        max_tokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Trim large response bodies to approximately this token budget'),
      },
    },
    (args) => runApiCall(args as ApiCallArgs, options.apiCall),
  );

  return server;
}
