import { App, normalizePath } from 'obsidian'

type ActiveAgentsFile = {
  path: string
  content: string
}

type AgentsSnapshot = {
  content: string
  files: ActiveAgentsFile[]
}

export class AgentsManager {
  constructor(private readonly app: App) {}

  public async getSnapshot(): Promise<AgentsSnapshot> {
    const files = await this.getActiveFiles()
    return {
      content: files
        .map((file) => file.content.trim())
        .join('\n\n')
        .trim(),
      files,
    }
  }

  private async getActiveFiles(): Promise<ActiveAgentsFile[]> {
    const candidatePaths = this.getCandidatePaths()
    const files = await Promise.all(
      candidatePaths.map(async (filePath) => {
        if (!(await this.app.vault.adapter.exists(filePath))) {
          return null
        }

        const content = await this.app.vault.adapter
          .read(filePath)
          .catch(() => '')
        if (!content.trim()) {
          return null
        }

        return {
          path: filePath,
          content,
        }
      }),
    )

    return files.filter((file): file is ActiveAgentsFile => !!file)
  }

  private getCandidatePaths(): string[] {
    const paths = new Set<string>(['AGENTS.md'])
    const activeFilePath = this.app.workspace.getActiveFile()?.path

    if (!activeFilePath) {
      return [...paths]
    }

    const segments = activeFilePath.split('/').slice(0, -1)
    let current = ''
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment
      paths.add(normalizePath(`${current}/AGENTS.md`))
    }

    return [...paths]
  }
}

export type { ActiveAgentsFile, AgentsSnapshot }
