/**
 * MetadataToolPack — frontmatter / 属性 / 链接 / 结构化查询工具包（Phase 4）
 *
 * 新增工具（全部为之前的功能缺口）：
 *   读取：note_frontmatter_get, vault_properties_list, vault_property_values,
 *         vault_query_notes, note_links_get, note_backlinks_get
 *   写入：note_frontmatter_set, note_frontmatter_delete, vault_move
 */

import { App, TFile } from 'obsidian'

import type { ToolEntry, ToolRegistry } from '../ToolRegistry'
import { normalizeVaultPath } from '../vault-utils'

// ─── 内部工具函数 ──────────────────────────────────────────────────────────────

/** 从 frontmatter 中删除 Obsidian 内部字段 */
function cleanFrontmatter(fm: Record<string, unknown>): Record<string, unknown> {
  const result = { ...fm }
  delete result['position']
  return result
}

/** 从嵌套路径（如 "frontmatter.status"）读取字段值 */
function getFieldValue(
  noteData: NoteData,
  field: string,
): unknown {
  if (field.startsWith('frontmatter.')) {
    const key = field.slice('frontmatter.'.length)
    return noteData.frontmatter[key]
  }
  return (noteData as unknown as Record<string, unknown>)[field]
}

interface NoteData {
  path: string
  basename: string
  extension: string
  size: number
  ctime: number
  mtime: number
  tags: string[]
  frontmatter: Record<string, unknown>
  headings: unknown[]
  links: unknown[]
}

interface VaultQueryFilter {
  pathPrefix?: string
  pathContains?: string
  tagsAll?: string[]
  tagsAny?: string[]
  frontmatter?: Record<string, unknown>
  extension?: string
}

interface SortSpec {
  field: string
  direction?: 'asc' | 'desc'
}

// ─── MetadataToolPack ─────────────────────────────────────────────────────────

export class MetadataToolPack {
  constructor(private readonly app: App) {}

  registerAll(registry: ToolRegistry): void {
    for (const entry of this.buildEntries()) {
      registry.register(entry)
    }
  }

  private buildEntries(): ToolEntry[] {
    const app = this.app

    return [

      // ── note_frontmatter_get ──────────────────────────────────────────────

      {
        tool: {
          name: 'note_frontmatter_get',
          description: 'Read the frontmatter (YAML properties) of a specific note as a JSON object.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Vault-relative path of the note.' },
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
            throw new Error('note_frontmatter_get requires a non-empty "path"')
          const relativePath = normalizeVaultPath(rawPath)
          const file = app.vault.getFileByPath(relativePath)
          if (!file) throw new Error(`note_frontmatter_get: file not found: ${relativePath}`)
          const cache = app.metadataCache.getFileCache(file)
          return JSON.stringify(cleanFrontmatter(cache?.frontmatter ?? {}), null, 2)
        },
      },

      // ── note_frontmatter_set ──────────────────────────────────────────────

      {
        tool: {
          name: 'note_frontmatter_set',
          description:
            'Atomically update frontmatter fields in a note using Obsidian\'s official processFrontMatter API. Safe for concurrent access. Does not touch the note body.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Vault-relative path of the note.' },
              updates: {
                type: 'object',
                description: 'Key-value pairs to set or update in the frontmatter.',
              },
              removeKeys: {
                type: 'array',
                items: { type: 'string' },
                description: 'Frontmatter keys to remove.',
              },
              mergeArrays: {
                type: 'boolean',
                description:
                  'When true, array values in "updates" are merged with existing arrays (deduplication). Default false (replace).',
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
            throw new Error('note_frontmatter_set requires a non-empty "path"')
          const relativePath = normalizeVaultPath(rawPath)
          const file = app.vault.getFileByPath(relativePath)
          if (!file) throw new Error(`note_frontmatter_set: file not found: ${relativePath}`)

          const updates = args?.updates as Record<string, unknown> | undefined
          const removeKeys = Array.isArray(args?.removeKeys)
            ? (args.removeKeys as string[])
            : []
          const mergeArrays = args?.mergeArrays === true

          await app.fileManager.processFrontMatter(file, (fm) => {
            if (updates) {
              for (const [key, value] of Object.entries(updates)) {
                if (mergeArrays && Array.isArray(fm[key]) && Array.isArray(value)) {
                  fm[key] = [...new Set([...(fm[key] as unknown[]), ...(value as unknown[])])]
                } else {
                  fm[key] = value
                }
              }
            }
            for (const key of removeKeys) {
              delete fm[key]
            }
          })

          const changed = [
            ...(updates ? Object.keys(updates) : []),
            ...removeKeys,
          ]
          return `Updated frontmatter in ${relativePath} (keys: ${changed.join(', ')})`
        },
      },

      // ── note_frontmatter_delete ───────────────────────────────────────────

      {
        tool: {
          name: 'note_frontmatter_delete',
          description: 'Remove specific keys from a note\'s frontmatter. Uses Obsidian\'s processFrontMatter API.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Vault-relative path of the note.' },
              keys: {
                type: 'array',
                items: { type: 'string' },
                description: 'Frontmatter keys to delete.',
              },
            },
            required: ['path', 'keys'],
          },
        },
        tier: 'read-write',
        source: 'builtin',
        approvalRequired: false,
        handler: async (args) => {
          const rawPath = args?.path
          const keys = Array.isArray(args?.keys) ? (args.keys as string[]) : []
          if (typeof rawPath !== 'string' || rawPath.trim().length === 0)
            throw new Error('note_frontmatter_delete requires a non-empty "path"')
          if (keys.length === 0)
            throw new Error('note_frontmatter_delete requires a non-empty "keys" array')
          const relativePath = normalizeVaultPath(rawPath)
          const file = app.vault.getFileByPath(relativePath)
          if (!file) throw new Error(`note_frontmatter_delete: file not found: ${relativePath}`)
          await app.fileManager.processFrontMatter(file, (fm) => {
            for (const key of keys) delete fm[key]
          })
          return `Deleted frontmatter keys [${keys.join(', ')}] from ${relativePath}`
        },
      },

      // ── vault_move ────────────────────────────────────────────────────────

      {
        tool: {
          name: 'vault_move',
          description:
            'Move or rename a vault file or folder. Uses Obsidian\'s fileManager.renameFile() so wiki-links pointing to the file are updated automatically.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Vault-relative current path of the file or folder.' },
              newPath: { type: 'string', description: 'Vault-relative destination path (including filename).' },
            },
            required: ['path', 'newPath'],
          },
        },
        tier: 'read-write',
        source: 'builtin',
        approvalRequired: false,
        handler: async (args) => {
          const rawPath = args?.path
          const rawNewPath = args?.newPath
          if (typeof rawPath !== 'string' || rawPath.trim().length === 0)
            throw new Error('vault_move requires a non-empty "path"')
          if (typeof rawNewPath !== 'string' || rawNewPath.trim().length === 0)
            throw new Error('vault_move requires a non-empty "newPath"')
          const relativePath = normalizeVaultPath(rawPath)
          const newRelativePath = normalizeVaultPath(rawNewPath)
          const file = app.vault.getAbstractFileByPath(relativePath)
          if (!file) throw new Error(`vault_move: path not found: ${relativePath}`)
          await app.fileManager.renameFile(file, newRelativePath)
          return `Moved ${relativePath} → ${newRelativePath}`
        },
      },

      // ── vault_properties_list ─────────────────────────────────────────────

      {
        tool: {
          name: 'vault_properties_list',
          description:
            'List all frontmatter property names used across the vault, with occurrence counts. Useful for discovering what properties exist before querying.',
          inputSchema: {
            type: 'object',
            properties: {
              pathPrefix: {
                type: 'string',
                description: 'If set, only scan notes under this vault-relative path prefix.',
              },
              minCount: {
                type: 'number',
                description: 'Only include properties that appear at least this many times. Default 1.',
              },
            },
            required: [],
          },
        },
        tier: 'read-only',
        source: 'builtin',
        approvalRequired: false,
        handler: async (args) => {
          const pathPrefix = typeof args?.pathPrefix === 'string' ? args.pathPrefix : undefined
          const minCount = typeof args?.minCount === 'number' ? args.minCount : 1

          const propCounts: Record<string, number> = {}
          for (const file of app.vault.getMarkdownFiles()) {
            if (pathPrefix && !file.path.startsWith(pathPrefix)) continue
            const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {}
            for (const key of Object.keys(fm)) {
              if (key === 'position') continue
              propCounts[key] = (propCounts[key] ?? 0) + 1
            }
          }

          const result = Object.entries(propCounts)
            .filter(([, count]) => count >= minCount)
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count)

          return JSON.stringify(result, null, 2)
        },
      },

      // ── vault_property_values ─────────────────────────────────────────────

      {
        tool: {
          name: 'vault_property_values',
          description:
            'Get the value distribution of a specific frontmatter property across the vault. Answers "what values does property X take, and in which notes?"',
          inputSchema: {
            type: 'object',
            properties: {
              property: {
                type: 'string',
                description: 'The frontmatter property name to inspect.',
              },
              pathPrefix: {
                type: 'string',
                description: 'If set, only scan notes under this vault-relative path prefix.',
              },
              groupByValue: {
                type: 'boolean',
                description:
                  'When true (default), group results by value and include per-value file lists. When false, return a flat [{path, value}] list.',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of entries to return. Default 500.',
              },
            },
            required: ['property'],
          },
        },
        tier: 'read-only',
        source: 'builtin',
        approvalRequired: false,
        handler: async (args) => {
          const property = args?.property
          if (typeof property !== 'string' || property.trim().length === 0)
            throw new Error('vault_property_values requires a non-empty "property"')
          const pathPrefix = typeof args?.pathPrefix === 'string' ? args.pathPrefix : undefined
          const groupByValue = args?.groupByValue !== false
          const limit = typeof args?.limit === 'number' ? args.limit : 500

          const valueMap: Record<string, string[]> = {}
          for (const file of app.vault.getMarkdownFiles()) {
            if (pathPrefix && !file.path.startsWith(pathPrefix)) continue
            const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {}
            const value = fm[property]
            if (value === undefined || value === null) continue
            const valueStr = Array.isArray(value)
              ? JSON.stringify(value)
              : String(value)
            ;(valueMap[valueStr] ??= []).push(file.path)
          }

          if (groupByValue) {
            const result = Object.entries(valueMap)
              .map(([value, files]) => ({ value, count: files.length, files }))
              .sort((a, b) => b.count - a.count)
              .slice(0, limit)
            return JSON.stringify(result, null, 2)
          }

          const flat: { path: string; value: string }[] = []
          for (const [value, files] of Object.entries(valueMap)) {
            for (const p of files) {
              flat.push({ path: p, value })
              if (flat.length >= limit) break
            }
            if (flat.length >= limit) break
          }
          return JSON.stringify(flat, null, 2)
        },
      },

      // ── vault_query_notes ─────────────────────────────────────────────────

      {
        tool: {
          name: 'vault_query_notes',
          description:
            'Structured metadata query over all vault notes. Supports filter, field selection (select), sorting, and limiting. The most powerful way to retrieve notes that match specific criteria.',
          inputSchema: {
            type: 'object',
            properties: {
              filter: {
                type: 'object',
                description:
                  'Filter criteria. Fields: pathPrefix (string), pathContains (string), extension (string), tagsAll (string[]), tagsAny (string[]), frontmatter (object, exact-match key-value pairs).',
              },
              select: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Fields to include in each result. Supported: path, basename, extension, size, ctime, mtime, tags, headings, links, frontmatter.<key>. Omit to return all fields.',
              },
              sort: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    field: { type: 'string' },
                    direction: { type: 'string', enum: ['asc', 'desc'] },
                  },
                  required: ['field'],
                },
                description: 'Sort order. Applied after filtering. Supports the same field names as "select".',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results to return. Default 100.',
              },
            },
            required: [],
          },
        },
        tier: 'read-only',
        source: 'builtin',
        approvalRequired: false,
        handler: async (args) => {
          const filter = args?.filter as VaultQueryFilter | undefined
          const select = Array.isArray(args?.select)
            ? (args.select as string[])
            : undefined
          const sort = Array.isArray(args?.sort)
            ? (args.sort as SortSpec[])
            : undefined
          const limit = typeof args?.limit === 'number' ? args.limit : 100

          let results: Record<string, unknown>[] = []

          for (const file of app.vault.getMarkdownFiles()) {
            const cache = app.metadataCache.getFileCache(file)
            const tags = (cache?.tags ?? []).map((t) => t.tag)
            const frontmatter = cleanFrontmatter(cache?.frontmatter ?? {})

            // ── Apply filters ────────────────────────────────────────────
            if (filter) {
              if (filter.pathPrefix && !file.path.startsWith(filter.pathPrefix)) continue
              if (filter.pathContains && !file.path.includes(filter.pathContains)) continue
              if (filter.extension && file.extension !== filter.extension) continue
              if (
                filter.tagsAll &&
                filter.tagsAll.length > 0 &&
                !filter.tagsAll.every((tag) => tags.includes(tag))
              )
                continue
              if (
                filter.tagsAny &&
                filter.tagsAny.length > 0 &&
                !filter.tagsAny.some((tag) => tags.includes(tag))
              )
                continue
              if (filter.frontmatter) {
                const passes = Object.entries(filter.frontmatter).every(
                  ([key, val]) => frontmatter[key] === val,
                )
                if (!passes) continue
              }
            }

            const noteData: NoteData = {
              path: file.path,
              basename: file.basename,
              extension: file.extension,
              size: file.stat.size,
              ctime: file.stat.ctime,
              mtime: file.stat.mtime,
              tags,
              frontmatter,
              headings: cache?.headings ?? [],
              links: cache?.links ?? [],
            }

            // ── Apply field selection ────────────────────────────────────
            if (select && select.length > 0) {
              const projected: Record<string, unknown> = {}
              for (const field of select) {
                projected[field] = getFieldValue(noteData, field)
              }
              results.push(projected)
            } else {
              results.push(noteData as unknown as Record<string, unknown>)
            }
          }

          // ── Sort ──────────────────────────────────────────────────────
          if (sort && sort.length > 0) {
            results.sort((a, b) => {
              for (const spec of sort) {
                const dir = spec.direction === 'desc' ? -1 : 1
                const aRaw = a[spec.field]
                const bRaw = b[spec.field]
                if (aRaw === bRaw) continue
                if (aRaw == null) return dir
                if (bRaw == null) return -dir
                return aRaw < bRaw ? -dir : dir
              }
              return 0
            })
          }

          // ── Limit ─────────────────────────────────────────────────────
          if (limit > 0) results = results.slice(0, limit)

          return JSON.stringify(results, null, 2)
        },
      },

      // ── note_links_get ────────────────────────────────────────────────────

      {
        tool: {
          name: 'note_links_get',
          description:
            'Get all outgoing wiki-links and markdown links from a note, with resolved paths where available.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Vault-relative path of the note.' },
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
            throw new Error('note_links_get requires a non-empty "path"')
          const relativePath = normalizeVaultPath(rawPath)
          const file = app.vault.getFileByPath(relativePath)
          if (!file) throw new Error(`note_links_get: file not found: ${relativePath}`)

          const cache = app.metadataCache.getFileCache(file)
          const resolvedLinks = app.metadataCache.resolvedLinks[relativePath] ?? {}

          const links = (cache?.links ?? []).map((link) => ({
            original: link.original,
            displayText: link.displayText,
            link: link.link,
            resolvedPath:
              Object.keys(resolvedLinks).find(
                (p) => p.endsWith(`/${link.link}.md`) || p === `${link.link}.md`,
              ) ?? null,
          }))

          return JSON.stringify(links, null, 2)
        },
      },

      // ── note_backlinks_get ────────────────────────────────────────────────

      {
        tool: {
          name: 'note_backlinks_get',
          description:
            'Get all notes that link to the given note (incoming links / backlinks).',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Vault-relative path of the note to find backlinks for.' },
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
            throw new Error('note_backlinks_get requires a non-empty "path"')
          const relativePath = normalizeVaultPath(rawPath)

          const resolvedLinks = app.metadataCache.resolvedLinks
          const backlinks: { from: string; count: number }[] = []

          for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
            const count = targets[relativePath]
            if (count) backlinks.push({ from: sourcePath, count })
          }

          backlinks.sort((a, b) => b.count - a.count)
          return JSON.stringify(backlinks, null, 2)
        },
      },
    ]
  }
}
