/**
 * ToolExecutor — Phase 5 更新
 *
 * 工具调用的统一执行入口。
 * Phase 5 变化：
 * - isAllowed() 改由 ToolPermissionPolicy 决策，移除对 McpManager.isToolExecutionAllowed() 的依赖
 * - McpManager 仅保留用于：① 外部 MCP 工具的 callTool() 回退 ② abortToolCall()
 */

import { McpManager } from '../mcp/mcpManager'
import { vaultAccessTracker } from '../tools/VaultAccessTracker'
import type { ToolRegistry } from '../tools/ToolRegistry'
import { normalizeVaultPath } from '../tools/vault-utils'
import type { ToolPermissionPolicy } from '../policy/types'
import { ToolCallResponse, ToolCallResponseStatus } from '../../types/tool-call.types'

export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissionPolicy: ToolPermissionPolicy,
    private readonly mcpManager: McpManager,
  ) {}

  /**
   * 判断某工具是否允许自动执行（无需用户审批）。
   * 委托 ToolPermissionPolicy.getApprovalDecision()。
   */
  isAllowed(toolName: string, conversationId: string): boolean {
    return this.permissionPolicy.getApprovalDecision(toolName, conversationId) === 'allow'
  }

  /**
   * 执行工具调用，返回结果。
   * 优先通过 ToolRegistry 查找 handler；若未注册则回退到 McpManager（兼容层）。
   */
  async execute(opts: {
    name: string
    args?: string | Record<string, unknown>
    id?: string
    conversationId: string
    signal?: AbortSignal
  }): Promise<ToolCallResponse> {
    const { name, args, id, signal, conversationId } = opts

    // 解析参数
    const parsedArgs: Record<string, unknown> =
      typeof args === 'string'
        ? args === ''
          ? {}
          : (() => { try { return JSON.parse(args) } catch { return {} } })()
        : (args ?? {})

    // 通过 ToolRegistry 查找 handler
    const entry = this.registry.resolve(name)
    if (entry) {
      const guardedPath = this.getReadRequiredPath(name, parsedArgs)
      if (guardedPath && !vaultAccessTracker.hasRead(conversationId, guardedPath)) {
        return {
          status: ToolCallResponseStatus.Error,
          error: `${name} requires a prior read of ${guardedPath} in this chat. Read the file first with vault_read or note_frontmatter_get.`,
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

    // 回退：委托 McpManager（外部 MCP / skill 尚未注册到 registry 的情况）
    return this.mcpManager.callTool({ name, args, id, signal })
  }

  /**
   * 中断某个正在执行的工具调用。
   */
  abort(id: string): boolean {
    return this.mcpManager.abortToolCall(id)
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
      toolName !== 'vault_move'
    ) {
      return null
    }

    const rawPath = args.path
    return typeof rawPath === 'string' && rawPath.trim().length > 0
      ? normalizeVaultPath(rawPath)
      : null
  }
}
