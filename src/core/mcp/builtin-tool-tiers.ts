export type BuiltinToolTier = 'read-only' | 'read-write' | 'danger-zone'

export const BUILTIN_READ_ONLY_TOOLS: string[] = [
  'vault_list',
  'vault_read',
  'commands_list',
  'tags_list',
  'search_text',
  'search_dataview',
  // Phase 4: metadata tools
  'note_frontmatter_get',
  'vault_properties_list',
  'vault_property_values',
  'vault_query_notes',
  'note_links_get',
  'note_backlinks_get',
]

export const BUILTIN_READ_WRITE_TOOLS: string[] = [
  'vault_write',
  'vault_edit',
  'vault_mkdir',
  'vault_append',
  'note_open',
  'command_execute',
  // Phase 4: metadata write + move
  'note_frontmatter_set',
  'note_frontmatter_delete',
  'vault_move',
]

export const BUILTIN_DANGER_ZONE_TOOLS: string[] = [
  'vault_delete',
]

export function getBuiltinToolTier(name: string): BuiltinToolTier | null {
  if (BUILTIN_READ_ONLY_TOOLS.includes(name)) return 'read-only'
  if (BUILTIN_READ_WRITE_TOOLS.includes(name)) return 'read-write'
  if (BUILTIN_DANGER_ZONE_TOOLS.includes(name)) return 'danger-zone'
  return null
}
