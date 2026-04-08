/**
 * ContextBuilder 接口 — Phase 1 接口定义
 *
 * 统一的上下文组装层。当前上下文注入分散在：
 * - promptGenerator.ts（skill section、只读约束、current file、RAG 内容、system prompt）
 * - Chat.tsx（会话状态传递）
 * - McpManager（skill prompt section）
 *
 * 重构后，所有上下文来源都通过 ContextSource 注册到 ContextBuilder，
 * ContextBuilder.build() 产出发给 LLM 的完整 system message + 消息列表。
 *
 * 当前（Phase 1-5）：此接口仅作为契约定义，实现在 Phase 6 完成。
 */

import type { ChatMessage } from '../../types/chat'
import type { RequestMessage } from '../../types/llm/request'
import type { SessionMode } from '../mcp/mcpManager'

// ─── Context Build Options ───────────────────────────────────────────────────

export interface ContextBuildOptions {
  /** 当前完整对话历史 */
  messages: ChatMessage[]

  /** 当前 session 模式，影响只读约束是否注入 */
  sessionMode: SessionMode

  /** 当前会话 ID，用于 RAG / skill cache 等 */
  conversationId: string

  /** 是否注入 vault / RAG 上下文 */
  useVaultSearch?: boolean
}

// ─── Built Context ───────────────────────────────────────────────────────────

export interface BuiltContext {
  /** 系统消息（包含 system prompt、custom instructions、skill section 等） */
  systemMessage: RequestMessage

  /** 处理后的历史消息（user / assistant / tool messages，已格式化为 LLM 请求格式） */
  messages: RequestMessage[]
}

// ─── Context Source ──────────────────────────────────────────────────────────

/**
 * ContextSource — 可插拔的上下文注入源。
 *
 * 每个来源负责生产自己的上下文片段（字符串），ContextBuilder 负责组合。
 * 来源包括：VaultContextSource、RagContextSource、SkillContextSource 等。
 */
export interface ContextSource {
  /** 来源唯一标识，用于调试和排序 */
  readonly id: string

  /**
   * 产出上下文片段。
   * 返回 null 表示此次无内容（例如 RAG 无相关结果）。
   */
  build(opts: ContextBuildOptions): Promise<string | null>
}

// ─── ContextBuilder Interface ─────────────────────────────────────────────────

/**
 * ContextBuilder — 统一上下文组装出口。
 *
 * 职责：
 * 1. 管理多个 ContextSource
 * 2. 调用各 source 并拼装 system message
 * 3. 格式化消息历史为 RequestMessage[]
 * 4. 输出 BuiltContext 供 TurnEngine 使用
 */
export interface ContextBuilder {
  /**
   * 注册一个上下文来源。
   * 同 id 的来源会覆盖。
   */
  registerSource(source: ContextSource): void

  /**
   * 注销一个上下文来源。
   */
  unregisterSource(id: string): void

  /**
   * 构建本轮请求的完整上下文。
   */
  build(opts: ContextBuildOptions): Promise<BuiltContext>
}
