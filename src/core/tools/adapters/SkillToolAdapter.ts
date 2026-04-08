/**
 * SkillToolAdapter — skill-as-tool 注册适配器（Phase 3）
 *
 * 将 SkillManager 的 skill 工具注册到 ToolRegistry。
 * SkillManager 的完整拆分（SkillRegistry / SkillLoader / SkillRunner）延迟到 Phase 6。
 */

import { SkillManager } from '../../skill/skillManager'
import type { ToolEntry, ToolRegistry } from '../ToolRegistry'

export class SkillToolAdapter {
  constructor(private readonly skillManager: SkillManager) {}

  async register(registry: ToolRegistry): Promise<void> {
    const details = await this.skillManager.getToolDescription()
    const entry: ToolEntry = {
      tool: {
        name: SkillManager.TOOL_NAME,
        description: details.description,
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: `The name of the skill from available_skills${details.hint}`,
            },
          },
          required: ['name'],
        },
      },
      tier: null,
      source: 'skill',
      approvalRequired: false,
      handler: async (args) => {
        const skill = args?.name
        if (typeof skill !== 'string' || skill.trim().length === 0) {
          throw new Error('Skill tool requires a non-empty "name" argument')
        }
        return this.skillManager.execute(skill)
      },
    }
    registry.register(entry)
  }
}
