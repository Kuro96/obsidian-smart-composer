/**
 * ExternalMcpAdapter — 外部 MCP server 工具注册适配器（Phase 3）
 *
 * 将一个已连接的外部 MCP server 的工具注册到 ToolRegistry。
 * McpManager 仍负责 server 的连接生命周期；此适配器只负责"注册工具到 ToolRegistry"。
 */

import type { McpClient, McpTool, McpToolCallResult } from '../../../types/mcp.types'
import { McpServerStatus } from '../../../types/mcp.types'
import type { McpServerState } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { getToolName, parseToolName } from '../../mcp/tool-name-utils'
import type { ToolEntry, ToolRegistry } from '../ToolRegistry'

/**
 * 将一个已连接的外部 MCP server 的所有工具注册到 ToolRegistry。
 * 只注册未被 disabled 的工具。
 */
export function registerExternalMcpServer(
  serverState: McpServerState,
  registry: ToolRegistry,
): void {
  if (serverState.status !== McpServerStatus.Connected) return

  const { name: serverName, config, client, tools } = serverState

  for (const tool of tools) {
    if (config.toolOptions[tool.name]?.disabled) continue

    const qualifiedName = getToolName(serverName, tool.name)
    const toolEntry: ToolEntry = {
      tool: {
        ...tool,
        name: qualifiedName,
      },
      tier: null, // external MCP tools have no builtin tier
      source: 'external-mcp',
      sourceId: serverName,
      approvalRequired: !(config.toolOptions[tool.name]?.allowAutoExecution ?? false),
      handler: makeExternalMcpHandler(client, tool.name),
    }
    registry.register(toolEntry)
  }
}

function makeExternalMcpHandler(
  client: McpClient,
  originalToolName: string,
): ToolEntry['handler'] {
  return async (args, ctx) => {
    const abortController = new AbortController()
    if (ctx.signal) {
      ctx.signal.addEventListener('abort', () => abortController.abort())
    }

    const result = (await client.callTool(
      { name: originalToolName, arguments: args },
      undefined,
      { signal: abortController.signal },
    )) as McpToolCallResult

    if (result.content.length === 0) throw new Error('Tool call returned no content')
    if (result.content[0].type !== 'text') {
      throw new Error(
        `Tool result with content type ${result.content[0].type} is not currently supported.`,
      )
    }
    if (result.isError) throw new Error(result.content[0].text)
    return result.content[0].text
  }
}
