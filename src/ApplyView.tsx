import { View, WorkspaceLeaf } from 'obsidian'
import React from 'react'
import { Root, createRoot } from 'react-dom/client'

import ApplyViewRoot from './components/apply-view/ApplyViewRoot'
import { APPLY_VIEW_TYPE } from './constants'
import { AppProvider } from './contexts/app-context'
import { PluginProvider } from './contexts/plugin-context'
import SmartComposerPlugin from './main'
import { ProposedToolReview } from './types/tool-call.types'

export type ApplyViewState = {
  proposal: ProposedToolReview
  onAccept: (finalAfterText: string) => void
  onReject: () => void
}

export class ApplyView extends View {
  private root: Root | null = null
  private applyState: ApplyViewState | null = null

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: SmartComposerPlugin,
  ) {
    super(leaf)
  }

  getViewType() {
    return APPLY_VIEW_TYPE
  }

  getIcon() {
    return 'file-diff'
  }

  getDisplayText() {
    const path = this.applyState?.proposal.targetPath
    return path ? `Review: ${path}` : 'Review changes'
  }

  setApplyState(state: ApplyViewState) {
    this.applyState = state
    this.doRender()
  }

  async onOpen() {
    this.root = createRoot(this.containerEl)
  }

  async onClose() {
    this.root?.unmount()
  }

  private doRender() {
    if (!this.root || !this.applyState) return
    const { proposal, onAccept, onReject } = this.applyState

    const handleAccept = (finalAfterText: string) => {
      onAccept(finalAfterText)
      this.leaf.detach()
    }

    const handleReject = () => {
      onReject()
      this.leaf.detach()
    }

    this.root.render(
      <PluginProvider plugin={this.plugin}>
        <AppProvider app={this.app}>
          <React.StrictMode>
            <ApplyViewRoot
              proposal={proposal}
              onAccept={handleAccept}
              onReject={handleReject}
              plugin={this.plugin}
            />
          </React.StrictMode>
        </AppProvider>
      </PluginProvider>,
    )
  }
}
