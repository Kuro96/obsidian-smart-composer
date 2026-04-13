import {
  AdvancedLinesDiffComputer,
  ILinesDiffComputerOptions,
  LineRangeMapping,
} from 'vscode-diff'

export type DiffBlock =
  | {
      type: 'unchanged'
      value: string
    }
  | {
      type: 'modified'
      originalValue?: string
      modifiedValue?: string
    }

export function createDiffBlocks(
  currentMarkdown: string,
  incomingMarkdown: string,
): DiffBlock[] {
  const blocks: DiffBlock[] = []

  const advOptions: ILinesDiffComputerOptions = {
    ignoreTrimWhitespace: false,
    computeMoves: true,
    maxComputationTimeMs: 0,
  }
  const advDiffComputer = new AdvancedLinesDiffComputer()

  const currentLines = currentMarkdown.split('\n')
  const incomingLines = incomingMarkdown.split('\n')
  const advLineChanges = advDiffComputer.computeDiff(
    currentLines,
    incomingLines,
    advOptions,
  ).changes

  let lastOriginalEndLineNumberExclusive = 1
  advLineChanges.forEach((change: LineRangeMapping) => {
    const oStart = change.originalRange.startLineNumber
    const oEnd = change.originalRange.endLineNumberExclusive
    const mStart = change.modifiedRange.startLineNumber
    const mEnd = change.modifiedRange.endLineNumberExclusive

    if (oStart > lastOriginalEndLineNumberExclusive) {
      const unchangedValue = currentLines
        .slice(lastOriginalEndLineNumberExclusive - 1, oStart - 1)
        .join('\n')
      if (unchangedValue.length > 0) {
        blocks.push({ type: 'unchanged', value: unchangedValue })
      }
    }

    const originalValue = currentLines.slice(oStart - 1, oEnd - 1).join('\n')
    const modifiedValue = incomingLines.slice(mStart - 1, mEnd - 1).join('\n')
    if (originalValue.length > 0 || modifiedValue.length > 0) {
      blocks.push({
        type: 'modified',
        originalValue: originalValue.length > 0 ? originalValue : undefined,
        modifiedValue: modifiedValue.length > 0 ? modifiedValue : undefined,
      })
    }

    lastOriginalEndLineNumberExclusive = oEnd
  })

  if (currentLines.length > lastOriginalEndLineNumberExclusive - 1) {
    const unchangedValue = currentLines
      .slice(lastOriginalEndLineNumberExclusive - 1)
      .join('\n')
    if (unchangedValue.length > 0) {
      blocks.push({ type: 'unchanged', value: unchangedValue })
    }
  }

  return blocks
}

export type UnifiedDiffLine = {
  type: 'context' | 'added' | 'removed' | 'hunk-header'
  content: string
  oldLineNo?: number
  newLineNo?: number
}

export function createUnifiedDiffLines(
  originalText: string,
  modifiedText: string,
  contextLines = 3,
): UnifiedDiffLine[] {
  const advOptions: ILinesDiffComputerOptions = {
    ignoreTrimWhitespace: false,
    computeMoves: true,
    maxComputationTimeMs: 0,
  }
  const diffComputer = new AdvancedLinesDiffComputer()

  const originalLines = originalText.split('\n')
  const modifiedLines = modifiedText.split('\n')
  const changes = diffComputer.computeDiff(
    originalLines,
    modifiedLines,
    advOptions,
  ).changes

  if (changes.length === 0) {
    return []
  }

  // Build raw diff entries: unchanged + removed + added
  type RawEntry = {
    type: 'unchanged' | 'removed' | 'added'
    content: string
    oldLineNo?: number
    newLineNo?: number
  }

  const rawEntries: RawEntry[] = []
  let lastOldEnd = 1
  let lastNewEnd = 1

  for (const change of changes) {
    const oStart = change.originalRange.startLineNumber
    const oEnd = change.originalRange.endLineNumberExclusive
    const mStart = change.modifiedRange.startLineNumber
    const mEnd = change.modifiedRange.endLineNumberExclusive

    // Unchanged lines before this change
    for (let i = lastOldEnd; i < oStart; i++) {
      rawEntries.push({
        type: 'unchanged',
        content: originalLines[i - 1],
        oldLineNo: i,
        newLineNo: lastNewEnd + (i - lastOldEnd),
      })
    }

    // Removed lines
    for (let i = oStart; i < oEnd; i++) {
      rawEntries.push({
        type: 'removed',
        content: originalLines[i - 1],
        oldLineNo: i,
      })
    }

    // Added lines
    for (let i = mStart; i < mEnd; i++) {
      rawEntries.push({
        type: 'added',
        content: modifiedLines[i - 1],
        newLineNo: i,
      })
    }

    lastOldEnd = oEnd
    lastNewEnd = mEnd - (oEnd - oStart) + (oEnd - lastOldEnd) // simplified:
    // After processing a change, the new line counter should be mEnd
    lastNewEnd = mEnd
    lastOldEnd = oEnd
  }

  // Trailing unchanged lines
  for (let i = lastOldEnd; i <= originalLines.length; i++) {
    rawEntries.push({
      type: 'unchanged',
      content: originalLines[i - 1],
      oldLineNo: i,
      newLineNo: lastNewEnd + (i - lastOldEnd),
    })
  }

  // Now group into hunks with context lines
  // Find ranges of changed entries and expand by contextLines
  const changedIndices: number[] = []
  rawEntries.forEach((entry, idx) => {
    if (entry.type !== 'unchanged') {
      changedIndices.push(idx)
    }
  })

  if (changedIndices.length === 0) return []

  // Build visible ranges
  type Range = { start: number; end: number }
  const ranges: Range[] = []

  for (const idx of changedIndices) {
    const start = Math.max(0, idx - contextLines)
    const end = Math.min(rawEntries.length - 1, idx + contextLines)
    if (ranges.length > 0 && start <= ranges[ranges.length - 1].end + 1) {
      ranges[ranges.length - 1].end = end
    } else {
      ranges.push({ start, end })
    }
  }

  // Generate output lines with hunk headers
  const result: UnifiedDiffLine[] = []

  for (const range of ranges) {
    // Compute hunk header line numbers
    const firstEntry = rawEntries[range.start]

    const oldStart = firstEntry.oldLineNo ?? firstEntry.newLineNo ?? 1
    const newStart = firstEntry.newLineNo ?? firstEntry.oldLineNo ?? 1

    let oldCount = 0
    let newCount = 0
    for (let i = range.start; i <= range.end; i++) {
      const e = rawEntries[i]
      if (e.type === 'unchanged' || e.type === 'removed') oldCount++
      if (e.type === 'unchanged' || e.type === 'added') newCount++
    }

    result.push({
      type: 'hunk-header',
      content: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    })

    for (let i = range.start; i <= range.end; i++) {
      const entry = rawEntries[i]
      result.push({
        type: entry.type === 'unchanged' ? 'context' : entry.type,
        content: entry.content,
        oldLineNo: entry.oldLineNo,
        newLineNo: entry.newLineNo,
      })
    }
  }

  return result
}
