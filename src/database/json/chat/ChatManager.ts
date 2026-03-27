import { App } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import { AbstractJsonRepository } from '../base'
import { CHAT_DIR, ROOT_DIR } from '../constants'
import { EmptyChatTitleException } from '../exception'

import {
  CHAT_SCHEMA_VERSION,
  ChatConversation,
  ChatConversationMetadata,
} from './types'

export class ChatManager extends AbstractJsonRepository<
  ChatConversation,
  ChatConversationMetadata
> {
  constructor(app: App) {
    super(app, `${ROOT_DIR}/${CHAT_DIR}`)
  }

  protected generateFileName(chat: ChatConversation): string {
    return `${chat.id}.json`
  }

  protected parseFileName(fileName: string): ChatConversationMetadata | null {
    const regex = new RegExp(
      `^v${CHAT_SCHEMA_VERSION}_(.+)_(\\d+)_([0-9a-f-]+)\\.json$`,
    )
    const match = fileName.match(regex)
    if (!match) return null

    const title = decodeURIComponent(match[1])
    const updatedAt = parseInt(match[2], 10)
    const id = match[3]

    return {
      id,
      schemaVersion: CHAT_SCHEMA_VERSION,
      title,
      updatedAt,
    }
  }

  public async createChat(
    initialData: Partial<ChatConversation>,
  ): Promise<ChatConversation> {
    if (initialData.title && initialData.title.length === 0) {
      throw new EmptyChatTitleException()
    }

    const now = Date.now()
    const newChat: ChatConversation = {
      id: uuidv4(),
      title: 'New chat',
      messages: [],
      createdAt: now,
      updatedAt: now,
      schemaVersion: CHAT_SCHEMA_VERSION,
      ...initialData,
    }

    await this.create(newChat)
    return newChat
  }

  public async findById(id: string): Promise<ChatConversation | null> {
    const chatEntries = await this.listChatEntries()
    return this.selectLatestChat(
      chatEntries.filter((entry) => entry.chat.id === id),
    )
  }

  public async updateChat(
    id: string,
    updates: Partial<
      Omit<ChatConversation, 'id' | 'createdAt' | 'updatedAt' | 'schemaVersion'>
    >,
  ): Promise<ChatConversation | null> {
    const chatEntries = await this.listChatEntries()
    const matchingEntries = chatEntries.filter((entry) => entry.chat.id === id)
    const chat = this.selectLatestChat(matchingEntries)
    if (!chat) return null

    if (updates.title !== undefined && updates.title.length === 0) {
      throw new EmptyChatTitleException()
    }

    const updatedChat: ChatConversation = {
      ...chat,
      ...updates,
      updatedAt: Date.now(),
    }

    await this.writeCanonicalChat(updatedChat)
    await this.removeChatEntries(matchingEntries)
    return updatedChat
  }

  public async deleteChat(id: string): Promise<boolean> {
    const matchingEntries = (await this.listChatEntries()).filter(
      (entry) => entry.chat.id === id,
    )
    if (matchingEntries.length === 0) return false

    await this.removeChatEntries(matchingEntries)
    return true
  }

  public async listChats(): Promise<ChatConversationMetadata[]> {
    const chatsById = new Map<string, ChatConversation>()

    for (const entry of await this.listChatEntries()) {
      const existing = chatsById.get(entry.chat.id)
      if (!existing || entry.chat.updatedAt > existing.updatedAt) {
        chatsById.set(entry.chat.id, entry.chat)
      }
    }

    return Array.from(chatsById.values())
      .map((chat) => ({
        id: chat.id,
        schemaVersion: chat.schemaVersion,
        title: chat.title,
        updatedAt: chat.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  public async repairStorage(): Promise<{
    scannedFiles: number
    repairedChats: number
    removedFiles: number
  }> {
    const entries = await this.listChatEntries()
    const entriesById = new Map<
      string,
      { fileName: string; chat: ChatConversation }[]
    >()

    for (const entry of entries) {
      const group = entriesById.get(entry.chat.id) ?? []
      group.push(entry)
      entriesById.set(entry.chat.id, group)
    }

    let repairedChats = 0
    let removedFiles = 0

    for (const group of entriesById.values()) {
      const latestChat = this.selectLatestChat(group)
      if (!latestChat) continue

      const canonicalFileName = this.generateFileName(latestChat)
      const needsRepair =
        group.length > 1 ||
        group.some((entry) => entry.fileName !== canonicalFileName)

      if (!needsRepair) continue

      await this.writeCanonicalChat(latestChat)
      await this.removeChatEntries(group, canonicalFileName)

      repairedChats += 1
      removedFiles += group.filter(
        (entry) => entry.fileName !== canonicalFileName,
      ).length
    }

    return {
      scannedFiles: entries.length,
      repairedChats,
      removedFiles,
    }
  }

  private async listChatEntries(): Promise<
    { fileName: string; chat: ChatConversation }[]
  > {
    const files = await this.app.vault.adapter.list(this.dataDir)
    const fileNames = files.files
      .map((filePath) => filePath.split('/').pop())
      .filter(
        (fileName): fileName is string =>
          !!fileName && fileName.endsWith('.json'),
      )

    const entries = await Promise.all(
      fileNames.map(async (fileName) => {
        try {
          const chat = await this.readChatFile(fileName)
          if (!chat || !chat.id) return null

          return {
            fileName,
            chat,
          }
        } catch (error) {
          console.error(`Failed to read chat file ${fileName}:`, error)
          return null
        }
      }),
    )

    return entries.filter(
      (entry): entry is { fileName: string; chat: ChatConversation } =>
        entry !== null,
    )
  }

  private selectLatestChat(
    entries: { fileName: string; chat: ChatConversation }[],
  ): ChatConversation | null {
    if (entries.length === 0) return null

    return (
      [...entries]
        .sort((left, right) => {
          if (right.chat.updatedAt !== left.chat.updatedAt) {
            return right.chat.updatedAt - left.chat.updatedAt
          }

          if (right.chat.createdAt !== left.chat.createdAt) {
            return right.chat.createdAt - left.chat.createdAt
          }

          return left.fileName.localeCompare(right.fileName)
        })
        .at(0)?.chat ?? null
    )
  }

  private async writeCanonicalChat(chat: ChatConversation): Promise<void> {
    const fileName = this.generateFileName(chat)
    const existingChat = await this.readChatFile(fileName)

    await this.writeChatFile(fileName, existingChat ? chat : chat)
  }

  private async removeChatEntries(
    entries: { fileName: string; chat: ChatConversation }[],
    preserveFileName?: string,
  ): Promise<void> {
    await Promise.all(
      entries
        .filter((entry) => entry.fileName !== preserveFileName)
        .map((entry) => this.deleteChatFile(entry.fileName)),
    )
  }

  private async readChatFile(
    fileName: string,
  ): Promise<ChatConversation | null> {
    const filePath = this.getFilePath(fileName)
    if (!(await this.app.vault.adapter.exists(filePath))) {
      return null
    }

    const content = await this.app.vault.adapter.read(filePath)
    return JSON.parse(content) as ChatConversation
  }

  private async writeChatFile(
    fileName: string,
    chat: ChatConversation,
  ): Promise<void> {
    const filePath = this.getFilePath(fileName)
    await this.app.vault.adapter.write(filePath, JSON.stringify(chat, null, 2))
  }

  private async deleteChatFile(fileName: string): Promise<void> {
    const filePath = this.getFilePath(fileName)
    if (await this.app.vault.adapter.exists(filePath)) {
      await this.app.vault.adapter.remove(filePath)
    }
  }

  private getFilePath(fileName: string): string {
    return `${this.dataDir}/${fileName}`
  }
}
