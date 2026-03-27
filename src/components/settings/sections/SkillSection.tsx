import { App } from 'obsidian'
import { useCallback, useEffect, useState } from 'react'

import { useSettings } from '../../../contexts/settings-context'
import SmartComposerPlugin from '../../../main'
import { ObsidianButton } from '../../common/ObsidianButton'
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
  }, [loadSkills, settings.skills.paths, settings.skills.urls])

  return (
    <div className="smtcmp-settings-section">
      <div className="smtcmp-settings-sub-header-container">
        <div className="smtcmp-settings-header">Skills</div>
        <ObsidianButton
          text={refreshing ? 'Refreshing...' : 'Refresh'}
          disabled={refreshing}
          onClick={() => {
            void loadSkills()
          }}
        />
      </div>
      <div className="smtcmp-settings-desc smtcmp-settings-callout">
        Configure which discovered skills are enabled for tool calling.
      </div>

      {skills.length === 0 ? (
        <div className="smtcmp-mcp-servers-empty">No skills found</div>
      ) : (
        <div className="smtcmp-server-tools-container">
          {skills.map((skill) => {
            const disabled =
              settings.skills.options[skill.name]?.disabled ?? false
            return (
              <div key={skill.name} className="smtcmp-mcp-tool">
                <div className="smtcmp-mcp-tool-info">
                  <div className="smtcmp-mcp-tool-name">{skill.name}</div>
                  <div className="smtcmp-mcp-tool-description">
                    {skill.description}
                  </div>
                  <div className="smtcmp-mcp-tool-description">
                    {skill.location}
                  </div>
                </div>
                <div className="smtcmp-mcp-tool-toggle">
                  <span className="smtcmp-mcp-tool-toggle-label">Enabled</span>
                  <ObsidianToggle
                    value={!disabled}
                    onChange={async (value) => {
                      await setSettings({
                        ...settings,
                        skills: {
                          ...settings.skills,
                          options: {
                            ...settings.skills.options,
                            [skill.name]: {
                              ...settings.skills.options[skill.name],
                              disabled: !value,
                            },
                          },
                        },
                      })
                    }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
