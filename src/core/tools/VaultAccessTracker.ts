import { normalizeVaultPath } from './vaultUtils'

class VaultAccessTracker {
  private readonly readsByConversation = new Map<string, Set<string>>()

  recordRead(conversationId: string, path: string): void {
    if (!conversationId) {
      return
    }

    let reads = this.readsByConversation.get(conversationId)
    if (!reads) {
      reads = new Set<string>()
      this.readsByConversation.set(conversationId, reads)
    }

    reads.add(normalizeVaultPath(path))
  }

  hasRead(conversationId: string, path: string): boolean {
    if (!conversationId) {
      return false
    }

    return (
      this.readsByConversation
        .get(conversationId)
        ?.has(normalizeVaultPath(path)) ?? false
    )
  }
}

export const vaultAccessTracker = new VaultAccessTracker()
