/**
 * CommandsToolPack — Obsidian 命令工具包（Phase 3）
 *
 * 包含：commands_list, command_execute
 */

import { App } from 'obsidian'

import type { ToolEntry, ToolRegistry } from '../ToolRegistry'

type ObsidianCommands = {
  commands: Record<string, { id: string; name: string }>
  executeCommandById: (id: string) => boolean
}

export class CommandsToolPack {
  constructor(private readonly app: App) {}

  registerAll(registry: ToolRegistry): void {
    for (const entry of this.buildEntries()) {
      registry.register(entry)
    }
  }

  private buildEntries(): ToolEntry[] {
    const app = this.app

    return [
      {
        tool: {
          name: 'commands_list',
          description:
            'List all available Obsidian commands with their IDs and names.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
        tier: 'read-only',
        source: 'builtin',
        approvalRequired: false,
        handler: async () => {
          const commandsMap = (app as App & { commands: ObsidianCommands })
            .commands.commands
          const commands = Object.values(commandsMap).map((cmd) => ({
            id: cmd.id,
            name: cmd.name,
          }))
          return JSON.stringify(commands, null, 2)
        },
      },

      {
        tool: {
          name: 'command_execute',
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
        tier: 'read-write',
        source: 'builtin',
        approvalRequired: false,
        handler: async (args) => {
          const commandId = args?.commandId
          if (typeof commandId !== 'string' || commandId.trim().length === 0)
            throw new Error('command_execute requires a non-empty "commandId"')
          const commandsObj = (app as App & { commands: ObsidianCommands })
            .commands
          if (!commandsObj.commands[commandId])
            throw new Error(`command_execute: command not found: ${commandId}`)
          const executed = commandsObj.executeCommandById(commandId)
          if (!executed)
            throw new Error(
              `command_execute: command could not be executed: ${commandId}`,
            )
          return `Executed command: ${commandId}`
        },
      },
    ]
  }
}
