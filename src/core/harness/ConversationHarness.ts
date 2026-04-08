/**
 * ConversationHarness — Phase 2 实现
 *
 * 会话级执行器，替代 ResponseGenerator 成为 UI 与执行层之间的边界。
 * 职责：
 * - 持有本次响应产生的新消息（responseMessages）
 * - 通过 TurnEngine 驱动单轮流式请求
 * - 通过 ToolExecutor 执行工具调用
 * - 通过 subscribe() 向 UI 推送消息变更
 *
 * 当前（Phase 2）：构造参数仍包含 McpManager / PromptGenerator，
 * 与旧 ResponseGenerator 保持接口相近，方便 useChatStreamManager 平滑切换。
 * Phase 5-6：UI 只调用 submit() / approveToolCall() / abort()，不再传入 messages。
 */

import { v4 as uuidv4 } from 'uuid'

import { BaseLLMProvider } from '../llm/base'
import { McpManager, SessionMode } from '../mcp/mcpManager'
import { ChatMessage, ChatToolMessage } from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import { LLMProvider } from '../../types/provider.types'
import {
  ToolCallResponseStatus,
} from '../../types/tool-call.types'
import { PromptGenerator } from '../../utils/chat/promptGenerator'

import { ToolExecutor } from './ToolExecutor'
import { TurnEngine } from './TurnEngine'

export type ConversationHarnessParams = {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  /** 初始消息列表（含用户历史消息），不含本次响应产生的新消息 */
  messages: ChatMessage[]
  conversationId: string
  enableTools: boolean
  enableSkills: boolean
  maxAutoIterations: number
  sessionMode: SessionMode
  promptGenerator: PromptGenerator
  mcpManager: McpManager
  abortSignal?: AbortSignal
}

export class ConversationHarness {
  private readonly receivedMessages: ChatMessage[]
  private readonly conversationId: string
  private readonly maxAutoIterations: number
  private readonly abortSignal?: AbortSignal

  private readonly turnEngine: TurnEngine
  private readonly toolExecutor: ToolExecutor

  /** 本次响应产生的新消息（不含 receivedMessages） */
  private responseMessages: ChatMessage[] = []
  private subscribers: ((messages: ChatMessage[]) => void)[] = []

  constructor(params: ConversationHarnessParams) {
    this.receivedMessages = params.messages
    this.conversationId = params.conversationId
    this.maxAutoIterations = Math.max(1, params.maxAutoIterations)
    this.abortSignal = params.abortSignal

    this.toolExecutor = new ToolExecutor(params.mcpManager)

    this.turnEngine = new TurnEngine({
      providerClient: params.providerClient,
      model: params.model,
      promptGenerator: params.promptGenerator,
      mcpManager: params.mcpManager,
      enableTools: params.enableTools,
      enableSkills: params.enableSkills,
      sessionMode: params.sessionMode,
    })
  }

  /** 订阅响应消息变更，返回取消订阅函数 */
  public subscribe(callback: (messages: ChatMessage[]) => void): () => void {
    this.subscribers.push(callback)
    return () => {
      this.subscribers = this.subscribers.filter((cb) => cb !== callback)
    }
  }

  /**
   * 执行完整的对话响应（可能包含多轮工具调用迭代）。
   * 通过 subscribe() 的回调实时推送消息变更。
   */
  public async run(): Promise<void> {
    for (let i = 0; i < this.maxAutoIterations; i++) {
      const allMessages = [
        ...this.receivedMessages,
        ...this.responseMessages,
      ]

      const { toolCallRequests } = await this.turnEngine.run({
        allMessages,
        abortSignal: this.abortSignal,
        onMessagesUpdate: (updater) => {
          this.responseMessages = updater(this.responseMessages)
          this.notifySubscribers()
        },
      })

      // 没有工具调用 → 对话完成
      if (toolCallRequests.length === 0) {
        return
      }

      // 构建工具消息，按权限决定自动执行还是等待审批
      const toolMessage: ChatToolMessage = {
        role: 'tool' as const,
        id: uuidv4(),
        toolCalls: toolCallRequests.map((req) => ({
          request: req,
          response: {
            status: this.toolExecutor.isAllowed(req.name, this.conversationId)
              ? ToolCallResponseStatus.Running
              : ToolCallResponseStatus.PendingApproval,
          },
        })),
      }

      this.responseMessages = [...this.responseMessages, toolMessage]
      this.notifySubscribers()

      // 并行执行所有允许自动执行的工具
      await Promise.all(
        toolMessage.toolCalls
          .filter(
            (tc) => tc.response.status === ToolCallResponseStatus.Running,
          )
          .map(async (tc) => {
            const response = await this.toolExecutor.execute({
              name: tc.request.name,
              args: tc.request.arguments,
              id: tc.request.id,
              signal: this.abortSignal,
            })
            this.responseMessages = this.responseMessages.map((msg) =>
              msg.id === toolMessage.id && msg.role === 'tool'
                ? {
                    ...msg,
                    toolCalls: msg.toolCalls.map((call) =>
                      call.request.id === tc.request.id
                        ? { ...call, response }
                        : call,
                    ),
                  }
                : msg,
            )
            this.notifySubscribers()
          }),
      )

      // 检查是否所有工具都已完成（Success 或 Error）
      // 如有 PendingApproval 或 Running 的工具，停止迭代，等待用户操作
      const updatedToolMessage = this.responseMessages.find(
        (msg) => msg.id === toolMessage.id && msg.role === 'tool',
      ) as ChatToolMessage | undefined

      const allCompleted = updatedToolMessage?.toolCalls.every((tc) =>
        [
          ToolCallResponseStatus.Success,
          ToolCallResponseStatus.Error,
        ].includes(tc.response.status),
      )

      if (!allCompleted) {
        return
      }
    }
  }

  private notifySubscribers(): void {
    this.subscribers.forEach((cb) => cb(this.responseMessages))
  }
}
