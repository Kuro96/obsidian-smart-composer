import isEqual from 'lodash.isequal'
import { App, Platform, TFile } from 'obsidian'
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
  static readonly VAULT_DELETE_TOOL = 'vault_delete'
  static readonly VAULT_APPEND_TOOL = 'vault_append'
  static readonly COMMANDS_LIST_TOOL = 'commands_list'
  static readonly TAGS_LIST_TOOL = 'tags_list'
  static readonly NOTE_OPEN_TOOL = 'note_open'
  static readonly ACTIVE_NOTE_GET_TOOL = 'active_note_get'
  static readonly ACTIVE_NOTE_PUT_TOOL = 'active_note_put'
  static readonly ACTIVE_NOTE_APPEND_TOOL = 'active_note_append'
  static readonly ACTIVE_NOTE_DELETE_TOOL = 'active_note_delete'
  static readonly VAULT_GET_TOOL = 'vault_get'
  static readonly SEARCH_SIMPLE_TOOL = 'search_simple'
  static readonly COMMAND_EXECUTE_TOOL = 'command_execute'
  static readonly SEARCH_DATAVIEW_TOOL = 'search_dataview'
  static readonly SEARCH_JSONLOGIC_TOOL = 'search_jsonlogic'

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
      {
        name: McpManager.VAULT_DELETE_TOOL,
        description:
          'DESTRUCTIVE: Move a vault file or folder to the system trash. This cannot be undone from within Obsidian. Confirm the correct path before calling.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Vault-relative file or folder path to delete.',
            },
          },
          required: ['path'],
        },
      },
      {
        name: McpManager.COMMANDS_LIST_TOOL,
        description:
          'List all available Obsidian commands with their IDs and names.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: McpManager.TAGS_LIST_TOOL,
        description: 'List all tags used in the vault.',
        inputSchema: {
          type: 'object',
          properties: {
            includeCounts: {
              type: 'boolean',
              description:
                'When true, include the usage count for each tag. Default false.',
            },
          },
          required: [],
        },
      },
      {
        name: McpManager.NOTE_OPEN_TOOL,
        description:
          'Open a note in the Obsidian UI. This is a stateful UI operation — it changes the active leaf visible to the user.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Vault-relative path of the note to open.',
            },
            newLeaf: {
              type: 'boolean',
              description:
                'When true, open in a new tab instead of reusing an existing leaf. Default false.',
            },
            line: {
              type: 'number',
              description:
                'Line number (1-indexed) to scroll to after opening.',
            },
          },
          required: ['path'],
        },
      },
      {
        name: McpManager.VAULT_APPEND_TOOL,
        description:
          'Append text to the end of a vault file. Creates the file if it does not exist.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Vault-relative file path.',
            },
            content: {
              type: 'string',
              description: 'Text to append.',
            },
            createDirectories: {
              type: 'boolean',
              description:
                'Create missing parent directories. Default true.',
            },
            ensureTrailingNewline: {
              type: 'boolean',
              description:
                'Insert a newline before appending if the file does not already end with one. Default false.',
            },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: McpManager.ACTIVE_NOTE_GET_TOOL,
        description: 'Read the currently active note in the Obsidian editor.',
        inputSchema: {
          type: 'object',
          properties: {
            format: {
              type: 'string',
              enum: ['text', 'note-json', 'document-map'],
              description:
                'Output format. text: raw content; note-json: frontmatter + content as JSON; document-map: headings/tags/links structure. Default text.',
            },
          },
          required: [],
        },
      },
      {
        name: McpManager.ACTIVE_NOTE_PUT_TOOL,
        description:
          'Overwrite the full content of the currently active note.',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'New full content for the active note.',
            },
          },
          required: ['content'],
        },
      },
      {
        name: McpManager.ACTIVE_NOTE_APPEND_TOOL,
        description: 'Append text to the end of the currently active note.',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Text to append.',
            },
            ensureTrailingNewline: {
              type: 'boolean',
              description:
                'Insert a newline before appending if the note does not end with one. Default false.',
            },
          },
          required: ['content'],
        },
      },
      {
        name: McpManager.ACTIVE_NOTE_DELETE_TOOL,
        description:
          'DESTRUCTIVE: Move the currently active note to the system trash.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: McpManager.VAULT_GET_TOOL,
        description:
          'Read a vault file or directory with richer output formats than vault_read.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Vault-relative file or directory path.',
            },
            format: {
              type: 'string',
              enum: ['text', 'directory', 'note-json', 'document-map'],
              description:
                'Output format. text: raw file content (default); directory: folder listing; note-json: frontmatter + content; document-map: headings/tags/links.',
            },
          },
          required: ['path'],
        },
      },
      {
        name: McpManager.SEARCH_SIMPLE_TOOL,
        description:
          'Search vault notes by filename or content. Returns matching files with match type and an optional context snippet.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Text to search for (case-insensitive).',
            },
            contextLength: {
              type: 'number',
              description:
                'Characters of surrounding context to include for content matches. Default 100.',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return. Default 20.',
            },
          },
          required: ['query'],
        },
      },
      {
        name: McpManager.COMMAND_EXECUTE_TOOL,
        description:
          'STATEFUL: Execute an Obsidian command by its ID. Use commands_list to discover valid IDs. Commands can trigger broad side effects.',
        inputSchema: {
          type: 'object',
          properties: {
            commandId: {
              type: 'string',
              description: 'The Obsidian command ID to execute.',
            },
          },
          required: ['commandId'],
        },
      },
      {
        name: McpManager.SEARCH_DATAVIEW_TOOL,
        description:
          'Execute a Dataview DQL query against the vault. Requires the Dataview plugin to be installed and enabled.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Dataview DQL query string.',
            },
          },
          required: ['query'],
        },
      },
      {
        name: McpManager.SEARCH_JSONLOGIC_TOOL,
        description:
          'Filter vault notes by metadata using a JSONLogic expression. Supported operators: ==, !=, <, <=, >, >=, and, or, not, in, var. The var operator accesses note fields: path, basename, extension, size, ctime, mtime, frontmatter.<key>, tags (array of strings).',
        inputSchema: {
          type: 'object',
          properties: {
            filter: {
              type: 'object',
              description: 'JSONLogic filter expression object.',
            },
          },
          required: ['filter'],
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
      McpManager.VAULT_DELETE_TOOL,
      McpManager.VAULT_APPEND_TOOL,
      McpManager.COMMANDS_LIST_TOOL,
      McpManager.TAGS_LIST_TOOL,
      McpManager.NOTE_OPEN_TOOL,
      McpManager.ACTIVE_NOTE_GET_TOOL,
      McpManager.ACTIVE_NOTE_PUT_TOOL,
      McpManager.ACTIVE_NOTE_APPEND_TOOL,
      McpManager.ACTIVE_NOTE_DELETE_TOOL,
      McpManager.VAULT_GET_TOOL,
      McpManager.SEARCH_SIMPLE_TOOL,
      McpManager.COMMAND_EXECUTE_TOOL,
      McpManager.SEARCH_DATAVIEW_TOOL,
      McpManager.SEARCH_JSONLOGIC_TOOL,
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

    if (name === McpManager.VAULT_DELETE_TOOL) {
      const rawPath = args?.path
      if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
        throw new Error('vault_delete requires a non-empty "path"')
      }
      const relativePath = this.normalizeVaultPath(rawPath)
      const target = this.app.vault.getAbstractFileByPath(relativePath)
      if (!target) {
        throw new Error(`vault_delete: path not found: ${relativePath}`)
      }
      await this.app.vault.trash(target, true)
      return `Moved to trash: ${relativePath}`
    }

    if (name === McpManager.COMMANDS_LIST_TOOL) {
      const commandsMap = (
        this.app as App & {
          commands: { commands: Record<string, { id: string; name: string }> }
        }
      ).commands.commands
      const commands = Object.values(commandsMap).map((cmd) => ({
        id: cmd.id,
        name: cmd.name,
      }))
      return JSON.stringify(commands, null, 2)
    }

    if (name === McpManager.TAGS_LIST_TOOL) {
      const includeCounts = args?.includeCounts === true
      const tagsWithCounts = (
        this.app.metadataCache as typeof this.app.metadataCache & {
          getTags: () => Record<string, number>
        }
      ).getTags()
      if (includeCounts) {
        return JSON.stringify(tagsWithCounts, null, 2)
      }
      return JSON.stringify(Object.keys(tagsWithCounts).sort(), null, 2)
    }

    if (name === McpManager.NOTE_OPEN_TOOL) {
      const rawPath = args?.path
      if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
        throw new Error('note_open requires a non-empty "path"')
      }
      const relativePath = this.normalizeVaultPath(rawPath)
      const file = this.app.vault.getAbstractFileByPath(relativePath)
      if (!file || !(file instanceof TFile)) {
        throw new Error(`note_open: file not found: ${relativePath}`)
      }
      const newLeaf = args?.newLeaf === true
      const line =
        typeof args?.line === 'number' ? Math.max(1, args.line) : undefined
      const leaf = newLeaf
        ? this.app.workspace.getLeaf('tab')
        : this.app.workspace.getLeaf(false)
      await leaf.openFile(file, {
        eState: line !== undefined ? { line: line - 1 } : undefined,
      })
      return `Opened ${relativePath}${line !== undefined ? ` at line ${line}` : ''}`
    }

    if (name === McpManager.VAULT_APPEND_TOOL) {
      const rawPath = args?.path
      const content = args?.content
      if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
        throw new Error('vault_append requires a non-empty "path"')
      }
      if (typeof content !== 'string') {
        throw new Error('vault_append requires a string "content"')
      }
      const relativePath = this.normalizeVaultPath(rawPath)
      const createDirectories =
        typeof args?.createDirectories === 'boolean'
          ? args.createDirectories
          : true
      const ensureTrailingNewline = args?.ensureTrailingNewline === true

      if (createDirectories) {
        await this.ensureParentDirectory(relativePath, adapter)
      }
      const exists = adapter.exists ? await adapter.exists(relativePath) : false
      let existing = ''
      if (exists) {
        existing = await adapter.read(relativePath)
        if (
          ensureTrailingNewline &&
          existing.length > 0 &&
          !existing.endsWith('\n')
        ) {
          existing += '\n'
        }
      }
      await adapter.write(relativePath, existing + content)
      return `Appended ${content.length} bytes to ${relativePath}`
    }

    if (name === McpManager.ACTIVE_NOTE_GET_TOOL) {
      const activeFile = this.app.workspace.getActiveFile()
      if (!activeFile) {
        throw new Error('active_note_get: no active file')
      }
      const format =
        typeof args?.format === 'string' ? args.format : 'text'

      if (format === 'text') {
        return await this.app.vault.cachedRead(activeFile)
      }
      if (format === 'note-json') {
        const content = await this.app.vault.cachedRead(activeFile)
        const cache = this.app.metadataCache.getFileCache(activeFile)
        return JSON.stringify(
          { path: activeFile.path, frontmatter: cache?.frontmatter ?? {}, content },
          null,
          2,
        )
      }
      if (format === 'document-map') {
        const cache = this.app.metadataCache.getFileCache(activeFile)
        return JSON.stringify(
          {
            path: activeFile.path,
            frontmatter: cache?.frontmatter ?? {},
            headings: cache?.headings ?? [],
            tags: (cache?.tags ?? []).map((t) => t.tag),
            links: cache?.links ?? [],
          },
          null,
          2,
        )
      }
      throw new Error(`active_note_get: unknown format "${format}"`)
    }

    if (name === McpManager.ACTIVE_NOTE_PUT_TOOL) {
      const activeFile = this.app.workspace.getActiveFile()
      if (!activeFile) {
        throw new Error('active_note_put: no active file')
      }
      const content = args?.content
      if (typeof content !== 'string') {
        throw new Error('active_note_put requires a string "content"')
      }
      await this.app.vault.modify(activeFile, content)
      return `Wrote ${content.length} bytes to ${activeFile.path}`
    }

    if (name === McpManager.ACTIVE_NOTE_APPEND_TOOL) {
      const activeFile = this.app.workspace.getActiveFile()
      if (!activeFile) {
        throw new Error('active_note_append: no active file')
      }
      const content = args?.content
      if (typeof content !== 'string') {
        throw new Error('active_note_append requires a string "content"')
      }
      const ensureTrailingNewline = args?.ensureTrailingNewline === true
      let existing = await this.app.vault.read(activeFile)
      if (
        ensureTrailingNewline &&
        existing.length > 0 &&
        !existing.endsWith('\n')
      ) {
        existing += '\n'
      }
      await this.app.vault.modify(activeFile, existing + content)
      return `Appended ${content.length} bytes to ${activeFile.path}`
    }

    if (name === McpManager.ACTIVE_NOTE_DELETE_TOOL) {
      const activeFile = this.app.workspace.getActiveFile()
      if (!activeFile) {
        throw new Error('active_note_delete: no active file')
      }
      const filePath = activeFile.path
      await this.app.vault.trash(activeFile, true)
      return `Moved to trash: ${filePath}`
    }

    if (name === McpManager.VAULT_GET_TOOL) {
      const rawPath = args?.path
      if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
        throw new Error('vault_get requires a non-empty "path"')
      }
      const relativePath = this.normalizeVaultPath(rawPath)
      const format =
        typeof args?.format === 'string' ? args.format : 'text'

      if (format === 'directory') {
        const listed = await adapter.list(relativePath)
        return JSON.stringify(
          { path: relativePath, folders: listed.folders, files: listed.files },
          null,
          2,
        )
      }

      const file = this.app.vault.getFileByPath(relativePath)
      if (!file) {
        throw new Error(`vault_get: file not found: ${relativePath}`)
      }

      if (format === 'text') {
        return await adapter.read(relativePath)
      }
      if (format === 'note-json') {
        const content = await adapter.read(relativePath)
        const cache = this.app.metadataCache.getFileCache(file)
        return JSON.stringify(
          { path: relativePath, frontmatter: cache?.frontmatter ?? {}, content },
          null,
          2,
        )
      }
      if (format === 'document-map') {
        const cache = this.app.metadataCache.getFileCache(file)
        return JSON.stringify(
          {
            path: relativePath,
            frontmatter: cache?.frontmatter ?? {},
            headings: cache?.headings ?? [],
            tags: (cache?.tags ?? []).map((t) => t.tag),
            links: cache?.links ?? [],
          },
          null,
          2,
        )
      }
      throw new Error(`vault_get: unknown format "${format}"`)
    }

    if (name === McpManager.SEARCH_SIMPLE_TOOL) {
      const query = args?.query
      if (typeof query !== 'string' || query.trim().length === 0) {
        throw new Error('search_simple requires a non-empty "query"')
      }
      const contextLength =
        typeof args?.contextLength === 'number' ? args.contextLength : 100
      const limit = typeof args?.limit === 'number' ? args.limit : 20

      const queryLower = query.toLowerCase()
      const allFiles = this.app.vault.getMarkdownFiles()
      const results: Array<{
        path: string
        matchType: 'filename' | 'content'
        context?: string
      }> = []

      for (const file of allFiles) {
        if (results.length >= limit) break
        if (file.name.toLowerCase().includes(queryLower)) {
          results.push({ path: file.path, matchType: 'filename' })
          continue
        }
        const content = await this.app.vault.cachedRead(file)
        const idx = content.toLowerCase().indexOf(queryLower)
        if (idx !== -1) {
          const start = Math.max(0, idx - Math.floor(contextLength / 2))
          const end = Math.min(
            content.length,
            idx + query.length + Math.floor(contextLength / 2),
          )
          results.push({
            path: file.path,
            matchType: 'content',
            context: content.slice(start, end),
          })
        }
      }
      return JSON.stringify(results, null, 2)
    }

    if (name === McpManager.COMMAND_EXECUTE_TOOL) {
      const commandId = args?.commandId
      if (typeof commandId !== 'string' || commandId.trim().length === 0) {
        throw new Error('command_execute requires a non-empty "commandId"')
      }
      const commandsObj = (
        this.app as App & {
          commands: {
            commands: Record<string, { id: string; name: string }>
            executeCommandById: (id: string) => boolean
          }
        }
      ).commands
      if (!commandsObj.commands[commandId]) {
        throw new Error(`command_execute: command not found: ${commandId}`)
      }
      const executed = commandsObj.executeCommandById(commandId)
      if (!executed) {
        throw new Error(
          `command_execute: command could not be executed: ${commandId}`,
        )
      }
      return `Executed command: ${commandId}`
    }

    if (name === McpManager.SEARCH_DATAVIEW_TOOL) {
      const query = args?.query
      if (typeof query !== 'string' || query.trim().length === 0) {
        throw new Error('search_dataview requires a non-empty "query"')
      }
      const dvPlugin = (
        this.app as App & {
          plugins?: { plugins?: Record<string, { api?: unknown }> }
        }
      ).plugins?.plugins?.['dataview']
      if (!dvPlugin?.api) {
        throw new Error(
          'search_dataview: Dataview plugin is not installed or enabled',
        )
      }
      const dv = dvPlugin.api as {
        query: (q: string) => Promise<{
          successful: boolean
          value: unknown
          error?: string
        }>
      }
      const result = await dv.query(query)
      if (!result.successful) {
        throw new Error(
          `search_dataview: query failed: ${result.error ?? 'unknown error'}`,
        )
      }
      return JSON.stringify(result.value, null, 2)
    }

    if (name === McpManager.SEARCH_JSONLOGIC_TOOL) {
      const filter = args?.filter
      if (
        filter === null ||
        typeof filter !== 'object' ||
        Array.isArray(filter)
      ) {
        throw new Error('search_jsonlogic requires an object "filter"')
      }

      const allFiles = this.app.vault.getMarkdownFiles()
      const matches: string[] = []

      for (const file of allFiles) {
        const cache = this.app.metadataCache.getFileCache(file)
        const noteData: Record<string, unknown> = {
          path: file.path,
          basename: file.basename,
          extension: file.extension,
          size: file.stat.size,
          ctime: file.stat.ctime,
          mtime: file.stat.mtime,
          frontmatter: cache?.frontmatter ?? {},
          tags: (cache?.tags ?? []).map((t) => t.tag),
        }
        if (McpManager.applyJsonLogic(filter, noteData)) {
          matches.push(file.path)
        }
      }
      return JSON.stringify(matches, null, 2)
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

  /**
   * Minimal JSONLogic evaluator supporting the operators advertised in the
   * search_jsonlogic tool description.
   */
  private static applyJsonLogic(
    rule: unknown,
    data: Record<string, unknown>,
  ): unknown {
    if (rule === null || typeof rule !== 'object') return rule
    if (Array.isArray(rule)) {
      return (rule as unknown[]).map((r) =>
        McpManager.applyJsonLogic(r, data),
      )
    }

    const entries = Object.entries(rule as Record<string, unknown>)
    if (entries.length !== 1) return rule

    const [op, rawArgs] = entries[0]

    // var must resolve before evaluating other operands
    if (op === 'var') {
      const key =
        typeof rawArgs === 'string' ? rawArgs : String(rawArgs ?? '')
      if (key === '') return data
      const parts = key.split('.')
      let val: unknown = data
      for (const part of parts) {
        if (val === null || val === undefined || typeof val !== 'object')
          return null
        val = (val as Record<string, unknown>)[part]
      }
      return val ?? null
    }

    // Lazy operators (short-circuit)
    if (op === 'and') {
      const items = Array.isArray(rawArgs) ? (rawArgs as unknown[]) : [rawArgs]
      for (const item of items) {
        const v = McpManager.applyJsonLogic(item, data)
        if (!v) return v
      }
      return true
    }
    if (op === 'or') {
      const items = Array.isArray(rawArgs) ? (rawArgs as unknown[]) : [rawArgs]
      for (const item of items) {
        const v = McpManager.applyJsonLogic(item, data)
        if (v) return v
      }
      return false
    }

    // Evaluate all arguments eagerly for the remaining operators
    const evalArgs = (
      Array.isArray(rawArgs) ? (rawArgs as unknown[]) : [rawArgs]
    ).map((a) => McpManager.applyJsonLogic(a, data))

    switch (op) {
      case '==':
        // eslint-disable-next-line eqeqeq
        return evalArgs[0] == evalArgs[1]
      case '===':
        return evalArgs[0] === evalArgs[1]
      case '!=':
        // eslint-disable-next-line eqeqeq
        return evalArgs[0] != evalArgs[1]
      case '!==':
        return evalArgs[0] !== evalArgs[1]
      case '>':
        return (evalArgs[0] as number) > (evalArgs[1] as number)
      case '>=':
        return (evalArgs[0] as number) >= (evalArgs[1] as number)
      case '<':
        return (evalArgs[0] as number) < (evalArgs[1] as number)
      case '<=':
        return (evalArgs[0] as number) <= (evalArgs[1] as number)
      case '!':
      case 'not':
        return !evalArgs[0]
      case 'in':
        if (Array.isArray(evalArgs[1]))
          return (evalArgs[1] as unknown[]).includes(evalArgs[0])
        if (typeof evalArgs[1] === 'string')
          return (evalArgs[1] as string).includes(String(evalArgs[0]))
        return false
      case 'cat':
        return evalArgs.map(String).join('')
      default:
        return null
    }
  }
}
