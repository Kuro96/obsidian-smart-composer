/**
 * ConversationHarness — Phase 5 更新
 *
 * 会话级执行器，替代 ResponseGenerator 成为 UI 与执行层之间的边界。
 * Phase 5 变化：
 * - 创建并持有 ApprovalPolicyImpl 和 ToolPermissionPolicyImpl
 * - TurnEngine.run() 改为传入 registry + sessionMode（不再在构造时固定）
 * - ToolExecutor 使用 ToolPermissionPolicy 决策权限，不再依赖 McpManager.isToolExecutionAllowed()
 * - enableTools=false 时向 TurnEngine 传入 null registry（工具对 LLM 不可见）
 */

import { App } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import { BaseLLMProvider } from '../llm/base'
import { McpManager, SessionMode } from '../mcp/mcpManager'
import { ApprovalPolicyImpl } from '../policy/ApprovalPolicyImpl'
import { ToolPermissionPolicyImpl } from '../policy/ToolPermissionPolicyImpl'
import type { ApprovalPolicy } from '../policy/types'
import { buildToolRegistry } from '../tools/buildToolRegistry'
import type { ToolRegistry } from '../tools/ToolRegistry'
import { ToolRegistryImpl } from '../tools/ToolRegistryImpl'
import { ChatMessage, ChatToolMessage } from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import { LLMProvider } from '../../types/provider.types'
import type { SmartComposerSettings } from '../../settings/schema/setting.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { PromptGenerator } from '../../utils/chat/promptGenerator'

import { ToolExecutor } from './ToolExecutor'
import { TurnEngine } from './TurnEngine'

export type ConversationHarnessParams = {
  app: App
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
  /** 用于 ToolPermissionPolicy 读取当前设置（工具自动执行策略等） */
  getSettings: () => SmartComposerSettings
  /** 可选：外部传入的 ApprovalPolicy（跨 harness 实例共享会话级批准） */
  approvalPolicy?: ApprovalPolicy
  abortSignal?: AbortSignal
}

export class ConversationHarness {
  private readonly receivedMessages: ChatMessage[]
  private readonly conversationId: string
  private readonly maxAutoIterations: number
  private readonly enableTools: boolean
  private readonly sessionMode: SessionMode
  private readonly abortSignal?: AbortSignal
  private readonly mcpManager: McpManager

  private readonly turnEngine: TurnEngine
  private toolExecutor: ToolExecutor

  /** 构建完成后的 registry，run() 使用 */
  private builtRegistry: ToolRegistry = new ToolRegistryImpl()

  /** 本次响应产生的新消息（不含 receivedMessages） */
  private responseMessages: ChatMessage[] = []
  private subscribers: ((messages: ChatMessage[]) => void)[] = []

  /** registry 异步构建完成的 Promise，run() 会先 await 它 */
  private readonly registryReady: Promise<void>

  constructor(params: ConversationHarnessParams) {
    this.receivedMessages = params.messages
    this.conversationId = params.conversationId
    this.maxAutoIterations = Math.max(1, params.maxAutoIterations)
    this.enableTools = params.enableTools
    this.sessionMode = params.sessionMode
    this.abortSignal = params.abortSignal
    this.mcpManager = params.mcpManager

    // 初始化占位（run() 调用前会被替换）
    // 优先使用外部传入的 approvalPolicy（跨 harness 持久化），否则创建本地实例
    const approvalPolicy = params.approvalPolicy ?? new ApprovalPolicyImpl()
    const emptyRegistry = new ToolRegistryImpl()
    const emptyPermissionPolicy = new ToolPermissionPolicyImpl(
      emptyRegistry,
      approvalPolicy,
      params.getSettings,
    )
    this.toolExecutor = new ToolExecutor(emptyRegistry, emptyPermissionPolicy, params.mcpManager)

    // 异步构建 registry，完成后创建真正的 policy 和 executor
    this.registryReady = buildToolRegistry({
      app: params.app,
      mcpManager: params.mcpManager,
      enableSkills: params.enableSkills,
    }).then((registry) => {
      this.builtRegistry = registry
      const permissionPolicy = new ToolPermissionPolicyImpl(
        registry,
        approvalPolicy,
        params.getSettings,
      )
      this.toolExecutor = new ToolExecutor(registry, permissionPolicy, params.mcpManager)
    })

    this.turnEngine = new TurnEngine({
      providerClient: params.providerClient,
      model: params.model,
      promptGenerator: params.promptGenerator,
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
    // 确保 registry 已构建完成
    await this.registryReady

    // enableTools=false 时传 null，TurnEngine 不向 LLM 暴露任何工具
    const registry = this.enableTools ? this.builtRegistry : null

    for (let i = 0; i < this.maxAutoIterations; i++) {
      const allMessages = [
        ...this.receivedMessages,
        ...this.responseMessages,
      ]

      const { toolCallRequests } = await this.turnEngine.run({
        allMessages,
        registry,
        sessionMode: this.sessionMode,
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
          .filter((tc) => tc.response.status === ToolCallResponseStatus.Running)
          .map(async (tc) => {
            const response = await this.toolExecutor.execute({
              name: tc.request.name,
              args: tc.request.arguments,
              id: tc.request.id,
              conversationId: this.conversationId,
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
