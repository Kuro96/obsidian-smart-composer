# obsidian-smart-composer Refactor PRD

## 1. Background

`obsidian-smart-composer` has already completed the core architectural split introduced in the previous round:

- `ConversationHarness`, `TurnEngine`, `ToolExecutor`
- `ToolRegistry` and built-in `ToolPack`s
- `ToolPermissionPolicy` and `ApprovalPolicy`
- `ContextBuilder` replacing the old prompt-first path as the main request assembly layer

The next round should not be another large structural rewrite. The repo now needs to converge behavior around one editing path, make tool usage more natural, and reduce old compatibility paths that still shape model behavior and UI.

## 2. Problem Statement

The current repo still has five structural gaps.

1. Tool-first is present in architecture, but not yet fully enforced in prompt guidance, tool descriptions, and runtime safeguards.
2. The legacy `<smtcmp_block> -> apply` path is still present in chat UX and code, competing with built-in tool editing.
3. Write-capable built-in tools do not yet flow through a staged diff review model.
4. Tool execution invariants are incomplete. In particular, read-before-write evidence is not enforced end-to-end, and manual approval currently bypasses `ToolExecutor`.
5. Settings and modal UX still reflects raw configuration editing more than guided workflows.

## 3. Goals

1. Make built-in tools the default action layer for vault operations.
2. Retire the legacy apply path as a primary editing workflow.
3. Introduce a single write-review path for all vault mutations.
4. Strengthen harness execution invariants so tool requests always land in explicit terminal states.
5. Improve settings and modal UX without changing the established visual language of the plugin.
6. Normalize file naming in the most inconsistent directories.

## 4. Non-Goals

1. Do not introduce a new settings schema version beyond `17`.
2. Do not do another wide architectural rewrite of harness, registry, or policy layers.
3. Do not remove historical rendering compatibility for old chat records in the early phases.
4. Do not redesign the whole UI system or visual style.
5. Do not add Obsidian-specific diff infrastructure that depends on unofficial APIs.

## 5. Compatibility Constraints

1. Each phase must leave the repo in a buildable, usable state.
2. Existing conversations that contain `<smtcmp_block>` content must remain viewable.
3. Existing settings must remain compatible with schema version `17`.
4. Built-in tools, external MCP tools, and skills must continue to coexist under the current registry model.

## 6. Current Repo Baseline

### Core execution

- `src/core/context/ContextBuilder.ts` already contains tool-first guidance and removes normal reliance on `<smtcmp_block>`.
- `src/core/harness/ConversationHarness.ts` and `src/core/harness/ToolExecutor.ts` already own the main tool execution loop.
- `src/core/tools/buildToolRegistry.ts` already registers built-in packs plus external MCP and skill adapters.

### Remaining legacy path

- `src/utils/chat/apply.ts`
- `src/ApplyView.tsx`
- `src/components/apply-view/ApplyViewRoot.tsx`
- `src/components/chat-view/Chat.tsx` apply mutation and apply navigation

### Important mismatch to resolve

Manual approval in `src/components/chat-view/ToolMessage.tsx` still executes tools through `McpManager.callTool()` instead of the registry-backed `ToolExecutor`. This means registry-only built-in tools and execution guards are not consistently applied in approval flows.

## 7. Product Requirements

### 7.1 Tool-first interaction

The assistant should default to tool usage whenever the request can be satisfied by built-in tools.

Requirements:

1. System guidance must explicitly prefer tools over manual instructions for vault operations.
2. Tool descriptions must be opinionated, not neutral API docs.
3. Existing-file mutations must require prior read evidence at runtime.
4. Frontmatter changes must be guided toward `note_frontmatter_set` / `note_frontmatter_delete` rather than generic text editing.

### 7.2 Legacy apply retirement

The repo should stop treating `<smtcmp_block>` editing as the primary editing path.

Requirements:

1. New editing work should route through tool calls.
2. Chat should no longer promote apply-view editing as the main path.
3. Old block rendering may remain for history compatibility until later cleanup.

### 7.3 Unified review flow for writes

All write-capable vault tools should move toward a staged review flow.

Requirements:

1. Write tools must produce reviewable proposed changes before disk mutation.
2. Diff review should be inline in chat by default.
3. A larger dedicated review surface may remain as an escalation path, not as the default entry point.

### 7.4 Harness robustness

Requirements:

1. Read-only safe tools should be eligible for future streaming execution.
2. Tool requests should always resolve to `success`, `error`, `aborted`, `rejected`, or `pending_review`/equivalent review state.
3. Approval behavior must be separated from tool visibility.
4. Approval execution must use the same execution path and safeguards as auto-execution.

### 7.5 Settings and modal UX

Requirements:

1. Separate runtime status from saved configuration.
2. Convert modal editing flows to draft -> validate -> commit.
3. Provide first-class configuration for built-in tool packs and high-risk tools.
4. Use outcome-oriented copy for dangerous settings.

### 7.6 Naming consistency

Requirements:

1. React components: `PascalCase.tsx`
2. hooks and utilities: `camelCase.ts`
3. classes, packs, registries, policies: `PascalCase.ts`

Priority directories:

- `src/core/tools/`
- `src/components/chat-view/chat-input/utils/`
- `src/utils/chat/`
- `src/components/settings/modals/`

## 8. Phase Plan

### Phase 1: Harden tool-first execution

Scope:

- Refine `ContextBuilder` guidance
- Strengthen built-in tool descriptions
- Add read-before-write enforcement
- Route approval execution through the same registry-backed executor path

Exit criteria:

1. The repo builds successfully.
2. Existing-file writes fail clearly without prior read evidence.
3. Manual approval uses the same execution safeguards as auto-execution.
4. Normal chat remains usable.

### Phase 2: Remove legacy apply as main path

Scope:

- Remove apply mutation from `Chat.tsx`
- Delete `src/utils/chat/apply.ts`
- Delete `src/ApplyView.tsx` and `src/components/apply-view/ApplyViewRoot.tsx`
- Keep block rendering only for historical display

Exit criteria:

1. No new editing flow depends on `<smtcmp_block> -> apply`.
2. Existing chat history with old blocks still renders.
3. The repo builds successfully.

### Phase 3: Introduce staged write review

Scope:

- Add proposed-change staging for write tools
- Add inline diff review in tool message UI
- Reuse `src/utils/chat/diff.ts` as shared diff infrastructure

Exit criteria:

1. Write-capable built-in tools no longer write immediately.
2. Inline review is available in chat.
3. The repo builds successfully.

### Phase 4: Improve harness execution details

Scope:

- Read-only streaming execution where safe
- Explicit terminal-state closure for missing tool results
- Concurrency-safe batching for read-only tools

Exit criteria:

1. Read-only tool chains feel faster or require fewer full-turn waits.
2. Tool requests always end in an explicit status.
3. The repo builds successfully.

### Phase 5: Rework settings and modals

Scope:

- Improve MCP and built-in tool configuration UX
- Separate runtime status from config sections
- Convert key modals to draft -> validate -> commit flows

Exit criteria:

1. Users can understand tool/runtime status without reading raw config details.
2. High-risk settings are explained by behavior and consequence.
3. The repo builds successfully.

### Phase 6: Normalize naming

Scope:

- Rename highest-value inconsistent files
- Update imports and tests accordingly

Exit criteria:

1. Priority directories follow the chosen naming conventions.
2. The repo builds successfully.

## 9. Validation Strategy

For every phase:

1. Run `npm run build`.
2. Confirm the changed path is still usable in the plugin UI.
3. Avoid landing a phase that leaves both new and old primary paths active for the same workflow.

## 10. Change History

- 2026-04-08: Initial PRD created from `refactor.md` and current repo baseline.
