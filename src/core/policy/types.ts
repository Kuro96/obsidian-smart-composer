/**
 * Policy 层接口 — Phase 1 接口定义
 *
 * 将权限与模式判断从 UI state、prompt 文案、McpManager 等多处收口到独立的 policy 层。
 *
 * 当前（Phase 1-4）：这些接口仅作为契约定义，实现在 Phase 5 完成。
 * Phase 5 之后：UI 和 TurnEngine 改为依赖这些接口，旧 McpManager.isToolExecutionAllowed() 被移除。
 */

import type { SessionMode } from '../mcp/mcpManager'

// ─── Approval Decision ───────────────────────────────────────────────────────

/**
 * 审批决策三档：
 * - 'allow'：直接自动执行，无需用户介入
 * - 'ask'：暂停，等待用户批准
 * - 'deny'：拒绝执行
 */
export type ApprovalDecision = 'allow' | 'ask' | 'deny'

// ─── SessionModePolicy ───────────────────────────────────────────────────────

/**
 * SessionModePolicy — session 模式（只读/读写）的单一数据源。
 *
 * 当前模式散落在：
 * - Chat.tsx sessionMode state
 * - promptGenerator.ts 只读文案约束
 * - McpManager.filterToolsBySessionMode()
 *
 * 重构后，这里成为唯一权威，UI 订阅此接口的变更。
 */
export interface SessionModePolicy {
  readonly mode: SessionMode

  setMode(mode: SessionMode): void

  /**
   * 订阅模式变更。
   * @returns 取消订阅函数
   */
  subscribe(callback: (mode: SessionMode) => void): () => void
}

// ─── ToolPermissionPolicy ────────────────────────────────────────────────────

/**
 * ToolPermissionPolicy — 决定工具的可见性与执行权限。
 *
 * 职责分工：
 * - isVisible：决定工具是否出现在发给 LLM 的工具列表中（read-only 模式下写工具不可见）
 * - getApprovalDecision：决定工具调用是自动执行、等待批准还是拒绝
 * - allowForConversation / allowPermanently：用户批准后更新规则
 *
 * 该接口整合了当前 McpManager.isToolExecutionAllowed() 和 allowToolForConversation() 的职责。
 */
export interface ToolPermissionPolicy {
  /**
   * 工具是否在当前 session 模式下可见（即是否应出现在 LLM 的工具列表中）。
   * read-only 模式下，tier 为 read-write 或 danger-zone 的工具不可见。
   */
  isVisible(toolName: string, mode: SessionMode): boolean

  /**
   * 获取工具调用的审批决策。
   * 优先级：会话级覆盖 > 永久覆盖 > toolOptions 配置 > policy 默认值。
   */
  getApprovalDecision(
    toolName: string,
    conversationId?: string,
  ): ApprovalDecision

  /**
   * 记录用户为本次会话批准了某工具的自动执行。
   * 对应 UI 中"Allow for this chat"操作。
   */
  allowForConversation(toolName: string, conversationId: string): void

  /**
   * 记录用户永久批准了某工具的自动执行。
   * 对应 UI 中"Always allow"操作。
   * 注意：永久批准应持久化到 settings。
   */
  allowPermanently(toolName: string): void
}

// ─── ApprovalPolicy ──────────────────────────────────────────────────────────

/**
 * ApprovalPolicy — 审批规则的存储与查询。
 *
 * 与 ToolPermissionPolicy 的分工：
 * - ToolPermissionPolicy：消费 ApprovalPolicy 的数据，结合 mode + tier 做最终决策
 * - ApprovalPolicy：纯粹的规则存储（会话级 + 全局级），不做策略合并
 *
 * 对应当前 McpManager.allowToolForConversation() 和 settings.toolOptions.allowAutoExecution。
 */
export interface ApprovalPolicy {
  /**
   * 某工具在指定会话中是否已被用户批准自动执行。
   */
  isAllowedForConversation(toolName: string, conversationId: string): boolean

  /**
   * 某工具是否有永久批准记录（来自 settings）。
   */
  isAllowedPermanently(toolName: string): boolean

  /**
   * 记录会话级批准。
   */
  setConversationApproval(toolName: string, conversationId: string): void

  /**
   * 记录永久批准（需要同步到 settings）。
   */
  setPermanentApproval(toolName: string): void

  /**
   * 清除某个会话的所有批准记录（会话结束时调用）。
   */
  clearConversationApprovals(conversationId: string): void
}
