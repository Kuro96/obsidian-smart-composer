/**
 * ContextBuilder — Phase 6 cache 友好的请求消息组装
 *
 * 重构动机（cache 复用）：
 * 旧 promptGenerator 的组装顺序为：
 *   system(按 shouldUseRAG 二选一) → customInstr → skill → currentFile → history
 *
 * 这导致 prompt cache 频繁失效：
 * 1. system message 按 per-message 的 shouldUseRAG 二选一 → 整个 prefix 失效
 * 2. currentFile 作为独立 message 出现在 history 之前 → 用户编辑当前文件后，
 *    后续整个 history 的 cache 都被打断
 * 3. currentFile 每轮 generateRequestMessages 时重新读取 → 多轮 tool call 中
 *    跨 turn 的 cache 也会因 currentFile 变化而失效
 *
 * 新顺序（cache 友好）：
 *   1. 稳定 prefix：system(单一版本，由 settings.vaultChatEnabled 决定，会话级稳定)
 *      → projectInstr(来自 AGENTS.md / settings fallback) → skill(来自 settings/mcp)
 *   2. 历史消息：含已发送的 user message。currentFile snapshot 在 compileUserMessagePrompt
 *      阶段已嵌入到各 user message 的 promptContent，所以 history 是稳定快照
 *   3. 末尾：rag 引用指令（仅当 vaultChatEnabled，会话级稳定）
 *
 * 这样：
 * - system 稳定 → prefix 不会因 RAG 切换而失效
 * - currentFile 跟随 user message 一起被快照 → 用户编辑文件不影响历史 cache
 * - 多轮 tool call 中，前一 turn 已经发送的内容（含 user message）完全可缓存
 */

import { App } from 'obsidian'

import { SmartComposerSettings } from '../../settings/schema/setting.types'
import {
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
} from '../../types/chat'
import { RequestMessage } from '../../types/llm/request'
import { PromptLevel } from '../../types/prompt-level.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import { AgentsManager } from '../agents/AgentsManager'
import { McpManager } from '../mcp/mcpManager'

const MAX_CONTEXT_MESSAGES = 20

export class ContextBuilder {
  constructor(
    private readonly app: App,
    private readonly settings: SmartComposerSettings,
    private readonly getMcpManager?: () => Promise<McpManager>,
  ) {}

  /**
   * 组装本轮请求的完整 RequestMessage 列表。
   *
   * 调用方需先把所有 user message 通过 compileUserMessagePrompt 编译过，
   * 此处仅消费 promptContent，不再读取 vault / 抓取 URL / 调 RAG。
   */
  public async build({
    compiledMessages,
  }: {
    compiledMessages: ChatMessage[]
  }): Promise<RequestMessage[]> {
    // ─── 稳定 prefix ───────────────────────────────────────────────
    const systemMessage = this.getSystemMessage()
    const customInstructionMessage = await this.getCustomInstructionMessage()
    const skillMessage = await this.getSkillMessage()

    // ─── 历史消息（含 user / assistant / tool） ─────────────────────
    // user message 自带 currentFile snapshot 与 RAG 结果，这里只是格式化
    const chatHistoryMessages = this.getChatHistoryMessages({
      messages: compiledMessages,
    })

    // ─── 末尾 RAG 引用指令（会话级稳定） ─────────────────────────────
    const ragInstructionMessage =
      this.settings.vaultChatEnabled &&
      this.getModelPromptLevel() === PromptLevel.Default
        ? this.getRagInstructionMessage()
        : null

    return [
      systemMessage,
      ...(customInstructionMessage ? [customInstructionMessage] : []),
      ...(skillMessage ? [skillMessage] : []),
      ...chatHistoryMessages,
      ...(ragInstructionMessage ? [ragInstructionMessage] : []),
    ]
  }

  // ─── System Message ─────────────────────────────────────────────────────────

  /**
   * 系统消息：由 settings.vaultChatEnabled（会话级稳定）决定，不再使用 per-message
   * 的 shouldUseRAG，避免 prompt cache 频繁失效。
   */
  private getSystemMessage(): RequestMessage {
    const modelPromptLevel = this.getModelPromptLevel()
    // 用 settings flag 而不是 per-message shouldUseRAG，会话内稳定
    const useRagSystemPrompt = this.settings.vaultChatEnabled

    const systemPrompt = `You are an intelligent assistant to help answer any questions that the user has${modelPromptLevel == PromptLevel.Default ? `, particularly about editing and organizing markdown files in Obsidian` : ''}.

1. Please keep your response as concise as possible. Avoid being verbose.

2. Do not lie or make up facts.

3. Format your response in markdown.

${
  modelPromptLevel == PromptLevel.Default
    ? `4. Respond in the same language as the user's message.

5. Before answering, first check whether a dedicated built-in tool can do the work more directly than plain text. If it can, use the tool.

6. Prefer the most specific tool available for the job:
   - Use \`vault_read\` for reading files.
   - Use \`vault_edit\` for normal file updates.
   - Use \`vault_write\` only for creating new files or near-complete rewrites.
   - Use \`note_frontmatter_set\` or \`note_frontmatter_delete\` for frontmatter changes instead of editing YAML manually.
   - Use \`vault_move\` for rename or move operations.
   - Use query/search tools before blindly reading many files.

7. Before modifying an existing file, read it first in this conversation. Do not overwrite existing files blindly.

8. When a relevant tool can perform the action, do not ask the user to manually apply edits that you could perform through tools.

9. If tools are not suitable for the request, provide the smallest useful markdown snippet or explanation. Do not use <smtcmp_block> tags for normal editing responses.
`
    : ''
}`

    const systemPromptRAG = `You are an intelligent assistant to help answer any questions that the user has${modelPromptLevel == PromptLevel.Default ? `, particularly about editing and organizing markdown files in Obsidian` : ''}. You will be given your conversation history with them and potentially relevant blocks of markdown content from the current vault.

1. Do not lie or make up facts.

2. Format your response in markdown.

${
  modelPromptLevel == PromptLevel.Default
    ? `3. Respond in the same language as the user's message.

4. Before answering, first check whether a dedicated built-in tool can do the work more directly than plain text. If it can, use the tool.

5. Prefer the most specific tool available for the job:
   - Use \`vault_read\` for reading files.
   - Use \`vault_edit\` for normal file updates.
   - Use \`vault_write\` only for creating new files or near-complete rewrites.
   - Use \`note_frontmatter_set\` or \`note_frontmatter_delete\` for frontmatter changes.
   - Use \`vault_move\` for rename or move operations.

6. Before modifying an existing file, read it first in this conversation. Do not overwrite existing files blindly.

7. When quoting or summarizing provided markdown snippets, never include any \`line_number|\` prefixes in the output.

8. If tools are not suitable for the request, provide the smallest useful markdown snippet or explanation. Do not use <smtcmp_block> tags for normal editing responses.`
    : ''
}`

    return {
      role: 'system',
      content: useRagSystemPrompt ? systemPromptRAG : systemPrompt,
    }
  }

  // ─── Custom Instructions ────────────────────────────────────────────────────

  private async getCustomInstructionMessage(): Promise<RequestMessage | null> {
    const agentsManager = new AgentsManager(this.app)
    const agentsInstructions = (await agentsManager.getSnapshot()).content
    const customInstruction =
      agentsInstructions || this.settings.systemPrompt.trim()
    if (!customInstruction) {
      return null
    }

    return {
      role: 'user',
      content: `Here are additional instructions to follow in your responses when relevant. There's no need to explicitly acknowledge them:
<custom_instructions>
${customInstruction}
</custom_instructions>`,
    }
  }

  // ─── Skill Catalog ──────────────────────────────────────────────────────────

  private async getSkillMessage(): Promise<RequestMessage | null> {
    if (
      !this.settings.chatOptions.enableTools ||
      !this.settings.chatOptions.enableSkills ||
      !this.getMcpManager
    ) {
      return null
    }
    const mcpManager = await this.getMcpManager()
    const section = await mcpManager.getSkillPromptSection()
    return {
      role: 'system',
      content: section,
    }
  }

  // ─── RAG Instruction (会话级稳定) ────────────────────────────────────────────

  private getRagInstructionMessage(): RequestMessage {
    return {
      role: 'user',
      content: `When referencing or quoting the markdown snippets I gave you, do not include "line_number|" prefixes in the output. Quote only the relevant excerpt in normal markdown when needed, and prefer tools for any real vault operation.`,
    }
  }

  // ─── Chat History 格式化 ────────────────────────────────────────────────────

  private getChatHistoryMessages({
    messages,
  }: {
    messages: ChatMessage[]
  }): RequestMessage[] {
    const requestMessages: RequestMessage[] = messages
      .slice(-MAX_CONTEXT_MESSAGES)
      .flatMap((message): RequestMessage[] => {
        if (message.role === 'user') {
          // 假定所有 user message 已经被 compileUserMessagePrompt 编译过
          return [
            {
              role: 'user',
              content: message.promptContent ?? '',
            },
          ]
        } else if (message.role === 'assistant') {
          return this.parseAssistantMessage({ message })
        } else {
          return this.parseToolMessage({ message })
        }
      })

    // 过滤掉孤儿 tool call / tool message
    const filteredRequestMessages: RequestMessage[] = requestMessages
      .map((msg) => {
        switch (msg.role) {
          case 'user':
            return msg
          case 'assistant': {
            const filteredToolCalls = msg.tool_calls?.filter((t) =>
              requestMessages.some(
                (rm) => rm.role === 'tool' && rm.tool_call.id === t.id,
              ),
            )
            return {
              ...msg,
              tool_calls:
                filteredToolCalls && filteredToolCalls.length > 0
                  ? filteredToolCalls
                  : undefined,
            }
          }
          case 'tool': {
            const assistantMessage = requestMessages.find(
              (rm) =>
                rm.role === 'assistant' &&
                rm.tool_calls?.some((t) => t.id === msg.tool_call.id),
            )
            if (!assistantMessage) {
              return null
            }
            return msg
          }
          default:
            return msg
        }
      })
      .filter((m) => m !== null) as RequestMessage[]

    return filteredRequestMessages
  }

  private parseAssistantMessage({
    message,
  }: {
    message: ChatAssistantMessage
  }): RequestMessage[] {
    let citationContent: string | null = null
    if (message.annotations && message.annotations.length > 0) {
      citationContent = `Citations:
${message.annotations
  .map((annotation, index) => {
    if (annotation.type === 'url_citation') {
      const { url, title } = annotation.url_citation
      return `[${index + 1}] ${title ? `${title}: ` : ''}${url}`
    }
  })
  .join('\n')}`
    }

    return [
      {
        role: 'assistant',
        content: [
          message.content,
          ...(citationContent ? [citationContent] : []),
        ].join('\n'),
        tool_calls: message.toolCallRequests,
        providerMetadata: message.providerMetadata,
      },
    ]
  }

  private parseToolMessage({
    message,
  }: {
    message: ChatToolMessage
  }): RequestMessage[] {
    return message.toolCalls.map((toolCall) => {
      switch (toolCall.response.status) {
        case ToolCallResponseStatus.PendingApproval:
        case ToolCallResponseStatus.PendingReview:
        case ToolCallResponseStatus.Running:
        case ToolCallResponseStatus.Rejected:
        case ToolCallResponseStatus.Aborted:
          return {
            role: 'tool',
            tool_call: toolCall.request,
            content: `Tool call ${toolCall.request.id} is ${toolCall.response.status}`,
          }
        case ToolCallResponseStatus.Success:
          return {
            role: 'tool',
            tool_call: toolCall.request,
            content: toolCall.response.data.text,
          }
        case ToolCallResponseStatus.Error:
          return {
            role: 'tool',
            tool_call: toolCall.request,
            content: `Error: ${toolCall.response.error}`,
          }
      }
    })
  }

  private getModelPromptLevel(): PromptLevel {
    const chatModel = this.settings.chatModels.find(
      (model) => model.id === this.settings.chatModelId,
    )
    return chatModel?.promptLevel ?? PromptLevel.Default
  }
}
