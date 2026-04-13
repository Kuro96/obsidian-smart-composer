/**
 * WorkspaceToolPack — 活动笔记与 Obsidian UI 工具包（Phase 3）
 *
 * 包含：note_open
 */

import { App, TFile } from 'obsidian'

import type { ToolEntry, ToolRegistry } from '../ToolRegistry'
import { normalizeVaultPath } from '../vaultUtils'

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
          name: 'note_open',
          description:
            'Open a note in the Obsidian UI. This is a stateful UI operation — it changes the active leaf visible to the user.',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Vault-relative path of the note to open.',
              },
              newLeaf: {
                type: 'boolean',
                description:
                  'When true, open in a new tab instead of reusing an existing leaf. Default false.',
              },
              line: {
                type: 'number',
                description:
                  'Line number (1-indexed) to scroll to after opening.',
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
          const line =
            typeof args?.line === 'number' ? Math.max(1, args.line) : undefined
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
