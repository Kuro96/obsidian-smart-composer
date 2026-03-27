import clsx from 'clsx'
import { Eye, EyeOff, GraduationCap } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { useApp } from '../../../contexts/app-context'
import { useMcp } from '../../../contexts/mcp-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import { SkillSectionModal } from '../../modals/SkillSectionModal'

export default function SkillBadge() {
  const app = useApp()
  const plugin = usePlugin()
  const { settings, setSettings } = useSettings()
  const { getMcpManager } = useMcp()
  const [skillCount, setSkillCount] = useState(0)

  const refreshSkillCount = useCallback(async () => {
    const manager = await getMcpManager()
    const skills = await manager.listSkills({ includeDisabled: true })
    setSkillCount(skills.length)
  }, [getMcpManager])

  const handleBadgeClick = useCallback(() => {
    new SkillSectionModal(app, plugin).open()
  }, [app, plugin])

  const handleSkillToggle = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.stopPropagation()
      void setSettings({
        ...settings,
        chatOptions: {
          ...settings.chatOptions,
          enableSkills: !settings.chatOptions.enableSkills,
        },
      })
    },
    [settings, setSettings],
  )

  useEffect(() => {
    void refreshSkillCount()
  }, [
    refreshSkillCount,
    settings.skills.paths,
    settings.skills.urls,
    settings.skills.options,
    settings.chatOptions.enableTools,
  ])

  useEffect(() => {
    const onRefresh = () => {
      void refreshSkillCount()
    }
    window.addEventListener('smtcmp:skills-refreshed', onRefresh)
    return () => {
      window.removeEventListener('smtcmp:skills-refreshed', onRefresh)
    }
  }, [refreshSkillCount])

  return (
    <div
      className="smtcmp-chat-user-input-file-badge"
      onClick={handleBadgeClick}
    >
      <div className="smtcmp-chat-user-input-file-badge-name">
        <GraduationCap
          size={12}
          className="smtcmp-chat-user-input-file-badge-name-icon"
        />
        <span
          className={clsx(
            !settings.chatOptions.enableSkills && 'smtcmp-excluded-content',
          )}
        >
          Skills ({skillCount})
        </span>
      </div>
      <div
        className="smtcmp-chat-user-input-file-badge-eye"
        onClick={handleSkillToggle}
      >
        {settings.chatOptions.enableSkills ? (
          <Eye size={12} />
        ) : (
          <EyeOff size={12} />
        )}
      </div>
    </div>
  )
}
