import {
  DEFAULT_APPLY_MODEL_ID,
  DEFAULT_CHAT_MODELS,
  DEFAULT_CHAT_MODEL_ID,
  DEFAULT_EMBEDDING_MODELS,
  DEFAULT_PROVIDERS,
} from '../../constants'

import { SETTINGS_SCHEMA_VERSION } from './migrations'
import { parseSmartComposerSettings } from './settings'

describe('parseSmartComposerSettings', () => {
  it('should return default values for empty input', () => {
    const result = parseSmartComposerSettings({})
    expect(result).toEqual({
      version: SETTINGS_SCHEMA_VERSION,

      vaultChatEnabled: true,

      providers: [...DEFAULT_PROVIDERS],

      chatModels: [...DEFAULT_CHAT_MODELS],
      embeddingModels: [...DEFAULT_EMBEDDING_MODELS],

      chatModelId: DEFAULT_CHAT_MODEL_ID,
      applyModelId: DEFAULT_APPLY_MODEL_ID,
      embeddingModelId: 'openai/text-embedding-3-small',

      systemPrompt: '',

      ragOptions: {
        chunkSize: 1000,
        thresholdTokens: 8192,
        minSimilarity: 0.0,
        limit: 10,
        excludePatterns: [],
        includePatterns: [],
      },

      mcp: {
        servers: [],
      },

      skills: {
        paths: [],
        urls: [],
        options: {},
      },

      chatOptions: {
        includeCurrentFileContent: true,
        enableTools: true,
        enableSkills: true,
        maxAutoIterations: 1,
        defaultAllowBuiltinReadWrite: false,
      },
    })
  })

  it('should coerce version 18 settings back to schema version 17', () => {
    const result = parseSmartComposerSettings({
      version: 18,
      systemPrompt: 'test prompt',
    })

    expect(result.version).toBe(SETTINGS_SCHEMA_VERSION)
    expect(result.version).toBe(17)
    expect(result.vaultChatEnabled).toBe(true)
    expect(result.systemPrompt).toBe('test prompt')
  })
})
