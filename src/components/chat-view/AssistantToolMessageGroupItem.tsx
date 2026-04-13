import { AssistantToolMessageGroup, ChatToolMessage } from '../../types/chat'
import {
  ProposedToolReview,
  ToolCallRequest,
  ToolCallResponse,
} from '../../types/tool-call.types'

import AssistantMessageAnnotations from './AssistantMessageAnnotations'
import AssistantMessageContent from './AssistantMessageContent'
import AssistantMessageReasoning from './AssistantMessageReasoning'
import AssistantToolMessageGroupActions from './AssistantToolMessageGroupActions'
import ToolMessage from './ToolMessage'

export type AssistantToolMessageGroupItemProps = {
  messages: AssistantToolMessageGroup
  conversationId: string
  onToolMessageUpdate: (message: ChatToolMessage) => void
  onAllowToolForConversation: (toolName: string, conversationId: string) => void
  executeToolCall: (
    request: ToolCallRequest,
    conversationId: string,
  ) => Promise<ToolCallResponse>
  applyReviewedToolCall: (
    proposal: ProposedToolReview,
    conversationId: string,
  ) => Promise<ToolCallResponse>
}

export default function AssistantToolMessageGroupItem({
  messages,
  conversationId,
  onToolMessageUpdate,
  onAllowToolForConversation,
  executeToolCall,
  applyReviewedToolCall,
}: AssistantToolMessageGroupItemProps) {
  return (
    <div className="smtcmp-assistant-tool-message-group">
      {messages.map((message) =>
        message.role === 'assistant' ? (
          message.reasoning || message.annotations || message.content ? (
            <div key={message.id} className="smtcmp-chat-messages-assistant">
              {message.reasoning && (
                <AssistantMessageReasoning reasoning={message.reasoning} />
              )}
              {message.annotations && (
                <AssistantMessageAnnotations
                  annotations={message.annotations}
                />
              )}
              <AssistantMessageContent content={message.content} />
            </div>
          ) : null
        ) : (
          <div key={message.id}>
            <ToolMessage
              message={message}
              conversationId={conversationId}
              onMessageUpdate={onToolMessageUpdate}
              onAllowToolForConversation={onAllowToolForConversation}
              executeToolCall={executeToolCall}
              applyReviewedToolCall={applyReviewedToolCall}
            />
          </div>
        ),
      )}
      {messages.length > 0 && (
        <AssistantToolMessageGroupActions messages={messages} />
      )}
    </div>
  )
}
