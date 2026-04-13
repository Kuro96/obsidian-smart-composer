/**
 * ToolRegistry — Phase 1 接口定义
 *
 * 统一的工具注册与查询层。所有工具（内置 / 外部 MCP / skill）都通过此接口注册，
 * TurnEngine 和 ToolExecutor 通过此接口查找工具，而不直接依赖 McpManager。
 *
 * 当前（Phase 1-2）：此接口仅作为契约，ToolRegistry 的实现暂时委托给旧 McpManager。
 * Phase 3 之后：逐步由 BuiltinToolPack / ExternalMcpAdapter / SkillToolAdapter 填充。
 */

import type { McpTool } from '../../types/mcp.types'
import type { BuiltinToolTier } from '../mcp/builtin-tool-tiers'
import type { SessionMode } from '../mcp/mcpManager'

// ─── Tool Source ────────────────────────────────────────────────────────────

/** 工具的来源类型 */
export type ToolSource = 'builtin' | 'external-mcp' | 'skill'

// ─── Tool Execution Context ──────────────────────────────────────────────────

/** 工具执行时的上下文，传入 handler */
export type ToolExecutionContext = {
  conversationId: string
  signal?: AbortSignal
}

// ─── Tool Entry ──────────────────────────────────────────────────────────────

/**
 * ToolEntry — 注册到 registry 的工具完整描述。
 * - `tool`：发送给 LLM 的 JSON schema（McpTool 格式）
 * - `tier`：风险等级，内置工具有明确 tier，外部 MCP / skill 为 null
 * - `source`：来源，用于路由到对应执行器
 * - `sourceId`：外部 MCP server ID 或 skill name，内置工具为 undefined
 * - `handler`：实际执行函数，返回文本结果
 * - `approvalRequired`：是否需要用户批准后才能执行（由 policy 层决定最终行为）
 */
export type ToolEntry = {
  tool: McpTool
  tier: BuiltinToolTier | null
  source: ToolSource
  sourceId?: string
  handler: (
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ) => Promise<string>
  approvalRequired: boolean
}

// ─── ToolRegistry Interface ──────────────────────────────────────────────────

export type ToolListFilter = {
  /** 按 session 模式过滤可见工具（read-only 模式下隐藏 read-write / danger-zone） */
  mode?: SessionMode
  /** 是否排除已禁用的工具 */
  excludeDisabled?: boolean
}

/**
 * ToolRegistry — 工具注册中心。
 *
 * 主要职责：
 * 1. register / unregister：供各 ToolPack 和 Adapter 注册工具
 * 2. list：供 TurnEngine 构建发给 LLM 的工具列表
 * 3. resolve：供 ToolExecutor 查找工具 entry 并执行
 */
export type ToolRegistry = {
  /** 注册一个工具。同名工具会覆盖。 */
  register(entry: ToolEntry): void

  /** 注销一个工具 */
  unregister(name: string): void

  /** 获取工具 entry（含 handler），供执行器使用 */
  resolve(name: string): ToolEntry | undefined

  /** 列出满足过滤条件的工具 schema 列表，供发给 LLM */
  list(filter?: ToolListFilter): McpTool[]

  /** 当前注册的工具总数 */
  readonly size: number
}
