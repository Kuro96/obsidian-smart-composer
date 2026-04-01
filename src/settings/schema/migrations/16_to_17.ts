import { SettingMigration } from '../setting.types'

import { DEFAULT_CHAT_MODELS_V15 } from './14_to_15'
import { getMigratedChatModels, getMigratedProviders } from './migrationUtils'

const DEFAULT_PROVIDERS_V17 = [
  { type: 'anthropic-plan', id: 'anthropic-plan' },
  { type: 'openai-plan', id: 'openai-plan' },
  { type: 'gemini-plan', id: 'gemini-plan' },
  { type: 'anthropic', id: 'anthropic' },
  { type: 'openai', id: 'openai' },
  { type: 'gemini', id: 'gemini' },
  { type: 'xai', id: 'xai' },
  { type: 'deepseek', id: 'deepseek' },
  { type: 'mistral', id: 'mistral' },
  { type: 'perplexity', id: 'perplexity' },
  { type: 'openrouter', id: 'openrouter' },
  { type: 'ollama', id: 'ollama' },
  { type: 'lm-studio', id: 'lm-studio' },
] as const

const DEFAULT_CHAT_MODELS_V17 = [
  ...DEFAULT_CHAT_MODELS_V15.slice(0, 3),
  {
    providerType: 'openai-plan',
    providerId: 'openai-plan',
    id: 'gpt-5.3-codex (plan)',
    model: 'gpt-5.3-codex',
  },
  {
    providerType: 'openai-plan',
    providerId: 'openai-plan',
    id: 'gpt-5.4 (plan)',
    model: 'gpt-5.4',
  },
  {
    providerType: 'gemini-plan',
    providerId: 'gemini-plan',
    id: 'gemini-3-pro-preview (plan)',
    model: 'gemini-3-pro-preview',
  },
  {
    providerType: 'gemini-plan',
    providerId: 'gemini-plan',
    id: 'gemini-3-flash-preview (plan)',
    model: 'gemini-3-flash-preview',
  },
  ...DEFAULT_CHAT_MODELS_V15.slice(3),
]

export const migrateFrom16To17: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 17
  newData.vaultChatEnabled = true

  newData.providers = getMigratedProviders(newData, DEFAULT_PROVIDERS_V17)
  newData.chatModels = getMigratedChatModels(newData, DEFAULT_CHAT_MODELS_V17)

  return newData
}
