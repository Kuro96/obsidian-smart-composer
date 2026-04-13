import { AgentsManager } from './AgentsManager'

describe('AgentsManager', () => {
  function createApp(params?: {
    activeFilePath?: string
    files?: Record<string, string>
  }) {
    const files = new Map(Object.entries(params?.files ?? {}))

    return {
      workspace: {
        getActiveFile: () =>
          params?.activeFilePath ? { path: params.activeFilePath } : null,
      },
      vault: {
        adapter: {
          exists: jest.fn(async (filePath: string) => files.has(filePath)),
          read: jest.fn(async (filePath: string) => {
            const content = files.get(filePath)
            if (content == null) {
              throw new Error(`File not found: ${filePath}`)
            }
            return content
          }),
        },
      },
    }
  }

  it('returns an empty snapshot when no AGENTS files exist', async () => {
    const manager = new AgentsManager(createApp() as never)

    await expect(manager.getSnapshot()).resolves.toEqual({
      content: '',
      files: [],
    })
  })

  it('loads the root AGENTS file when there is no active file', async () => {
    const manager = new AgentsManager(
      createApp({
        files: {
          'AGENTS.md': 'root instructions',
        },
      }) as never,
    )

    await expect(manager.getSnapshot()).resolves.toEqual({
      content: 'root instructions',
      files: [
        {
          path: 'AGENTS.md',
          content: 'root instructions',
        },
      ],
    })
  })

  it('merges root and nested AGENTS files from root to current file directory', async () => {
    const manager = new AgentsManager(
      createApp({
        activeFilePath: 'projects/demo/note.md',
        files: {
          'AGENTS.md': 'root instructions',
          'projects/AGENTS.md': 'project instructions',
          'projects/demo/AGENTS.md': 'local instructions',
        },
      }) as never,
    )

    await expect(manager.getSnapshot()).resolves.toEqual({
      content:
        'root instructions\n\nproject instructions\n\nlocal instructions',
      files: [
        {
          path: 'AGENTS.md',
          content: 'root instructions',
        },
        {
          path: 'projects/AGENTS.md',
          content: 'project instructions',
        },
        {
          path: 'projects/demo/AGENTS.md',
          content: 'local instructions',
        },
      ],
    })
  })

  it('ignores empty AGENTS files', async () => {
    const manager = new AgentsManager(
      createApp({
        activeFilePath: 'notes/today.md',
        files: {
          'AGENTS.md': 'root instructions',
          'notes/AGENTS.md': '   \n',
        },
      }) as never,
    )

    await expect(manager.getSnapshot()).resolves.toEqual({
      content: 'root instructions',
      files: [
        {
          path: 'AGENTS.md',
          content: 'root instructions',
        },
      ],
    })
  })
})
