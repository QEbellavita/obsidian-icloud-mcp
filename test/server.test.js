'use strict';

// Drives the real server over stdio. The service tests cover behaviour in
// isolation; these check the MCP layer actually wires it up.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
jest.setTimeout(20000);

async function connect(vaults) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'server.js')],
    cwd: ROOT,
    env: vaults
      ? { ...process.env, OBSIDIAN_VAULTS: JSON.stringify(vaults) }
      : { ...process.env, OBSIDIAN_VAULTS: '' },
  });
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

describe('obsidian-icloud-mcp server', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-server-'));
    fs.writeFileSync(path.join(root, 'note.md'), '# Note\nfindable content\n');
  });

  test('advertises the seven vault tools', async () => {
    const client = await connect({ Personal: root });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'obsidian_create_note',
        'obsidian_list_notes',
        'obsidian_read_note',
        'obsidian_search_notes',
        'obsidian_update_note',
        'obsidian_vault_health',
        'obsidian_warm_notes',
      ]);
      for (const t of tools) expect(t.inputSchema).toBeDefined();
    } finally {
      await client.close();
    }
  });

  test('round-trips a note through create, search and read', async () => {
    const client = await connect({ Personal: root });
    try {
      const created = await client.callTool({
        name: 'obsidian_create_note',
        arguments: { vault: 'Personal', path: 'sub/fresh.md', content: '# Fresh\nunique-token\n' },
      });
      expect(JSON.parse(created.content[0].text).status).toBe('created');

      const found = await client.callTool({
        name: 'obsidian_search_notes',
        arguments: { vault: 'Personal', query: 'unique-token' },
      });
      const matches = JSON.parse(found.content[0].text).matches;
      expect(matches).toHaveLength(1);
      expect(matches[0].path).toBe('sub/fresh.md');

      const read = await client.callTool({
        name: 'obsidian_read_note',
        arguments: { vault: 'Personal', path: 'sub/fresh.md' },
      });
      expect(JSON.parse(read.content[0].text).content).toContain('unique-token');
    } finally {
      await client.close();
    }
  });

  test('refuses to escape the vault, and stays alive afterwards', async () => {
    const client = await connect({ Personal: root });
    try {
      const res = await client.callTool({
        name: 'obsidian_read_note',
        arguments: { vault: 'Personal', path: '../escape.md' },
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/inside the vault/i);

      // The server must not have died on the rejected call.
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(7);
    } finally {
      await client.close();
    }
  });

  test('starts with zero tools when no vault is configured', async () => {
    // Rather than crashing, which the host would report as a broken server.
    const client = await connect(null);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(0);
    } finally {
      await client.close();
    }
  });
});
