#!/usr/bin/env node
'use strict';

// Standalone MCP server exposing Obsidian vault tools over stdio.
//
// Vaults are configured by the OBSIDIAN_VAULTS env var, a JSON object of
// name -> absolute path:
//
//   OBSIDIAN_VAULTS='{"Personal":"/Users/me/Notes"}'
//
// With no vaults configured the server starts and advertises zero tools,
// rather than failing in a way the host reports as a broken server.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const createDomain = require('./src/obsidian-vault.js');

const domain = typeof createDomain === 'function' ? createDomain() : createDomain;
const tools = domain.tools();
const byName = new Map(tools.map((t) => [t.def.name, t]));

const server = new Server(
  { name: 'obsidian-icloud-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => t.def),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = byName.get(request.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
    };
  }
  try {
    const result = await tool.handler(request.params.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    // Surface the reason. The service throws deliberately readable errors —
    // "not downloaded from iCloud", "outside the vault", "already exists" —
    // and swallowing them would make the failure look like a bug in the host.
    return {
      isError: true,
      content: [{ type: 'text', text: `${request.params.name}: ${err.message}` }],
    };
  }
});

async function main() {
  // stdout is the MCP transport; diagnostics must go to stderr or the protocol
  // stream is corrupted.
  await server.connect(new StdioServerTransport());
  if (tools.length === 0) {
    process.stderr.write(
      'obsidian-icloud-mcp: no vaults configured. Set OBSIDIAN_VAULTS, e.g.\n' +
      '  OBSIDIAN_VAULTS=\'{"Personal":"/absolute/path/to/vault"}\'\n',
    );
  } else {
    process.stderr.write(`obsidian-icloud-mcp ready — ${tools.length} tools\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
