/**
 * vault-utils — 内置工具共享的 Vault 路径与目录工具函数
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

export function getVaultAdapter(app: { vault: { adapter: unknown } }): VaultAdapter {
  return app.vault.adapter as VaultAdapter
}

export function normalizeVaultPath(input: string): string {
  const normalized = input.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized.length === 0) return ''
  if (normalized.startsWith('/')) {
    throw new Error('Vault path must be relative, absolute paths are not allowed')
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

/**
 * Minimal JSONLogic evaluator (same as McpManager.applyJsonLogic).
 * Supports: ==, !=, <, <=, >, >=, and, or, not, in, var
 */
export function applyJsonLogic(rule: unknown, data: Record<string, unknown>): unknown {
  if (rule === null || typeof rule !== 'object') return rule
  if (Array.isArray(rule)) {
    return (rule as unknown[]).map((r) => applyJsonLogic(r, data))
  }
  const entries = Object.entries(rule as Record<string, unknown>)
  if (entries.length !== 1) return rule
  const [op, rawArgs] = entries[0]

  if (op === 'var') {
    const key = typeof rawArgs === 'string' ? rawArgs : String(rawArgs ?? '')
    if (key === '') return data
    let val: unknown = data
    for (const part of key.split('.')) {
      if (val === null || val === undefined || typeof val !== 'object') return null
      val = (val as Record<string, unknown>)[part]
    }
    return val ?? null
  }

  if (op === 'and') {
    const items = Array.isArray(rawArgs) ? (rawArgs as unknown[]) : [rawArgs]
    for (const item of items) {
      const v = applyJsonLogic(item, data)
      if (!v) return v
    }
    return true
  }
  if (op === 'or') {
    const items = Array.isArray(rawArgs) ? (rawArgs as unknown[]) : [rawArgs]
    for (const item of items) {
      const v = applyJsonLogic(item, data)
      if (v) return v
    }
    return false
  }

  const args = Array.isArray(rawArgs)
    ? (rawArgs as unknown[]).map((a) => applyJsonLogic(a, data))
    : [applyJsonLogic(rawArgs, data)]

  switch (op) {
    case '==': return args[0] == args[1]   // eslint-disable-line eqeqeq
    case '!=': return args[0] != args[1]   // eslint-disable-line eqeqeq
    case '<':  return (args[0] as number) < (args[1] as number)
    case '<=': return (args[0] as number) <= (args[1] as number)
    case '>':  return (args[0] as number) > (args[1] as number)
    case '>=': return (args[0] as number) >= (args[1] as number)
    case 'not': return !args[0]
    case 'in':
      if (Array.isArray(args[1])) return (args[1] as unknown[]).includes(args[0])
      if (typeof args[1] === 'string') return (args[1] as string).includes(String(args[0]))
      return false
    default: return false
  }
}
