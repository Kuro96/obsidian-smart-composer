import { migrateFrom16To17 } from './16_to_17'

describe('Migration from v16 to v17', () => {
  it('should increment version to 17', () => {
    const oldSettings = {
      version: 16,
    }
    const result = migrateFrom16To17(oldSettings)
    expect(result.version).toBe(17)
  })

  it('should add new openai plan chat models and keep custom models', () => {
    const oldSettings = {
      version: 16,
      providers: [],
      chatModels: [
        {
          id: 'custom-model',
          providerType: 'custom',
          providerId: 'custom',
          model: 'custom-model',
        },
      ],
    }

    const result = migrateFrom16To17(oldSettings)
    const chatModels = result.chatModels as {
      id: string
      providerType: string
      providerId: string
      model: string
    }[]

    const gpt53CodexPlan = chatModels.find(
      (m) => m.id === 'gpt-5.3-codex (plan)',
    )
    const gpt54Plan = chatModels.find((m) => m.id === 'gpt-5.4 (plan)')

    expect(gpt53CodexPlan).toMatchObject({
      providerType: 'openai-plan',
      providerId: 'openai-plan',
      model: 'gpt-5.3-codex',
    })
    expect(gpt54Plan).toMatchObject({
      providerType: 'openai-plan',
      providerId: 'openai-plan',
      model: 'gpt-5.4',
    })
    expect(chatModels.find((m) => m.id === 'custom-model')).toBeDefined()
  })
})
