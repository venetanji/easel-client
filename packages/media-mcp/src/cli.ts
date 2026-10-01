#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMediaServer } from './server.js';

async function main(): Promise<void> {
  const server = createMediaServer();
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown MCP server error.';
  console.error(`Easel Media MCP: ${message}`);
  process.exitCode = 1;
});
