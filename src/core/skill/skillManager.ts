import * as os from 'os'
import * as path from 'path'

import {
  getVaultSkillsAbsolutePath,
  getVaultSkillsRelativePath,
} from '../agents/agentPaths'
import { SmartComposerSettings } from '../../settings/schema/setting.types'

type SkillInfo = {
  name: string
  description: string
  location: string
  content: string
  source: 'fs' | 'vault'
  vaultPath?: string
}

type SkillIndex = {
  skills?: {
    name?: string
    files?: string[]
  }[]
}

const LIMIT = 10

function toFileUrl(p: string): string {
  if (!p.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(p)) {
    return `vault://${encodeURI(p)}`
  }
  const normalized = p.replace(/\\/g, '/')
  const prefix = normalized.startsWith('/') ? 'file://' : 'file:///'
  return `${prefix}${encodeURI(normalized)}`
}

function parseFrontmatter(input: string): {
  name?: string
  description?: string
} {
  const match = input.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) {
    return {}
  }

  const lines = match[1].split(/\r?\n/)
  let name: string | undefined
  let description: string | undefined
  for (const line of lines) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!kv) {
      continue
    }
    const key = kv[1]
    const raw = kv[2].trim()
    const value = raw
      .replace(/^"([\s\S]*)"$/, '$1')
      .replace(/^'([\s\S]*)'$/, '$1')
    if (key === 'name') {
      name = value
      continue
    }
    if (key === 'description') {
      description = value
    }
  }

  return { name, description }
}

async function isDir(dir: string): Promise<boolean> {
  try {
    const fs = await import('fs/promises')
    const stat = await fs.stat(dir)
    return stat.isDirectory()
  } catch {
    return false
  }
}

async function walk(dir: string): Promise<string[]> {
  const fs = await import('fs/promises')
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        return walk(file)
      }
      return [file]
    }),
  )
  return nested.flat()
}

function parseIndex(input: string): SkillIndex {
  try {
    return JSON.parse(input) as SkillIndex
  } catch {
    return {}
  }
}

export class SkillManager {
  static readonly TOOL_NAME = 'skill'

  private readonly getSettings: () => SmartComposerSettings
  private readonly getVaultRoot: () => string | undefined
  private readonly getVault?: () => {
    getAbstractFileByPath: (path: string) => unknown
    cachedRead: (file: unknown) => Promise<string>
  }
  private readonly getVaultAdapter?: () => {
    list: (path: string) => Promise<{
      files: string[]
      folders: string[]
    }>
    read: (path: string) => Promise<string>
  }

  constructor(params: {
    getSettings: () => SmartComposerSettings
    getVaultRoot: () => string | undefined
    getVault?: () => {
      getAbstractFileByPath: (path: string) => unknown
      cachedRead: (file: unknown) => Promise<string>
    }
    getVaultAdapter?: () => {
      list: (path: string) => Promise<{
        files: string[]
        folders: string[]
      }>
      read: (path: string) => Promise<string>
    }
  }) {
    this.getSettings = params.getSettings
    this.getVaultRoot = params.getVaultRoot
    this.getVault = params.getVault
    this.getVaultAdapter = params.getVaultAdapter
  }

  public static format(list: SkillInfo[], opts: { verbose: boolean }) {
    if (list.length === 0) {
      return 'No skills are currently available.'
    }

    if (opts.verbose) {
      return [
        '<available_skills>',
        ...list.flatMap((skill) => [
          '  <skill>',
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${toFileUrl(skill.location)}</location>`,
          '  </skill>',
        ]),
        '</available_skills>',
      ].join('\n')
    }

    return [
      '## Available Skills',
      ...list.map((skill) => `- **${skill.name}**: ${skill.description}`),
    ].join('\n')
  }

  public async list() {
    const list = await this.listAll()
    return list.filter((skill: SkillInfo) => this.isEnabled(skill.name))
  }

  public async listAll() {
    const map: Record<string, SkillInfo> = {}

    const vault = this.getVaultRoot()
    const home = os.homedir()
    const settings = this.getSettings()
    const vaultSkillsPath = getVaultSkillsRelativePath(settings)

    if (vault) {
      await this.scanAnyRoot(getVaultSkillsAbsolutePath(settings, vault), map)
    }

    await this.scanVaultDir(vaultSkillsPath, map)
    await this.scanVaultAdapterDir(vaultSkillsPath, map)

    for (const item of settings.skills.paths) {
      const dir = item.startsWith('~/')
        ? path.join(home, item.slice(2))
        : path.isAbsolute(item)
          ? item
          : vault
            ? path.join(vault, item)
            : item
      await this.scanAnyRoot(dir, map)
    }

    for (const url of settings.skills.urls) {
      const dirs = await this.pull(url)
      for (const dir of dirs) {
        await this.scanAnyRoot(dir, map)
      }
    }

    return Object.values(map).sort((a: SkillInfo, b: SkillInfo) =>
      a.name.localeCompare(b.name),
    )
  }

  public async get(name: string) {
    const list = await this.list()
    return list.find((skill: SkillInfo) => skill.name === name)
  }

  public async getPromptSection() {
    const list = await this.list()
    return [
      'Skills provide specialized instructions and workflows for specific tasks.',
      'Use the skill tool to load a skill when a task matches its description.',
      SkillManager.format(list, { verbose: true }),
    ].join('\n')
  }

  public async getToolDescription() {
    const list = await this.list()
    const description =
      list.length === 0
        ? 'Load a specialized skill that provides domain-specific instructions and workflows. No skills are currently available.'
        : [
            'Load a specialized skill that provides domain-specific instructions and workflows.',
            '',
            'When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.',
            '',
            'The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.',
            '',
            'Tool output includes a `<skill_content name="...">` block with the loaded content.',
            '',
            'The following skills provide specialized sets of instructions for particular tasks',
            'Invoke this tool to load a skill when a task matches one of the available skills listed below:',
            '',
            SkillManager.format(list, { verbose: false }),
          ].join('\n')

    const examples = list
      .map((skill: SkillInfo) => `'${skill.name}'`)
      .slice(0, 3)
      .join(', ')
    const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : ''

    return {
      description,
      hint,
    }
  }

  public async execute(name: string) {
    const skill = await this.get(name)
    if (!skill) {
      const available = await this.list().then((list) =>
        list.map((item: SkillInfo) => item.name).join(', '),
      )
      throw new Error(
        `Skill "${name}" not found. Available skills: ${available || 'none'}`,
      )
    }

    const basePath =
      skill.source === 'vault' && skill.vaultPath
        ? path.dirname(skill.vaultPath)
        : path.dirname(skill.location)
    const files =
      skill.source === 'vault'
        ? await this.listVaultFiles(basePath)
        : await walk(path.dirname(skill.location)).then((all) =>
            all
              .filter(
                (file) =>
                  !file.endsWith(`${path.sep}SKILL.md`) &&
                  !file.endsWith('/SKILL.md'),
              )
              .slice(0, LIMIT)
              .map((file) => `<file>${file}</file>`)
              .join('\n'),
          )

    return [
      `<skill_content name="${skill.name}">`,
      `# Skill: ${skill.name}`,
      '',
      skill.content.trim(),
      '',
      `Base directory for this skill: ${toFileUrl(basePath)}`,
      'Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.',
      'Note: file list is sampled.',
      '',
      '<skill_files>',
      files,
      '</skill_files>',
      '</skill_content>',
    ].join('\n')
  }

  private async listVaultFiles(basePath: string): Promise<string> {
    const adapter = this.getVaultAdapter?.()
    if (adapter) {
      const walkAdapter = async (dir: string): Promise<string[]> => {
        const listed = await adapter
          .list(dir)
          .catch(() => ({ files: [], folders: [] }))
        const nested = await Promise.all(
          listed.folders.map((folder) => walkAdapter(folder)),
        )
        return [...listed.files, ...nested.flat()]
      }
      const all = await walkAdapter(basePath)
      return all
        .filter(
          (file) => path.basename(file.replace(/\\/g, '/')) !== 'SKILL.md',
        )
        .slice(0, LIMIT)
        .map((file) => `<file>${file}</file>`)
        .join('\n')
    }

    const vault = this.getVault?.()
    if (!vault) {
      return ''
    }
    const rootNode = vault.getAbstractFileByPath(basePath) as {
      path?: string
      name?: string
      children?: unknown[]
    } | null
    if (!rootNode) {
      return ''
    }

    const files: string[] = []
    const visit = (node: {
      path?: string
      name?: string
      children?: unknown[]
    }) => {
      if (files.length >= LIMIT) {
        return
      }
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          visit(
            child as {
              path?: string
              name?: string
              children?: unknown[]
            },
          )
          if (files.length >= LIMIT) {
            break
          }
        }
        return
      }

      const isSkillFile =
        node.name === 'SKILL.md' || node.path?.endsWith('/SKILL.md')
      if (isSkillFile) {
        return
      }
      if (node.path) {
        files.push(`<file>${node.path}</file>`)
      }
    }

    visit(rootNode)
    return files.join('\n')
  }

  private async scanAnyRoot(root: string, map: Record<string, SkillInfo>) {
    if (!(await isDir(root))) {
      return
    }
    const all = await walk(root)
    const files = all.filter((file) => path.basename(file) === 'SKILL.md')
    const fs = await import('fs/promises')
    await Promise.all(
      files.map(async (file) => {
        const text = await fs.readFile(file, 'utf8').catch(() => '')
        if (!text) {
          return
        }
        const parsed = parseFrontmatter(text)
        if (!parsed.name || !parsed.description) {
          return
        }
        map[parsed.name] = {
          name: parsed.name,
          description: parsed.description,
          location: file,
          content: text,
          source: 'fs',
        }
      }),
    )
  }

  private async scanVaultDir(root: string, map: Record<string, SkillInfo>) {
    const vault = this.getVault?.()
    if (!vault) {
      return
    }

    const rootNode = vault.getAbstractFileByPath(root) as {
      path?: string
      name?: string
      children?: unknown[]
    } | null
    if (!rootNode) {
      return
    }

    const walkNode = async (node: {
      path?: string
      name?: string
      children?: unknown[]
    }) => {
      if (Array.isArray(node.children)) {
        await Promise.all(
          node.children.map((child) =>
            walkNode(
              child as {
                path?: string
                name?: string
                children?: unknown[]
              },
            ),
          ),
        )
        return
      }

      const isSkillFile =
        node.name === 'SKILL.md' || node.path?.endsWith('/SKILL.md')
      if (!isSkillFile) {
        return
      }

      const text = await vault.cachedRead(node).catch(() => '')
      if (!text) {
        return
      }

      const parsed = parseFrontmatter(text)
      if (!parsed.name || !parsed.description) {
        return
      }

      const vaultPath = node.path ?? parsed.name
      const rootDir = this.getVaultRoot()
      const location = rootDir ? path.join(rootDir, vaultPath) : vaultPath

      map[parsed.name] = {
        name: parsed.name,
        description: parsed.description,
        location,
        content: text,
        source: 'vault',
        vaultPath,
      }
    }

    await walkNode(rootNode)
  }

  private async scanVaultAdapterDir(
    root: string,
    map: Record<string, SkillInfo>,
  ) {
    const adapter = this.getVaultAdapter?.()
    if (!adapter) {
      return
    }

    const walkAdapter = async (dir: string): Promise<string[]> => {
      const listed = await adapter
        .list(dir)
        .catch(() => ({ files: [], folders: [] }))
      const nested = await Promise.all(
        listed.folders.map((folder) => walkAdapter(folder)),
      )
      return [...listed.files, ...nested.flat()]
    }

    const allFiles = await walkAdapter(root)
    const skillFiles = allFiles.filter(
      (file) => path.basename(file.replace(/\\/g, '/')) === 'SKILL.md',
    )
    await Promise.all(
      skillFiles.map(async (file) => {
        const text = await adapter.read(file).catch(() => '')
        if (!text) {
          return
        }

        const parsed = parseFrontmatter(text)
        if (!parsed.name || !parsed.description) {
          return
        }

        const rootDir = this.getVaultRoot()
        const location = rootDir ? path.join(rootDir, file) : file

        map[parsed.name] = {
          name: parsed.name,
          description: parsed.description,
          location,
          content: text,
          source: 'vault',
          vaultPath: file,
        }
      }),
    )
  }

  private async pull(url: string): Promise<string[]> {
    const base = url.endsWith('/') ? url : `${url}/`
    const indexUrl = new URL('index.json', base).href
    const indexText = await fetch(indexUrl)
      .then(async (res) => {
        if (!res.ok) {
          return ''
        }
        return res.text()
      })
      .catch(() => '')
    if (!indexText) {
      return []
    }

    const index = parseIndex(indexText)
    const list = (index.skills ?? []).filter((item) => {
      return (
        !!item.name &&
        Array.isArray(item.files) &&
        item.files.includes('SKILL.md')
      )
    })
    if (list.length === 0) {
      return []
    }

    const cache = path.join(os.tmpdir(), 'obsidian-smart-composer', 'skills')
    const fs = await import('fs/promises')
    await fs.mkdir(cache, { recursive: true })
    const host = base.slice(0, -1)

    const dirs = await Promise.all(
      list.map(async (item) => {
        const root = path.join(cache, item.name ?? 'unknown')
        await Promise.all(
          (item.files ?? []).map(async (file) => {
            const next = path.join(root, file)
            if (await isDir(next)) {
              return
            }
            const exists = await fs
              .stat(next)
              .then(() => true)
              .catch(() => false)
            if (exists) {
              return
            }
            const body = await fetch(
              new URL(file, `${host}/${item.name}/`).href,
            )
              .then(async (res) => {
                if (!res.ok) {
                  return null
                }
                return res.arrayBuffer()
              })
              .catch(() => null)
            if (!body) {
              return
            }
            await fs.mkdir(path.dirname(next), { recursive: true })
            await fs.writeFile(next, Buffer.from(body))
          }),
        )

        const md = path.join(root, 'SKILL.md')
        const ok = await fs
          .stat(md)
          .then((stat) => stat.isFile())
          .catch(() => false)
        return ok ? root : null
      }),
    )

    return dirs.filter((dir): dir is string => !!dir)
  }

  private isEnabled(name: string): boolean {
    const settings = this.getSettings()
    return !(settings.skills.options[name]?.disabled ?? false)
  }
}

export type { SkillInfo }
