/**
 * VaultToolPack — 文件与目录 I/O 工具包（Phase 3）
 *
 * 包含：vault_list, vault_read, vault_write, vault_edit, vault_mkdir,
 *       vault_append, vault_delete, vault_get
 *
 * 从 McpManager.getVaultTools() + callVaultTool() 中提取。
 */

import { App, TFile } from 'obsidian'

import type { ToolEntry, ToolRegistry } from '../ToolRegistry'
import {
  ensureParentDirectory,
  getVaultAdapter,
  normalizeVaultPath,
} from '../vault-utils'

export class VaultToolPack {
  constructor(private readonly app: App) {}

  registerAll(registry: ToolRegistry): void {
    for (const entry of this.buildEntries()) {
      registry.register(entry)
    }
  }

  private buildEntries(): ToolEntry[] {
    const app = this.app
    const adapter = () => getVaultAdapter(app)

    return [
      {
        tool: {
          name: 'vault_list',
          description:
            'List files and folders under a vault-relative directory. Use this before reading or writing files.',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Vault-relative directory path to list. Default is vault root.',
              },
            },
            required: [],
          },
        },
        tier: 'read-only',
        source: 'builtin',
        approvalRequired: false,
        handler: async (args) => {
          const relativePath = normalizeVaultPath(
            typeof args?.path === 'string' ? args.path : '',
          )
          const listed = await adapter().list(relativePath)
          return JSON.stringify({ path: relativePath, folders: listed.folders, files: listed.files }, null, 2)
        },
      },

      {
        tool: {
          name: 'vault_read',
          description: 'Read a UTF-8 text file from the vault by vault-relative path.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Vault-relative file path to read.' },
            },
            required: ['path'],
          },
        },
        tier: 'read-only',
        source: 'builtin',
        approvalRequired: false,
        handler: async (args) => {
          const rawPath = args?.path
          if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
            throw new Error('vault_read requires a non-empty "path"')
          }
          return adapter().read(normalizeVaultPath(rawPath))
        },
      },

      {
        tool: {
          name: 'vault_write',
          description:
            'Write UTF-8 text content to a vault-relative file path (full overwrite). Prefer vault_edit for normal file updates. Use vault_write when vault_edit is not suitable (e.g., near-complete rewrite) or when vault_edit fails.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Vault-relative file path to write.' },
              content: { type: 'string', description: 'Full UTF-8 text content to write.' },
              createDirectories: {
                type: 'boolean',
                description: 'Whether to create missing parent directories. Default true.',
              },
            },
            required: ['path', 'content'],
          },
        },
        tier: 'read-write',
        source: 'builtin',
        approvalRequired: false,
        handler: async (args) => {
          const rawPath = args?.path
          const content = args?.content
          if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
            throw new Error('vault_write requires a non-empty "path"')
          }
          if (typeof content !== 'string') {
            throw new Error('vault_write requires a string "content"')
          }
          const relativePath = normalizeVaultPath(rawPath)
          const createDirs =
            typeof args?.createDirectories === 'boolean' ? args.createDirectories : true
          if (createDirs) await ensureParentDirectory(relativePath, adapter())
          await adapter().write(relativePath, content)
          return `Wrote ${content.length} bytes to ${relativePath}`
        },
      },

      {
        tool: {
          name: 'vault_edit',
          description:
            'Edit part of a UTF-8 text file by replacing oldText with newText. This is the preferred tool for file modifications. Use vault_write only when vault_edit is not suitable (e.g., near-complete rewrite) or after vault_edit fails.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Vault-relative file path to edit.' },
              oldText: { type: 'string', description: 'Exact text snippet to replace.' },
              newText: { type: 'string', description: 'Replacement text snippet.' },
              replaceAll: {
                type: 'boolean',
                description: 'Replace all occurrences when true. Default false (expects exactly one match).',
              },
            },
            required: ['path', 'oldText', 'newText'],
          },
        },
        tier: 'read-write',
        source: 'builtin',
        approvalRequired: false,
        handler: async (args) => {
          const rawPath = args?.path
          const oldText = args?.oldText
          const newText = args?.newText
          const replaceAll = args?.replaceAll === true
          if (typeof rawPath !== 'string' || rawPath.trim().length === 0)
            throw new Error('vault_edit requires a non-empty "path"')
          if (typeof oldText !== 'string' || oldText.length === 0)
            throw new Error('vault_edit requires a non-empty string "oldText"')
          if (typeof newText !== 'string')
            throw new Error('vault_edit requires a string "newText"')
          const relativePath = normalizeVaultPath(rawPath)
          const original = await adapter().read(relativePath)
          const occurrences = original.split(oldText).length - 1
          if (occurrences === 0)
            throw new Error(`vault_edit could not find oldText in ${relativePath}`)
          if (!replaceAll && occurrences !== 1)
            throw new Error(
              `vault_edit found ${occurrences} matches; set replaceAll=true or provide a more specific oldText`,
            )
          const next = replaceAll
            ? original.split(oldText).join(newText)
            : original.replace(oldText, newText)
          await adapter().write(relativePath, next)
          return `Edited ${relativePath}; replaced ${replaceAll ? occurrences : 1} occurrence(s)`
        },
      },

      {
        tool: {
          name: 'vault_mkdir',
          description: 'Create a vault-relative directory path recursively if it does not exist.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Vault-relative directory path to create.' },
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
            throw new Error('vault_mkdir requires a non-empty "path"')
          const relativePath = normalizeVaultPath(rawPath)
          const a = adapter()
          const parts = relativePath.split('/').filter(Boolean)
          let cursor = ''
          for (const part of parts) {
            cursor = cursor.length === 0 ? part : `${cursor}/${part}`
            const exists = a.exists ? await a.exists(cursor) : false
            if (!exists) {
              await a.mkdir(cursor).catch((e: Error) => {
                if (!`${e?.message ?? ''}`.includes('already exists')) throw e
              })
            }
          }
          return `Created directory ${relativePath}`
        },
      },

      {
        tool: {
          name: 'vault_append',
          description:
            'Append text to the end of a vault file. Creates the file if it does not exist.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Vault-relative file path.' },
              content: { type: 'string', description: 'Text to append.' },
              createDirectories: {
                type: 'boolean',
                description: 'Create missing parent directories. Default true.',
              },
              ensureTrailingNewline: {
                type: 'boolean',
                description:
                  'Insert a newline before appending if the file does not already end with one. Default false.',
              },
            },
            required: ['path', 'content'],
          },
        },
        tier: 'read-write',
        source: 'builtin',
        approvalRequired: false,
        handler: async (args) => {
          const rawPath = args?.path
          const content = args?.content
          if (typeof rawPath !== 'string' || rawPath.trim().length === 0)
            throw new Error('vault_append requires a non-empty "path"')
          if (typeof content !== 'string')
            throw new Error('vault_append requires a string "content"')
          const relativePath = normalizeVaultPath(rawPath)
          const a = adapter()
          const createDirs =
            typeof args?.createDirectories === 'boolean' ? args.createDirectories : true
          const ensureNL = args?.ensureTrailingNewline === true
          if (createDirs) await ensureParentDirectory(relativePath, a)
          const exists = a.exists ? await a.exists(relativePath) : false
          let existing = ''
          if (exists) {
            existing = await a.read(relativePath)
            if (ensureNL && existing.length > 0 && !existing.endsWith('\n')) {
              existing += '\n'
            }
          }
          await a.write(relativePath, existing + content)
          return `Appended ${content.length} bytes to ${relativePath}`
        },
      },

      {
        tool: {
          name: 'vault_delete',
          description:
            'DESTRUCTIVE: Move a vault file or folder to the system trash. This cannot be undone from within Obsidian. Confirm the correct path before calling.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Vault-relative file or folder path to delete.' },
            },
            required: ['path'],
          },
        },
        tier: 'danger-zone',
        source: 'builtin',
        approvalRequired: true,
        handler: async (args) => {
          const rawPath = args?.path
          if (typeof rawPath !== 'string' || rawPath.trim().length === 0)
            throw new Error('vault_delete requires a non-empty "path"')
          const relativePath = normalizeVaultPath(rawPath)
          const target = app.vault.getAbstractFileByPath(relativePath)
          if (!target) throw new Error(`vault_delete: path not found: ${relativePath}`)
          await app.vault.trash(target, true)
          return `Moved to trash: ${relativePath}`
        },
      },

      {
        tool: {
          name: 'vault_get',
          description:
            'Read a vault file or directory with richer output formats than vault_read.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Vault-relative file or directory path.' },
              format: {
                type: 'string',
                enum: ['text', 'directory', 'note-json', 'document-map'],
                description:
                  'Output format. text: raw file content (default); directory: folder listing; note-json: frontmatter + content; document-map: headings/tags/links.',
              },
            },
            required: ['path'],
          },
        },
        tier: 'read-only',
        source: 'builtin',
        approvalRequired: false,
        handler: async (args) => {
          const rawPath = args?.path
          if (typeof rawPath !== 'string' || rawPath.trim().length === 0)
            throw new Error('vault_get requires a non-empty "path"')
          const relativePath = normalizeVaultPath(rawPath)
          const format = typeof args?.format === 'string' ? args.format : 'text'
          const a = adapter()

          if (format === 'directory') {
            const listed = await a.list(relativePath)
            return JSON.stringify(
              { path: relativePath, folders: listed.folders, files: listed.files },
              null,
              2,
            )
          }

          const file = app.vault.getFileByPath(relativePath)
          if (!file) throw new Error(`vault_get: file not found: ${relativePath}`)

          if (format === 'text') return a.read(relativePath)
          if (format === 'note-json') {
            const content = await a.read(relativePath)
            const cache = app.metadataCache.getFileCache(file as TFile)
            return JSON.stringify(
              { path: relativePath, frontmatter: cache?.frontmatter ?? {}, content },
              null,
              2,
            )
          }
          if (format === 'document-map') {
            const cache = app.metadataCache.getFileCache(file as TFile)
            return JSON.stringify(
              {
                path: relativePath,
                frontmatter: cache?.frontmatter ?? {},
                headings: cache?.headings ?? [],
                tags: (cache?.tags ?? []).map((t) => t.tag),
                links: cache?.links ?? [],
              },
              null,
              2,
            )
          }
          throw new Error(`vault_get: unknown format "${format}"`)
        },
      },
    ]
  }
}
