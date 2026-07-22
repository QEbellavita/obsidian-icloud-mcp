<p align="center">
  <img src="./assets/header.svg" alt="obsidian-icloud-mcp — an Obsidian MCP that survives iCloud eviction" width="100%">
</p>

<p align="center"><a href="https://github.com/QEbellavita/obsidian-icloud-mcp/actions/workflows/test.yml"><img src="https://github.com/QEbellavita/obsidian-icloud-mcp/actions/workflows/test.yml/badge.svg" alt="tests"></a></p>

An MCP server for Obsidian vaults that doesn't hang on iCloud.

Read, search, create and update notes from your assistant — and see exactly how much
of the vault iCloud has actually left on disk. Seven tools, no daemon, no index to rebuild.

## Why another one

Because the obvious implementation breaks on iCloud Drive, and breaks in the worst
possible way: it hangs forever.

If your vault lives in iCloud with **Optimize Mac Storage** on, macOS evicts note bodies
and leaves *dataless placeholders* behind. They look like ordinary files — `stat` reports
a real size — but the first `read()` blocks while macOS fetches the content over the
network. On an evicted vault, a naive search hits hundreds of those in a row and never
returns. No error, no timeout, just a search that never finishes.

A deadline alone doesn't fix it: a single blocking read never yields control back, so the
between-files clock check is never reached. The only reliable signal is `stat`'s **block
count** — a dataless placeholder reports `blocks == 0` despite a non-zero size.

This server checks that before every read, and bounds total search time on top. Evicted
notes are skipped and reported, not waited on:

```json
{
  "matches": [ ... ],
  "scanned": 112,
  "total": 486,
  "unavailable": 43,
  "incomplete": true,
  "note": "Searched 112/486 notes; 43 are not downloaded from iCloud yet and were skipped. Results may be incomplete."
}
```

`incomplete: true` means "there may be more" — rather than silently returning partial
results as if they were the whole answer. The counts distinguish the two reasons: notes
that weren't materialised (`unavailable`) versus hitting the time budget.

Reading one specific evicted note fails honestly with *"not downloaded from iCloud"*
instead of blocking.

## Install

Point your MCP client at it:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "obsidian-icloud-mcp"],
      "env": {
        "OBSIDIAN_VAULTS": "{\"Personal\":\"/Users/you/Documents/Notes\"}"
      }
    }
  }
}
```

Or from source: `git clone https://github.com/QEbellavita/obsidian-icloud-mcp` and point
`command: node, args: [/absolute/path/to/obsidian-icloud-mcp/server.js]` at the checkout.

Formerly named `obsidian-vault-mcp`; renamed because that npm name belongs to an unrelated
project by another author — `npx obsidian-vault-mcp` is not this server. The old GitHub URL
redirects here.

`OBSIDIAN_VAULTS` is a JSON object of name → absolute path. Multiple vaults are fine:

```json
"OBSIDIAN_VAULTS": "{\"Personal\":\"/Users/you/Notes\",\"Work\":\"/Users/you/Work/vault\"}"
```

With no vaults configured the server starts and advertises zero tools, rather than
crashing in a way your host reports as a broken server.

## Tools

| Tool | |
|---|---|
| `obsidian_list_notes` | List Markdown notes, optionally under a subdirectory |
| `obsidian_search_notes` | Full-text search with path, line number and excerpt |
| `obsidian_read_note` | Read one note |
| `obsidian_create_note` | Create a note; refuses to overwrite |
| `obsidian_update_note` | Atomic overwrite of an existing note |
| `obsidian_vault_health` | Materialized vs evicted counts, bytes pending, largest evicted notes — stat-only, never blocks |
| `obsidian_warm_notes` | Opt-in background downloads for evicted notes, bounded per call |

## Safety

The vault boundary is enforced, not assumed:

- Paths must be relative and stay inside the configured vault — `../` is rejected
- **Symlinks that resolve outside the vault are rejected**, not followed
- Only `.md` files are read or written
- `create` refuses to clobber; `update` refuses to create
- Writes are atomic (temp file + rename), so an interrupted write can't truncate a note

Directory walking skips anything that can't hold notes — `.git`, `node_modules`,
`.obsidian` — which also stops a vault that happens to be a source checkout from taking
minutes to list. And it never descends into a stalling bundle directory, where even
`readdir` can block indefinitely on iCloud.

## Tests

```bash
npm test
```

23 tests. Nineteen cover the service directly — including every iCloud failure mode above,
driven through an injected `fs` so eviction is simulated deterministically rather than
depending on your actual sync state. Four drive the real server over a real stdio
transport.

## Licence

MIT — see [LICENSE](LICENSE).
