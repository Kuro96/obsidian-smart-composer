import isEqual from 'lodash.isequal'
import { App, Platform } from 'obsidian'
import * as path from 'path'

import { SmartComposerSettings } from '../../settings/schema/setting.types'
import {
  McpServerConfig,
  McpServerState,
  McpServerStatus,
  McpTool,
  McpToolCallResult,
} from '../../types/mcp.types'
import {
  ToolCallResponse,
  ToolCallResponseStatus,
} from '../../types/tool-call.types'

import { InvalidToolNameException, McpNotAvailableException } from './exception'
import {
  getToolName,
  parseToolName,
  validateServerName,
} from './tool-name-utils'
import { SkillManager } from '../skill/skillManager'

export class McpManager {
  static readonly TOOL_NAME_DELIMITER = '__' // Delimiter for tool name construction (serverName__toolName)
  static readonly VAULT_LIST_TOOL = 'vault_list'
  static readonly VAULT_READ_TOOL = 'vault_read'
  static readonly VAULT_WRITE_TOOL = 'vault_write'
  static readonly VAULT_EDIT_TOOL = 'vault_edit'
  static readonly VAULT_MKDIR_TOOL = 'vault_mkdir'

  public readonly disabled = !Platform.isDesktop // MCP should be disabled on mobile since it doesn't support node.js

  private settings: SmartComposerSettings
  private app: App
  private unsubscribeFromSettings: () => void
  private defaultEnv: Record<string, string>

  private servers: McpServerState[] = [] // IMPORTANT: Always use this.updateServers() to update this array
  private activeToolCalls: Map<string, AbortController> = new Map()
  private allowedToolsByConversation: Map<string, Set<string>> = new Map()
  private subscribers = new Set<(servers: McpServerState[]) => void>()

  private availableToolsCache: McpTool[] | null = null
  private skillManager: SkillManager

  constructor({
    app,
    settings,
    registerSettingsListener,
  }: {
    app: App
    settings: SmartComposerSettings
    registerSettingsListener: (
      listener: (settings: SmartComposerSettings) => void,
    ) => () => void
  }) {
    this.app = app
    this.settings = settings
    this.unsubscribeFromSettings = registerSettingsListener((newSettings) => {
      this.handleSettingsUpdate(newSettings)
    })
    this.skillManager = new SkillManager({
      getSettings: () => this.settings,
      getVaultRoot: () => {
        const adapter = this.app.vault.adapter as {
          basePath?: string
          getBasePath?: () => string
        }
        return adapter.basePath ?? adapter.getBasePath?.()
      },
      getVault: () => this.app.vault,
      getVaultAdapter: () =>
        this.app.vault.adapter as {
          list: (
            path: string,
          ) => Promise<{ files: string[]; folders: string[] }>
          read: (path: string) => Promise<string>
        },
    })
  }

  public async initialize() {
    if (this.disabled) {
      return
    }

    // Get default environment variables
    const { shellEnvSync } = await import('shell-env')
    this.defaultEnv = shellEnvSync()

    // Create MCP servers
    const servers = await Promise.all(
      this.settings.mcp.servers.map((serverConfig) =>
        this.connectServer(serverConfig),
      ),
    )
    this.updateServers(servers)
  }

  public cleanup() {
    // Disconnect all clients
    void Promise.all(
      this.servers
        .filter((s) => s.status === McpServerStatus.Connected)
        .map((s) => s.client.close()),
    )

    if (this.unsubscribeFromSettings) {
      this.unsubscribeFromSettings()
    }

    this.servers = []
    this.subscribers.clear()
    this.activeToolCalls.clear()
  }

  public getServers() {
    return this.servers
  }

  public subscribeServersChange(callback: (servers: McpServerState[]) => void) {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  public async handleSettingsUpdate(settings: SmartComposerSettings) {
    this.settings = settings
    const updatedServers = settings.mcp.servers.map(
      (serverConfig: McpServerConfig): McpServerState => {
        const existingServer = this.servers.find(
          (s) => s.name === serverConfig.id,
        )
        if (
          existingServer &&
          isEqual(existingServer.config.parameters, serverConfig.parameters) &&
          existingServer.config.enabled === serverConfig.enabled
        ) {
          // Server is already up to date
          return {
            ...existingServer,
            config: serverConfig,
          }
        }
        return {
          name: serverConfig.id,
          config: serverConfig,
          status: McpServerStatus.Connecting,
        }
      },
    )

    this.updateServers(updatedServers)

    await Promise.all(
      updatedServers
        .filter((s) => s.status === McpServerStatus.Connecting)
        .map(async (s) => {
          const server = await this.connectServer(s.config)
          this.updateServers((prevServers) =>
            prevServers.map((prevServer) =>
              prevServer.name === server.name ? server : prevServer,
            ),
          )
        }),
    )
  }

  private notifySubscribers() {
    for (const cb of this.subscribers) cb(this.servers)
  }

  private updateServers(
    newServersOrUpdater?:
      | McpServerState[]
      | ((prevServers: McpServerState[]) => McpServerState[]),
  ) {
    const currentServers = this.servers
    const nextServers =
      typeof newServersOrUpdater === 'function'
        ? newServersOrUpdater(currentServers)
        : (newServersOrUpdater ?? currentServers)

    // Find clients that need to be disconnected
    const clientsToDisconnect = currentServers
      .filter((server) => server.status === McpServerStatus.Connected)
      .map((server) => server.client)
      .filter(
        (client) =>
          !nextServers.some(
            (server) =>
              server.status === McpServerStatus.Connected &&
              server.client === client,
          ),
      )

    // Disconnect clients in the background
    if (clientsToDisconnect.length > 0) {
      void Promise.all(clientsToDisconnect.map((client) => client.close()))
    }

    this.servers = nextServers
    this.availableToolsCache = null // Invalidate available tools cache
    this.notifySubscribers() // Should call after invalidating the cache
  }

  private async connectServer(
    serverConfig: McpServerConfig,
  ): Promise<McpServerState> {
    if (this.disabled) {
      throw new McpNotAvailableException()
    }

    const { id: name, parameters: serverParams, enabled } = serverConfig

    if (!enabled) {
      return {
        name,
        config: serverConfig,
        status: McpServerStatus.Disconnected,
      }
    }

    try {
      validateServerName(name)
    } catch (error) {
      return {
        name,
        config: serverConfig,
        status: McpServerStatus.Error,
        error: error as Error,
      }
    }

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StdioClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/stdio.js'
    )
    const client = new Client({ name, version: '1.0.0' })

    try {
      await client.connect(
        new StdioClientTransport({
          ...serverParams,
          env: {
            ...this.defaultEnv,
            ...(serverParams.env ?? {}),
          },
        }),
      )
    } catch (error) {
      return {
        name,
        config: serverConfig,
        status: McpServerStatus.Error,
        error: new Error(
          `Failed to connect to MCP server ${name}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      }
    }

    try {
      const toolList = await client.listTools()
      return {
        name,
        config: serverConfig,
        status: McpServerStatus.Connected,
        client,
        tools: toolList.tools,
      }
    } catch (error) {
      return {
        name,
        config: serverConfig,
        status: McpServerStatus.Error,
        error: new Error(
          `Failed to list tools for MCP server ${name}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      }
    }
  }

  public async listAvailableTools(opts?: {
    enableSkill?: boolean
  }): Promise<McpTool[]> {
    if (this.disabled) {
      return []
    }

    if (this.availableToolsCache) {
      if (opts?.enableSkill === false) {
        return [...this.availableToolsCache]
      }
      const skill = await this.getSkillTool()
      return [...this.availableToolsCache, skill]
    }

    const availableTools = (
      await Promise.all(
        this.servers.map(async (server): Promise<McpTool[]> => {
          if (server.status !== McpServerStatus.Connected) {
            return []
          }
          try {
            const toolList = await server.client.listTools()
            return toolList.tools
              .filter((tool) => !server.config.toolOptions[tool.name]?.disabled)
              .map((tool) => ({
                ...tool,
                name: getToolName(server.name, tool.name),
              }))
          } catch (error) {
            console.error(
              `Failed to list tools for MCP server ${server.name}: ${error instanceof Error ? error.message : String(error)}`,
            )
            return []
          }
        }),
      )
    ).flat()

    availableTools.push(...this.getVaultTools())

    this.availableToolsCache = [...availableTools]
    if (opts?.enableSkill === false) {
      return availableTools
    }
    const skill = await this.getSkillTool()
    return [...availableTools, skill]
  }

  public listBuiltInTools(): McpTool[] {
    return this.getVaultTools()
  }

  public async getSkillPromptSection(): Promise<string> {
    return this.skillManager.getPromptSection()
  }

  public async listSkills(opts?: { includeDisabled?: boolean }) {
    if (opts?.includeDisabled) {
      return this.skillManager.listAll()
    }
    return this.skillManager.list()
  }

  public allowToolForConversation(
    requestToolName: string,
    conversationId: string,
  ): void {
    let allowedTools = this.allowedToolsByConversation.get(conversationId)
    if (!allowedTools) {
      allowedTools = new Set<string>()
      this.allowedToolsByConversation.set(conversationId, allowedTools)
    }
    allowedTools.add(requestToolName)
  }

  public isToolExecutionAllowed({
    requestToolName,
    conversationId,
  }: {
    requestToolName: string
    conversationId?: string
  }): boolean {
    // Check if the tool is allowed for the conversation
    if (conversationId) {
      if (
        this.allowedToolsByConversation
          .get(conversationId)
          ?.has(requestToolName)
      ) {
        return true
      }
    }

    try {
      const { serverName, toolName } = parseToolName(requestToolName)
      const server = this.servers.find((server) => server.name === serverName)
      if (!server) {
        return false
      }
      const toolOption = server.config.toolOptions[toolName]
      if (!toolOption) {
        return false
      }
      return toolOption.allowAutoExecution ?? false
    } catch (error) {
      if (error instanceof InvalidToolNameException) {
        return false
      }
      throw error
    }
  }

  public async callTool({
    name,
    args,
    id,
    signal,
  }: {
    name: string
    args?: Record<string, unknown> | string | undefined
    id?: string
    signal?: AbortSignal
  }): Promise<
    Extract<
      ToolCallResponse,
      {
        status:
          | ToolCallResponseStatus.Success
          | ToolCallResponseStatus.Error
          | ToolCallResponseStatus.Aborted
      }
    >
  > {
    if (this.disabled) {
      throw new McpNotAvailableException()
    }

    const toolAbortController = new AbortController()
    if (id !== undefined) {
      const existingAbortController = this.activeToolCalls.get(id)
      if (existingAbortController) {
        existingAbortController.abort()
      }
      this.activeToolCalls.set(id, toolAbortController)
    }
    const compositeSignal = toolAbortController.signal
    if (signal) {
      signal.addEventListener('abort', () => toolAbortController.abort())
    }

    try {
      if (this.isVaultTool(name)) {
        const parsedArgs: Record<string, unknown> | undefined =
          typeof args === 'string'
            ? args === ''
              ? {}
              : JSON.parse(args)
            : args
        const out = await this.callVaultTool(name, parsedArgs)
        return {
          status: ToolCallResponseStatus.Success,
          data: {
            type: 'text',
            text: out,
          },
        }
      }

      if (name === SkillManager.TOOL_NAME) {
        const parsedArgs: Record<string, unknown> | undefined =
          typeof args === 'string'
            ? args === ''
              ? {}
              : JSON.parse(args)
            : args
        const skill = parsedArgs?.name
        if (typeof skill !== 'string' || skill.trim().length === 0) {
          throw new Error('Skill tool requires a non-empty "name" argument')
        }
        const out = await this.skillManager.execute(skill)
        return {
          status: ToolCallResponseStatus.Success,
          data: {
            type: 'text',
            text: out,
          },
        }
      }

      const { serverName, toolName } = parseToolName(name)
      const server = this.servers.find((server) => server.name === serverName)
      if (!server) {
        throw new Error(`MCP server ${serverName} not found`)
      }
      if (server.status !== McpServerStatus.Connected) {
        throw new Error(`MCP server ${serverName} is not connected`)
      }
      const { client } = server

      const parsedArgs: Record<string, unknown> | undefined =
        typeof args === 'string' ? (args === '' ? {} : JSON.parse(args)) : args

      const result = (await client.callTool(
        {
          name: toolName,
          arguments: parsedArgs,
        },
        undefined,
        {
          signal: compositeSignal,
        },
      )) as McpToolCallResult

      if (result.content.length === 0) {
        throw new Error('Tool call returned no content')
      }
      if (result.content[0].type !== 'text') {
        throw new Error(
          `Tool result with content type ${result.content[0].type} is not currently supported.`,
        )
      }
      if (result.isError) {
        return {
          status: ToolCallResponseStatus.Error,
          error: result.content[0].text,
        }
      }
      return {
        status: ToolCallResponseStatus.Success,
        data: {
          type: 'text',
          text: result.content[0].text,
        },
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        return {
          status: ToolCallResponseStatus.Aborted,
        }
      }

      // Handle other errors
      return {
        status: ToolCallResponseStatus.Error,
        error: error.message || 'Unknown error occurred',
      }
    } finally {
      if (id !== undefined) {
        this.activeToolCalls.delete(id)
      }
    }
  }

  public abortToolCall(id: string): boolean {
    if (this.disabled) {
      return false
    }
    const toolAbortController = this.activeToolCalls.get(id)
    if (toolAbortController) {
      toolAbortController.abort()
      this.activeToolCalls.delete(id)
      return true
    }
    return false
  }

  private async getSkillTool(): Promise<McpTool> {
    const details = await this.skillManager.getToolDescription()
    return {
      name: SkillManager.TOOL_NAME,
      description: details.description,
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: `The name of the skill from available_skills${details.hint}`,
          },
        },
        required: ['name'],
      },
    }
  }

  private getVaultTools(): McpTool[] {
    return [
      {
        name: McpManager.VAULT_LIST_TOOL,
        description:
          'List files and folders under a vault-relative directory. Use this before reading or writing files.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'Vault-relative directory path to list. Default is vault root.',
            },
          },
          required: [],
        },
      },
      {
        name: McpManager.VAULT_READ_TOOL,
        description:
          'Read a UTF-8 text file from the vault by vault-relative path.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Vault-relative file path to read.',
            },
          },
          required: ['path'],
        },
      },
      {
        name: McpManager.VAULT_WRITE_TOOL,
        description:
          'Write UTF-8 text content to a vault-relative file path (full overwrite). Prefer vault_edit for normal file updates. Use vault_write when vault_edit is not suitable (e.g., near-complete rewrite) or when vault_edit fails.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Vault-relative file path to write.',
            },
            content: {
              type: 'string',
              description: 'Full UTF-8 text content to write.',
            },
            createDirectories: {
              type: 'boolean',
              description:
                'Whether to create missing parent directories. Default true.',
            },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: McpManager.VAULT_EDIT_TOOL,
        description:
          'Edit part of a UTF-8 text file by replacing oldText with newText. This is the preferred tool for file modifications. Use vault_write only when vault_edit is not suitable (e.g., near-complete rewrite) or after vault_edit fails.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Vault-relative file path to edit.',
            },
            oldText: {
              type: 'string',
              description: 'Exact text snippet to replace.',
            },
            newText: {
              type: 'string',
              description: 'Replacement text snippet.',
            },
            replaceAll: {
              type: 'boolean',
              description:
                'Replace all occurrences when true. Default false (expects exactly one match).',
            },
          },
          required: ['path', 'oldText', 'newText'],
        },
      },
      {
        name: McpManager.VAULT_MKDIR_TOOL,
        description:
          'Create a vault-relative directory path recursively if it does not exist.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Vault-relative directory path to create.',
            },
          },
          required: ['path'],
        },
      },
    ]
  }

  private isVaultTool(name: string): boolean {
    return [
      McpManager.VAULT_LIST_TOOL,
      McpManager.VAULT_READ_TOOL,
      McpManager.VAULT_WRITE_TOOL,
      McpManager.VAULT_EDIT_TOOL,
      McpManager.VAULT_MKDIR_TOOL,
    ].includes(name)
  }

  private async callVaultTool(
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<string> {
    const adapter = this.app.vault.adapter as {
      list: (path: string) => Promise<{ files: string[]; folders: string[] }>
      read: (path: string) => Promise<string>
      write: (path: string, data: string) => Promise<void>
      mkdir: (path: string) => Promise<void>
      exists?: (path: string, sensitive?: boolean) => Promise<boolean>
    }

    if (name === McpManager.VAULT_LIST_TOOL) {
      const relativePath = this.normalizeVaultPath(
        typeof args?.path === 'string' ? args.path : '',
      )
      const listed = await adapter.list(relativePath)
      return JSON.stringify(
        {
          path: relativePath,
          folders: listed.folders,
          files: listed.files,
        },
        null,
        2,
      )
    }

    if (name === McpManager.VAULT_READ_TOOL) {
      const rawPath = args?.path
      if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
        throw new Error('vault_read requires a non-empty "path"')
      }
      const relativePath = this.normalizeVaultPath(rawPath)
      const content = await adapter.read(relativePath)
      return content
    }

    if (name === McpManager.VAULT_WRITE_TOOL) {
      const rawPath = args?.path
      const content = args?.content
      if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
        throw new Error('vault_write requires a non-empty "path"')
      }
      if (typeof content !== 'string') {
        throw new Error('vault_write requires a string "content"')
      }
      const relativePath = this.normalizeVaultPath(rawPath)
      const createDirectories =
        typeof args?.createDirectories === 'boolean'
          ? args.createDirectories
          : true

      if (createDirectories) {
        await this.ensureParentDirectory(relativePath, adapter)
      }
      await adapter.write(relativePath, content)
      return `Wrote ${content.length} bytes to ${relativePath}`
    }

    if (name === McpManager.VAULT_EDIT_TOOL) {
      const rawPath = args?.path
      const oldText = args?.oldText
      const newText = args?.newText
      const replaceAll = args?.replaceAll === true

      if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
        throw new Error('vault_edit requires a non-empty "path"')
      }
      if (typeof oldText !== 'string' || oldText.length === 0) {
        throw new Error('vault_edit requires a non-empty string "oldText"')
      }
      if (typeof newText !== 'string') {
        throw new Error('vault_edit requires a string "newText"')
      }

      const relativePath = this.normalizeVaultPath(rawPath)
      const original = await adapter.read(relativePath)
      const occurrences = original.split(oldText).length - 1

      if (occurrences === 0) {
        throw new Error(`vault_edit could not find oldText in ${relativePath}`)
      }
      if (!replaceAll && occurrences !== 1) {
        throw new Error(
          `vault_edit found ${occurrences} matches; set replaceAll=true or provide a more specific oldText`,
        )
      }

      const next = replaceAll
        ? original.split(oldText).join(newText)
        : original.replace(oldText, newText)
      await adapter.write(relativePath, next)
      return `Edited ${relativePath}; replaced ${replaceAll ? occurrences : 1} occurrence(s)`
    }

    if (name === McpManager.VAULT_MKDIR_TOOL) {
      const rawPath = args?.path
      if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
        throw new Error('vault_mkdir requires a non-empty "path"')
      }
      const relativePath = this.normalizeVaultPath(rawPath)
      await this.mkdirRecursive(relativePath, adapter)
      return `Created directory ${relativePath}`
    }

    throw new Error(`Unsupported vault tool: ${name}`)
  }

  private normalizeVaultPath(input: string): string {
    const normalized = input.trim().replace(/\\/g, '/').replace(/^\.\//, '')
    if (normalized.length === 0) {
      return ''
    }
    if (normalized.startsWith('/')) {
      throw new Error(
        'Vault path must be relative, absolute paths are not allowed',
      )
    }
    const parsed = path.posix.normalize(normalized)
    if (
      parsed === '..' ||
      parsed.startsWith('../') ||
      parsed.includes('/../')
    ) {
      throw new Error('Vault path cannot escape vault root')
    }
    return parsed
  }

  private async ensureParentDirectory(
    filePath: string,
    adapter: {
      mkdir: (path: string) => Promise<void>
      exists?: (path: string, sensitive?: boolean) => Promise<boolean>
    },
  ) {
    const parent = path.posix.dirname(filePath)
    if (!parent || parent === '.') {
      return
    }
    await this.mkdirRecursive(parent, adapter)
  }

  private async mkdirRecursive(
    dirPath: string,
    adapter: {
      mkdir: (path: string) => Promise<void>
      exists?: (path: string, sensitive?: boolean) => Promise<boolean>
    },
  ) {
    const parts = dirPath.split('/').filter(Boolean)
    let cursor = ''
    for (const part of parts) {
      cursor = cursor.length === 0 ? part : `${cursor}/${part}`
      const exists = adapter.exists ? await adapter.exists(cursor) : false
      if (!exists) {
        await adapter.mkdir(cursor).catch((error: Error) => {
          if (!`${error?.message ?? ''}`.includes('already exists')) {
            throw error
          }
        })
      }
    }
  }
}
