#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const LEGACY_CHAT_DIR = '.smtcmp_chat_histories'
const JSON_CHAT_DIR = path.join('.smtcmp_json_db', 'chats')

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    return { __readError: error.message }
  }
}

function collectJsonFiles(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return []
  }

  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()
}

function summarizeDirectory(vaultPath, relativeDir) {
  const absoluteDir = path.join(vaultPath, relativeDir)
  const files = collectJsonFiles(absoluteDir)
  const groups = new Map()
  const invalidFiles = []

  for (const fileName of files) {
    const filePath = path.join(absoluteDir, fileName)
    const data = readJson(filePath)

    if (data.__readError || !data.id) {
      invalidFiles.push({ fileName, error: data.__readError || 'Missing id' })
      continue
    }

    const group = groups.get(data.id) || []
    group.push({
      fileName,
      title: data.title,
      updatedAt: data.updatedAt,
      createdAt: data.createdAt,
      messageCount: Array.isArray(data.messages) ? data.messages.length : null,
      isCanonicalFile: fileName === `${data.id}.json`,
    })
    groups.set(data.id, group)
  }

  const duplicates = Array.from(groups.entries())
    .map(([id, entries]) => ({ id, entries }))
    .filter((group) => group.entries.length > 1)
    .sort((left, right) => right.entries.length - left.entries.length)

  return {
    relativeDir,
    absoluteDir,
    fileCount: files.length,
    chatCount: groups.size,
    duplicateCount: duplicates.length,
    duplicates,
    invalidFiles,
  }
}

function printReport(report) {
  console.log(`\n[${report.relativeDir}]`)
  console.log(`Directory: ${report.absoluteDir}`)
  console.log(`JSON files: ${report.fileCount}`)
  console.log(`Unique chat ids: ${report.chatCount}`)
  console.log(`Duplicate chat ids: ${report.duplicateCount}`)

  if (report.invalidFiles.length > 0) {
    console.log('Invalid files:')
    for (const file of report.invalidFiles) {
      console.log(`  - ${file.fileName}: ${file.error}`)
    }
  }

  if (report.duplicates.length === 0) {
    console.log('No duplicate chat ids found.')
    return
  }

  console.log('Duplicate groups:')
  for (const group of report.duplicates) {
    console.log(`  - chat id ${group.id} (${group.entries.length} files)`)
    for (const entry of group.entries.sort(
      (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
    )) {
      console.log(
        `    * ${entry.fileName} | updatedAt=${entry.updatedAt} | createdAt=${entry.createdAt} | messages=${entry.messageCount} | canonical=${entry.isCanonicalFile} | title=${JSON.stringify(entry.title)}`,
      )
    }
  }
}

function main() {
  const vaultPath = process.argv[2]

  if (!vaultPath) {
    console.error('Usage: node scripts/diagnose-chat-storage.js <vault-path>')
    process.exit(1)
  }

  const resolvedVaultPath = path.resolve(vaultPath)

  if (
    !fs.existsSync(resolvedVaultPath) ||
    !fs.statSync(resolvedVaultPath).isDirectory()
  ) {
    console.error(
      `Vault path does not exist or is not a directory: ${resolvedVaultPath}`,
    )
    process.exit(1)
  }

  console.log(`Inspecting vault: ${resolvedVaultPath}`)
  printReport(summarizeDirectory(resolvedVaultPath, JSON_CHAT_DIR))
  printReport(summarizeDirectory(resolvedVaultPath, LEGACY_CHAT_DIR))
}

main()
