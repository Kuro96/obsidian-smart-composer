/**
 * SessionModePolicyImpl — SessionModePolicy 接口的具体实现（Phase 5）
 *
 * session 模式的单一数据源。
 * Phase 5：ConversationHarness 创建并持有此对象，将 sessionMode 参数存入其中。
 * Phase 6：Chat.tsx 改为订阅此对象，不再自己维护 sessionMode state。
 */

import type { SessionMode } from '../mcp/mcpManager'

import type { SessionModePolicy } from './types'

export class SessionModePolicyImpl implements SessionModePolicy {
  private _mode: SessionMode
  private readonly subscribers = new Set<(mode: SessionMode) => void>()

  constructor(initialMode: SessionMode = 'read-write') {
    this._mode = initialMode
  }

  get mode(): SessionMode {
    return this._mode
  }

  setMode(mode: SessionMode): void {
    if (mode === this._mode) return
    this._mode = mode
    for (const cb of this.subscribers) cb(mode)
  }

  subscribe(callback: (mode: SessionMode) => void): () => void {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }
}
