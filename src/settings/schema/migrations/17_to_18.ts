import { SettingMigration } from '../setting.types'

export const migrateFrom17To18: SettingMigration['migrate'] = (data) => {
  return { ...data, version: 18 }
}
