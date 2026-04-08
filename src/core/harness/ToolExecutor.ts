/**
 * ToolExecutor — Phase 5 更新
 *
 * 工具调用的统一执行入口。
 * Phase 5 变化：
 * - isAllowed() 改由 ToolPermissionPolicy 决策，移除对 McpManager.isToolExecutionAllowed() 的依赖
 * - McpManager 仅保留用于：① 外部 MCP 工具的 callTool() 回退 ② abortToolCall()
 */

import { App, TFile, TFolder, parseYaml, stringifyYaml } from 'obsidian'

import { McpManager } from '../mcp/mcpManager'
import type { ToolPermissionPolicy } from '../policy/types'
import { vaultAccessTracker } from '../tools/VaultAccessTracker'
import type { ToolRegistry } from '../tools/ToolRegistry'
import {
  ensureParentDirectory,
  getVaultAdapter,
  normalizeVaultPath,
} from '../tools/vaultUtils'
import {
  ProposedToolReview,
  ToolCallResponse,
  ToolCallResponseStatus,
} from '../../types/tool-call.types'

const STAGED_REVIEW_TOOLS = new Set([
  'vault_write',
  'vault_edit',
  'vault_append',
  'note_frontmatter_set',
  'note_frontmatter_delete',
  'vault_move',
  'vault_delete',
])

export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissionPolicy: ToolPermissionPolicy,
    private readonly mcpManager: McpManager,
    private readonly app: App,
  ) {}

  isAllowed(toolName: string, conversationId: string): boolean {
    return this.permissionPolicy.getApprovalDecision(toolName, conversationId) === 'allow'
  }

  shouldStageReview(toolName: string): boolean {
    return STAGED_REVIEW_TOOLS.has(toolName)
  }

  async execute(opts: {
    name: string
    args?: string | Record<string, unknown>
    id?: string
    conversationId: string
    signal?: AbortSignal
  }): Promise<ToolCallResponse> {
    const { name, args, id, signal, conversationId } = opts

    const parsedArgs: Record<string, unknown> =
      typeof args === 'string'
        ? args === ''
          ? {}
          : (() => {
              try {
                return JSON.parse(args)
              } catch {
                return {}
              }
            })()
        : (args ?? {})

    const entry = this.registry.resolve(name)
    if (entry) {
      const guardedPath = this.getReadRequiredPath(name, parsedArgs)
      if (guardedPath && !vaultAccessTracker.hasRead(conversationId, guardedPath)) {
        return {
          status: ToolCallResponseStatus.Error,
          error: `${name} requires a prior read of ${guardedPath} in this chat. Read the file first with vault_read or note_frontmatter_get.`,
        }
      }

      if (this.shouldStageReview(name)) {
        try {
          return {
            status: ToolCallResponseStatus.PendingReview,
            proposal: await this.buildReviewProposal(name, parsedArgs),
          }
        } catch (error) {
          return {
            status: ToolCallResponseStatus.Error,
            error: (error as Error).message || 'Unknown error occurred',
          }
        }
      }

      const abortController = new AbortController()
      if (signal) {
        signal.addEventListener('abort', () => abortController.abort())
      }

      try {
        const text = await entry.handler(parsedArgs, {
          conversationId,
          signal: abortController.signal,
        })
        const readPath = this.getReadEvidencePath(name, parsedArgs)
        if (readPath) {
          vaultAccessTracker.recordRead(conversationId, readPath)
        }
        return {
          status: ToolCallResponseStatus.Success,
          data: { type: 'text', text },
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          return { status: ToolCallResponseStatus.Aborted }
        }
        return {
          status: ToolCallResponseStatus.Error,
          error: (error as Error).message || 'Unknown error occurred',
        }
      }
    }

    return this.mcpManager.callTool({ name, args, id, signal })
  }

  async applyReview(opts: {
    proposal: ProposedToolReview
    conversationId: string
  }): Promise<ToolCallResponse> {
    const { proposal } = opts

    try {
      switch (proposal.kind) {
        case 'write':
        case 'edit':
        case 'append':
        case 'frontmatter': {
          const afterText = proposal.afterText
          if (typeof afterText !== 'string') {
            throw new Error(`Missing reviewed content for ${proposal.toolName}`)
          }
          const adapter = getVaultAdapter(this.app)
          const createDirectories = proposal.metadata?.createDirectories === true
          if (createDirectories) {
            await ensureParentDirectory(proposal.targetPath, adapter)
          }
          await adapter.write(proposal.targetPath, afterText)
          return {
            status: ToolCallResponseStatus.Success,
            data: { type: 'text', text: proposal.summary },
          }
        }
        case 'move': {
          const rawNewPath = proposal.metadata?.newPath
          if (typeof rawNewPath !== 'string') {
            throw new Error('Missing destination path for reviewed move')
          }
          const target = this.app.vault.getAbstractFileByPath(proposal.targetPath)
          if (!target) {
            throw new Error(`vault_move: path not found: ${proposal.targetPath}`)
          }
          await this.app.fileManager.renameFile(target, normalizeVaultPath(rawNewPath))
          return {
            status: ToolCallResponseStatus.Success,
            data: { type: 'text', text: proposal.summary },
          }
        }
        case 'delete': {
          const target = this.app.vault.getAbstractFileByPath(proposal.targetPath)
          if (!target) {
            throw new Error(`vault_delete: path not found: ${proposal.targetPath}`)
          }
          await this.app.vault.trash(target, true)
          return {
            status: ToolCallResponseStatus.Success,
            data: { type: 'text', text: proposal.summary },
          }
        }
      }
    } catch (error) {
      return {
        status: ToolCallResponseStatus.Error,
        error: (error as Error).message || 'Unknown error occurred',
      }
    }
  }

  abort(id: string): boolean {
    return this.mcpManager.abortToolCall(id)
  }

  private async buildReviewProposal(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ProposedToolReview> {
    switch (toolName) {
      case 'vault_write':
        return this.buildVaultWriteProposal(args)
      case 'vault_edit':
        return this.buildVaultEditProposal(args)
      case 'vault_append':
        return this.buildVaultAppendProposal(args)
      case 'note_frontmatter_set':
        return this.buildFrontmatterSetProposal(args)
      case 'note_frontmatter_delete':
        return this.buildFrontmatterDeleteProposal(args)
      case 'vault_move':
        return this.buildVaultMoveProposal(args)
      case 'vault_delete':
        return this.buildVaultDeleteProposal(args)
      default:
        throw new Error(`Unsupported reviewed tool: ${toolName}`)
    }
  }

  private async buildVaultWriteProposal(
    args: Record<string, unknown>,
  ): Promise<ProposedToolReview> {
    const rawPath = args.path
    const content = args.content
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      throw new Error('vault_write requires a non-empty "path"')
    }
    if (typeof content !== 'string') {
      throw new Error('vault_write requires a string "content"')
    }

    const targetPath = normalizeVaultPath(rawPath)
    const adapter = getVaultAdapter(this.app)
    const exists = adapter.exists ? await adapter.exists(targetPath) : false
    const beforeText = exists ? await adapter.read(targetPath) : undefined

    return {
      toolName: 'vault_write',
      targetPath,
      kind: 'write',
      beforeText,
      afterText: content,
      summary: exists
        ? `Overwrite ${targetPath}`
        : `Create ${targetPath}`,
      metadata: {
        createDirectories:
          typeof args.createDirectories === 'boolean' ? args.createDirectories : true,
      },
    }
  }

  private async buildVaultEditProposal(
    args: Record<string, unknown>,
  ): Promise<ProposedToolReview> {
    const rawPath = args.path
    const oldText = args.oldText
    const newText = args.newText
    const replaceAll = args.replaceAll === true
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0)
      throw new Error('vault_edit requires a non-empty "path"')
    if (typeof oldText !== 'string' || oldText.length === 0)
      throw new Error('vault_edit requires a non-empty string "oldText"')
    if (typeof newText !== 'string')
      throw new Error('vault_edit requires a string "newText"')

    const targetPath = normalizeVaultPath(rawPath)
    const adapter = getVaultAdapter(this.app)
    const beforeText = await adapter.read(targetPath)
    const occurrences = beforeText.split(oldText).length - 1
    if (occurrences === 0)
      throw new Error(`vault_edit could not find oldText in ${targetPath}`)
    if (!replaceAll && occurrences !== 1) {
      throw new Error(
        `vault_edit found ${occurrences} matches; set replaceAll=true or provide a more specific oldText`,
      )
    }

    return {
      toolName: 'vault_edit',
      targetPath,
      kind: 'edit',
      beforeText,
      afterText: replaceAll
        ? beforeText.split(oldText).join(newText)
        : beforeText.replace(oldText, newText),
      summary: `Edit ${targetPath}`,
    }
  }

  private async buildVaultAppendProposal(
    args: Record<string, unknown>,
  ): Promise<ProposedToolReview> {
    const rawPath = args.path
    const content = args.content
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0)
      throw new Error('vault_append requires a non-empty "path"')
    if (typeof content !== 'string')
      throw new Error('vault_append requires a string "content"')

    const targetPath = normalizeVaultPath(rawPath)
    const adapter = getVaultAdapter(this.app)
    const exists = adapter.exists ? await adapter.exists(targetPath) : false
    const ensureTrailingNewline = args.ensureTrailingNewline === true
    let beforeText = ''
    if (exists) {
      beforeText = await adapter.read(targetPath)
      if (
        ensureTrailingNewline &&
        beforeText.length > 0 &&
        !beforeText.endsWith('\n')
      ) {
        beforeText += '\n'
      }
    }

    return {
      toolName: 'vault_append',
      targetPath,
      kind: 'append',
      beforeText: exists ? beforeText : undefined,
      afterText: `${beforeText}${content}`,
      summary: exists
        ? `Append to ${targetPath}`
        : `Create and append to ${targetPath}`,
      metadata: {
        createDirectories:
          typeof args.createDirectories === 'boolean' ? args.createDirectories : true,
      },
    }
  }

  private async buildFrontmatterSetProposal(
    args: Record<string, unknown>,
  ): Promise<ProposedToolReview> {
    const rawPath = args.path
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0)
      throw new Error('note_frontmatter_set requires a non-empty "path"')

    const targetPath = normalizeVaultPath(rawPath)
    const file = this.app.vault.getFileByPath(targetPath)
    if (!file) throw new Error(`note_frontmatter_set: file not found: ${targetPath}`)

    const beforeText = await this.app.vault.read(file)
    const updates = args.updates as Record<string, unknown> | undefined
    const removeKeys = Array.isArray(args.removeKeys)
      ? (args.removeKeys as string[])
      : []
    const mergeArrays = args.mergeArrays === true

    return {
      toolName: 'note_frontmatter_set',
      targetPath,
      kind: 'frontmatter',
      beforeText,
      afterText: this.updateFrontmatterText(beforeText, (frontmatter) => {
        if (updates) {
          for (const [key, value] of Object.entries(updates)) {
            if (mergeArrays && Array.isArray(frontmatter[key]) && Array.isArray(value)) {
              frontmatter[key] = [
                ...new Set([...(frontmatter[key] as unknown[]), ...(value as unknown[])]),
              ]
            } else {
              frontmatter[key] = value
            }
          }
        }
        for (const key of removeKeys) {
          delete frontmatter[key]
        }
      }),
      summary: `Update frontmatter in ${targetPath}`,
    }
  }

  private async buildFrontmatterDeleteProposal(
    args: Record<string, unknown>,
  ): Promise<ProposedToolReview> {
    const rawPath = args.path
    const keys = Array.isArray(args.keys) ? (args.keys as string[]) : []
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0)
      throw new Error('note_frontmatter_delete requires a non-empty "path"')
    if (keys.length === 0)
      throw new Error('note_frontmatter_delete requires a non-empty "keys" array')

    const targetPath = normalizeVaultPath(rawPath)
    const file = this.app.vault.getFileByPath(targetPath)
    if (!file) throw new Error(`note_frontmatter_delete: file not found: ${targetPath}`)

    const beforeText = await this.app.vault.read(file)
    return {
      toolName: 'note_frontmatter_delete',
      targetPath,
      kind: 'frontmatter',
      beforeText,
      afterText: this.updateFrontmatterText(beforeText, (frontmatter) => {
        for (const key of keys) {
          delete frontmatter[key]
        }
      }),
      summary: `Delete frontmatter keys from ${targetPath}`,
    }
  }

  private async buildVaultMoveProposal(
    args: Record<string, unknown>,
  ): Promise<ProposedToolReview> {
    const rawPath = args.path
    const rawNewPath = args.newPath
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0)
      throw new Error('vault_move requires a non-empty "path"')
    if (typeof rawNewPath !== 'string' || rawNewPath.trim().length === 0)
      throw new Error('vault_move requires a non-empty "newPath"')

    const targetPath = normalizeVaultPath(rawPath)
    const newPath = normalizeVaultPath(rawNewPath)

    return {
      toolName: 'vault_move',
      targetPath,
      kind: 'move',
      summary: `Move ${targetPath} -> ${newPath}`,
      metadata: { newPath },
    }
  }

  private async buildVaultDeleteProposal(
    args: Record<string, unknown>,
  ): Promise<ProposedToolReview> {
    const rawPath = args.path
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0)
      throw new Error('vault_delete requires a non-empty "path"')

    const targetPath = normalizeVaultPath(rawPath)
    const target = this.app.vault.getAbstractFileByPath(targetPath)
    if (!target) throw new Error(`vault_delete: path not found: ${targetPath}`)

    let beforeText: string | undefined
    if (target instanceof TFile) {
      beforeText = await this.app.vault.read(target)
    }

    return {
      toolName: 'vault_delete',
      targetPath,
      kind: 'delete',
      beforeText,
      summary:
        target instanceof TFolder
          ? `Delete folder ${targetPath}`
          : `Delete file ${targetPath}`,
    }
  }

  private updateFrontmatterText(
    markdown: string,
    mutator: (frontmatter: Record<string, unknown>) => void,
  ): string {
    const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/)
    const rawFrontmatter = match?.[1] ?? ''
    const body = match ? markdown.slice(match[0].length) : markdown
    const parsed = rawFrontmatter.trim().length > 0
      ? ((parseYaml(rawFrontmatter) as Record<string, unknown> | null) ?? {})
      : {}

    mutator(parsed)

    const nextKeys = Object.keys(parsed)
    if (nextKeys.length === 0) {
      return body
    }

    const serialized = stringifyYaml(parsed).trimEnd()
    if (body.length === 0) {
      return `---\n${serialized}\n---\n`
    }

    return `---\n${serialized}\n---\n${body.replace(/^\n+/, '')}`
  }

  private getReadEvidencePath(
    toolName: string,
    args: Record<string, unknown>,
  ): string | null {
    if (toolName !== 'vault_read' && toolName !== 'note_frontmatter_get') {
      return null
    }

    const rawPath = args.path
    return typeof rawPath === 'string' && rawPath.trim().length > 0
      ? normalizeVaultPath(rawPath)
      : null
  }

  private getReadRequiredPath(
    toolName: string,
    args: Record<string, unknown>,
  ): string | null {
    if (
      toolName !== 'vault_edit' &&
      toolName !== 'vault_append' &&
      toolName !== 'note_frontmatter_set' &&
      toolName !== 'note_frontmatter_delete' &&
      toolName !== 'vault_move' &&
      toolName !== 'vault_write'
    ) {
      return null
    }

    const rawPath = args.path
    return typeof rawPath === 'string' && rawPath.trim().length > 0
      ? normalizeVaultPath(rawPath)
      : null
  }
}
