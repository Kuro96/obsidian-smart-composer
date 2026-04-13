/**
 * TurnEngine — Phase 5 更新
 *
 * 单轮流式请求的核心逻辑。
 * Phase 5 变化：
 * - 移除 McpManager 依赖（不再调用 listAvailableTools）
 * - 工具列表改由 run() 传入的 ToolRegistry 提供，按 sessionMode 过滤
 * - sessionMode 从构造参数移至 run() 选项（每轮可动态传入）
 */

import { v4 as uuidv4 } from 'uuid'

import { ChatMessage } from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import { RequestTool } from '../../types/llm/request'
import {
  Annotation,
  LLMResponseStreaming,
  ToolCallDelta,
} from '../../types/llm/response'
import { LLMProvider } from '../../types/provider.types'
import { ToolCallRequest } from '../../types/tool-call.types'
import { fetchAnnotationTitles } from '../../utils/chat/fetch-annotation-titles'
import { PromptGenerator } from '../../utils/chat/promptGenerator'
import { BaseLLMProvider } from '../llm/base'
import { SessionMode } from '../mcp/mcpManager'
import type { ToolRegistry } from '../tools/ToolRegistry'

export type TurnEngineParams = {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  promptGenerator: PromptGenerator
}

export type TurnEngineRunOptions = {
  /** 本轮所有消息（含历史 + 当前 response 消息） */
  allMessages: ChatMessage[]
  /**
   * 工具注册表。null 表示本轮禁用工具（不传 tools 给 LLM）。
   * Phase 5 开始由 ConversationHarness 在 run() 时传入，而非构造时固定。
   */
  registry: ToolRegistry | null
  /** 当前 session 模式，用于工具可见性过滤 */
  sessionMode: SessionMode
  abortSignal?: AbortSignal
  /**
   * 消息状态变更回调。
   * TurnEngine 通过此回调通知调用方（ConversationHarness）有新增或变更的消息。
   */
  onMessagesUpdate: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void
  onToolCallsReady?: (toolCallRequests: ToolCallRequest[]) => void
}

export type TurnEngineResult = {
  /** 本轮 LLM 响应中产生的工具调用请求 */
  toolCallRequests: ToolCallRequest[]
}

export class TurnEngine {
  private readonly providerClient: BaseLLMProvider<LLMProvider>
  private readonly model: ChatModel
  private readonly promptGenerator: PromptGenerator

  constructor(params: TurnEngineParams) {
    this.providerClient = params.providerClient
    this.model = params.model
    this.promptGenerator = params.promptGenerator
  }

  /**
   * 执行一次 LLM 流式请求，收集工具调用请求。
   * 通过 `onMessagesUpdate` 实时推送消息变化（增量文本、annotations 等）。
   */
  async run(opts: TurnEngineRunOptions): Promise<TurnEngineResult> {
    const {
      allMessages,
      abortSignal,
      onMessagesUpdate,
      registry,
      sessionMode,
      onToolCallsReady,
    } = opts

    // 1. 构建本轮请求消息
    const requestMessages = await this.promptGenerator.generateRequestMessages({
      messages: allMessages,
    })

    // 2. 从 ToolRegistry 获取按 sessionMode 过滤后的工具列表
    const availableTools = registry ? registry.list({ mode: sessionMode }) : []

    const tools: RequestTool[] | undefined =
      availableTools.length > 0
        ? availableTools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: {
                ...tool.inputSchema,
                properties: tool.inputSchema.properties ?? {},
              },
            },
          }))
        : undefined

    // 3. 发起流式请求
    const stream = await this.providerClient.streamResponse(
      this.model,
      {
        model: this.model.model,
        messages: requestMessages,
        tools,
        stream: true,
      },
      { signal: abortSignal },
    )

    // 4. 初始化本轮 assistant 消息
    const responseMessageId = uuidv4()
    onMessagesUpdate((prev) => [
      ...prev,
      {
        role: 'assistant' as const,
        content: '',
        id: responseMessageId,
        metadata: { model: this.model },
      },
    ])

    // 5. 消费流式数据
    let accumulatedToolCalls: Record<number, ToolCallDelta> = {}
    let didNotifyToolCalls = false
    for await (const chunk of stream) {
      const { updatedToolCalls } = this.processChunk(
        chunk,
        responseMessageId,
        accumulatedToolCalls,
        onMessagesUpdate,
      )
      accumulatedToolCalls = updatedToolCalls

      const finishReason = chunk.choices[0]?.finish_reason
      if (
        !didNotifyToolCalls &&
        (finishReason === 'tool_calls' || finishReason === 'function_call')
      ) {
        const toolCallRequests =
          this.extractToolCallRequests(accumulatedToolCalls)
        if (toolCallRequests.length > 0) {
          didNotifyToolCalls = true
          onMessagesUpdate((prev) =>
            prev.map((msg) =>
              msg.id === responseMessageId && msg.role === 'assistant'
                ? {
                    ...msg,
                    toolCallRequests,
                  }
                : msg,
            ),
          )
          onToolCallsReady?.(toolCallRequests)
        }
      }
    }

    // 6. 从累积的工具调用中提取有效的 ToolCallRequest
    const toolCallRequests = this.extractToolCallRequests(accumulatedToolCalls)

    // 7. 将工具调用请求写回 assistant 消息
    onMessagesUpdate((prev) =>
      prev.map((msg) =>
        msg.id === responseMessageId && msg.role === 'assistant'
          ? {
              ...msg,
              toolCallRequests:
                toolCallRequests.length > 0 ? toolCallRequests : undefined,
            }
          : msg,
      ),
    )

    return { toolCallRequests }
  }

  private extractToolCallRequests(
    accumulatedToolCalls: Record<number, ToolCallDelta>,
  ): ToolCallRequest[] {
    return Object.values(accumulatedToolCalls).reduce<ToolCallRequest[]>(
      (acc, toolCall) => {
        if (!toolCall.function?.name) return acc
        acc.push({
          id: toolCall.id ?? uuidv4(),
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        })
        return acc
      },
      [],
    )
  }

  private processChunk(
    chunk: LLMResponseStreaming,
    responseMessageId: string,
    existingToolCalls: Record<number, ToolCallDelta>,
    onMessagesUpdate: TurnEngineRunOptions['onMessagesUpdate'],
  ): { updatedToolCalls: Record<number, ToolCallDelta> } {
    const content = chunk.choices[0]?.delta?.content ?? ''
    const reasoning = chunk.choices[0]?.delta?.reasoning
    const toolCalls = chunk.choices[0]?.delta?.tool_calls
    const annotations = chunk.choices[0]?.delta?.annotations
    const providerMetadata = chunk.choices[0]?.delta?.providerMetadata

    const updatedToolCalls = toolCalls
      ? this.mergeToolCallDeltas(toolCalls, existingToolCalls)
      : existingToolCalls

    if (annotations) {
      fetchAnnotationTitles(annotations, (url, title) => {
        onMessagesUpdate((prev) =>
          prev.map((msg) =>
            msg.id === responseMessageId && msg.role === 'assistant'
              ? {
                  ...msg,
                  annotations: msg.annotations?.map((a) =>
                    a.type === 'url_citation' && a.url_citation.url === url
                      ? {
                          ...a,
                          url_citation: {
                            ...a.url_citation,
                            title: title ?? undefined,
                          },
                        }
                      : a,
                  ),
                }
              : msg,
          ),
        )
      })
    }

    onMessagesUpdate((prev) =>
      prev.map((msg) =>
        msg.id === responseMessageId && msg.role === 'assistant'
          ? {
              ...msg,
              content: msg.content + content,
              reasoning: reasoning
                ? (msg.reasoning ?? '') + reasoning
                : msg.reasoning,
              annotations: mergeAnnotations(msg.annotations, annotations),
              metadata: {
                ...msg.metadata,
                usage: chunk.usage ?? msg.metadata?.usage,
              },
              providerMetadata: msg.providerMetadata ?? providerMetadata,
            }
          : msg,
      ),
    )

    return { updatedToolCalls }
  }

  private mergeToolCallDeltas(
    incoming: ToolCallDelta[],
    existing: Record<number, ToolCallDelta>,
  ): Record<number, ToolCallDelta> {
    const merged = { ...existing }
    for (const tc of incoming) {
      const { index } = tc
      if (!merged[index]) {
        merged[index] = tc
        continue
      }
      const prev = merged[index]
      const mergedTc: ToolCallDelta = {
        index,
        id: prev.id ?? tc.id,
        type: prev.type ?? tc.type,
      }
      if (prev.function || tc.function) {
        const existingArgs = prev.function?.arguments
        const newArgs = tc.function?.arguments
        mergedTc.function = {
          name: prev.function?.name ?? tc.function?.name,
          arguments:
            existingArgs || newArgs
              ? [existingArgs ?? '', newArgs ?? ''].join('')
              : undefined,
        }
      }
      merged[index] = mergedTc
    }
    return merged
  }
}

function mergeAnnotations(
  prev?: Annotation[],
  next?: Annotation[],
): Annotation[] | undefined {
  if (!prev) return next
  if (!next) return prev
  const merged = [...prev]
  for (const a of next) {
    if (!merged.find((x) => x.url_citation.url === a.url_citation.url))
      merged.push(a)
  }
  return merged
}
