/**
 * ToolExecutor — Phase 2 实现
 *
 * 工具调用的统一执行入口。
 * 当前（Phase 2-3）：委托给 McpManager，屏蔽 UI 对 McpManager 的直接依赖。
 * Phase 3 之后：改为通过 ToolRegistry.resolve() 查找 handler 执行，McpManager 降为适配器。
 */

import { McpManager } from '../mcp/mcpManager'
import { ToolCallResponse } from '../../types/tool-call.types'

export class ToolExecutor {
  constructor(private readonly mcpManager: McpManager) {}

  /**
   * 判断某工具是否允许自动执行（无需用户审批）。
   * 委托给 McpManager.isToolExecutionAllowed()。
   */
  isAllowed(toolName: string, conversationId: string): boolean {
    return this.mcpManager.isToolExecutionAllowed({
      requestToolName: toolName,
      conversationId,
    })
  }

  /**
   * 执行工具调用，返回结果。
   * 委托给 McpManager.callTool()。
   */
  async execute(opts: {
    name: string
    args?: string | Record<string, unknown>
    id?: string
    signal?: AbortSignal
  }): Promise<ToolCallResponse> {
    return this.mcpManager.callTool(opts)
  }

  /**
   * 中断某个正在执行的工具调用。
   */
  abort(id: string): boolean {
    return this.mcpManager.abortToolCall(id)
  }
}
