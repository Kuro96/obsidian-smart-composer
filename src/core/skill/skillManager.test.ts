import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs/promises'

import { smartComposerSettingsSchema } from '../../settings/schema/setting.types'

import { SkillManager } from './skillManager'

describe('SkillManager', () => {
  function createMockVault(agentsDirectoryName = '.agents') {
    type Node = {
      name: string
      path: string
      children?: Node[]
    }
    const files: Record<string, string> = {}
    const byPath: Record<string, Node> = {}

    const put = (node: Node) => {
      byPath[node.path] = node
      if (node.children) {
        for (const child of node.children) {
          put(child)
        }
      }
    }

    const skillsRoot = `${agentsDirectoryName}/skills`
    const skillMd: Node = {
      name: 'SKILL.md',
      path: `${skillsRoot}/tool-skill/SKILL.md`,
    }
    files[skillMd.path] = `---
name: tool-skill
description: Tool skill.
---

# Tool Skill

Use this skill.
`

    const demo: Node = {
      name: 'demo.txt',
      path: `${skillsRoot}/tool-skill/scripts/demo.txt`,
    }
    files[demo.path] = 'demo'

    const root: Node = {
      name: 'skills',
      path: skillsRoot,
      children: [
        {
          name: 'tool-skill',
          path: `${skillsRoot}/tool-skill`,
          children: [
            skillMd,
            {
              name: 'scripts',
              path: `${skillsRoot}/tool-skill/scripts`,
              children: [demo],
            },
          ],
        },
      ],
    }
    put(root)

    return {
      getAbstractFileByPath: (p: string) => byPath[p] ?? null,
      cachedRead: async (f: { path?: string }) => files[f.path ?? ''] ?? '',
    }
  }

  it('discovers local skills and formats prompt section', async () => {
    const vault = createMockVault()
    const settings = smartComposerSettingsSchema.parse({})
    const manager = new SkillManager({
      getSettings: () => settings,
      getVaultRoot: () => '/tmp/vault',
      getVault: () => vault,
    })

    const list = await manager.list()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('tool-skill')

    const section = await manager.getPromptSection()
    expect(section).toContain(
      'Skills provide specialized instructions and workflows for specific tasks.',
    )
    expect(section).toContain('<available_skills>')
    expect(section).toContain('<name>tool-skill</name>')
  })

  it('loads skill content block with sampled files', async () => {
    const vault = createMockVault()
    const settings = smartComposerSettingsSchema.parse({})
    const manager = new SkillManager({
      getSettings: () => settings,
      getVaultRoot: () => '/tmp/vault',
      getVault: () => vault,
    })

    const out = await manager.execute('tool-skill')
    expect(out).toContain('<skill_content name="tool-skill">')
    expect(out).toContain('Base directory for this skill: vault://')
    expect(out).toContain('<file>')
    expect(out).toContain('demo.txt')
  })

  it('discovers skills from the configured agents directory', async () => {
    const vault = createMockVault('.smart-agents')
    const settings = smartComposerSettingsSchema.parse({
      agents: {
        directoryName: '.smart-agents',
      },
    })
    const manager = new SkillManager({
      getSettings: () => settings,
      getVaultRoot: () => '/tmp/vault',
      getVault: () => vault,
    })

    const list = await manager.list()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('tool-skill')
    expect(list[0].vaultPath).toBe('.smart-agents/skills/tool-skill/SKILL.md')
  })

  it('ignores configured external skill paths outside the vault', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-manager-'))
    const externalSkill = path.join(tempRoot, 'external-skill')

    await fs.mkdir(externalSkill, { recursive: true })
    await fs.writeFile(
      path.join(externalSkill, 'SKILL.md'),
      `---
name: external-skill
description: External skill.
---

# External Skill
`,
      'utf8',
    )

    try {
      const settings = smartComposerSettingsSchema.parse({
        skills: {
          paths: [externalSkill],
        },
      })
      const manager = new SkillManager({
        getSettings: () => settings,
        getVaultRoot: () => '/tmp/vault',
      })

      await expect(manager.list()).resolves.toHaveLength(0)
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })
})
