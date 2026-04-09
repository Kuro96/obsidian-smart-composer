import { CheckIcon, ChevronDown, ChevronUp, X } from 'lucide-react'
import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { DiffBlock, createDiffBlocks } from '../../utils/chat/diff'
import { ProposedToolReview } from '../../types/tool-call.types'
import SmartComposerPlugin from '../../main'

export default function ApplyViewRoot({
  proposal,
  onAccept,
  onReject,
  plugin,
}: {
  proposal: ProposedToolReview
  onAccept: (finalAfterText: string) => void
  onReject: () => void
  plugin: SmartComposerPlugin
}) {
  const [currentDiffIndex, setCurrentDiffIndex] = useState(0)
  const diffBlockRefs = useRef<(HTMLDivElement | null)[]>([])
  const scrollerRef = useRef<HTMLDivElement>(null)

  const [diff, setDiff] = useState<DiffBlock[]>(() =>
    typeof proposal.beforeText === 'string' &&
    typeof proposal.afterText === 'string'
      ? createDiffBlocks(proposal.beforeText, proposal.afterText)
      : [],
  )

  const modifiedBlockIndices = useMemo(
    () =>
      diff.reduce<number[]>((acc, block, index) => {
        if (block.type !== 'unchanged') {
          acc.push(index)
        }
        return acc
      }, []),
    [diff],
  )

  const autoAcceptEnabled = useMemo(() => {
    const toolName = proposal.toolName
    const toolOptions = (plugin.settings.mcp as {
      builtin?: {
        toolOptions?: Record<string, { autoAcceptReview?: boolean }>
      }
    }).builtin?.toolOptions?.[toolName]
    return toolOptions?.autoAcceptReview === true
  }, [plugin.settings, proposal.toolName])

  const toggleAutoAccept = useCallback(() => {
    const settings = plugin.settings
    const mcp = settings.mcp as {
      builtin?: {
        toolOptions?: Record<string, Record<string, unknown>>
      }
    }
    const builtin = mcp.builtin ?? {}
    const toolOptions = { ...(builtin.toolOptions ?? {}) }
    const current = toolOptions[proposal.toolName] ?? {}
    toolOptions[proposal.toolName] = {
      ...current,
      autoAcceptReview: !autoAcceptEnabled,
    }

    plugin.setSettings({
      ...settings,
      mcp: {
        ...settings.mcp,
        builtin: {
          ...(mcp.builtin ?? {}),
          toolOptions,
        },
      },
    } as typeof settings)
  }, [plugin, proposal.toolName, autoAcceptEnabled])

  const scrollToDiffBlock = useCallback(
    (index: number) => {
      if (index >= 0 && index < modifiedBlockIndices.length) {
        const element = diffBlockRefs.current[modifiedBlockIndices[index]]
        if (element) {
          element.scrollIntoView({ block: 'start' })
          setCurrentDiffIndex(index)
        }
      }
    },
    [modifiedBlockIndices],
  )

  const handlePrevDiff = useCallback(() => {
    scrollToDiffBlock(currentDiffIndex - 1)
  }, [currentDiffIndex, scrollToDiffBlock])

  const handleNextDiff = useCallback(() => {
    scrollToDiffBlock(currentDiffIndex + 1)
  }, [currentDiffIndex, scrollToDiffBlock])

  const handleAccept = () => {
    const newContent = diff
      .map((diffBlock) => {
        if (diffBlock.type === 'modified') {
          return diffBlock.modifiedValue
        } else {
          return diffBlock.value
        }
      })
      .join('\n')
    onAccept(newContent)
  }

  const acceptCurrentBlock = (index: number) => {
    setDiff((prevDiff) => {
      const currentPart = prevDiff[index]
      if (currentPart.type === 'unchanged') return prevDiff

      if (!currentPart.originalValue) {
        return [...prevDiff.slice(0, index), ...prevDiff.slice(index + 1)]
      }

      const newPart: DiffBlock = {
        type: 'unchanged',
        value: currentPart.originalValue,
      }
      return [
        ...prevDiff.slice(0, index),
        newPart,
        ...prevDiff.slice(index + 1),
      ]
    })
  }

  const acceptIncomingBlock = (index: number) => {
    setDiff((prevDiff) => {
      const currentPart = prevDiff[index]
      if (currentPart.type === 'unchanged') return prevDiff

      if (!currentPart.modifiedValue) {
        return [...prevDiff.slice(0, index), ...prevDiff.slice(index + 1)]
      }

      const newPart: DiffBlock = {
        type: 'unchanged',
        value: currentPart.modifiedValue,
      }
      return [
        ...prevDiff.slice(0, index),
        newPart,
        ...prevDiff.slice(index + 1),
      ]
    })
  }

  const acceptBothBlocks = (index: number) => {
    setDiff((prevDiff) => {
      const currentPart = prevDiff[index]
      if (currentPart.type === 'unchanged') return prevDiff

      const newPart: DiffBlock = {
        type: 'unchanged',
        value: [currentPart.originalValue, currentPart.modifiedValue]
          .filter(Boolean)
          .join('\n'),
      }
      return [
        ...prevDiff.slice(0, index),
        newPart,
        ...prevDiff.slice(index + 1),
      ]
    })
  }

  const updateCurrentDiffFromScroll = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    const scrollerRect = scroller.getBoundingClientRect()
    const scrollerTop = scrollerRect.top
    const visibleThreshold = 10

    for (let i = 0; i < modifiedBlockIndices.length; i++) {
      const element = diffBlockRefs.current[modifiedBlockIndices[i]]
      if (!element) continue

      const rect = element.getBoundingClientRect()
      const relativeTop = rect.top - scrollerTop

      if (relativeTop >= -visibleThreshold) {
        setCurrentDiffIndex(i)
        break
      }
    }
  }, [modifiedBlockIndices])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    const handleScroll = () => updateCurrentDiffFromScroll()
    scroller.addEventListener('scroll', handleScroll)
    return () => scroller.removeEventListener('scroll', handleScroll)
  }, [updateCurrentDiffFromScroll])

  useEffect(() => {
    if (modifiedBlockIndices.length > 0) {
      scrollToDiffBlock(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div id="smtcmp-apply-view">
      <div className="view-header">
        <div className="view-header-title-container mod-at-start">
          <div className="view-header-title">
            Review: {proposal.targetPath}
          </div>
          <div className="view-actions">
            <label className="smtcmp-auto-accept-toggle">
              <input
                type="checkbox"
                checked={autoAcceptEnabled}
                onChange={toggleAutoAccept}
              />
              <span>Always auto-accept</span>
            </label>
            <div className="smtcmp-diff-navigation">
              <button
                className="clickable-icon"
                onClick={handlePrevDiff}
                disabled={currentDiffIndex <= 0}
                aria-label="Previous diff"
              >
                <ChevronUp size={14} />
              </button>
              <span>
                {modifiedBlockIndices.length > 0
                  ? `${currentDiffIndex + 1} of ${modifiedBlockIndices.length}`
                  : '0 of 0'}
              </span>
              <button
                className="clickable-icon"
                onClick={handleNextDiff}
                disabled={currentDiffIndex >= modifiedBlockIndices.length - 1}
                aria-label="Next diff"
              >
                <ChevronDown size={14} />
              </button>
            </div>
            <button
              className="clickable-icon view-action"
              aria-label="Accept changes"
              onClick={handleAccept}
            >
              <CheckIcon size={14} />
              Accept
            </button>
            <button
              className="clickable-icon view-action"
              aria-label="Cancel"
              onClick={onReject}
            >
              <X size={14} />
              Cancel
            </button>
          </div>
        </div>
      </div>

      <div className="view-content">
        <div className="markdown-source-view cm-s-obsidian mod-cm6 node-insert-event is-readable-line-width is-live-preview is-folding show-properties">
          <div className="cm-editor">
            <div className="cm-scroller" ref={scrollerRef}>
              <div className="cm-sizer">
                <div className="smtcmp-inline-title">
                  {proposal.targetPath.replace(/\.[^/.]+$/, '')}
                </div>

                {diff.map((block, index) => (
                  <DiffBlockView
                    key={index}
                    block={block}
                    onAcceptIncoming={() => acceptIncomingBlock(index)}
                    onAcceptCurrent={() => acceptCurrentBlock(index)}
                    onAcceptBoth={() => acceptBothBlocks(index)}
                    ref={(el) => {
                      diffBlockRefs.current[index] = el
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const DiffBlockView = forwardRef<
  HTMLDivElement,
  {
    block: DiffBlock
    onAcceptIncoming: () => void
    onAcceptCurrent: () => void
    onAcceptBoth: () => void
  }
>(({ block, onAcceptIncoming, onAcceptCurrent, onAcceptBoth }, ref) => {
  if (block.type === 'unchanged') {
    return (
      <div className="smtcmp-diff-block">
        <div style={{ width: '100%' }}>{block.value}</div>
      </div>
    )
  }

  return (
    <div className="smtcmp-diff-block-container" ref={ref}>
      {block.originalValue && block.originalValue.length > 0 && (
        <div className="smtcmp-diff-block removed">
          <div style={{ width: '100%' }}>{block.originalValue}</div>
        </div>
      )}
      {block.modifiedValue && block.modifiedValue.length > 0 && (
        <div className="smtcmp-diff-block added">
          <div style={{ width: '100%' }}>{block.modifiedValue}</div>
        </div>
      )}
      <div className="smtcmp-diff-block-actions">
        <button onClick={onAcceptIncoming} className="smtcmp-accept">
          Accept Incoming
        </button>
        <button onClick={onAcceptCurrent} className="smtcmp-exclude">
          Accept Current
        </button>
        <button onClick={onAcceptBoth}>Accept Both</button>
      </div>
    </div>
  )
})

DiffBlockView.displayName = 'DiffBlockView'
