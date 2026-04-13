/**
 * Harness 层接口 — Phase 1 接口定义
 *
 * TurnEngine 和 ConversationHarness 是重构后的核心执行层。
 * 当前对应 responseGenerator.ts 中的请求循环逻辑，但与 UI 完全解耦。
 *
 * 分工：
 * - TurnEngine：负责单轮执行（构建上下文 -> 调模型 -> 处理工具 -> 决定是否继续）
 * - ConversationHarness：负责会话生命周期（跨 turn 状态、abort、订阅者通知）
 *
 * 当前（Phase 1）：此接口仅作为契约定义，实现在 Phase 2 完成。
 */

import type { ChatMessage, ChatToolMessage } from '../../types/chat'
import type {
  ToolCallRequest,
  ToolCallResponse,
} from '../../types/tool-call.types'
import type { ContextBuilder } from '../context/types'
import type { SessionMode } from '../mcp/mcpManager'
import type { ToolPermissionPolicy } from '../policy/types'
import type { ToolRegistry } from '../tools/ToolRegistry'

// ─── Turn Delta ──────────────────────────────────────────────────────────────

/**
 * TurnDelta — TurnEngine 运行过程中产出的事件流。
 *
 * 订阅者（ConversationHarness / UI）按顺序消费这些事件以更新状态。
 */
export type TurnDelta =
  | {
      type: 'assistant-text'
      /** 增量文本内容 */
      content: string
    }
  | {
      type: 'assistant-reasoning'
      /** 增量推理内容（支持 thinking 模型） */
      reasoning: string
    }
  | {
      type: 'tool-start'
      /** 工具调用 ID */
      toolCallId: string
      /** 工具名称 */
      name: string
      /** 原始参数字符串（可能在流式过程中是不完整的 JSON） */
      argumentsDelta: string
    }
  | {
      type: 'tool-approval-required'
      /** 需要用户批准的工具调用 */
      request: ToolCallRequest
    }
  | {
      type: 'tool-result'
      toolCallId: string
      response: ToolCallResponse
    }
  | {
      type: 'turn-complete'
      /** 本轮是否因为有 pending approval 工具而暂停 */
      hasPendingApprovals: boolean
      /** 本轮是否应继续到下一轮（仍有工具结果需要处理） */
      shouldContinue: boolean
    }
  | {
      type: 'error'
      error: Error
    }

// ─── TurnEngine Options ──────────────────────────────────────────────────────

export type TurnEngineOptions = {
  /** 当前完整对话历史（含本轮用户消息） */
  messages: ChatMessage[]

  /** 会话 ID，用于审批策略查询 */
  conversationId: string

  /** 工具注册表，TurnEngine 从中获取工具列表和执行器 */
  registry: ToolRegistry

  /** 权限策略，决定工具可见性和审批 */
  policy: ToolPermissionPolicy

  /** 上下文构建器 */
  contextBuilder: ContextBuilder

  /** 当前 session 模式 */
  sessionMode: SessionMode

  /** 最大自动迭代轮数 */
  maxIterations: number

  /** AbortSignal，用于中断 */
  signal?: AbortSignal
}

// ─── TurnEngine Interface ─────────────────────────────────────────────────────

/**
 * TurnEngine — 单轮执行引擎。
 *
 * 核心循环（每次 run() 可能包含多轮工具调用迭代）：
 * 1. contextBuilder.build() 构建本轮上下文
 * 2. registry.list() 获取当前可见工具列表
 * 3. LLMDriver.stream() 流式获取响应
 * 4. 遇到 tool_use 时：通过 policy 决定 allow/ask/deny，执行或等待批准
 * 5. 工具执行完毕后进入下一迭代，直到没有工具调用或达到 maxIterations
 */
export type TurnEngine = {
  /**
   * 执行一次完整的 turn（可能包含多轮工具调用迭代）。
   * 通过 onDelta 回调流式推送事件。
   */
  run(
    opts: TurnEngineOptions,
    onDelta: (delta: TurnDelta) => void,
  ): Promise<void>
}

// ─── ConversationHarness Options ─────────────────────────────────────────────

export type ConversationHarnessOptions = {
  conversationId: string
  registry: ToolRegistry
  policy: ToolPermissionPolicy
  contextBuilder: ContextBuilder
  sessionMode: SessionMode
  maxAutoIterations: number
}

// ─── ConversationHarness Interface ───────────────────────────────────────────

/**
 * ConversationHarness — 会话级执行器。
 *
 * 职责：
 * - 管理跨 turn 的消息历史
 * - 处理 abort
 * - 通知 UI 订阅者（状态更新）
 * - 处理 pending approval 工具的恢复执行
 *
 * UI 只与 ConversationHarness 交互，不直接调用 TurnEngine / ToolRegistry。
 */
export type ConversationHarness = {
  /**
   * 提交新的用户消息并启动一轮对话。
   * 通过 subscribe() 的回调推送更新。
   */
  submit(userMessage: ChatMessage): Promise<void>

  /**
   * 用户批准某工具调用后，恢复暂停的执行。
   */
  approveToolCall(toolCallId: string): Promise<void>

  /**
   * 用户拒绝某工具调用后，以拒绝结果继续对话。
   */
  rejectToolCall(toolCallId: string): void

  /**
   * 中断当前正在进行的 turn。
   */
  abort(): void

  /**
   * 订阅消息列表变更。
   * @returns 取消订阅函数
   */
  subscribe(callback: (messages: ChatMessage[]) => void): () => void

  /**
   * 向当前会话注入工具消息（用于恢复持久化的 pending tool 状态）。
   */
  injectToolMessage(toolMessage: ChatToolMessage): void
}
