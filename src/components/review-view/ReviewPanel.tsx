import { ProposedToolReview } from '../../types/tool-call.types'
import { createDiffBlocks } from '../../utils/chat/diff'
import { openMarkdownFile } from '../../utils/obsidian'
import { useApp } from '../../contexts/app-context'
import { ObsidianButton } from '../common/ObsidianButton'

export function ReviewPanel({ proposal }: { proposal: ProposedToolReview | null }) {
  const app = useApp()

  if (!proposal) {
    return <div className="smtcmp-mcp-servers-empty">No review selected.</div>
  }

  const diffBlocks =
    typeof proposal.beforeText === 'string' && typeof proposal.afterText === 'string'
      ? createDiffBlocks(proposal.beforeText, proposal.afterText)
      : []

  return (
    <div className="smtcmp-settings-section">
      <div className="smtcmp-settings-sub-header">Review Diff</div>
      <div className="smtcmp-settings-desc">{proposal.summary}</div>
      <div className="smtcmp-modal-summary-row">
        <span>Tool {proposal.toolName}</span>
        <span>Target {proposal.targetPath}</span>
      </div>
      <div style={{ margin: '0.75rem 0' }}>
        <ObsidianButton
          text="Open target note"
          onClick={() => openMarkdownFile(app, proposal.targetPath)}
        />
      </div>
      {diffBlocks.length > 0 ? (
        <div className="smtcmp-toolcall-review-diff">
          {diffBlocks.map((block, index) =>
            block.type === 'unchanged' ? null : (
              <div key={index} className="smtcmp-toolcall-content-section">
                {block.originalValue && (
                  <pre className="smtcmp-mcp-server-modal-validation smtcmp-mcp-server-modal-validation--error">
                    {block.originalValue}
                  </pre>
                )}
                {block.modifiedValue && (
                  <pre className="smtcmp-mcp-server-modal-validation smtcmp-mcp-server-modal-validation--success">
                    {block.modifiedValue}
                  </pre>
                )}
              </div>
            ),
          )}
        </div>
      ) : (
        <div className="smtcmp-settings-desc">
          This change does not include a text diff preview in the panel.
        </div>
      )}
    </div>
  )
}
