import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleMinus,
  Edit,
  Loader2,
  PanelRight,
  Trash2,
  X,
} from 'lucide-react'
import { App } from 'obsidian'
import { useCallback, useEffect, useState } from 'react'

import { useSettings } from '../../../contexts/settings-context'
import {
  BUILTIN_DANGER_ZONE_TOOLS,
  BUILTIN_READ_ONLY_TOOLS,
  BUILTIN_READ_WRITE_TOOLS,
  getBuiltinToolTier,
} from '../../../core/mcp/builtin-tool-tiers'
import { McpManager } from '../../../core/mcp/mcpManager'
import { ApprovalDecision } from '../../../core/policy/types'
import SmartComposerPlugin from '../../../main'
import {
  McpServerState,
  McpServerStatus,
  McpTool,
} from '../../../types/mcp.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ConfirmModal } from '../../modals/ConfirmModal'
import {
  AddMcpServerModal,
  EditMcpServerModal,
} from '../modals/McpServerFormModal'

type McpSectionProps = {
  app: App
  plugin: SmartComposerPlugin
}

export function McpSection({ app, plugin }: McpSectionProps) {
  const { settings } = useSettings()
  const [mcpManager, setMcpManager] = useState<McpManager | null>(null)
  const [mcpServers, setMcpServers] = useState<McpServerState[]>([])
  const [builtInTools, setBuiltInTools] = useState<McpTool[]>([])

  const connectedServerCount = mcpServers.filter(
    (server) => server.status === McpServerStatus.Connected,
  ).length
  const enabledServerCount = mcpServers.filter(
    (server) => server.config.enabled,
  ).length
  const remoteToolCount = mcpServers.reduce(
    (count, server) =>
      server.status === McpServerStatus.Connected
        ? count + server.tools.length
        : count,
    0,
  )
  const toolsEnabled = settings.chatOptions.enableTools

  useEffect(() => {
    const initMCPManager = async () => {
      const mcpManager = await plugin.getMcpManager()
      setMcpManager(mcpManager)
      setMcpServers(mcpManager.getServers())
      setBuiltInTools(mcpManager.listBuiltInTools())
    }
    initMCPManager()
  }, [plugin])

  useEffect(() => {
    if (mcpManager) {
      const unsubscribe = mcpManager.subscribeServersChange((servers) => {
        setMcpServers(servers)
      })
      return () => {
        unsubscribe()
      }
    }
  }, [mcpManager])

  return (
    <div className="smtcmp-settings-section smtcmp-mcp-modal-shell">
      <div className="smtcmp-modal-summary-row">
        <span>MCP servers {mcpServers.length}</span>
        <span>Connected {connectedServerCount}</span>
        <span>Enabled {enabledServerCount}</span>
        <span>Remote tools {remoteToolCount}</span>
        <span>Built-in {builtInTools.length}</span>
        <span>Tools {toolsEnabled ? 'On' : 'Off'}</span>
      </div>

      {mcpManager?.externalServersDisabled ? (
        <div className="smtcmp-mcp-empty-state">
          <div className="smtcmp-settings-sub-header">
            External MCP servers are not supported on mobile devices
          </div>
          <div className="smtcmp-settings-desc">
            Built-in tools are available on mobile. Open Smart Composer on
            desktop to manage external MCP servers.
          </div>
        </div>
      ) : (
        <div className="smtcmp-mcp-panel-grid">
          <section className="smtcmp-mcp-panel smtcmp-mcp-panel--servers">
            <div className="smtcmp-settings-sub-header-container smtcmp-mcp-panel-header">
              <div>
                <div className="smtcmp-settings-sub-header">
                  User-installed MCP Servers
                </div>
                <div className="smtcmp-settings-desc smtcmp-mcp-panel-desc">
                  Saved server configuration. Add, edit, enable, and tune
                  external tool permissions here.
                </div>
              </div>
              <div className="smtcmp-mcp-panel-header-action">
                <ObsidianButton
                  text="Add MCP Server"
                  onClick={() => new AddMcpServerModal(app, plugin).open()}
                />
              </div>
            </div>

            <div className="smtcmp-mcp-servers-container">
              <div className="smtcmp-mcp-servers-header">
                <div>Server</div>
                <div>Status</div>
                <div>Enabled</div>
                <div>Actions</div>
              </div>
              {mcpServers.length > 0 ? (
                mcpServers.map((server) => (
                  <McpServerComponent
                    key={server.name}
                    server={server}
                    app={app}
                    plugin={plugin}
                  />
                ))
              ) : (
                <div className="smtcmp-mcp-servers-empty">
                  <div className="smtcmp-mcp-servers-empty-title">
                    No MCP servers configured
                  </div>
                  <div className="smtcmp-settings-desc">
                    Add a server to expose external tools and configure
                    auto-execution rules.
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="smtcmp-mcp-panel smtcmp-mcp-panel--builtin">
            <div className="smtcmp-mcp-panel-header smtcmp-settings-sub-header-container">
              <div>
                <div className="smtcmp-settings-sub-header">
                  Built-in Vault Tools
                </div>
                <div className="smtcmp-settings-desc smtcmp-mcp-panel-desc">
                  Built-in tools bundled with Smart Composer. These are runtime
                  capabilities, not per-server installs.
                </div>
              </div>
            </div>

            {builtInTools.length > 0 ? (
              <McpBuiltInWorkbench tools={builtInTools} />
            ) : (
              <div className="smtcmp-mcp-servers-empty">
                <div className="smtcmp-mcp-servers-empty-title">
                  No built-in tools available
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

function McpServerComponent({
  server,
  app,
  plugin,
}: {
  server: McpServerState
  app: App
  plugin: SmartComposerPlugin
}) {
  const { settings, setSettings } = useSettings()
  const [isOpen, setIsOpen] = useState(false)

  const handleEdit = useCallback(() => {
    new EditMcpServerModal(app, plugin, server.name).open()
  }, [server.name, app, plugin])

  const handleDelete = useCallback(() => {
    const message = `Are you sure you want to delete MCP server "${server.name}"?`
    new ConfirmModal(app, {
      title: 'Delete MCP Server',
      message: message,
      ctaText: 'Delete',
      onConfirm: async () => {
        await setSettings({
          ...settings,
          mcp: {
            ...settings.mcp,
            servers: settings.mcp.servers.filter((s) => s.id !== server.name),
          },
        })
      },
    }).open()
  }, [server.name, settings, setSettings, app])

  const handleToggleEnabled = useCallback(
    (enabled: boolean) => {
      setSettings({
        ...settings,
        mcp: {
          ...settings.mcp,
          servers: settings.mcp.servers.map((s) =>
            s.id === server.name ? { ...s, enabled } : s,
          ),
        },
      })
    },
    [settings, setSettings, server.name],
  )

  return (
    <div className="smtcmp-mcp-server">
      <div className="smtcmp-mcp-server-row">
        <div className="smtcmp-mcp-server-name">
          <button
            type="button"
            className="smtcmp-mcp-server-expand"
            onClick={() => setIsOpen(!isOpen)}
          >
            <span>{server.name}</span>
            {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
        <div className="smtcmp-mcp-server-status">
          <McpServerStatusBadge status={server.status} />
        </div>
        <div className="smtcmp-mcp-server-toggle">
          <ObsidianToggle
            value={server.config.enabled}
            onChange={handleToggleEnabled}
          />
        </div>
        <div className="smtcmp-mcp-server-actions">
          <button
            onClick={handleEdit}
            className="clickable-icon"
            aria-label="Edit"
          >
            <Edit size={16} />
          </button>
          <button
            onClick={handleDelete}
            className="clickable-icon"
            aria-label="Delete"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      {isOpen && <ExpandedServerInfo server={server} />}
    </div>
  )
}

function ExpandedServerInfo({ server }: { server: McpServerState }) {
  const [selectedToolName, setSelectedToolName] = useState<string | null>(null)

  useEffect(() => {
    if (server.status !== McpServerStatus.Connected) {
      setSelectedToolName(null)
      return
    }

    const hasSelectedTool = server.tools.some(
      (tool) => tool.name === selectedToolName,
    )

    if (!hasSelectedTool) {
      setSelectedToolName(server.tools[0]?.name ?? null)
    }
  }, [server, selectedToolName])

  if (
    server.status === McpServerStatus.Disconnected ||
    server.status === McpServerStatus.Connecting
  ) {
    return null
  }

  return (
    <div className="smtcmp-server-expanded-info">
      {server.status === McpServerStatus.Connected && (
        <div>
          <div className="smtcmp-server-expanded-info-header">Tools</div>
          <McpConnectedToolsWorkbench
            server={server}
            selectedToolName={selectedToolName}
            onSelectTool={setSelectedToolName}
          />
        </div>
      )}
      {server.status === McpServerStatus.Error && (
        <div>
          <div className="smtcmp-server-expanded-info-header">Error</div>
          <div className="smtcmp-server-error-message">
            {server.error.message}
          </div>
        </div>
      )}
    </div>
  )
}

function McpServerStatusBadge({ status }: { status: McpServerStatus }) {
  const statusConfig = {
    [McpServerStatus.Connected]: {
      icon: <Check size={16} />,
      label: 'Connected',
      statusClass: 'smtcmp-mcp-server-status-badge--connected',
    },
    [McpServerStatus.Connecting]: {
      icon: <Loader2 size={16} className="spinner" />,
      label: 'Connecting...',
      statusClass: 'smtcmp-mcp-server-status-badge--connecting',
    },
    [McpServerStatus.Error]: {
      icon: <X size={16} />,
      label: 'Error',
      statusClass: 'smtcmp-mcp-server-status-badge--error',
    },
    [McpServerStatus.Disconnected]: {
      icon: <CircleMinus size={14} />,
      label: 'Disconnected',
      statusClass: 'smtcmp-mcp-server-status-badge--disconnected',
    },
  }

  const { icon, label, statusClass } = statusConfig[status]

  return (
    <div className={`smtcmp-mcp-server-status-badge ${statusClass}`}>
      {icon}
      <div className="smtcmp-mcp-server-status-badge-label">{label}</div>
    </div>
  )
}

function McpConnectedToolsWorkbench({
  server,
  selectedToolName,
  onSelectTool,
}: {
  server: Extract<McpServerState, { status: McpServerStatus.Connected }>
  selectedToolName: string | null
  onSelectTool: (toolName: string) => void
}) {
  const selectedTool =
    server.tools.find((tool) => tool.name === selectedToolName) ??
    server.tools[0] ??
    null

  if (server.tools.length === 0) {
    return (
      <div className="smtcmp-mcp-tools-empty-panel">
        <div className="smtcmp-mcp-servers-empty-title">No tools exposed</div>
        <div className="smtcmp-settings-desc">
          This server is connected, but it has not reported any available tools.
        </div>
      </div>
    )
  }

  return (
    <div
      className={`smtcmp-mcp-tool-workbench${selectedTool ? '' : ' smtcmp-mcp-tool-workbench--no-detail'}`}
    >
      <div className="smtcmp-mcp-tool-table">
        <div className="smtcmp-mcp-tool-table-header smtcmp-mcp-tool-table-header--two-col">
          <div>Tool</div>
          <div>Enabled</div>
        </div>
        {server.tools.map((tool) => (
          <McpConnectedToolRow
            key={tool.name}
            tool={tool}
            server={server}
            selected={tool.name === selectedTool?.name}
            onSelect={() => onSelectTool(tool.name)}
          />
        ))}
      </div>

      {selectedTool && (
        <McpToolDetailPanel
          title={selectedTool.name}
          meta={`Connected via ${server.name}`}
          tool={selectedTool}
          server={server}
        />
      )}
    </div>
  )
}

function McpConnectedToolRow({
  tool,
  server,
  selected,
  onSelect,
}: {
  tool: McpTool
  server: Extract<McpServerState, { status: McpServerStatus.Connected }>
  selected: boolean
  onSelect: () => void
}) {
  const { settings, setSettings } = useSettings()

  const isEnabled = !(server.config.toolOptions[tool.name]?.disabled ?? false)

  const handleToggleEnabled = (enabled: boolean) => {
    const toolOptions = { ...server.config.toolOptions }
    toolOptions[tool.name] = {
      disabled: !enabled,
      allowAutoExecution: toolOptions[tool.name]?.allowAutoExecution ?? false,
    }
    setSettings({
      ...settings,
      mcp: {
        ...settings.mcp,
        servers: settings.mcp.servers.map((s) =>
          s.id === server.name ? { ...s, toolOptions } : s,
        ),
      },
    })
  }

  return (
    <button
      type="button"
      className={`smtcmp-mcp-tool-row-button smtcmp-mcp-tool-row-button--two-col${selected ? ' smtcmp-mcp-tool-row-button--selected' : ''}`}
      onClick={onSelect}
    >
      <div className="smtcmp-mcp-tool-row-main">
        <div className="smtcmp-mcp-tool-name">{tool.name}</div>
      </div>
      <div
        className="smtcmp-mcp-tool-row-toggle"
        onClick={(e) => e.stopPropagation()}
      >
        <ObsidianToggle value={isEnabled} onChange={handleToggleEnabled} />
      </div>
    </button>
  )
}

function McpBuiltInWorkbench({ tools }: { tools: McpTool[] }) {
  const { settings, setSettings } = useSettings()
  const builtinPolicy = settings.mcp.builtin?.policy
  const builtinToolOptions = settings.mcp.builtin?.toolOptions ?? {}

  const setBuiltinPolicy = (
    key: 'readOnlyDefault' | 'readWriteDefault' | 'dangerousDefault',
    value: ApprovalDecision,
  ) => {
    void setSettings({
      ...settings,
      mcp: {
        ...settings.mcp,
        builtin: {
          ...settings.mcp.builtin,
          policy: {
            readOnlyDefault: builtinPolicy?.readOnlyDefault ?? 'allow',
            readWriteDefault: builtinPolicy?.readWriteDefault ?? 'ask',
            dangerousDefault: builtinPolicy?.dangerousDefault ?? 'ask',
            [key]: value,
          },
          toolOptions: builtinToolOptions,
        },
      },
    })
  }

  const setBuiltinAutoExecute = (toolName: string, autoExecute: boolean) => {
    void setSettings({
      ...settings,
      mcp: {
        ...settings.mcp,
        builtin: {
          ...settings.mcp.builtin,
          policy: {
            readOnlyDefault: builtinPolicy?.readOnlyDefault ?? 'allow',
            readWriteDefault: builtinPolicy?.readWriteDefault ?? 'ask',
            dangerousDefault: builtinPolicy?.dangerousDefault ?? 'ask',
          },
          toolOptions: {
            ...builtinToolOptions,
            [toolName]: {
              ...builtinToolOptions[toolName],
              autoExecute,
            },
          },
        },
      },
    })
  }

  const highlightedTools = tools.filter((tool) =>
    [
      'vault_write',
      'vault_edit',
      'note_frontmatter_set',
      'vault_move',
      'command_execute',
      'vault_delete',
    ].includes(tool.name),
  )

  return (
    <div className="smtcmp-mcp-tool-table smtcmp-mcp-tool-table--builtin">
      <div className="smtcmp-mcp-tool-detail-controls smtcmp-mcp-builtin-group">
        <McpBuiltinPolicyCard
          title="Read-only default"
          description={`Default behavior for read-only built-in tools (${BUILTIN_READ_ONLY_TOOLS.length} tools).`}
          value={builtinPolicy?.readOnlyDefault ?? 'allow'}
          onChange={(value) => setBuiltinPolicy('readOnlyDefault', value)}
        />
        <McpBuiltinPolicyCard
          title="Read/write default"
          description={`Default behavior for normal write tools (${BUILTIN_READ_WRITE_TOOLS.length} tools).`}
          value={builtinPolicy?.readWriteDefault ?? 'ask'}
          onChange={(value) => setBuiltinPolicy('readWriteDefault', value)}
        />
        <McpBuiltinPolicyCard
          title="Danger-zone default"
          description={`Default behavior for destructive tools (${BUILTIN_DANGER_ZONE_TOOLS.length} tools).`}
          value={builtinPolicy?.dangerousDefault ?? 'ask'}
          onChange={(value) => setBuiltinPolicy('dangerousDefault', value)}
        />
      </div>

      {highlightedTools.length > 0 && (
        <div className="smtcmp-mcp-tool-detail-controls smtcmp-mcp-builtin-group">
          {highlightedTools.map((tool) => (
            <McpToolControlCard
              key={tool.name}
              title={tool.name}
              description={`Override the default policy for this ${getBuiltinToolTier(tool.name) ?? 'builtin'} tool and let Smart Composer auto-execute it without pausing first.`}
              value={builtinToolOptions[tool.name]?.autoExecute ?? false}
              onChange={(value) => setBuiltinAutoExecute(tool.name, value)}
            />
          ))}
        </div>
      )}

      <div className="smtcmp-mcp-builtin-tool-list">
        <div className="smtcmp-mcp-tool-table-header smtcmp-mcp-tool-table-header--builtin">
          <div>Tool</div>
        </div>
        <div className="smtcmp-mcp-builtin-tool-list-scroll">
          {tools.map((tool) => (
            <div key={tool.name} className="smtcmp-mcp-builtin-tool-row-button">
              <div className="smtcmp-mcp-tool-name">{tool.name}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function McpBuiltinPolicyCard({
  title,
  description,
  value,
  onChange,
}: {
  title: string
  description: string
  value: ApprovalDecision
  onChange: (value: ApprovalDecision) => void
}) {
  return (
    <div className="smtcmp-mcp-tool-control-card">
      <div className="smtcmp-mcp-tool-control-copy">
        <div className="smtcmp-mcp-tool-control-title">{title}</div>
        <div className="smtcmp-mcp-tool-control-desc">{description}</div>
      </div>
      <div className="smtcmp-mcp-tool-control-toggle">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value as ApprovalDecision)}
        >
          <option value="allow">Allow</option>
          <option value="ask">Ask</option>
          <option value="deny">Deny</option>
        </select>
      </div>
    </div>
  )
}

function McpToolDetailPanel({
  title,
  meta,
  tool,
  server,
}: {
  title: string
  meta: string
  tool: McpTool
  server: Extract<McpServerState, { status: McpServerStatus.Connected }>
}) {
  const { settings, setSettings } = useSettings()

  const handleToggleAutoExecution = (allowAutoExecution: boolean) => {
    const toolOptions = { ...server.config.toolOptions }
    toolOptions[tool.name] = {
      ...toolOptions[tool.name],
      allowAutoExecution,
    }

    setSettings({
      ...settings,
      mcp: {
        ...settings.mcp,
        servers: settings.mcp.servers.map((s) =>
          s.id === server.name ? { ...s, toolOptions } : s,
        ),
      },
    })
  }

  return (
    <div className="smtcmp-mcp-tool-detail-panel">
      <div className="smtcmp-mcp-tool-detail-kicker">
        <PanelRight size={14} />
        <span>Tool Detail</span>
      </div>
      <div className="smtcmp-mcp-tool-detail-title">{title}</div>
      <div className="smtcmp-mcp-tooltip-meta">{meta}</div>
      {tool.description && (
        <div className="smtcmp-mcp-tool-description">{tool.description}</div>
      )}

      <div className="smtcmp-mcp-tool-detail-controls">
        <McpToolControlCard
          title="Auto-execute"
          description="Allows Smart Composer to run this tool without asking first. Turn this on only if you are comfortable with the model taking action immediately for this server."
          value={
            server.config.toolOptions[tool.name]?.allowAutoExecution ?? false
          }
          onChange={handleToggleAutoExecution}
        />
      </div>
    </div>
  )
}

function McpToolControlCard({
  title,
  description,
  value,
  onChange,
}: {
  title: string
  description: string
  value: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="smtcmp-mcp-tool-control-card">
      <div className="smtcmp-mcp-tool-control-copy">
        <div className="smtcmp-mcp-tool-control-title">{title}</div>
        <div className="smtcmp-mcp-tool-control-desc">{description}</div>
      </div>
      <div className="smtcmp-mcp-tool-control-toggle">
        <ObsidianToggle value={value} onChange={onChange} />
      </div>
    </div>
  )
}
