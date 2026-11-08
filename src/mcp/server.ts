import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VERSION } from '../version.js';
import { runSwaggerDigest, type DigestServerOptions } from './digest.js';

/**
 * Builds the MCP server exposing the `swagger_digest` tool.
 *
 * The instance is transport-agnostic: `src/mcp/index.ts` connects it to a
 * StdioServerTransport, while tests connect it to an InMemoryTransport pair.
 * No I/O happens at module scope or during construction.
 */
export function createMcpServer(options: DigestServerOptions = {}): McpServer {
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
        write_to_file: z
          .object({ directory: z.string(), filename: z.string() })
          .optional()
          .describe('Save the digest to a file instead of returning it inline'),
      },
    },
    (args) => runSwaggerDigest(args, options),
  );

  return server;
}
