## Why

The TypeScript/React migration (archived change `2026-04-12-typescript-rust-rewrite` plus the in-flight `unified-ts-migration`) regressed parts of the user-facing pipeline. An end-to-end audit surfaced **six contract bugs that hard-fail live features** (refine, start mode, skip stage, SSE `review` event, EventSource listener leak, out-of-order state handling) and **seven legacy parity gaps** that reduce operator situational awareness (agent activity bar, sub-stage progress, `f` shortcut, diff file search, large-diff safety, diff render progress, log export). This change restores correctness and parity so the React UI is usable day-to-day for Jira → QA → Pre-Prod → Production approvals.

## What Changes

- **API contract fixes**
  - `POST /api/refine`: frontend sends required `gate` field; sanitizer allows it (was already in schema but FE dropped it)
  - `POST /api/start`: security sanitizer schema accepts optional `mode: 'resume' | 'fresh'` so the field survives into the handler
  - `POST /api/skip-stage`: frontend sends `confirm: true` so sanitizer + handler accept the call
- **SSE event pipeline**
  - Frontend attaches a `review` event listener that re-fetches state / clears gate overlays after approve/reject/refine
  - EventSource named listeners stored on a ref and removed in `closeEventSource()` to stop leaks across reconnects
  - `pipeline.updateState()` dedupes duplicate state payloads and guards `stageStartedAt` against backwards stage transitions
- **Pipeline UI parity**
  - New `AgentActivityBar` component surfaces the live "what is it doing" string from `state.data._agent_action` (or equivalent)
  - `AgentStatus` shows sub-stage progress (write → review → fix) during `generate_code` based on `state.data._sub_stage`
  - `f` key binding in `useGlobalKeyboardShortcuts` opens the refine form on `explore_plan` gate
- **Code review UI parity**
  - `FileTree` gets a search input that filters files by substring
  - `DiffViewer` shows a warning modal when a hunk set exceeds 5 000 lines, with a "render anyway" action
  - A lightweight diff render progress indicator appears while parsing
- **Log viewer parity**
  - `LogViewer` adds an export button that downloads the visible/filtered logs as `{ticket}-logs.txt`
- **Dead endpoint cleanup**
  - Remove the 11 unused backend routes identified in the audit (`/api/error`, `/api/reset-stage`, `/api/test-artifacts`, `/api/notification-audit`, `/api/escalations`, `/api/tickets`, `GET /api/comments`, `GET /api/review-comments`, `POST /api/review-comments`) once confirmed no external consumer; keep `/api/state` and `/api/review` since they exist in `api.ts` even if unused by components today

## Capabilities

### New Capabilities
- `api-contract`: Canonical request/response shape for each `/api/*` endpoint the React frontend calls, including the sanitizer schema envelope and SSE event types
- `pipeline-ui`: Visualization contract for live pipeline status — stage + sub-stage progress, agent activity line, stuck detection — consumed by `AgentStatus`
- `code-review-ui`: Contract for the diff viewer including split/unified toggle, char-level highlights, file search, inline comments with threading, and large-diff safety guards

### Modified Capabilities
<!-- No existing application specs -->

## Impact

- **Pipeline stages affected**: none directly (this is a UI+API contract change). Approval / refine / skip stage actions will start working again for all stages that currently trigger them
- **Modified files (backend)**: `packages/backend/src/middleware/security.ts`, `packages/backend/src/server/routes.ts`
- **Modified files (frontend)**: `packages/frontend/src/lib/api.ts`, `packages/frontend/src/hooks/useSSE.ts`, `packages/frontend/src/store/pipeline.ts`, `packages/frontend/src/components/AgentStatus.tsx`, `packages/frontend/src/components/GateApproval.tsx`, `packages/frontend/src/components/review/DiffViewer.tsx`, `packages/frontend/src/components/review/FileTree.tsx`, `packages/frontend/src/components/LogViewer.tsx`, `packages/frontend/src/hooks/useGlobalKeyboardShortcuts.ts`
- **New files (frontend)**: `packages/frontend/src/components/AgentActivityBar.tsx`, `packages/frontend/src/components/SubStageProgress.tsx`, `packages/frontend/src/components/LargeDiffWarning.tsx`
- **New dependencies**: None — all changes use existing React/Zustand/standard browser APIs
- **New env vars**: None
- **Failure scenarios**: Each fix is additive — if a subtask regresses we can revert that commit without impacting the rest. API contract fixes ship with updated sanitizer schemas so existing callers keep working (`mode`/`confirm` remain optional where safe).
- **Internal GitLab constraint**: No impact — all changes are UI/API shape, no new external calls
