/**
 * buildToolRegistry — ToolRegistry 工厂函数（Phase 3）
 *
 * 按当前会话状态组装完整的 ToolRegistry：
 * 1. 注册所有内置工具 packs（Vault / Workspace / Commands / Search）
 * 2. 注册所有已连接的外部 MCP server 工具
 * 3. 注册 skill 工具（可选）
 *
 * 每次新建 ConversationHarness 时调用，确保使用最新的 server/skill 状态。
 */

import { App } from 'obsidian'

import { McpManager } from '../mcp/mcpManager'

import { registerExternalMcpServer } from './adapters/ExternalMcpAdapter'
import { SkillToolAdapter } from './adapters/SkillToolAdapter'
import { CommandsToolPack } from './packs/CommandsToolPack'
import { MetadataToolPack } from './packs/MetadataToolPack'
import { SearchToolPack } from './packs/SearchToolPack'
import { VaultToolPack } from './packs/VaultToolPack'
import { WorkspaceToolPack } from './packs/WorkspaceToolPack'
import type { ToolRegistry } from './ToolRegistry'
import { ToolRegistryImpl } from './ToolRegistryImpl'

export type BuildToolRegistryOptions = {
  app: App
  mcpManager: McpManager
  enableSkills: boolean
}

export async function buildToolRegistry(
  opts: BuildToolRegistryOptions,
): Promise<ToolRegistry> {
  const { app, mcpManager, enableSkills } = opts
  const registry = new ToolRegistryImpl()

  // 1. 注册内置工具 packs
  new VaultToolPack(app).registerAll(registry)
  new WorkspaceToolPack(app).registerAll(registry)
  new CommandsToolPack(app).registerAll(registry)
  new SearchToolPack(app).registerAll(registry)
  new MetadataToolPack(app).registerAll(registry)

  // 2. 注册外部 MCP server 工具
  for (const server of mcpManager.getServers()) {
    registerExternalMcpServer(server, registry)
  }

  // 3. 注册 skill 工具（若启用）
  if (enableSkills) {
    const skillAdapter = new SkillToolAdapter(mcpManager.getSkillManager())
    await skillAdapter.register(registry)
  }

  return registry
}
