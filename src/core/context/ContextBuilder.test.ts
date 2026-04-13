import { smartComposerSettingsSchema } from '../../settings/schema/setting.types'
import { ChatMessage } from '../../types/chat'

import { ContextBuilder } from './ContextBuilder'

describe('ContextBuilder', () => {
  function createApp(params?: {
    activeFilePath?: string
    agentsFiles?: Record<string, string>
  }) {
    const files = new Map(Object.entries(params?.agentsFiles ?? {}))

    return {
      workspace: {
        getActiveFile: () =>
          params?.activeFilePath ? { path: params.activeFilePath } : null,
      },
      vault: {
        adapter: {
          exists: jest.fn(async (filePath: string) => files.has(filePath)),
          read: jest.fn(async (filePath: string) => {
            const content = files.get(filePath)
            if (content == null) {
              throw new Error(`File not found: ${filePath}`)
            }
            return content
          }),
        },
      },
    }
  }

  const compiledMessages: ChatMessage[] = [
    {
      role: 'user',
      id: 'user-1',
      content: null,
      promptContent: 'hello',
      mentionables: [],
    },
  ]

  it('prefers AGENTS.md instructions over the legacy system prompt', async () => {
    const settings = smartComposerSettingsSchema.parse({
      systemPrompt: 'legacy instructions',
      vaultChatEnabled: false,
    })
    const builder = new ContextBuilder(
      createApp({
        activeFilePath: 'notes/today.md',
        agentsFiles: {
          'AGENTS.md': 'root instructions',
          'notes/AGENTS.md': 'local instructions',
        },
      }) as never,
      settings,
    )

    const messages = await builder.build({ compiledMessages })
    expect(messages[1]).toEqual({
      role: 'user',
      content: `Here are additional instructions to follow in your responses when relevant. There's no need to explicitly acknowledge them:
<custom_instructions>
root instructions

local instructions
</custom_instructions>`,
    })
  })

  it('falls back to the legacy system prompt when no AGENTS.md exists', async () => {
    const settings = smartComposerSettingsSchema.parse({
      systemPrompt: 'legacy instructions',
      vaultChatEnabled: false,
    })
    const builder = new ContextBuilder(createApp() as never, settings)

    const messages = await builder.build({ compiledMessages })
    expect(messages[1]).toEqual({
      role: 'user',
      content: `Here are additional instructions to follow in your responses when relevant. There's no need to explicitly acknowledge them:
<custom_instructions>
legacy instructions
</custom_instructions>`,
    })
  })

  it('omits the instruction message when neither AGENTS.md nor system prompt exists', async () => {
    const settings = smartComposerSettingsSchema.parse({
      vaultChatEnabled: false,
    })
    const builder = new ContextBuilder(createApp() as never, settings)

    const messages = await builder.build({ compiledMessages })
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[1]).toEqual({ role: 'user', content: 'hello' })
  })
})
