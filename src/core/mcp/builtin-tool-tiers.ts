export type BuiltinToolTier = 'read-only' | 'read-write' | 'danger-zone'

export const BUILTIN_READ_ONLY_TOOLS: string[] = [
  'vault_list',
  'vault_read',
  'vault_get',
  'active_note_get',
  'commands_list',
  'tags_list',
  'search_simple',
  'search_dataview',
  'search_jsonlogic',
]

export const BUILTIN_READ_WRITE_TOOLS: string[] = [
  'vault_write',
  'vault_edit',
  'vault_mkdir',
  'vault_append',
  'active_note_put',
  'active_note_append',
  'note_open',
  'command_execute',
]

export const BUILTIN_DANGER_ZONE_TOOLS: string[] = [
  'vault_delete',
  'active_note_delete',
]

export function getBuiltinToolTier(name: string): BuiltinToolTier | null {
  if (BUILTIN_READ_ONLY_TOOLS.includes(name)) return 'read-only'
  if (BUILTIN_READ_WRITE_TOOLS.includes(name)) return 'read-write'
  if (BUILTIN_DANGER_ZONE_TOOLS.includes(name)) return 'danger-zone'
  return null
}
