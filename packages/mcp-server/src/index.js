#!/usr/bin/env node
/**
 * odw MCP server — stdio transport. The ONLY file in this package that imports
 * the MCP SDK (tests cover daemon-client.js + tools.js without it).
 *
 * No daemon probe at startup ON PURPOSE: MCP clients launch this server before
 * (or regardless of) the daemon — every tool resolves the daemon lazily and
 * surfaces "daemon offline" / "auth token" guidance per call instead.
 */

import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createDaemonClient } from './daemon-client.js';
import { TOOL_DEFINITIONS, createToolHandlers } from './tools.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const server = new Server({ name: 'odw', version }, { capabilities: { tools: {} } });
const handlers = createToolHandlers(createDaemonClient());

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = handlers[name];
  if (!handler) {
    return { content: [{ type: 'text', text: `error: unknown tool ${name}` }], isError: true };
  }
  return handler(args ?? {});
});

await server.connect(new StdioServerTransport());
