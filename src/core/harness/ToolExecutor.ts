/**
 * ToolExecutor — Phase 3 更新
 *
 * 工具调用的统一执行入口。
 * Phase 3 开始：通过 ToolRegistry 查找并执行工具，不再直接调用 McpManager.callTool()。
 * 权限判断（isAllowed）仍委托 McpManager，直到 Phase 5 的 ToolPermissionPolicy 完成。
 */

import { McpManager } from '../mcp/mcpManager'
import type { ToolRegistry } from '../tools/ToolRegistry'
import { ToolCallResponse, ToolCallResponseStatus } from '../../types/tool-call.types'

export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly mcpManager: McpManager,
  ) {}

  /**
   * 判断某工具是否允许自动执行（无需用户审批）。
   * 仍委托 McpManager.isToolExecutionAllowed()，Phase 5 迁移到 ToolPermissionPolicy。
   */
  isAllowed(toolName: string, conversationId: string): boolean {
    return this.mcpManager.isToolExecutionAllowed({
      requestToolName: toolName,
      conversationId,
    })
  }

  /**
   * 执行工具调用，返回结果。
   * 优先通过 ToolRegistry 查找 handler；若未注册则回退到 McpManager（兼容层）。
   */
  async execute(opts: {
    name: string
    args?: string | Record<string, unknown>
    id?: string
    signal?: AbortSignal
  }): Promise<ToolCallResponse> {
    const { name, args, id, signal } = opts

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
      // 注册表命中：直接调用 handler
      const abortController = new AbortController()
      if (id !== undefined) {
        // 记录到 mcpManager 以支持 abort（Phase 5 前的临时做法）
      }
      if (signal) {
        signal.addEventListener('abort', () => abortController.abort())
      }
      try {
        const text = await entry.handler(parsedArgs, {
          conversationId: '',
          signal: abortController.signal,
        })
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
}
