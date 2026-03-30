# Built-in MCP Tools

All tools are registered as built-in vault tools in `src/core/mcp/mcpManager.ts` and are available to the assistant without any external MCP server configuration.

---

## Existing Tools (pre-parity work)

| Tool | Description |
|------|-------------|
| `vault_list` | List files and folders under a vault-relative directory |
| `vault_read` | Read a UTF-8 text file by vault-relative path |
| `vault_write` | Full overwrite of a vault file (prefer `vault_edit` for partial changes) |
| `vault_edit` | Replace a text snippet in a vault file (`oldText` → `newText`) |
| `vault_mkdir` | Create a vault-relative directory path recursively |

---

## Phase 1 — Vault & UI Basics

| Tool | Arguments | Description |
|------|-----------|-------------|
| `vault_delete` | `path` | **Destructive.** Move a vault file or folder to the system trash. |
| `commands_list` | — | List all available Obsidian commands with their IDs and names. |
| `tags_list` | `includeCounts?` | List all tags used in the vault. Pass `includeCounts: true` to include usage counts. |
| `note_open` | `path`, `newLeaf?`, `line?` | **Stateful UI.** Open a note in the Obsidian editor. `newLeaf` opens a new tab; `line` (1-indexed) scrolls to that line. |

---

## Phase 2 — Active Note & Append

| Tool | Arguments | Description |
|------|-----------|-------------|
| `vault_append` | `path`, `content`, `createDirectories?`, `ensureTrailingNewline?` | Append text to the end of a vault file. Creates the file if it does not exist. |
| `active_note_get` | `format?` | Read the currently active note. `format`: `text` (default) / `note-json` (frontmatter + content) / `document-map` (headings, tags, links). Fails when no file is active. |
| `active_note_put` | `content` | Overwrite the full content of the currently active note. |
| `active_note_append` | `content`, `ensureTrailingNewline?` | Append text to the end of the currently active note. |
| `active_note_delete` | — | **Destructive.** Move the currently active note to the system trash. |

---

## Phase 3 — Richer Reads & Search

| Tool | Arguments | Description |
|------|-----------|-------------|
| `vault_get` | `path`, `format?` | Read a file or directory with richer output. `format`: `text` (default) / `directory` (folder listing) / `note-json` (frontmatter + content) / `document-map` (headings, tags, links, frontmatter). |
| `search_simple` | `query`, `contextLength?`, `limit?` | Case-insensitive full-vault search. Checks filenames first, then file content. Returns each match with `matchType` (`filename` or `content`) and a surrounding `context` snippet. Defaults: `contextLength=100`, `limit=20`. |

---

## Phase 4 — Command Execution

| Tool | Arguments | Description |
|------|-----------|-------------|
| `command_execute` | `commandId` | **Stateful.** Execute an Obsidian command by its ID. Use `commands_list` to discover valid IDs. Validates command existence before execution. Commands can trigger broad side effects. |

---

## Phase 5 — Structured Search

| Tool | Arguments | Description |
|------|-----------|-------------|
| `search_dataview` | `query` | Execute a Dataview DQL query. Requires the Dataview plugin to be installed and enabled; fails clearly if unavailable. |
| `search_jsonlogic` | `filter` | Filter vault notes by metadata using a JSONLogic expression. Returns an array of matching file paths. |

### `search_jsonlogic` — available operators and data fields

**Operators:** `==`, `!=`, `===`, `!==`, `<`, `<=`, `>`, `>=`, `and`, `or`, `not` / `!`, `in`, `cat`, `var`

**Note data fields accessible via `var`:**

| Field | Type | Notes |
|-------|------|-------|
| `path` | string | Full vault-relative path, e.g. `folder/note.md` |
| `basename` | string | Filename without extension |
| `extension` | string | File extension without leading dot |
| `size` | number | File size in bytes |
| `ctime` | number | Creation timestamp (ms since epoch) |
| `mtime` | number | Last-modified timestamp (ms since epoch) |
| `frontmatter.<key>` | any | Any frontmatter field, e.g. `frontmatter.status` |
| `tags` | string[] | Array of tag strings including the `#` prefix |

**Example filter** — notes tagged `#project` with `status` frontmatter equal to `active`:

```json
{
  "and": [
    { "in": ["#project", { "var": "tags" }] },
    { "==": [{ "var": "frontmatter.status" }, "active"] }
  ]
}
```

---

## Implementation Notes

- All tools are dispatched through `callVaultTool()` in `McpManager`.
- Path arguments are normalised and validated by `normalizeVaultPath()` to prevent directory traversal.
- Active-note tools (`active_note_*`) call `workspace.getActiveFile()` and fail immediately with a clear error when no file is open.
- `search_dataview` and `command_execute` access internal Obsidian APIs that are not part of the official TypeScript types; they are accessed via typed casts.
- The `applyJsonLogic` static method is a self-contained evaluator — no external dependency.
