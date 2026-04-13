/**
 * ApprovalPolicyImpl — ApprovalPolicy 接口的具体实现（Phase 5）
 *
 * 存储两类批准记录：
 * - 会话级：用户在当前聊天中点击"Allow for this chat"
 * - 永久级：用户点击"Always allow"，持久化到 settings（由外部负责保存）
 *
 * 当前（Phase 5）：永久级批准直接来自 settings.mcp.servers[].toolOptions.allowAutoExecution，
 * 通过 getSettings() 读取，不在此类中另外维护状态。
 */

import type { ApprovalPolicy } from './types'

export class ApprovalPolicyImpl implements ApprovalPolicy {
  /** conversationId → Set<toolName> */
  private readonly conversationApprovals = new Map<string, Set<string>>()

  isAllowedForConversation(toolName: string, conversationId: string): boolean {
    return (
      this.conversationApprovals.get(conversationId)?.has(toolName) ?? false
    )
  }

  /**
   * 永久批准由 ToolPermissionPolicyImpl 从 settings 中读取，此处不维护状态。
   * 实现返回 false，让 ToolPermissionPolicy 负责查 settings。
   */
  isAllowedPermanently(_toolName: string): boolean {
    return false
  }

  setConversationApproval(toolName: string, conversationId: string): void {
    let set = this.conversationApprovals.get(conversationId)
    if (!set) {
      set = new Set<string>()
      this.conversationApprovals.set(conversationId, set)
    }
    set.add(toolName)
  }

  /** 永久批准写入 settings，由外部（ToolMessage.tsx → McpManager）负责 */
  setPermanentApproval(_toolName: string): void {
    // no-op：交由 McpManager.allowToolForConversation() 处理，Phase 6 再统一
  }

  clearConversationApprovals(conversationId: string): void {
    this.conversationApprovals.delete(conversationId)
  }
}
