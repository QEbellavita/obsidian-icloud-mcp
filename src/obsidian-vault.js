'use strict';

const { createObsidianVaultService } = require('./service');

function loadVaults() {
  const raw = process.env.OBSIDIAN_VAULTS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (error) {
    throw new Error(`Invalid OBSIDIAN_VAULTS JSON: ${error.message}`);
  }
}

function makeInput(properties, required) {
  return { type: 'object', properties, required };
}

function createDomain() {
  const vaults = loadVaults();
  if (!vaults) return { tools: () => [], resources: () => [] };
  const service = createObsidianVaultService({ vaults });
  const vault = { type: 'string', enum: Object.keys(vaults) };
  const notePath = { type: 'string', description: 'Markdown path relative to the selected vault.' };
  const content = { type: 'string', description: 'UTF-8 Markdown note content.' };

  return {
    tools: () => [
      {
        def: {
          name: 'obsidian_list_notes',
          description: 'List Markdown notes in an approved Obsidian vault.',
          inputSchema: makeInput({ vault, directory: { type: 'string' } }, ['vault']),
        },
        handler: (args) => service.listNotes(args.vault, args.directory || ''),
      },
      {
        def: {
          name: 'obsidian_search_notes',
          description: 'Search Markdown note contents in an approved Obsidian vault.',
          inputSchema: makeInput({ vault, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['vault', 'query']),
        },
        handler: (args) => service.searchNotes(args.vault, args.query, args.limit),
      },
      {
        def: {
          name: 'obsidian_read_note',
          description: 'Read one Markdown note from an approved Obsidian vault.',
          inputSchema: makeInput({ vault, path: notePath }, ['vault', 'path']),
        },
        handler: (args) => service.readNote(args.vault, args.path),
      },
      {
        def: {
          name: 'obsidian_create_note',
          description: 'Create a new Markdown note in an approved Obsidian vault.',
          inputSchema: makeInput({ vault, path: notePath, content }, ['vault', 'path', 'content']),
        },
        handler: (args) => service.createNote(args.vault, args.path, args.content),
      },
      {
        def: {
          name: 'obsidian_update_note',
          description: 'Replace an existing Markdown note in an approved Obsidian vault.',
          inputSchema: makeInput({ vault, path: notePath, content }, ['vault', 'path', 'content']),
        },
        handler: (args) => service.updateNote(args.vault, args.path, args.content),
      },
      {
        def: {
          name: 'obsidian_vault_health',
          description:
            'How much of a vault is actually on disk right now: materialized vs iCloud-evicted note counts, bytes '
            + 'pending download, and the largest evicted notes. stat-only — never triggers a download, never blocks.',
          inputSchema: makeInput({ vault }, ['vault']),
        },
        handler: (args) => service.vaultHealth(args.vault),
      },
      {
        def: {
          name: 'obsidian_warm_notes',
          description:
            'Request background iCloud downloads for evicted notes — the given `paths`, or (with none) the first '
            + '`limit` evicted notes found (default 25, max 100). Returns immediately; downloads proceed in the '
            + 'background. Check obsidian_vault_health for progress.',
          inputSchema: makeInput({
            vault,
            paths: { type: 'array', items: notePath, maxItems: 100 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          }, ['vault']),
        },
        handler: (args) => service.warmNotes(args.vault, { paths: args.paths, limit: args.limit }),
      },
    ],
    resources: () => [{
      name: 'obsidian-vault-capabilities',
      uri: 'obsidian://vault/capabilities',
      handler: async () => ({
        domain: 'obsidian-vault',
        vaults: Object.keys(vaults),
        tools: ['obsidian_list_notes', 'obsidian_search_notes', 'obsidian_read_note', 'obsidian_create_note', 'obsidian_update_note', 'obsidian_vault_health', 'obsidian_warm_notes'],
      }),
    }],
  };
}

const domain = createDomain();

module.exports = {
  name: 'obsidian-vault',
  requires: [],
  tools: domain.tools,
  resources: domain.resources,
};
