import { App } from 'obsidian'

import { SettingsProvider } from '../../contexts/settings-context'
import SmartComposerPlugin from '../../main'
import { ReactModal } from '../common/ReactModal'
import { SkillSection } from '../settings/sections/SkillSection'

type SkillSectionComponentProps = {
  app: App
  plugin: SmartComposerPlugin
}

export class SkillSectionModal extends ReactModal<SkillSectionComponentProps> {
  constructor(app: App, plugin: SmartComposerPlugin) {
    super({
      app,
      Component: SkillSectionComponent,
      props: {
        app,
        plugin,
      },
    })
    this.modalEl.style.width = '960px'
    this.modalEl.addClass('smtcmp-mcp-modal')
    this.contentEl.addClass('smtcmp-mcp-modal-content')
  }
}

function SkillSectionComponent({ app, plugin }: SkillSectionComponentProps) {
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(next) => plugin.setSettings(next)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <SkillSection app={app} plugin={plugin} />
    </SettingsProvider>
  )
}
