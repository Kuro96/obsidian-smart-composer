import * as path from 'path'

const DEFAULT_AGENTS_DIRECTORY_NAME = '.agents'

type HasAgentsDirectory = {
  agents?: {
    directoryName?: string
  }
}

export function getAgentsDirectoryName(settings: HasAgentsDirectory): string {
  const trimmed = settings.agents?.directoryName
    ?.trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')

  return trimmed || DEFAULT_AGENTS_DIRECTORY_NAME
}

export function getVaultSkillsRelativePath(
  settings: HasAgentsDirectory,
): string {
  return `${getAgentsDirectoryName(settings)}/skills`
}

export function getVaultSkillsAbsolutePath(
  settings: HasAgentsDirectory,
  vaultRoot: string,
): string {
  return path.join(
    vaultRoot,
    ...getAgentsDirectoryName(settings).split('/'),
    'skills',
  )
}

export { DEFAULT_AGENTS_DIRECTORY_NAME }
