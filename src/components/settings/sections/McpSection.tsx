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
import { McpManager } from '../../../core/mcp/mcpManager'
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

      <div className="smtcmp-mcp-panel smtcmp-mcp-panel--overview">
        <div className="smtcmp-settings-sub-header-container smtcmp-mcp-panel-header">
          <div>
            <div className="smtcmp-settings-sub-header">Runtime Overview</div>
            <div className="smtcmp-settings-desc smtcmp-mcp-panel-desc">
              This area reflects what the model can currently access at runtime. Use the panels below to change saved configuration.
            </div>
          </div>
        </div>
        <div className="smtcmp-modal-summary-row">
          <span>Connected servers {connectedServerCount}</span>
          <span>Enabled servers {enabledServerCount}</span>
          <span>Remote tools {remoteToolCount}</span>
          <span>Built-in tools {builtInTools.length}</span>
          <span>Global tools {toolsEnabled ? 'Enabled' : 'Disabled'}</span>
        </div>
      </div>

      {mcpManager?.disabled ? (
        <div className="smtcmp-mcp-empty-state">
          <div className="smtcmp-settings-sub-header">
            MCP is not supported on mobile devices
          </div>
          <div className="smtcmp-settings-desc">
            Open Smart Composer on desktop to manage servers and tool
            permissions.
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
                  Saved server configuration. Add, edit, enable, and tune external tool permissions here.
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
                  Built-in tools bundled with Smart Composer. These are runtime capabilities, not per-server installs.
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
    <div className="smtcmp-mcp-tool-workbench">
      <div className="smtcmp-mcp-tool-table">
        <div className="smtcmp-mcp-tool-table-header smtcmp-mcp-tool-table-header--single">
          <div>Tool</div>
        </div>
        {server.tools.map((tool) => (
          <McpConnectedToolRow
            key={tool.name}
            tool={tool}
            selected={tool.name === selectedTool?.name}
            onSelect={() => onSelectTool(tool.name)}
          />
        ))}
      </div>

      {selectedTool && (
        <McpToolDetailPanel
          title={selectedTool.name}
          meta={`Connected via ${server.name}`}
          mode="connected"
          tool={selectedTool}
          server={server}
        />
      )}
    </div>
  )
}

function McpConnectedToolRow({
  tool,
  selected,
  onSelect,
}: {
  tool: McpTool
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      className={`smtcmp-mcp-tool-row-button smtcmp-mcp-tool-row-button--single${selected ? ' smtcmp-mcp-tool-row-button--selected' : ''}`}
      onClick={onSelect}
    >
      <div className="smtcmp-mcp-tool-row-main">
        <div className="smtcmp-mcp-tool-name">{tool.name}</div>
      </div>
    </button>
  )
}

function McpBuiltInWorkbench({ tools }: { tools: McpTool[] }) {
  return (
    <div className="smtcmp-mcp-tool-table smtcmp-mcp-tool-table--builtin">
      <div className="smtcmp-mcp-tool-table-header smtcmp-mcp-tool-table-header--builtin">
        <div>Tool</div>
      </div>
      {tools.map((tool) => (
        <div key={tool.name} className="smtcmp-mcp-builtin-tool-row-button">
          <div className="smtcmp-mcp-tool-name">{tool.name}</div>
        </div>
      ))}
    </div>
  )
}

function McpToolDetailPanel({
  title,
  meta,
  mode,
  tool,
  server,
}: {
  title: string
  meta: string
  mode: 'builtin' | 'connected'
  tool?: McpTool
  server?: Extract<McpServerState, { status: McpServerStatus.Connected }>
}) {
  const { settings, setSettings } = useSettings()

  const handleToggleEnabled = (enabled: boolean) => {
    if (!tool || !server) return

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
          s.id === server.name
            ? {
                ...s,
                toolOptions,
              }
            : s,
        ),
      },
    })
  }

  const handleToggleAutoExecution = (allowAutoExecution: boolean) => {
    if (!tool || !server) return

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
          s.id === server.name
            ? {
                ...s,
                toolOptions,
              }
            : s,
        ),
      },
    })
  }

  return (
    <div className="smtcmp-mcp-tool-detail-panel">
      <div className="smtcmp-mcp-tool-detail-kicker">
        <PanelRight size={14} />
        <span>
          {mode === 'connected' ? 'Tool Detail' : 'Vault Tool Detail'}
        </span>
      </div>
      <div className="smtcmp-mcp-tool-detail-title">{title}</div>
      <div className="smtcmp-mcp-tooltip-meta">{meta}</div>

      {mode === 'connected' && tool && server && (
        <div className="smtcmp-mcp-tool-detail-controls">
          <McpToolControlCard
            title="Enabled"
            description="Turns this tool on or off for the selected server."
            value={!(server.config.toolOptions[tool.name]?.disabled ?? false)}
            onChange={handleToggleEnabled}
          />
          <McpToolControlCard
            title="Auto-execute"
            description="Allows Smart Composer to run this tool without asking first. Turn this on only if you are comfortable with the model taking action immediately for this server."
            value={
              server.config.toolOptions[tool.name]?.allowAutoExecution ?? false
            }
            onChange={handleToggleAutoExecution}
          />
        </div>
      )}
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
