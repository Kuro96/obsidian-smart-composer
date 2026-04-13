/**
 * vaultUtils — 内置工具共享的 Vault 路径与目录工具函数
 * 从 McpManager 中提取，供各 ToolPack 复用。
 */

import * as path from 'path'

type VaultAdapter = {
  list: (path: string) => Promise<{ files: string[]; folders: string[] }>
  read: (path: string) => Promise<string>
  write: (path: string, data: string) => Promise<void>
  mkdir: (path: string) => Promise<void>
  exists?: (path: string, sensitive?: boolean) => Promise<boolean>
}

export function getVaultAdapter(app: {
  vault: { adapter: unknown }
}): VaultAdapter {
  return app.vault.adapter as VaultAdapter
}

export function normalizeVaultPath(input: string): string {
  const normalized = input.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized.length === 0) return ''
  if (normalized.startsWith('/')) {
    throw new Error(
      'Vault path must be relative, absolute paths are not allowed',
    )
  }
  const parsed = path.posix.normalize(normalized)
  if (parsed === '..' || parsed.startsWith('../') || parsed.includes('/../')) {
    throw new Error('Vault path cannot escape vault root')
  }
  return parsed
}

export async function ensureParentDirectory(
  filePath: string,
  adapter: Pick<VaultAdapter, 'mkdir' | 'exists'>,
): Promise<void> {
  const parent = path.posix.dirname(filePath)
  if (!parent || parent === '.') return
  await mkdirRecursive(parent, adapter)
}

export async function mkdirRecursive(
  dirPath: string,
  adapter: Pick<VaultAdapter, 'mkdir' | 'exists'>,
): Promise<void> {
  const parts = dirPath.split('/').filter(Boolean)
  let cursor = ''
  for (const part of parts) {
    cursor = cursor.length === 0 ? part : `${cursor}/${part}`
    const exists = adapter.exists ? await adapter.exists(cursor) : false
    if (!exists) {
      await adapter.mkdir(cursor).catch((error: Error) => {
        if (!`${error?.message ?? ''}`.includes('already exists')) throw error
      })
    }
  }
}
