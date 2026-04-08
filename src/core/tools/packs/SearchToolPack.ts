/**
 * SearchToolPack — 搜索工具包（Phase 3）
 *
 * 包含：tags_list, search_simple, search_dataview, search_jsonlogic
 * tags_list 归入此包（语义上属于"检索"范畴）。
 */

import { App } from 'obsidian'

import type { ToolEntry, ToolRegistry } from '../ToolRegistry'
import { applyJsonLogic } from '../vault-utils'

/** search_simple / search_text 共享实现 */
function makeSearchTextHandler(app: App): ToolEntry['handler'] {
  return async (args) => {
    const query = args?.query
    if (typeof query !== 'string' || query.trim().length === 0)
      throw new Error('search requires a non-empty "query"')
    const contextLength = typeof args?.contextLength === 'number' ? args.contextLength : 100
    const limit = typeof args?.limit === 'number' ? args.limit : 20
    const queryLower = query.toLowerCase()
    const allFiles = app.vault.getMarkdownFiles()
    const results: Array<{ path: string; matchType: 'filename' | 'content'; context?: string }> = []

    for (const file of allFiles) {
      if (results.length >= limit) break
      if (file.name.toLowerCase().includes(queryLower)) {
        results.push({ path: file.path, matchType: 'filename' })
        continue
      }
      const content = await app.vault.cachedRead(file)
      const idx = content.toLowerCase().indexOf(queryLower)
      if (idx !== -1) {
        const start = Math.max(0, idx - Math.floor(contextLength / 2))
        const end = Math.min(content.length, idx + query.length + Math.floor(contextLength / 2))
        results.push({ path: file.path, matchType: 'content', context: content.slice(start, end) })
      }
    }
    return JSON.stringify(results, null, 2)
  }
}

export class SearchToolPack {
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
          name: 'tags_list',
          description: 'List all tags used in the vault.',
          inputSchema: {
            type: 'object',
            properties: {
              includeCounts: {
                type: 'boolean',
                description: 'When true, include the usage count for each tag. Default false.',
              },
            },
            required: [],
          },
        },
        tier: 'read-only',
        source: 'builtin',
        approvalRequired: false,
        handler: async (args) => {
          const includeCounts = args?.includeCounts === true
          const tagsWithCounts = (
            app.metadataCache as typeof app.metadataCache & {
              getTags: () => Record<string, number>
            }
          ).getTags()
          if (includeCounts) return JSON.stringify(tagsWithCounts, null, 2)
          return JSON.stringify(Object.keys(tagsWithCounts).sort(), null, 2)
        },
      },

      {
        tool: {
          name: 'search_text',
          description:
            'Search vault notes by filename or content (alias for search_simple, preferred name going forward). Returns matching files with match type and an optional context snippet.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Text to search for (case-insensitive).' },
              contextLength: {
                type: 'number',
                description: 'Characters of surrounding context to include for content matches. Default 100.',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results to return. Default 20.',
              },
            },
            required: ['query'],
          },
        },
        tier: 'read-only',
        source: 'builtin',
        approvalRequired: false,
        handler: makeSearchTextHandler(app),
      },

      {
        tool: {
          name: 'search_simple',
          description:
            'Search vault notes by filename or content. Returns matching files with match type and an optional context snippet.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Text to search for (case-insensitive).' },
              contextLength: {
                type: 'number',
                description: 'Characters of surrounding context to include for content matches. Default 100.',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results to return. Default 20.',
              },
            },
            required: ['query'],
          },
        },
        tier: 'read-only',
        source: 'builtin',
        approvalRequired: false,
        handler: makeSearchTextHandler(app),
      },

      {
        tool: {
          name: 'search_dataview',
          description:
            'Execute a Dataview DQL query against the vault. Requires the Dataview plugin to be installed and enabled.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Dataview DQL query string.' },
            },
            required: ['query'],
          },
        },
        tier: 'read-only',
        source: 'builtin',
        approvalRequired: false,
        handler: async (args) => {
          const query = args?.query
          if (typeof query !== 'string' || query.trim().length === 0)
            throw new Error('search_dataview requires a non-empty "query"')
          const dvPlugin = (
            app as App & { plugins?: { plugins?: Record<string, { api?: unknown }> } }
          ).plugins?.plugins?.['dataview']
          if (!dvPlugin?.api)
            throw new Error('search_dataview: Dataview plugin is not installed or enabled')
          const dv = dvPlugin.api as {
            query: (q: string) => Promise<{ successful: boolean; value: unknown; error?: string }>
          }
          const result = await dv.query(query)
          if (!result.successful)
            throw new Error(`search_dataview: query failed: ${result.error ?? 'unknown error'}`)
          return JSON.stringify(result.value, null, 2)
        },
      },

      {
        tool: {
          name: 'search_jsonlogic',
          description:
            'Filter vault notes by metadata using a JSONLogic expression. Supported operators: ==, !=, <, <=, >, >=, and, or, not, in, var. The var operator accesses note fields: path, basename, extension, size, ctime, mtime, frontmatter.<key>, tags (array of strings).',
          inputSchema: {
            type: 'object',
            properties: {
              filter: { type: 'object', description: 'JSONLogic filter expression object.' },
            },
            required: ['filter'],
          },
        },
        tier: 'read-only',
        source: 'builtin',
        approvalRequired: false,
        handler: async (args) => {
          const filter = args?.filter
          if (filter === null || typeof filter !== 'object' || Array.isArray(filter))
            throw new Error('search_jsonlogic requires an object "filter"')
          const allFiles = app.vault.getMarkdownFiles()
          const matches: string[] = []
          for (const file of allFiles) {
            const cache = app.metadataCache.getFileCache(file)
            const noteData: Record<string, unknown> = {
              path: file.path,
              basename: file.basename,
              extension: file.extension,
              size: file.stat.size,
              ctime: file.stat.ctime,
              mtime: file.stat.mtime,
              frontmatter: cache?.frontmatter ?? {},
              tags: (cache?.tags ?? []).map((t) => t.tag),
            }
            if (applyJsonLogic(filter, noteData)) matches.push(file.path)
          }
          return JSON.stringify(matches, null, 2)
        },
      },
    ]
  }
}
