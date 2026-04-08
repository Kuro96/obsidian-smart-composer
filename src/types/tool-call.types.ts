export type ToolCallRequest = {
  id: string
  name: string
  arguments?: string
}

export type ProposedToolReview = {
  toolName: string
  targetPath: string
  kind: 'write' | 'edit' | 'append' | 'frontmatter' | 'move' | 'delete'
  summary: string
  beforeText?: string
  afterText?: string
  metadata?: Record<string, unknown>
}

export type ToolCallResponse =
  | {
      status:
        | ToolCallResponseStatus.PendingApproval
        | ToolCallResponseStatus.Rejected
        | ToolCallResponseStatus.Running
    }
  | {
      status: ToolCallResponseStatus.PendingReview
      proposal: ProposedToolReview
    }
  | {
      status: ToolCallResponseStatus.Success
      data: {
        type: 'text'
        text: string
      }
    }
  | {
      status: ToolCallResponseStatus.Error
      error: string
    }
  | {
      status: ToolCallResponseStatus.Aborted
    }

export enum ToolCallResponseStatus {
  PendingApproval = 'pending_approval',
  PendingReview = 'pending_review',
  Rejected = 'rejected',
  Running = 'running',
  Success = 'success',
  Error = 'error',
  Aborted = 'aborted',
}
