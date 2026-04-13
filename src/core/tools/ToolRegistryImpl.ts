/**
 * ToolRegistryImpl — ToolRegistry 接口的具体实现（Phase 3）
 *
 * 基于 Map 的简单注册中心。Phase 3 开始被 ConversationHarness 创建并使用。
 */

import type { McpTool } from '../../types/mcp.types'
import { getBuiltinToolTier } from '../mcp/builtin-tool-tiers'

import type { ToolEntry, ToolListFilter, ToolRegistry } from './ToolRegistry'

export class ToolRegistryImpl implements ToolRegistry {
  private readonly entries: Map<string, ToolEntry> = new Map()

  register(entry: ToolEntry): void {
    this.entries.set(entry.tool.name, entry)
  }

  unregister(name: string): void {
    this.entries.delete(name)
  }

  resolve(name: string): ToolEntry | undefined {
    return this.entries.get(name)
  }

  list(filter?: ToolListFilter): McpTool[] {
    const mode = filter?.mode ?? 'read-write'
    const result: McpTool[] = []

    for (const entry of this.entries.values()) {
      // 按 session 模式过滤：read-only 模式下隐藏 read-write / danger-zone 工具
      if (mode === 'read-only') {
        const tier = entry.tier ?? getBuiltinToolTier(entry.tool.name)
        if (tier === 'read-write' || tier === 'danger-zone') continue
      }
      result.push(entry.tool)
    }

    return result
  }

  get size(): number {
    return this.entries.size
  }
}
