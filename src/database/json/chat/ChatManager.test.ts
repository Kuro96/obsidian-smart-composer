import { App } from 'obsidian'

import { ChatManager } from './ChatManager'
import { CHAT_SCHEMA_VERSION, ChatConversation } from './types'

const CHAT_DIR = '.smtcmp_json_db/chats'

function createMockApp(initialFiles: Record<string, string> = {}) {
  const files = new Map(Object.entries(initialFiles))

  const mockAdapter = {
    exists: jest.fn(async (filePath: string) => {
      if (filePath === CHAT_DIR) {
        return true
      }

      return files.has(filePath)
    }),
    mkdir: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(async (filePath: string) => {
      const content = files.get(filePath)
      if (content === undefined) {
        throw new Error(`File not found: ${filePath}`)
      }

      return content
    }),
    write: jest.fn(async (filePath: string, content: string) => {
      files.set(filePath, content)
    }),
    remove: jest.fn(async (filePath: string) => {
      files.delete(filePath)
    }),
    list: jest.fn(async (dirPath: string) => {
      const prefix = `${dirPath}/`
      return {
        files: Array.from(files.keys()).filter((filePath) =>
          filePath.startsWith(prefix),
        ),
        folders: [],
      }
    }),
  }

  const mockApp = {
    vault: {
      adapter: mockAdapter,
    },
  } as unknown as App

  return {
    app: mockApp,
    files,
  }
}

function createChat(
  overrides: Partial<ChatConversation> & Pick<ChatConversation, 'id'>,
): ChatConversation {
  return {
    id: overrides.id,
    title: overrides.title ?? 'New chat',
    messages: overrides.messages ?? [],
    createdAt: overrides.createdAt ?? 100,
    updatedAt: overrides.updatedAt ?? 100,
    schemaVersion: overrides.schemaVersion ?? CHAT_SCHEMA_VERSION,
  }
}

describe('ChatManager', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('filename generation', () => {
    it('uses a stable id-based file name', () => {
      const { app } = createMockApp()
      const chatManager = new ChatManager(app)

      const chat = createChat({ id: '123e4567-e89b-12d3-a456-426614174000' })

      expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (chatManager as any).generateFileName(chat),
      ).toBe('123e4567-e89b-12d3-a456-426614174000.json')
    })
  })

  describe('duplicate handling', () => {
    it('deduplicates chats by id when listing chats', async () => {
      const olderChat = createChat({
        id: 'same-id',
        title: 'Old title',
        updatedAt: 100,
      })
      const newerChat = createChat({
        id: 'same-id',
        title: 'New title',
        updatedAt: 200,
      })

      const { app } = createMockApp({
        [`${CHAT_DIR}/v1_Old%20title_100_same-id.json`]:
          JSON.stringify(olderChat),
        [`${CHAT_DIR}/v1_New%20title_200_same-id.json`]:
          JSON.stringify(newerChat),
      })

      const chatManager = new ChatManager(app)
      const chats = await chatManager.listChats()

      expect(chats).toEqual([
        {
          id: 'same-id',
          schemaVersion: CHAT_SCHEMA_VERSION,
          title: 'New title',
          updatedAt: 200,
        },
      ])
    })

    it('loads the latest duplicate chat by id', async () => {
      const olderChat = createChat({
        id: 'same-id',
        title: 'Old title',
        updatedAt: 100,
      })
      const newerChat = createChat({
        id: 'same-id',
        title: 'New title',
        updatedAt: 200,
      })

      const { app } = createMockApp({
        [`${CHAT_DIR}/v1_Old%20title_100_same-id.json`]:
          JSON.stringify(olderChat),
        [`${CHAT_DIR}/v1_New%20title_200_same-id.json`]:
          JSON.stringify(newerChat),
      })

      const chatManager = new ChatManager(app)

      await expect(chatManager.findById('same-id')).resolves.toEqual(newerChat)
    })

    it('repairs duplicate and legacy chat files into one stable file', async () => {
      const olderChat = createChat({
        id: 'same-id',
        title: 'Old title',
        updatedAt: 100,
      })
      const newerChat = createChat({
        id: 'same-id',
        title: 'New title',
        updatedAt: 200,
      })

      const { app, files } = createMockApp({
        [`${CHAT_DIR}/v1_Old%20title_100_same-id.json`]:
          JSON.stringify(olderChat),
        [`${CHAT_DIR}/v1_New%20title_200_same-id.json`]:
          JSON.stringify(newerChat),
      })

      const chatManager = new ChatManager(app)
      const result = await chatManager.repairStorage()

      expect(result).toEqual({
        scannedFiles: 2,
        repairedChats: 1,
        removedFiles: 2,
      })

      expect(Array.from(files.keys())).toEqual([`${CHAT_DIR}/same-id.json`])
      expect(JSON.parse(files.get(`${CHAT_DIR}/same-id.json`) ?? '')).toEqual(
        newerChat,
      )
    })

    it('updates a canonical chat file without deleting it', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(300)

      const existingChat = createChat({
        id: 'same-id',
        title: 'Original title',
        updatedAt: 100,
      })

      const { app, files } = createMockApp({
        [`${CHAT_DIR}/same-id.json`]: JSON.stringify(existingChat),
      })

      const chatManager = new ChatManager(app)
      const updatedChat = await chatManager.updateChat('same-id', {
        title: 'Updated title',
      })

      expect(updatedChat).toEqual({
        ...existingChat,
        title: 'Updated title',
        updatedAt: 300,
      })
      expect(Array.from(files.keys())).toEqual([`${CHAT_DIR}/same-id.json`])
      expect(JSON.parse(files.get(`${CHAT_DIR}/same-id.json`) ?? '')).toEqual(
        updatedChat,
      )
    })

    it('updates an existing legacy chat into the stable file and removes stale copies', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(300)

      const olderChat = createChat({
        id: 'same-id',
        title: 'Old title',
        updatedAt: 100,
      })

      const { app, files } = createMockApp({
        [`${CHAT_DIR}/v1_Old%20title_100_same-id.json`]:
          JSON.stringify(olderChat),
      })

      const chatManager = new ChatManager(app)
      const updatedChat = await chatManager.updateChat('same-id', {
        title: 'Renamed title',
      })

      expect(updatedChat).toEqual({
        ...olderChat,
        title: 'Renamed title',
        updatedAt: 300,
      })
      expect(Array.from(files.keys())).toEqual([`${CHAT_DIR}/same-id.json`])
    })
  })
})
