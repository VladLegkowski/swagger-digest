#!/usr/bin/env node
/**
 * MCP stdio entry point for swagger-digest.
 *
 * Registered as the `swagger-digest-mcp` bin. The client (Claude Desktop,
 * Cursor, OpenCode, …) spawns this process and communicates over stdin/stdout;
 * nothing is ever written to stdout except MCP protocol frames.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';

async function main(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  // The stdio transport keeps the event loop alive while the connection is open.
}

main().catch((error: unknown) => {
  // Diagnostics go to stderr only — stdout carries the protocol.
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
