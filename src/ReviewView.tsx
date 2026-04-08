import { ItemView, WorkspaceLeaf } from 'obsidian'
import React from 'react'
import { Root, createRoot } from 'react-dom/client'

import { ReviewPanel } from './components/review-view/ReviewPanel'
import { REVIEW_VIEW_TYPE } from './constants'
import { AppProvider } from './contexts/app-context'
import { PluginProvider } from './contexts/plugin-context'
import SmartComposerPlugin from './main'
import { ProposedToolReview } from './types/tool-call.types'

export class ReviewView extends ItemView {
  private root: Root | null = null
  private proposal: ProposedToolReview | null

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: SmartComposerPlugin,
  ) {
    super(leaf)
    this.proposal = plugin.initialReviewProposal ?? null
  }

  getViewType() {
    return REVIEW_VIEW_TYPE
  }

  getIcon() {
    return 'file-diff'
  }

  getDisplayText() {
    return 'Smart composer review'
  }

  async onOpen() {
    await this.render()
    this.proposal = null
  }

  async onClose() {
    this.root?.unmount()
  }

  setProposal(proposal: ProposedToolReview) {
    this.proposal = proposal
    void this.render()
  }

  async render() {
    if (!this.root) {
      this.root = createRoot(this.containerEl.children[1])
    }

    this.root.render(
      <PluginProvider plugin={this.plugin}>
        <AppProvider app={this.app}>
          <React.StrictMode>
            <ReviewPanel proposal={this.proposal} />
          </React.StrictMode>
        </AppProvider>
      </PluginProvider>,
    )
  }
}
