import { PanelRight } from 'lucide-react'
import { App } from 'obsidian'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { useSettings } from '../../../contexts/settings-context'
import SmartComposerPlugin from '../../../main'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'

type SkillSectionProps = {
  app: App
  plugin: SmartComposerPlugin
}

type SkillItem = {
  name: string
  description: string
  location: string
}

export function SkillSection({ plugin }: SkillSectionProps) {
  const { settings, setSettings } = useSettings()
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(
    null,
  )

  const loadSkills = useCallback(async () => {
    setRefreshing(true)
    try {
      const manager = await plugin.getMcpManager()
      const list = await manager.listSkills({ includeDisabled: true })
      setSkills(
        list.map((skill) => ({
          name: skill.name,
          description: skill.description,
          location: skill.location,
        })),
      )
      window.dispatchEvent(new Event('smtcmp:skills-refreshed'))
    } finally {
      setRefreshing(false)
    }
  }, [plugin])

  useEffect(() => {
    void loadSkills()
  }, [
    loadSkills,
    settings.agents.directoryName,
    settings.skills.paths,
    settings.skills.urls,
  ])

  useEffect(() => {
    if (skills.length === 0) {
      setSelectedSkillName(null)
      return
    }

    const hasSelectedSkill = skills.some(
      (skill) => skill.name === selectedSkillName,
    )
    if (!hasSelectedSkill) {
      setSelectedSkillName(skills[0].name)
    }
  }, [skills, selectedSkillName])

  const enabledSkillCount = useMemo(
    () =>
      skills.filter(
        (skill) => !(settings.skills.options[skill.name]?.disabled ?? false),
      ).length,
    [settings.skills.options, skills],
  )

  const selectedSkill =
    skills.find((skill) => skill.name === selectedSkillName) ??
    skills[0] ??
    null

  const handleToggleSkill = async (skillName: string, value: boolean) => {
    await setSettings({
      ...settings,
      skills: {
        ...settings.skills,
        options: {
          ...settings.skills.options,
          [skillName]: {
            ...settings.skills.options[skillName],
            disabled: !value,
          },
        },
      },
    })
  }

  return (
    <div className="smtcmp-settings-section smtcmp-mcp-modal-shell">
      <div className="smtcmp-modal-summary-row">
        <span>Skills {skills.length}</span>
        <span>Enabled {enabledSkillCount}</span>
        <span>
          Skill tool {settings.chatOptions.enableSkills ? 'On' : 'Off'}
        </span>
        <span>{refreshing ? 'Syncing' : 'Ready'}</span>
      </div>

      <section className="smtcmp-mcp-panel">
        <div className="smtcmp-settings-sub-header-container smtcmp-mcp-panel-header">
          <div>
            <div className="smtcmp-settings-sub-header">Discovered Skills</div>
            <div className="smtcmp-settings-desc smtcmp-mcp-panel-desc">
              Configure which discovered skills are enabled for tool calling.
            </div>
          </div>
          <div className="smtcmp-mcp-panel-header-action">
            <ObsidianButton
              text={refreshing ? 'Refreshing...' : 'Refresh'}
              disabled={refreshing}
              onClick={() => {
                void loadSkills()
              }}
            />
          </div>
        </div>

        <ObsidianSetting
          name="Agents directory"
          desc="Vault-relative folder used for agent assets such as skills. Default: .agents"
        >
          <ObsidianTextInput
            value={settings.agents.directoryName}
            onChange={async (value) => {
              await setSettings({
                ...settings,
                agents: {
                  ...settings.agents,
                  directoryName: value,
                },
              })
            }}
          />
        </ObsidianSetting>

        {skills.length === 0 ? (
          <div className="smtcmp-mcp-servers-empty">
            <div className="smtcmp-mcp-servers-empty-title">
              No skills found
            </div>
            <div className="smtcmp-settings-desc">
              Add skill paths or URLs in settings, then refresh this library.
            </div>
          </div>
        ) : (
          <div
            className={`smtcmp-mcp-tool-workbench${selectedSkill ? '' : ' smtcmp-mcp-tool-workbench--no-detail'}`}
          >
            <div className="smtcmp-mcp-tool-table">
              <div className="smtcmp-mcp-tool-table-header smtcmp-mcp-tool-table-header--two-col">
                <div>Skill</div>
                <div>Enabled</div>
              </div>
              {skills.map((skill) => {
                const isEnabled = !(
                  settings.skills.options[skill.name]?.disabled ?? false
                )
                return (
                  <button
                    key={skill.name}
                    type="button"
                    className={`smtcmp-mcp-tool-row-button smtcmp-mcp-tool-row-button--two-col${skill.name === selectedSkill?.name ? ' smtcmp-mcp-tool-row-button--selected' : ''}`}
                    onClick={() => setSelectedSkillName(skill.name)}
                  >
                    <div className="smtcmp-mcp-tool-row-main">
                      <div className="smtcmp-mcp-tool-name">{skill.name}</div>
                    </div>
                    <div
                      className="smtcmp-mcp-tool-row-toggle"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ObsidianToggle
                        value={isEnabled}
                        onChange={(value) =>
                          void handleToggleSkill(skill.name, value)
                        }
                      />
                    </div>
                  </button>
                )
              })}
            </div>

            {selectedSkill && (
              <div className="smtcmp-mcp-tool-detail-panel">
                <div className="smtcmp-mcp-tool-detail-kicker">
                  <PanelRight size={14} />
                  <span>Skill Detail</span>
                </div>
                <div className="smtcmp-mcp-tool-detail-title">
                  {selectedSkill.name}
                </div>
                <div className="smtcmp-mcp-tooltip-meta">
                  {selectedSkill.location}
                </div>
                {selectedSkill.description && (
                  <div className="smtcmp-mcp-tool-description">
                    {selectedSkill.description}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
