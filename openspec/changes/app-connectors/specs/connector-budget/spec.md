## ADDED Requirements

### Requirement: Connector content budget of 15 KB per item
The system SHALL enforce a 15 KB per-item budget for connector content. Each connector module's `summarize()` function SHALL produce output within this budget.

#### Scenario: Content within budget
- **WHEN** a connector module produces summarized content of 12 KB
- **THEN** the content is stored as-is in `connectorContents[]`

#### Scenario: Content exceeds budget
- **WHEN** a connector module produces content exceeding 15 KB
- **THEN** the content is truncated to 15 KB at the nearest paragraph/line boundary with a truncation notice appended

### Requirement: Connector content injected into analysis prompt
The system SHALL inject `connectorContents[]` into the `explore-plan.js` analysis prompt as a dedicated section, separate from `fetchedUrlContents` and `attachmentContents`. The section SHALL be labeled `## Connector Documents` and placed after the existing URL content section.

#### Scenario: Connector content present in ticket state
- **WHEN** `state.data.ticket.connectorContents` is non-empty during `explore-plan` stage
- **THEN** each item is rendered as `### <title> (source: <source>)\n<content>` in the analysis prompt under `## Connector Documents`

#### Scenario: No connector content
- **WHEN** `connectorContents` is empty or undefined
- **THEN** the `## Connector Documents` section is omitted from the prompt entirely

### Requirement: Connector content injected into developer prompt
The system SHALL inject `connectorContents[]` into the `generate-code/index.js` developer prompt, using the same format as the analysis prompt. Each item is individually capped at 15 KB (no per-item reduction like regular URLs).

#### Scenario: Developer prompt with connector content
- **WHEN** `connectorContents` is non-empty during code generation
- **THEN** each item appears in the developer context under `## Connector Documents`, individually capped at 15 KB

#### Scenario: Prompt truncation under token pressure
- **WHEN** the total prompt exceeds `MAX_PROMPT_TOKENS` and truncation is needed
- **THEN** connector content is truncated BEFORE code file content but AFTER regular URL content, preserving the most critical context (code) while reducing supplementary context (connectors) first

### Requirement: Total connector content cap
The system SHALL enforce a total connector content cap of 45 KB (3 items × 15 KB max). If more than 3 connector URLs are found, only the first 3 are processed; remaining URLs fall through to UNFETCHABLE handling.

#### Scenario: Ticket with 5 connector URLs
- **WHEN** a ticket contains 5 connector URLs
- **THEN** the first 3 are processed by connectors, and the remaining 2 are added to `authRequiredUrls` with a message "Connector limit reached — paste content manually"

#### Scenario: Ticket with 2 connector URLs
- **WHEN** a ticket contains 2 connector URLs
- **THEN** both are processed normally — no cap applied

### Requirement: Crash recovery for connector content
The system SHALL persist `connectorContents[]` in the state JSON file. On pipeline resume, if `connectorContents` is already populated, the fetch-ticket stage SHALL skip re-fetching connector URLs.

#### Scenario: Resume after crash with connector data
- **WHEN** the pipeline resumes and `state.data.ticket.connectorContents` contains entries
- **THEN** connector fetch is skipped — existing data is reused

#### Scenario: Resume after crash without connector data
- **WHEN** the pipeline resumes and `connectorContents` is empty or undefined
- **THEN** connector URLs are re-fetched normally
