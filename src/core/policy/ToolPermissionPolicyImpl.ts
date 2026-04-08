/**
 * ToolPermissionPolicyImpl — ToolPermissionPolicy 接口的具体实现（Phase 5）
 *
 * 整合了当前 McpManager.isToolExecutionAllowed() 的全部逻辑，并增加了对新
 * settings.mcp.builtin.policy 的支持，同时向后兼容旧的 defaultAllowBuiltinReadWrite。
 *
 * 决策优先级（由高到低）：
 * 1. 会话级批准（ApprovalPolicy）
 * 2. danger-zone tier → 始终 'ask'
 * 3. read-only tier → 始终 'allow'
 * 4. read-write 内置工具 → settings.mcp.builtin.policy.readWriteDefault（或旧 key 兼容）
 * 5. 外部 MCP 工具 → server.toolOptions[toolName].allowAutoExecution
 * 6. 未知工具 → 'ask'
 */

import { InvalidToolNameException } from '../mcp/exception'
import { getBuiltinToolTier } from '../mcp/builtin-tool-tiers'
import { parseToolName } from '../mcp/tool-name-utils'
import type { ToolRegistry } from '../tools/ToolRegistry'
import type { SmartComposerSettings } from '../../settings/schema/setting.types'
import type { SessionMode } from '../mcp/mcpManager'
import type { ApprovalDecision, ApprovalPolicy, ToolPermissionPolicy } from './types'

export class ToolPermissionPolicyImpl implements ToolPermissionPolicy {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly approvalPolicy: ApprovalPolicy,
    private readonly getSettings: () => SmartComposerSettings,
  ) {}

  /**
   * 工具是否在当前 session 模式下对模型可见。
   * read-only 模式下，tier 为 read-write 或 danger-zone 的工具不可见。
   */
  isVisible(toolName: string, mode: SessionMode): boolean {
    if (mode === 'read-write') return true
    // read-only：只允许 read-only tier
    const tier = this.getTier(toolName)
    if (tier === 'read-write' || tier === 'danger-zone') return false
    return true
  }

  /**
   * 获取工具调用的审批决策。
   */
  getApprovalDecision(toolName: string, conversationId?: string): ApprovalDecision {
    // 1. 会话级批准优先
    if (
      conversationId &&
      this.approvalPolicy.isAllowedForConversation(toolName, conversationId)
    ) {
      return 'allow'
    }

    const tier = this.getTier(toolName)

    // 2. 内置工具按 tier 决策
    if (tier !== null) {
      if (tier === 'danger-zone') return 'ask'
      if (tier === 'read-only') return 'allow'
      // read-write：查 policy
      return this.readWriteDefault()
    }

    // 3. 外部 MCP 工具：查 server.toolOptions.allowAutoExecution
    try {
      const { serverName, toolName: originalName } = parseToolName(toolName)
      const settings = this.getSettings()
      const server = settings.mcp.servers.find((s) => s.id === serverName)
      if (!server) return 'ask'
      const opt = server.toolOptions[originalName]
      if (opt?.allowAutoExecution) return 'allow'
      return 'ask'
    } catch (e) {
      if (e instanceof InvalidToolNameException) return 'ask'
      throw e
    }
  }

  allowForConversation(toolName: string, conversationId: string): void {
    this.approvalPolicy.setConversationApproval(toolName, conversationId)
  }

  allowPermanently(_toolName: string): void {
    // Phase 6 统一处理；当前永久批准仍通过 McpManager.allowToolForConversation 写入 settings
  }

  // ─── 内部辅助 ──────────────────────────────────────────────────────────────

  private getTier(toolName: string) {
    // 优先从注册表获取（精确），回退到名称匹配
    const entry = this.registry.resolve(toolName)
    if (entry?.tier !== undefined) return entry.tier
    return getBuiltinToolTier(toolName)
  }

  private readWriteDefault(): ApprovalDecision {
    const settings = this.getSettings()
    // 新字段优先
    const newPolicy = (settings.mcp as { builtin?: { policy?: { readWriteDefault?: ApprovalDecision } } })
      .builtin?.policy?.readWriteDefault
    if (newPolicy) return newPolicy
    // 向后兼容旧字段
    return settings.chatOptions.defaultAllowBuiltinReadWrite ? 'allow' : 'ask'
  }
}
