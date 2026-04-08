/**
 * WorkspaceToolPack — 活动笔记与 Obsidian UI 工具包（Phase 3）
 *
 * 包含：active_note_get, active_note_put, active_note_append, note_open
 */

import { App, TFile } from 'obsidian'

import type { ToolEntry, ToolRegistry } from '../ToolRegistry'
import { normalizeVaultPath } from '../vault-utils'

export class WorkspaceToolPack {
  constructor(private readonly app: App) {}

  registerAll(registry: ToolRegistry): void {
    for (const entry of this.buildEntries()) {
      registry.register(entry)
    }
  }

  private buildEntries(): ToolEntry[] {
    const app = this.app

    return [
      {
        tool: {
          name: 'active_note_get',
          description: 'Read the currently active note in the Obsidian editor.',
          inputSchema: {
            type: 'object',
            properties: {
              format: {
                type: 'string',
                enum: ['text', 'note-json', 'document-map'],
                description:
                  'Output format. text: raw content; note-json: frontmatter + content as JSON; document-map: headings/tags/links structure. Default text.',
              },
            },
            required: [],
          },
        },
        tier: 'read-only',
        source: 'builtin',
        approvalRequired: false,
        handler: async (args) => {
          const activeFile = app.workspace.getActiveFile()
          if (!activeFile) throw new Error('active_note_get: no active file')
          const format = typeof args?.format === 'string' ? args.format : 'text'
          if (format === 'text') return app.vault.cachedRead(activeFile)
          if (format === 'note-json') {
            const content = await app.vault.cachedRead(activeFile)
            const cache = app.metadataCache.getFileCache(activeFile)
            return JSON.stringify(
              { path: activeFile.path, frontmatter: cache?.frontmatter ?? {}, content },
              null,
              2,
            )
          }
          if (format === 'document-map') {
            const cache = app.metadataCache.getFileCache(activeFile)
            return JSON.stringify(
              {
                path: activeFile.path,
                frontmatter: cache?.frontmatter ?? {},
                headings: cache?.headings ?? [],
                tags: (cache?.tags ?? []).map((t) => t.tag),
                links: cache?.links ?? [],
              },
              null,
              2,
            )
          }
          throw new Error(`active_note_get: unknown format "${format}"`)
        },
      },

      {
        tool: {
          name: 'active_note_put',
          description: 'Overwrite the full content of the currently active note.',
          inputSchema: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'New full content for the active note.' },
            },
            required: ['content'],
          },
        },
        tier: 'read-write',
        source: 'builtin',
        approvalRequired: false,
        handler: async (args) => {
          const activeFile = app.workspace.getActiveFile()
          if (!activeFile) throw new Error('active_note_put: no active file')
          const content = args?.content
          if (typeof content !== 'string')
            throw new Error('active_note_put requires a string "content"')
          await app.vault.modify(activeFile, content)
          return `Wrote ${content.length} bytes to ${activeFile.path}`
        },
      },

      {
        tool: {
          name: 'active_note_append',
          description: 'Append text to the end of the currently active note.',
          inputSchema: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Text to append.' },
              ensureTrailingNewline: {
                type: 'boolean',
                description:
                  'Insert a newline before appending if the note does not end with one. Default false.',
              },
            },
            required: ['content'],
          },
        },
        tier: 'read-write',
        source: 'builtin',
        approvalRequired: false,
        handler: async (args) => {
          const activeFile = app.workspace.getActiveFile()
          if (!activeFile) throw new Error('active_note_append: no active file')
          const content = args?.content
          if (typeof content !== 'string')
            throw new Error('active_note_append requires a string "content"')
          const ensureNL = args?.ensureTrailingNewline === true
          let existing = await app.vault.read(activeFile)
          if (ensureNL && existing.length > 0 && !existing.endsWith('\n')) {
            existing += '\n'
          }
          await app.vault.modify(activeFile, existing + content)
          return `Appended ${content.length} bytes to ${activeFile.path}`
        },
      },

      {
        tool: {
          name: 'note_open',
          description:
            'Open a note in the Obsidian UI. This is a stateful UI operation — it changes the active leaf visible to the user.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Vault-relative path of the note to open.' },
              newLeaf: {
                type: 'boolean',
                description: 'When true, open in a new tab instead of reusing an existing leaf. Default false.',
              },
              line: {
                type: 'number',
                description: 'Line number (1-indexed) to scroll to after opening.',
              },
            },
            required: ['path'],
          },
        },
        tier: 'read-write',
        source: 'builtin',
        approvalRequired: false,
        handler: async (args) => {
          const rawPath = args?.path
          if (typeof rawPath !== 'string' || rawPath.trim().length === 0)
            throw new Error('note_open requires a non-empty "path"')
          const relativePath = normalizeVaultPath(rawPath)
          const file = app.vault.getAbstractFileByPath(relativePath)
          if (!file || !(file instanceof TFile))
            throw new Error(`note_open: file not found: ${relativePath}`)
          const newLeaf = args?.newLeaf === true
          const line = typeof args?.line === 'number' ? Math.max(1, args.line) : undefined
          const leaf = newLeaf
            ? app.workspace.getLeaf('tab')
            : app.workspace.getLeaf(false)
          await leaf.openFile(file, {
            eState: line !== undefined ? { line: line - 1 } : undefined,
          })
          return `Opened ${relativePath}${line !== undefined ? ` at line ${line}` : ''}`
        },
      },
    ]
  }
}
