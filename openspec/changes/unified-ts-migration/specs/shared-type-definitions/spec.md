# Shared Type Definitions Spec

## Domain: packages/shared/src/types/

## Status: ADDED

## Overview
Complete TypeScript type definitions covering all 28 domains used across the MI Dev Agent pipeline.
Approximately 160 types spread across 15+ type files (~2,500 LOC).

## Requirements

### ADDED: Type Domain Availability
- WHEN importing from `@shared/types` THEN all 28 type domains are available including: jira, gitlab, adf, tickets, codegen, http, state, connectors, sse, slack, process, approval, logging, metrics, config, notifications, ui, diff, review, pipeline, gates, deploy, qa, ci, docker, routing, toast, and modal.
- WHEN a consumer imports a single domain THEN only that domain's types are included (tree-shakeable barrel exports).

### ADDED: PipelineData Composite Type
- WHEN `PipelineData` is used THEN it is a domain-split intersection type: `TicketData & CodeGenData & GateData & MetricsData & UIStateData`.
- WHEN a stage reads `state.data` THEN it receives the full `PipelineData` type with compile-time field access validation.
- WHEN a new domain is added THEN it extends `PipelineData` via intersection without modifying existing domain types.

### ADDED: Jira API Types
- WHEN Jira API responses are received THEN they match `JiraIssue`, `JiraComment`, `JiraAttachment`, `JiraTransition` types.
- WHEN a Jira issue is fetched THEN `JiraIssue` contains `key`, `fields`, `changelog`, and `renderedFields` with correct nesting.
- WHEN Jira transitions are listed THEN each `JiraTransition` has `id`, `name`, `to.statusCategory` typed fields.
- WHEN Jira attachments are downloaded THEN `JiraAttachment` provides `filename`, `mimeType`, `content` (URL string), and `size` (number).

### ADDED: GitLab API Types
- WHEN GitLab API responses are received THEN they match `GitLabMergeRequest`, `GitLabDiff`, `GitLabCommitAction` types.
- WHEN a merge request is created THEN `GitLabMergeRequest` includes `iid`, `web_url`, `source_branch`, `target_branch`, `state`, `merge_status`.
- WHEN commit actions are sent THEN `GitLabCommitAction` has a discriminated `action` field: `"create" | "update" | "delete" | "move"`.
- WHEN diffs are fetched THEN `GitLabDiff` includes `old_path`, `new_path`, `diff` (unified diff string), `new_file`, `deleted_file`.

### ADDED: ADF Node Types
- WHEN ADF nodes are parsed THEN they match the `AdfNode` discriminated union type keyed on `type` field.
- WHEN an ADF node has `type: "paragraph"` THEN its `content` is typed as `AdfInlineNode[]`.
- WHEN an ADF node has `type: "mediaSingle"` THEN its `attrs` includes `layout` and `width`.
- WHEN walking the ADF tree THEN recursive `AdfNode` children are type-safe without casting.

### ADDED: Connector and Config Types
- WHEN connector status is checked THEN `ConnectorStatus` is `"connected" | "disconnected" | "coming-soon"`.
- WHEN config fields are loaded THEN `ConfigField` has `key`, `label`, `value`, `sensitive` (boolean), `service` (grouping key).
- WHEN notification config is loaded THEN `NotificationConfig` maps 9 gate names to 5 channel booleans.
