/**
 * TurnEngine — Phase 2 实现
 *
 * 单轮流式请求的核心逻辑，从 ResponseGenerator.streamSingleResponse() 提取而来。
 * 负责：构建请求 → 流式调用 LLM → 累积工具调用 → 更新消息状态。
 *
 * 当前（Phase 2-3）：直接依赖 McpManager 和 PromptGenerator。
 * Phase 3 之后：改为依赖 ToolRegistry 和 ContextBuilder。
 */

import { v4 as uuidv4 } from 'uuid'

import { BaseLLMProvider } from '../llm/base'
import { McpManager, SessionMode } from '../mcp/mcpManager'
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

export type TurnEngineParams = {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  promptGenerator: PromptGenerator
  mcpManager: McpManager
  enableTools: boolean
  enableSkills: boolean
  sessionMode: SessionMode
}

export type TurnEngineRunOptions = {
  /** 本轮所有消息（含历史 + 当前 response 消息） */
  allMessages: ChatMessage[]
  abortSignal?: AbortSignal
  /**
   * 消息状态变更回调。
   * TurnEngine 通过此回调通知调用方（ConversationHarness）有新增或变更的消息。
   * `updater` 接收当前 response messages，返回更新后的列表。
   */
  onMessagesUpdate: (
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => void
}

export type TurnEngineResult = {
  /** 本轮 LLM 响应中产生的工具调用请求 */
  toolCallRequests: ToolCallRequest[]
}

export class TurnEngine {
  private readonly providerClient: BaseLLMProvider<LLMProvider>
  private readonly model: ChatModel
  private readonly promptGenerator: PromptGenerator
  private readonly mcpManager: McpManager
  private readonly enableTools: boolean
  private readonly enableSkills: boolean
  private readonly sessionMode: SessionMode

  constructor(params: TurnEngineParams) {
    this.providerClient = params.providerClient
    this.model = params.model
    this.promptGenerator = params.promptGenerator
    this.mcpManager = params.mcpManager
    this.enableTools = params.enableTools
    this.enableSkills = params.enableSkills
    this.sessionMode = params.sessionMode
  }

  /**
   * 执行一次 LLM 流式请求，收集工具调用请求。
   * 通过 `onMessagesUpdate` 实时推送消息变化（增量文本、annotations 等）。
   */
  async run(opts: TurnEngineRunOptions): Promise<TurnEngineResult> {
    const { allMessages, abortSignal, onMessagesUpdate } = opts

    // 1. 构建本轮请求消息
    const requestMessages = await this.promptGenerator.generateRequestMessages({
      messages: allMessages,
      sessionMode: this.sessionMode,
    })

    // 2. 构建工具列表
    const availableTools = this.enableTools
      ? await this.mcpManager.listAvailableTools({
          enableSkill: this.enableSkills,
          sessionMode: this.sessionMode,
        })
      : []

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
    for await (const chunk of stream) {
      const { updatedToolCalls } = this.processChunk(
        chunk,
        responseMessageId,
        accumulatedToolCalls,
        onMessagesUpdate,
      )
      accumulatedToolCalls = updatedToolCalls
    }

    // 6. 从累积的工具调用中提取有效的 ToolCallRequest
    const toolCallRequests: ToolCallRequest[] = Object.values(
      accumulatedToolCalls,
    ).reduce<ToolCallRequest[]>((acc, toolCall) => {
      if (!toolCall.function?.name) return acc
      acc.push({
        id: toolCall.id ?? uuidv4(),
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      })
      return acc
    }, [])

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
    if (!merged.find((x) => x.url_citation.url === a.url_citation.url)) {
      merged.push(a)
    }
  }
  return merged
}
