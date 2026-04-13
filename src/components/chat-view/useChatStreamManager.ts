import { UseMutationResult, useMutation } from '@tanstack/react-query'
import { Notice } from 'obsidian'
import { useCallback, useMemo, useRef } from 'react'

import { useApp } from '../../contexts/app-context'
import { useMcp } from '../../contexts/mcp-context'
import { useSettings } from '../../contexts/settings-context'
import { ConversationHarness } from '../../core/harness/ConversationHarness'
import { ToolExecutor } from '../../core/harness/ToolExecutor'
import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
  LLMBaseUrlNotSetException,
  LLMModelNotFoundException,
} from '../../core/llm/exception'
import { getChatModelClient } from '../../core/llm/manager'
import { SessionMode } from '../../core/mcp/mcpManager'
import { ApprovalPolicyImpl } from '../../core/policy/ApprovalPolicyImpl'
import { ToolPermissionPolicyImpl } from '../../core/policy/ToolPermissionPolicyImpl'
import { buildToolRegistry } from '../../core/tools/buildToolRegistry'
import { ChatMessage } from '../../types/chat'
import {
  ProposedToolReview,
  ToolCallRequest,
  ToolCallResponse,
} from '../../types/tool-call.types'
import { PromptGenerator } from '../../utils/chat/promptGenerator'
import { ErrorModal } from '../modals/ErrorModal'

type UseChatStreamManagerParams = {
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
  autoScrollToBottom: () => void
  promptGenerator: PromptGenerator
  sessionMode: SessionMode
}

export type UseChatStreamManager = {
  abortActiveStreams: () => void
  submitChatMutation: UseMutationResult<
    void,
    Error,
    { chatMessages: ChatMessage[]; conversationId: string }
  >
  /** 用户在 ToolMessage 中点击"Allow for this chat"时调用，记录会话级批准 */
  allowToolForConversation: (toolName: string, conversationId: string) => void
  executeToolCall: (
    request: ToolCallRequest,
    conversationId: string,
  ) => Promise<ToolCallResponse>
  applyReviewedToolCall: (
    proposal: ProposedToolReview,
    conversationId: string,
  ) => Promise<ToolCallResponse>
}

export function useChatStreamManager({
  setChatMessages,
  autoScrollToBottom,
  promptGenerator,
  sessionMode,
}: UseChatStreamManagerParams): UseChatStreamManager {
  const app = useApp()
  const { settings, setSettings } = useSettings()
  const { getMcpManager } = useMcp()

  const activeStreamAbortControllersRef = useRef<AbortController[]>([])
  // ApprovalPolicy 在 hook 生命周期内保持稳定，跨 ConversationHarness 实例持久化会话级批准
  const approvalPolicyRef = useRef(new ApprovalPolicyImpl())

  const abortActiveStreams = useCallback(() => {
    for (const abortController of activeStreamAbortControllersRef.current) {
      abortController.abort()
    }
    activeStreamAbortControllersRef.current = []
  }, [])

  const { providerClient, model } = useMemo(() => {
    try {
      return getChatModelClient({
        modelId: settings.chatModelId,
        settings,
        setSettings,
      })
    } catch (error) {
      if (error instanceof LLMModelNotFoundException) {
        if (settings.chatModels.length === 0) {
          throw error
        }
        // Fallback to the first chat model if the selected chat model is not found
        const firstChatModel = settings.chatModels[0]
        setSettings({
          ...settings,
          chatModelId: firstChatModel.id,
          chatModels: settings.chatModels.map((model) =>
            model.id === firstChatModel.id
              ? {
                  ...model,
                  enable: true,
                }
              : model,
          ),
        })
        return getChatModelClient({
          modelId: firstChatModel.id,
          settings,
          setSettings,
        })
      }
      throw error
    }
  }, [settings, setSettings])

  const submitChatMutation = useMutation({
    mutationFn: async ({
      chatMessages,
      conversationId,
    }: {
      chatMessages: ChatMessage[]
      conversationId: string
    }) => {
      const lastMessage = chatMessages.at(-1)
      if (!lastMessage) {
        // chatMessages is empty
        return
      }

      abortActiveStreams()
      const abortController = new AbortController()
      activeStreamAbortControllersRef.current.push(abortController)

      let unsubscribeHarness: (() => void) | undefined

      try {
        const mcpManager = await getMcpManager()
        const capturedSettings = settings
        const harness = new ConversationHarness({
          app,
          providerClient,
          model,
          messages: chatMessages,
          conversationId,
          enableTools: settings.chatOptions.enableTools,
          enableSkills: settings.chatOptions.enableSkills,
          maxAutoIterations: settings.chatOptions.maxAutoIterations,
          sessionMode,
          promptGenerator,
          mcpManager,
          getSettings: () => capturedSettings,
          approvalPolicy: approvalPolicyRef.current,
          abortSignal: abortController.signal,
        })

        unsubscribeHarness = harness.subscribe((responseMessages) => {
          setChatMessages((prevChatMessages) => {
            const lastMessageIndex = prevChatMessages.findIndex(
              (message) => message.id === lastMessage.id,
            )
            if (lastMessageIndex === -1) {
              // The last message no longer exists in the chat history.
              // This likely means a new message was submitted while this stream was running.
              // Abort this stream and keep the current chat history.
              abortController.abort()
              return prevChatMessages
            }
            return [
              ...prevChatMessages.slice(0, lastMessageIndex + 1),
              ...responseMessages,
            ]
          })
          autoScrollToBottom()
        })

        await harness.run()
      } catch (error) {
        // Ignore AbortError
        if (error instanceof Error && error.name === 'AbortError') {
          return
        }
        throw error
      } finally {
        if (unsubscribeHarness) {
          unsubscribeHarness()
        }
        activeStreamAbortControllersRef.current =
          activeStreamAbortControllersRef.current.filter(
            (controller) => controller !== abortController,
          )
      }
    },
    onError: (error) => {
      if (
        error instanceof LLMAPIKeyNotSetException ||
        error instanceof LLMAPIKeyInvalidException ||
        error instanceof LLMBaseUrlNotSetException
      ) {
        new ErrorModal(app, 'Error', error.message, error.rawError?.message, {
          showSettingsButton: true,
        }).open()
      } else {
        new Notice(error.message)
        console.error('Failed to generate response', error)
      }
    },
  })

  const allowToolForConversation = useCallback(
    (toolName: string, conversationId: string) => {
      approvalPolicyRef.current.setConversationApproval(
        toolName,
        conversationId,
      )
    },
    [],
  )

  const executeToolCall = useCallback(
    async (request: ToolCallRequest, conversationId: string) => {
      const mcpManager = await getMcpManager()
      const registry = await buildToolRegistry({
        app,
        mcpManager,
        enableSkills: settings.chatOptions.enableSkills,
      })
      const permissionPolicy = new ToolPermissionPolicyImpl(
        registry,
        approvalPolicyRef.current,
        () => settings,
      )
      const toolExecutor = new ToolExecutor(
        registry,
        permissionPolicy,
        mcpManager,
        app,
        () => settings,
      )

      return toolExecutor.execute({
        name: request.name,
        args: request.arguments,
        id: request.id,
        conversationId,
      })
    },
    [app, getMcpManager, settings],
  )

  const applyReviewedToolCall = useCallback(
    async (proposal: ProposedToolReview, conversationId: string) => {
      const mcpManager = await getMcpManager()
      const registry = await buildToolRegistry({
        app,
        mcpManager,
        enableSkills: settings.chatOptions.enableSkills,
      })
      const permissionPolicy = new ToolPermissionPolicyImpl(
        registry,
        approvalPolicyRef.current,
        () => settings,
      )
      const toolExecutor = new ToolExecutor(
        registry,
        permissionPolicy,
        mcpManager,
        app,
        () => settings,
      )

      return toolExecutor.applyReview({
        proposal,
        conversationId,
      })
    },
    [app, getMcpManager, settings],
  )

  return {
    abortActiveStreams,
    submitChatMutation,
    allowToolForConversation,
    executeToolCall,
    applyReviewedToolCall,
  }
}
