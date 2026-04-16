## 1. Workspace & Build Infrastructure

- [x] 1.1 Create `packages/agent/` directory with `src/lib/`, `src/stages/`, `src/server/` subdirectories
- [x] 1.2 Create `packages/agent/package.json` with name `@mi/agent`, main `dist/index.js`, types `dist/index.d.ts`, dependency on `@mi/shared: *`
- [x] 1.3 Create `packages/agent/tsconfig.json` with `composite: true`, `allowJs: true`, `module: commonjs`, `target: ES2022`, `outDir: ./dist`, `rootDir: ./src`, paths for `@shared/*`, reference to `../shared`
- [x] 1.4 Add `"packages/agent"` to root `package.json` workspaces array
- [x] 1.5 Add `{ "path": "packages/agent" }` to root `tsconfig.json` references
- [x] 1.6 Add `build:agent` script to root `package.json`, update `build` to include it after `build:shared`
- [x] 1.7 Add `test:agent` and `lint:agent` scripts to root `package.json`
- [x] 1.8 Update Dockerfile Stage 2 to copy and build `packages/agent/`
- [x] 1.9 Update Dockerfile Stage 3 to copy `packages/agent/dist/` and `package.json`
- [x] 1.10 Run `npm install` to wire workspace, verify `tsc --noEmit` passes with empty src/index.ts

## 2. Shared Type Definitions — Core Types

- [x] 2.1 Create `packages/shared/src/types/jira.ts` with JiraIssue, JiraFields, JiraComment, JiraAttachment, JiraUser, JiraStatus, JiraIssueType, JiraPriority, JiraTransition, JiraIssueLink, JiraLinkType (~30 types)
- [x] 2.2 Create `packages/shared/src/types/gitlab.ts` with GitLabMergeRequest, GitLabDiff, GitLabCommit, GitLabBranch, GitLabFile, GitLabTreeItem, GitLabUser, GitLabNote, GitLabPipeline, GitLabCommitAction, GitLabMRApprovals (~28 types)
- [x] 2.3 Create `packages/shared/src/types/adf.ts` with AdfNode, AdfNodeType, AdfMark, AdfHeadingAttrs, AdfCodeBlockAttrs, AdfMentionAttrs, AdfInlineCardAttrs, AdfContext (~15 types, recursive discriminated union)
- [x] 2.4 Create `packages/shared/src/types/tickets.ts` with TicketContext, TicketComment, LinkedIssue, AttachmentContent, FetchedUrlContent, ConnectorContent (~8 types)
- [x] 2.5 Create `packages/shared/src/types/codegen.ts` with CodeChange, DevServerResult, BuildCheckResult, RuntimeTestResult, BrowserVerifyResult (~8 types)
- [x] 2.6 Create `packages/shared/src/types/http.ts` with HttpResponse<T>, HttpRequestOptions, CircuitBreakerState, HealthSnapshot, RequestMetrics (~5 types)
- [x] 2.7 Create `packages/shared/src/types/state.ts` with StateEnvelope, StateEnvelopeV2, StateMutator, IReadResult, UIApproval, PruneResult (~6 types)

## 3. Shared Type Definitions — Supporting Types

- [x] 3.1 Create `packages/shared/src/types/process.ts` with ClaudeCallOptions, ClaudeResponse, AgentProcessInfo, ProcessRedactorHandle (~5 types)
- [x] 3.2 Create `packages/shared/src/types/sse.ts` with SseMessage, SseLogEntry, ClientInfo, SseStatus (~5 types)
- [x] 3.3 Create `packages/shared/src/types/connectors.ts` with GDrive*, Figma*, Postman* result types, FigmaNode, PostmanRequest (~20 types)
- [x] 3.4 Create `packages/shared/src/types/slack.ts` with SlackMessage, SlackBlock, SlackAttachment, SlackResponse (~8 types)
- [x] 3.5 Create `packages/shared/src/types/approval.ts` with ApprovalGate, RejectionRecord, ApprovalCheckResult (~3 types)
- [x] 3.6 Create `packages/shared/src/types/review.ts` with CodeReview, ReviewIssue, ReviewSuggestion, SecurityReview, SecurityIssue (~5 types)
- [x] 3.7 Create `packages/shared/src/types/diff.ts` with MRDiff, DiffStats, DiffLine, InlineComment (~4 types)
- [x] 3.8 Create `packages/shared/src/types/logging.ts` with LogEntry, LogLevel, LogConfig (~3 types)
- [x] 3.9 Create `packages/shared/src/types/metrics.ts` with StageMetrics, SystemMetrics (~2 types)
- [x] 3.10 Create `packages/shared/src/types/notifications.ts` with NotificationQueueItem, NotificationDeliveryStatus (~2 types)
- [x] 3.11 Create `packages/shared/src/types/qa.ts` with QATestResult, SmokeTest, RegressionCase (~3 types)
- [x] 3.12 Update `packages/shared/src/types/index.ts` to re-export all new type files
- [x] 3.13 Run `npm run build:shared` and verify no type errors, all exports accessible

## 4. JS→TS Phase 1 — Leaf Files (0 local deps)

- [x] 4.1 Copy `lib/constants.js` to `packages/agent/src/lib/constants.ts`, add type annotations, verify compiles
- [x] 4.2 Copy `lib/config-schema.js` → `packages/agent/src/lib/config-schema.ts`, type ConfigSchemaEntry, ConfigGroup
- [x] 4.3 Copy `lib/env-parser.js` → `packages/agent/src/lib/env-parser.ts`, type loadAndApplyEnv return
- [x] 4.4 Copy `lib/adf.js` → `packages/agent/src/lib/adf.ts`, use AdfNode types from @shared
- [x] 4.5 Copy `lib/state-lock.js` → `packages/agent/src/lib/state-lock.ts`, type Lock interface { release(): void }
- [x] 4.6 Copy `lib/state-migration.js` → `packages/agent/src/lib/state-migration.ts`
- [x] 4.7 Copy `lib/graceful-shutdown.js` → `packages/agent/src/lib/graceful-shutdown.ts`
- [x] 4.8 Copy `lib/security.js` → `packages/agent/src/lib/security.ts`
- [x] 4.9 Copy `lib/gdrive.js` → `packages/agent/src/lib/gdrive.ts`, use connector types from @shared
- [x] 4.10 Copy `lib/figma.js` → `packages/agent/src/lib/figma.ts`
- [x] 4.11 Copy `lib/postman.js` → `packages/agent/src/lib/postman.ts`
- [x] 4.12 Copy `lib/redaction.js` → `packages/agent/src/lib/redaction.ts`
- [x] 4.13 Copy `lib/refusal-detection.js` → `packages/agent/src/lib/refusal-detection.ts`
- [x] 4.14 Copy `lib/version.js` → `packages/agent/src/lib/version.ts`
- [x] 4.15 Run `npm run build:agent` and verify all Phase 1 files compile
- [x] 4.16 Run `npm run lint:agent` — zero type errors

## 5. JS→TS Phase 2 — Hub Files (HIGH RISK)

- [x] 5.1 Copy `lib/config.js` → `packages/agent/src/lib/config.ts` — convert to typed exports, use IConfig interface, keep `any` escape hatches for 70+ bindings
- [x] 5.2 Copy `lib/config-validate.js` → `packages/agent/src/lib/config-validate.ts`
- [x] 5.3 Copy `lib/logging.js` → `packages/agent/src/lib/logging.ts` — type Logger class with LogLevel, RedactorFn, SSEBroadcastFn
- [x] 5.4 Copy `lib/state-unified.js` → `packages/agent/src/lib/state-unified.ts` — type StateManager with sync/async APIs, use PipelineState from @shared
- [x] 5.5 Copy `lib/http-client.js` → `packages/agent/src/lib/http-client.ts` — type HttpOptions, HttpResponse<T>, CircuitBreaker class, RateLimitTracker, MetricsCollector
- [x] 5.6 Copy `lib/utils.js` → `packages/agent/src/lib/utils.ts` — type all utility functions
- [x] 5.7 Verify all Phase 1 files still compile after hub file imports change
- [x] 5.8 Run full `npm run build:agent` — all Phase 1+2 files compile

## 6. JS→TS Phase 3 — Service Files

- [x] 6.1 Copy `lib/jira.js` → `packages/agent/src/lib/jira.ts` — use JiraIssue, JiraComment types from @shared
- [x] 6.2 Copy `lib/gitlab.js` → `packages/agent/src/lib/gitlab.ts` — use GitLabMergeRequest, GitLabDiff types
- [x] 6.3 Copy `lib/slack.js` → `packages/agent/src/lib/slack.ts` — use SlackMessage, SlackBlock types
- [x] 6.4 Copy `lib/claude.js` → `packages/agent/src/lib/claude.ts` — use ClaudeCallOptions, ClaudeResponse types
- [x] 6.5 Copy `lib/notification-config.js` → `packages/agent/src/lib/notification-config.ts`
- [x] 6.6 Copy `lib/notification-resilience.js` → `packages/agent/src/lib/notification-resilience.ts`
- [x] 6.7 Copy `lib/escalation.js` → `packages/agent/src/lib/escalation.ts`
- [x] 6.8 Copy `lib/restart-protection.js` → `packages/agent/src/lib/restart-protection.ts`
- [x] 6.9 Copy remaining lib/*.js files → packages/agent/src/lib/*.ts
- [x] 6.10 Run `npm run build:agent` — all lib files compile

## 7. JS→TS Phase 4 — Stages

- [x] 7.1 Copy `stages/fetch-ticket.js` → `packages/agent/src/stages/fetch-ticket.ts` — use TicketContext, ConnectorContent types
- [x] 7.2 Copy `stages/explore-plan.js` → `packages/agent/src/stages/explore-plan.ts`
- [x] 7.3 Copy `stages/generate-code/index.js` → `packages/agent/src/stages/generate-code/index.ts` — use CodeChange types
- [x] 7.4 Copy all `stages/generate-code/*.js` sub-files → `.ts` (developer, reviewer, runtime-tests, browser-verify, build-check, fixer, dev-server, ac-verification, env-setup, evidence-collector, legacy-codegen, login-helper, route-detector)
- [x] 7.5 Copy `stages/push-code.js` → `packages/agent/src/stages/push-code.ts`
- [x] 7.6 Copy `stages/gate-code-review.js` → `packages/agent/src/stages/gate-code-review.ts` — use ApprovalGate types
- [x] 7.7 Copy `stages/deploy-qa.js` → `packages/agent/src/stages/deploy-qa.ts`
- [x] 7.8 Copy `stages/test-qa.js` → `packages/agent/src/stages/test-qa.ts` — use QATestResult types
- [x] 7.9 Copy remaining stages → `.ts` (gate-preprod, create-preprod-mr, gate-dual, deploy-prod, done, validation)
- [x] 7.10 Run `npm run build:agent` — all stages compile

## 8. JS→TS Phase 5 — Server & Entry Points

- [x] 8.1 Copy `server/sse.js` → `packages/agent/src/server/sse.ts` — use SseMessage, ClientInfo types
- [x] 8.2 Copy `server/routes.js` → `packages/agent/src/server/routes.ts`
- [x] 8.3 Copy `server/html.js` → `packages/agent/src/server/html.ts`
- [x] 8.4 Copy `server/agent-process.js` → `packages/agent/src/server/agent-process.ts` — use AgentProcessInfo types
- [x] 8.5 Copy remaining server/*.js → packages/agent/src/server/*.ts
- [x] 8.6 Copy `run-agent.js` → `packages/agent/src/index.ts` (main entry, orchestrator logic)
- [x] 8.7 Create root `run-agent.js` shim: `require('./packages/agent/dist/index.js')`
- [x] 8.8 Create root `server.js` shim: `require('./packages/agent/dist/server/index.js')`
- [x] 8.9 Run full `npm run build` — entire monorepo compiles
- [x] 8.10 Start agent with `npm run dev:legacy` and verify it boots successfully on port 3000

## 9. React UI Shell & Routing

- [x] 9.1 Create `packages/frontend/src/store/navigation.ts` — Zustand slice with `currentView`, `setView()`, hash listener
- [x] 9.2 Update `packages/frontend/src/App.tsx` — add hash-based view switching (#/dashboard, #/settings, #/review)
- [x] 9.3 Create `packages/frontend/src/components/Toast.tsx` — toast component with success/error/warn/info variants, auto-dismiss, vertical stacking
- [x] 9.4 Create `packages/frontend/src/contexts/ToastContext.tsx` — provider + `useToast()` hook
- [x] 9.5 Create `packages/frontend/src/components/ConfirmDialog.tsx` — modal with Cancel/Confirm, Esc to close, focus trap
- [x] 9.6 Create `packages/frontend/src/components/ErrorOverlay.tsx` — full-page error card with dismiss button
- [x] 9.7 Update `packages/frontend/src/components/Sidebar.tsx` — add Settings nav link, active state for current view
- [x] 9.8 Verify navigation between all 3 views works with hash changes

## 10. React Settings Page

- [x] 10.1 Create `packages/frontend/src/store/settings.ts` — Zustand slice with config, notifications, connectors state + actions
- [x] 10.2 Add 4 API endpoints to `packages/frontend/src/lib/api.ts` — getConfig, saveConfig, testConnection, getNotificationConfig, saveNotificationConfig
- [x] 10.3 Create `packages/frontend/src/components/settings/SettingsPage.tsx` — page shell with 3-tab interface
- [x] 10.4 Create `packages/frontend/src/components/settings/ConfigTab.tsx` — config fields grouped by service, collapsible groups
- [x] 10.5 Create `packages/frontend/src/components/settings/ConfigField.tsx` — text/password field with eye toggle, required indicator, info tooltip
- [x] 10.6 Create `packages/frontend/src/components/settings/TestConnectionButton.tsx` — POST /api/config/test with loading state, success/error feedback
- [x] 10.7 Create `packages/frontend/src/components/settings/NotificationsTab.tsx` — 9 gates x 5 channels grid with toggle switches
- [x] 10.8 Create `packages/frontend/src/components/settings/ConnectorsTab.tsx` — 9 connector cards with status badges (Connected/Disconnected/Coming Soon)
- [x] 10.9 Create `packages/frontend/src/components/settings/ConnectorCard.tsx` — individual card with icon, name, description, status, test button
- [x] 10.10 Create `packages/frontend/src/components/settings/DisplaySettings.tsx` — theme toggle, diff mode, cache clear button
- [x] 10.11 Wire SettingsPage into App.tsx hash routing
- [x] 10.12 Verify Settings page loads config from GET /api/config, save works, test connection works for all services

## 11. React Diff Viewer

- [x] 11.1 Add `react-diff-view` + `unidiff` dependencies to `packages/frontend/package.json`
- [x] 11.2 Create `packages/frontend/src/components/review/DiffViewer.tsx` — main shell with split/unified toggle, file tree, diff area
- [x] 11.3 Create `packages/frontend/src/components/review/FileTree.tsx` — file list with add/modify/delete indicators, click to select
- [x] 11.4 Create `packages/frontend/src/components/review/DiffPane.tsx` — renders diff for selected file using react-diff-view
- [x] 11.5 Create `packages/frontend/src/components/review/DiffStatsBar.tsx` — shows +N -N additions/deletions, files changed
- [x] 11.6 Create `packages/frontend/src/components/review/InlineComment.tsx` — comment form that appears on line click (+), submit/cancel
- [x] 11.7 Create `packages/frontend/src/components/review/PlanTabs.tsx` — tab viewer for Proposal/Design/Specs/Tasks markdown content
- [x] 11.8 Create `packages/frontend/src/utils/diff.ts` — char-level highlighting utility for consecutive add/remove pairs
- [x] 11.9 Add `getReview` API endpoint to `packages/frontend/src/lib/api.ts`
- [x] 11.10 Wire DiffViewer into App.tsx hash routing under #/review
- [x] 11.11 Verify diff viewer loads data from GET /api/review, renders split/unified, file switching works

## 12. React Approval Forms

- [x] 12.1 Update `packages/frontend/src/components/GateApproval.tsx` — add button loading states, reject form modal, refine form modal
- [x] 12.2 Create `packages/frontend/src/components/approval/RejectForm.tsx` — textarea for rejection reason, submit → POST /api/reject
- [x] 12.3 Create `packages/frontend/src/components/approval/RefineForm.tsx` — textarea for refinement instructions, submit → POST /api/refine
- [x] 12.4 Verify approve/reject/refine flows work end-to-end with toast feedback

## 13. Rust SSE Optimizer

- [x] 13.1 Update `packages/native/sse-engine/Cargo.toml` — bump napi to v8+ with `napi8` feature
- [x] 13.2 Create `packages/native/sse-engine/src/event.rs` — SseEvent struct { id: u32, event_type: String, data: String }
- [x] 13.3 Create `packages/native/sse-engine/src/event_hub.rs` — TypedCircularBuffer<SseEvent> replacing StringCircularBuffer for typed replay
- [x] 13.4 Add AtomicU64 message ID counter with `next_id()` NAPI export
- [x] 13.5 Add `format_sse_frame(id, event, data) -> Vec<u8>` — pre-format SSE frame once
- [x] 13.6 Create `packages/native/sse-engine/src/registry.rs` — ClientRegistry with add/remove/query_backpressure, Arc<Mutex<HashMap>>
- [x] 13.7 Update `packages/native/sse-engine/src/lib.rs` — export SseEvent, TypedCircularBuffer, ClientRegistry, next_id, format_sse_frame
- [x] 13.8 Update `packages/native/fallback.js` — add JS implementations of new exports
- [x] 13.9 Update `packages/native/index.js` — add new exports to adapter
- [x] 13.10 Run `cargo test --all` in packages/native — all Rust tests pass
- [x] 13.11 Run `npm run build:native` — NAPI build succeeds
- [x] 13.12 Verify JS fallback works when native addon is absent

## 14. Integration & Verification

- [x] 14.1 Run full `npm run build` — shared, agent, backend, frontend all compile
- [x] 14.2 Run `npm run lint` — zero type errors across all packages
- [x] 14.3 Run `npm run test` — all existing tests pass (shared, backend, frontend)
- [x] 14.4 Start server with `npm run dev`, verify React UI loads at localhost:3000
- [x] 14.5 Navigate to #/settings — verify Settings page renders with config fields
- [x] 14.6 Navigate to #/review — verify Diff Viewer placeholder renders
- [x] 14.7 Run `npm run dev:legacy` — verify legacy shim delegates to packages/agent correctly
- [x] 14.8 Start a test pipeline with a mock ticket — verify all 12 stages execute with TS-converted code
- [x] 14.9 Verify SSE events stream correctly to React frontend
- [x] 14.10 Verify toast notifications appear on config save/test connection
