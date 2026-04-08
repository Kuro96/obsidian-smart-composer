import clsx from 'clsx'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  X,
} from 'lucide-react'
import { memo, useCallback, useMemo, useState } from 'react'

import { useMcp } from '../../contexts/mcp-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import { getBuiltinToolTier } from '../../core/mcp/builtin-tool-tiers'
import { InvalidToolNameException } from '../../core/mcp/exception'
import { parseToolName } from '../../core/mcp/tool-name-utils'
import { ChatToolMessage } from '../../types/chat'
import {
  ProposedToolReview,
  ToolCallRequest,
  ToolCallResponse,
  ToolCallResponseStatus,
} from '../../types/tool-call.types'
import { SplitButton } from '../common/SplitButton'

import { ObsidianCodeBlock } from './ObsidianMarkdown'
import { createDiffBlocks } from '../../utils/chat/diff'

const STATUS_LABELS: Record<ToolCallResponseStatus, string> = {
  [ToolCallResponseStatus.PendingApproval]: 'Call',
  [ToolCallResponseStatus.PendingReview]: 'Review',
  [ToolCallResponseStatus.Rejected]: 'Rejected',
  [ToolCallResponseStatus.Running]: 'Running',
  [ToolCallResponseStatus.Success]: 'Called',
  [ToolCallResponseStatus.Error]: 'Failed',
  [ToolCallResponseStatus.Aborted]: 'Aborted',
}

export const getToolMessageContent = (message: ChatToolMessage): string => {
  return message.toolCalls
    ?.map((toolCall) => {
      const { serverName, toolName } = (() => {
        try {
          return parseToolName(toolCall.request.name)
        } catch (error) {
          if (error instanceof InvalidToolNameException) {
            return { serverName: null, toolName: toolCall.request.name }
          }
          throw error
        }
      })()
      return [
        `${STATUS_LABELS[toolCall.response.status]} ${serverName ? `${serverName}:${toolName}` : toolName}`,
        ...(toolCall.request.arguments
          ? [`Parameters: ${toolCall.request.arguments}`]
          : []),
      ].join('\n')
    })
    .join('\n')
}

const ToolMessage = memo(function ToolMessage({
  message,
  conversationId,
  onMessageUpdate,
  onAllowToolForConversation,
  executeToolCall,
  applyReviewedToolCall,
}: {
  message: ChatToolMessage
  conversationId: string
  onMessageUpdate: (message: ChatToolMessage) => void
  onAllowToolForConversation: (toolName: string, conversationId: string) => void
  executeToolCall: (
    request: ToolCallRequest,
    conversationId: string,
  ) => Promise<ToolCallResponse>
  applyReviewedToolCall: (
    proposal: ProposedToolReview,
    conversationId: string,
  ) => Promise<ToolCallResponse>
}) {
  return (
    <div className="smtcmp-toolcall-container">
      {message.toolCalls.map((toolCall, index) => (
        <div
          key={toolCall.request.id}
          className={clsx(index > 0 && 'smtcmp-toolcall-border-top')}
        >
          <ToolCallItem
            request={toolCall.request}
            response={toolCall.response}
            conversationId={conversationId}
            onAllowToolForConversation={onAllowToolForConversation}
            executeToolCall={executeToolCall}
            applyReviewedToolCall={applyReviewedToolCall}
            onResponseUpdate={(response) =>
              onMessageUpdate({
                ...message,
                toolCalls: message.toolCalls.map((t) =>
                  t.request.id === toolCall.request.id ? { ...t, response } : t,
                ),
              })
            }
          />
        </div>
      ))}
    </div>
  )
})

function ToolCallItem({
  request,
  response,
  conversationId,
  onResponseUpdate,
  onAllowToolForConversation,
  executeToolCall,
  applyReviewedToolCall,
}: {
  request: ToolCallRequest
  response: ToolCallResponse
  conversationId: string
  onResponseUpdate: (response: ToolCallResponse) => void
  onAllowToolForConversation: (toolName: string, conversationId: string) => void
  executeToolCall: (
    request: ToolCallRequest,
    conversationId: string,
  ) => Promise<ToolCallResponse>
  applyReviewedToolCall: (
    proposal: ProposedToolReview,
    conversationId: string,
  ) => Promise<ToolCallResponse>
}) {
  const {
    handleToolCall,
    handleAllowForConversation,
    handleAllowAutoExecution,
    handleReject,
    handleAbort,
    handleApplyReviewed,
  } = useToolCall(
    request,
    conversationId,
    onResponseUpdate,
    onAllowToolForConversation,
    executeToolCall,
    applyReviewedToolCall,
  )

  const [isOpen, setIsOpen] = useState(
    // Open by default if the tool call requires approval
    response.status === ToolCallResponseStatus.PendingApproval ||
      response.status === ToolCallResponseStatus.PendingReview,
  )

  const { serverName, toolName } = useMemo(() => {
    try {
      return parseToolName(request.name)
    } catch (error) {
      if (error instanceof InvalidToolNameException) {
        return {
          serverName: null,
          toolName: request.name,
        }
      }
      throw error
    }
  }, [request.name])
  const canAutoAllow = !!serverName
  const isDangerZone = getBuiltinToolTier(request.name) === 'danger-zone'
  const plugin = usePlugin()
  const parameters = useMemo(() => {
    if (!request.arguments) {
      return 'No parameters'
    }
    try {
      return JSON.stringify(JSON.parse(request.arguments), null, 2)
    } catch (error) {
      return request.arguments
    }
  }, [request.arguments])

  return (
    <div
      className={clsx(
        'smtcmp-toolcall',
        isDangerZone && 'smtcmp-toolcall--danger',
      )}
    >
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="smtcmp-toolcall-header"
      >
        <div className="smtcmp-toolcall-header-icon">
          {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </div>
        <div className="smtcmp-toolcall-header-content">
          <span>{STATUS_LABELS[response.status] || 'Unknown'}</span>
          <span>&nbsp;&nbsp;</span>
          <span className="smtcmp-toolcall-header-tool-name">
            {serverName ? `${serverName}:${toolName}` : toolName}
          </span>
        </div>
        <div className="smtcmp-toolcall-header-icon smtcmp-toolcall-header-icon--status">
          <StatusIcon status={response.status} />
        </div>
      </div>
      {isOpen && (
        <div className="smtcmp-toolcall-content">
          <div className="smtcmp-toolcall-content-section">
            <div>Parameters:</div>
            <ObsidianCodeBlock language="json" content={parameters} />
          </div>
          {response.status === ToolCallResponseStatus.Success && (
            <div className="smtcmp-toolcall-content-section">
              <div>Result:</div>
              <ObsidianCodeBlock content={response.data.text} />
            </div>
          )}
          {response.status === ToolCallResponseStatus.Error && (
            <div className="smtcmp-toolcall-content-section">
              <div>Error:</div>
              <ObsidianCodeBlock content={response.error} />
            </div>
          )}
          {response.status === ToolCallResponseStatus.PendingReview && (
            <ReviewProposal proposal={response.proposal} />
          )}
          {response.status === ToolCallResponseStatus.Success &&
            response.data.proposal && (
              <ReviewProposal proposal={response.data.proposal} />
            )}
        </div>
      )}
      {isDangerZone &&
        response.status === ToolCallResponseStatus.PendingApproval && (
          <div className="smtcmp-toolcall-danger-warning">
            <AlertTriangle size={14} />
            <span>
              This operation is destructive and cannot be undone from within
              Obsidian.
            </span>
          </div>
        )}
      {((response.status === ToolCallResponseStatus.PendingApproval ||
        response.status === ToolCallResponseStatus.PendingReview) ||
        response.status === ToolCallResponseStatus.Running ||
        (response.status === ToolCallResponseStatus.Success &&
          !!response.data.proposal)) && (
        <div className="smtcmp-toolcall-footer">
          {response.status === ToolCallResponseStatus.PendingApproval && (
            <div className="smtcmp-toolcall-footer-actions">
              <SplitButton
                primaryText="Allow"
                onPrimaryClick={() => {
                  handleToolCall()
                }}
                menuOptions={[
                  ...(canAutoAllow
                    ? [
                        {
                          label: 'Always allow this tool',
                          onClick: () => {
                            handleToolCall()
                            handleAllowAutoExecution()
                          },
                        },
                      ]
                    : []),
                  {
                    label: 'Allow for this chat',
                    onClick: () => {
                      handleToolCall()
                      handleAllowForConversation()
                    },
                  },
                ]}
              />
              <button
                onClick={() => {
                  handleReject()
                  setIsOpen(false)
                }}
              >
                Reject
              </button>
            </div>
          )}
          {response.status === ToolCallResponseStatus.PendingReview && (
            <div className="smtcmp-toolcall-footer-actions">
              <button onClick={() => plugin.openReviewView(response.proposal)}>
                Open review
              </button>
              <button
                onClick={() => {
                  handleApplyReviewed(response.proposal)
                  setIsOpen(false)
                }}
              >
                Apply
              </button>
              <button
                onClick={() => {
                  handleReject()
                  setIsOpen(false)
                }}
              >
                Reject
              </button>
            </div>
          )}
          {response.status === ToolCallResponseStatus.Running && (
            <div className="smtcmp-toolcall-footer-actions">
              <button onClick={handleAbort}>Abort</button>
            </div>
          )}
          {response.status === ToolCallResponseStatus.Success &&
            response.data.proposal && (
              <div className="smtcmp-toolcall-footer-actions">
                <button onClick={() => plugin.openReviewView(response.data.proposal!)}>
                  Open review
                </button>
              </div>
            )}
        </div>
      )}
    </div>
  )
}

function useToolCall(
  request: ToolCallRequest,
  conversationId: string,
  onResponseUpdate: (response: ToolCallResponse) => void,
  onAllowToolForConversation: (toolName: string, conversationId: string) => void,
  executeToolCall: (
    request: ToolCallRequest,
    conversationId: string,
  ) => Promise<ToolCallResponse>,
  applyReviewedToolCall: (
    proposal: ProposedToolReview,
    conversationId: string,
  ) => Promise<ToolCallResponse>,
) {
  const { settings, setSettings } = useSettings()
  const { getMcpManager } = useMcp()

  const handleToolCall = useCallback(async () => {
    onResponseUpdate({
      status: ToolCallResponseStatus.Running,
    })
    const toolCallResponse = await executeToolCall(request, conversationId)
    onResponseUpdate(toolCallResponse)
  }, [request, conversationId, onResponseUpdate, executeToolCall])

  const handleAllowForConversation = useCallback(async () => {
    // Phase 6：通过 ApprovalPolicy（在 useChatStreamManager 中持有）记录会话级批准，
    // 不再调用 mcpManager.allowToolForConversation()
    onAllowToolForConversation(request.name, conversationId)
  }, [request, conversationId, onAllowToolForConversation])

  const handleAllowAutoExecution = useCallback(async () => {
    const { serverName, toolName } = parseToolName(request.name)
    const server = settings.mcp.servers.find((s) => s.id === serverName)
    if (!server) {
      throw new Error(`Server ${serverName} not found`)
    }
    const toolOptions = { ...server.toolOptions }
    if (!toolOptions[toolName]) {
      // If the tool is not in the toolOptions, add it with default values
      toolOptions[toolName] = {
        allowAutoExecution: false,
        disabled: false,
      }
    }
    toolOptions[toolName] = {
      ...toolOptions[toolName],
      allowAutoExecution: true,
    }

    setSettings({
      ...settings,
      mcp: {
        ...settings.mcp,
        servers: settings.mcp.servers.map((s) =>
          s.id === server.id
            ? {
                ...s,
                toolOptions: toolOptions,
              }
            : s,
        ),
      },
    })
  }, [request, settings, setSettings])

  const handleReject = useCallback(async () => {
    onResponseUpdate({
      status: ToolCallResponseStatus.Rejected,
    })
  }, [onResponseUpdate])

  const handleAbort = useCallback(async () => {
    const mcpManager = await getMcpManager()
    mcpManager.abortToolCall(request.id)
    onResponseUpdate({
      status: ToolCallResponseStatus.Aborted,
    })
  }, [request, onResponseUpdate, getMcpManager])

  const handleApplyReviewed = useCallback(
    async (proposal: ProposedToolReview) => {
      onResponseUpdate({
        status: ToolCallResponseStatus.Running,
      })
      const toolCallResponse = await applyReviewedToolCall(proposal, conversationId)
      onResponseUpdate(toolCallResponse)
    },
    [applyReviewedToolCall, conversationId, onResponseUpdate],
  )

  return {
    handleToolCall,
    handleAllowForConversation,
    handleAllowAutoExecution,
    handleReject,
    handleAbort,
    handleApplyReviewed,
  }
}

function ReviewProposal({ proposal }: { proposal: ProposedToolReview }) {
  const diffBlocks = useMemo(() => {
    if (
      typeof proposal.beforeText !== 'string' ||
      typeof proposal.afterText !== 'string'
    ) {
      return []
    }

    return createDiffBlocks(proposal.beforeText, proposal.afterText)
  }, [proposal])

  return (
    <div className="smtcmp-toolcall-content-section">
      <div>Review:</div>
      <ObsidianCodeBlock content={proposal.summary} />
      {diffBlocks.length > 0 && (
        <div className="smtcmp-toolcall-review-diff">
          {diffBlocks.map((block, index) =>
            block.type === 'unchanged' ? null : (
              <div key={index} className="smtcmp-toolcall-content-section">
                {block.originalValue && (
                  <ObsidianCodeBlock content={block.originalValue} />
                )}
                {block.modifiedValue && (
                  <ObsidianCodeBlock content={block.modifiedValue} />
                )}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  )
}

function StatusIcon({ status }: { status: ToolCallResponseStatus }) {
  switch (status) {
    case ToolCallResponseStatus.PendingApproval:
    case ToolCallResponseStatus.PendingReview:
      return null
    case ToolCallResponseStatus.Rejected:
    case ToolCallResponseStatus.Aborted:
    case ToolCallResponseStatus.Error:
      return <X size={16} style={{ color: 'var(--text-error)' }} />
    case ToolCallResponseStatus.Running:
      return <Loader2 size={16} className="spinner" />
    case ToolCallResponseStatus.Success:
      return <Check size={16} style={{ color: 'var(--text-success)' }} />
    default:
      return null
  }
}

export default ToolMessage
