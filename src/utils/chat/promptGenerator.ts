import { App, TFile, htmlToMarkdown, requestUrl } from 'obsidian'

import { editorStateToPlainText } from '../../components/chat-view/chat-input/utils/editor-state-to-plain-text'
import { QueryProgressState } from '../../components/chat-view/QueryProgress'
import { ContextBuilder } from '../../core/context/ContextBuilder'
import { McpManager } from '../../core/mcp/mcpManager'
import { RAGEngine } from '../../core/rag/ragEngine'
import { SelectEmbedding } from '../../database/schema'
import { SmartComposerSettings } from '../../settings/schema/setting.types'
import { ChatMessage, ChatUserMessage } from '../../types/chat'
import { ContentPart, RequestMessage } from '../../types/llm/request'
import {
  MentionableBlock,
  MentionableCurrentFile,
  MentionableFile,
  MentionableFolder,
  MentionableImage,
  MentionableUrl,
  MentionableVault,
} from '../../types/mentionable'
import { PromptLevel } from '../../types/prompt-level.types'
import { tokenCount } from '../llm/token'
import {
  getNestedFiles,
  readMultipleTFiles,
  readTFileContent,
} from '../obsidian'

import { YoutubeTranscript, isYoutubeUrl } from './youtube-transcript'

/**
 * PromptGenerator — Phase 6 重构
 *
 * 职责被压缩到两件事：
 * 1. compileUserMessagePrompt: 编译用户输入（读 vault / RAG 检索 / 抓 URL / 当前文件 snapshot）
 *    把所有"动态上下文"在用户消息提交时一次性快照到 promptContent
 * 2. generateRequestMessages: 委托给 ContextBuilder 组装最终 RequestMessage[]
 *
 * 重构动机（cache 复用，详见 ContextBuilder.ts 头部注释）：
 * - currentFile 由原来"每轮 generateRequestMessages 时独立读取"改为"compile 时嵌入 promptContent"
 *   → 避免用户编辑当前文件时打断历史 cache
 * - system message 由 ContextBuilder 统一根据 settings 生成（会话级稳定）
 *   → 避免按 per-message shouldUseRAG 切换导致 prefix 失效
 */
export class PromptGenerator {
  private getRagEngine: () => Promise<RAGEngine>
  private app: App
  private settings: SmartComposerSettings
  private contextBuilder: ContextBuilder

  constructor(
    getRagEngine: () => Promise<RAGEngine>,
    app: App,
    settings: SmartComposerSettings,
    getMcpManager?: () => Promise<McpManager>,
  ) {
    this.getRagEngine = getRagEngine
    this.app = app
    this.settings = settings
    this.contextBuilder = new ContextBuilder(app, settings, getMcpManager)
  }

  public async generateRequestMessages({
    messages,
  }: {
    messages: ChatMessage[]
  }): Promise<RequestMessage[]> {
    if (messages.length === 0) {
      throw new Error('No messages provided')
    }

    // Fallback：如果某条 user message 还没编译过 promptContent，这里补一次。
    // 正常路径下 Chat.tsx 在 submit 阶段已经全部编译过。
    const compiledMessages = await Promise.all(
      messages.map(async (message) => {
        if (message.role === 'user' && !message.promptContent) {
          const { promptContent, similaritySearchResults } =
            await this.compileUserMessagePrompt({ message })
          return { ...message, promptContent, similaritySearchResults }
        }
        return message
      }),
    )

    // 至少存在一条 user message
    if (!compiledMessages.some((m) => m.role === 'user')) {
      throw new Error('No user messages found')
    }

    return this.contextBuilder.build({ compiledMessages })
  }

  public async compileUserMessagePrompt({
    message,
    useVaultSearch,
    onQueryProgressChange,
  }: {
    message: ChatUserMessage
    useVaultSearch?: boolean
    onQueryProgressChange?: (queryProgress: QueryProgressState) => void
  }): Promise<{
    promptContent: ChatUserMessage['promptContent']
    shouldUseRAG: boolean
    similaritySearchResults?: (Omit<SelectEmbedding, 'embedding'> & {
      similarity: number
    })[]
  }> {
    try {
      if (!message.content) {
        return {
          promptContent: '',
          shouldUseRAG: false,
        }
      }
      const query = editorStateToPlainText(message.content)
      let similaritySearchResults = undefined

      useVaultSearch =
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
        useVaultSearch ||
        message.mentionables.some(
          (m): m is MentionableVault => m.type === 'vault',
        )

      if (!this.settings.vaultChatEnabled) {
        useVaultSearch = false
      }

      onQueryProgressChange?.({
        type: 'reading-mentionables',
      })
      const files = message.mentionables
        .filter((m): m is MentionableFile => m.type === 'file')
        .map((m) => m.file)
      const folders = message.mentionables
        .filter((m): m is MentionableFolder => m.type === 'folder')
        .map((m) => m.folder)
      const nestedFiles = folders.flatMap((folder) =>
        getNestedFiles(folder, this.app.vault),
      )
      const allFiles = [...files, ...nestedFiles]
      const fileContents = await readMultipleTFiles(allFiles, this.app.vault)

      // Count tokens incrementally to avoid long processing times on large content sets
      const exceedsTokenThreshold = async () => {
        let accTokenCount = 0
        for (const content of fileContents) {
          const count = await tokenCount(content)
          accTokenCount += count
          if (accTokenCount > this.settings.ragOptions.thresholdTokens) {
            return true
          }
        }
        return false
      }
      const shouldUseRAG =
        this.settings.vaultChatEnabled &&
        (useVaultSearch || (await exceedsTokenThreshold()))

      let filePrompt: string
      if (shouldUseRAG) {
        similaritySearchResults = useVaultSearch
          ? await (
              await this.getRagEngine()
            ).processQuery({
              query,
              onQueryProgressChange: onQueryProgressChange,
            }) // TODO: Add similarity boosting for mentioned files or folders
          : await (
              await this.getRagEngine()
            ).processQuery({
              query,
              scope: {
                files: files.map((f) => f.path),
                folders: folders.map((f) => f.path),
              },
              onQueryProgressChange: onQueryProgressChange,
            })
        filePrompt = `## Potentially Relevant Snippets from the current vault
${similaritySearchResults
  .map(({ path, content, metadata }) => {
    const newContent =
      this.getModelPromptLevel() == PromptLevel.Default
        ? this.addLineNumbersToContent({
            content,
            startLine: metadata.startLine,
          })
        : content
    return `\`\`\`${path}\n${newContent}\n\`\`\`\n`
  })
  .join('')}\n`
      } else {
        filePrompt = allFiles
          .map((file, index) => {
            return `\`\`\`${file.path}\n${fileContents[index]}\n\`\`\`\n`
          })
          .join('')
      }

      const blocks = message.mentionables.filter(
        (m): m is MentionableBlock => m.type === 'block',
      )
      const blockPrompt = blocks
        .map(({ file, content }) => {
          return `\`\`\`${file.path}\n${content}\n\`\`\`\n`
        })
        .join('')

      const urls = message.mentionables.filter(
        (m): m is MentionableUrl => m.type === 'url',
      )

      const urlPrompt =
        urls.length > 0
          ? `## Potentially Relevant Websearch Results
${(
  await Promise.all(
    urls.map(
      async ({ url }) => `\`\`\`
Website URL: ${url}
Website Content:
${await this.getWebsiteContent(url)}
\`\`\``,
    ),
  )
).join('\n')}
`
          : ''

      // Phase 6 cache 优化：currentFile snapshot 在此处一次性写入 promptContent，
      // 不再由 generateRequestMessages 在每轮重新读取。这样：
      // - 已发送的 user message 是稳定快照（即使用户后续编辑了文件，历史也不变）
      // - 多轮 tool call 中前一 turn 的 prompt prefix 完全可缓存
      const currentFile = message.mentionables.find(
        (m): m is MentionableCurrentFile => m.type === 'current-file',
      )?.file
      let currentFilePrompt = ''
      if (currentFile && this.settings.chatOptions.includeCurrentFileContent) {
        const currentFileContent = await readTFileContent(
          currentFile,
          this.app.vault,
        )
        currentFilePrompt = `# Inputs
## Current File
Here is the file I'm looking at.
\`\`\`${currentFile.path}
${currentFileContent}
\`\`\`\n\n`
      }

      const imageDataUrls = message.mentionables
        .filter((m): m is MentionableImage => m.type === 'image')
        .map(({ data }) => data)

      // Reset query progress
      onQueryProgressChange?.({
        type: 'idle',
      })

      return {
        promptContent: [
          ...imageDataUrls.map(
            (data): ContentPart => ({
              type: 'image_url',
              image_url: {
                url: data,
              },
            }),
          ),
          {
            type: 'text',
            text: `${currentFilePrompt}${filePrompt}${blockPrompt}${urlPrompt}\n\n${query}\n\n`,
          },
        ],
        shouldUseRAG,
        similaritySearchResults: similaritySearchResults,
      }
    } catch (error) {
      console.error('Failed to compile user message', error)
      onQueryProgressChange?.({
        type: 'idle',
      })
      throw error
    }
  }

  private addLineNumbersToContent({
    content,
    startLine,
  }: {
    content: string
    startLine: number
  }): string {
    const lines = content.split('\n')
    const linesWithNumbers = lines.map((line, index) => {
      return `${startLine + index}|${line}`
    })
    return linesWithNumbers.join('\n')
  }

  /**
   * TODO: Improve markdown conversion logic
   * - filter visually hidden elements
   * ...
   */
  private async getWebsiteContent(url: string): Promise<string> {
    if (isYoutubeUrl(url)) {
      try {
        // TODO: pass language based on user preferences
        const { title, transcript } =
          await YoutubeTranscript.fetchTranscriptAndMetadata(url)

        return `Title: ${title}
Video Transcript:
${transcript.map((t) => `${t.offset}: ${t.text}`).join('\n')}`
      } catch (error) {
        console.error('Error fetching YouTube transcript', error)
      }
    }

    const response = await requestUrl({ url })
    return htmlToMarkdown(response.text)
  }

  private getModelPromptLevel(): PromptLevel {
    const chatModel = this.settings.chatModels.find(
      (model) => model.id === this.settings.chatModelId,
    )
    return chatModel?.promptLevel ?? PromptLevel.Default
  }
}
