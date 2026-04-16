## ADDED Requirements

### Requirement: Exit-code-78 sentinel from agent child

The agent child process SHALL, on encountering an HTTP 401 from an OAuth-backed provider that cannot be self-healed from within the child, write `{ provider, timestamp }` to `state.data._authFailure` and invoke `process.exit(78)`.

#### Scenario: Agent hits 401 from GitLab mid-pipeline

- **WHEN** the agent is running `stages/push-code.ts` and GitLab returns HTTP 401
- **AND** the GitLab connector is in OAuth mode
- **THEN** the agent SHALL persist `state.data._authFailure = { provider: 'gitlab', ts: <now> }` via the existing `state-unified.ts` API
- **AND** the agent SHALL call `process.exit(78)` instead of throwing

#### Scenario: Agent hits 401 from PAT-mode connector

- **WHEN** the agent hits 401 from Jira (PAT mode)
- **THEN** the agent SHALL use the existing escalation path (Slack alert + Jira comment)
- **AND** SHALL NOT use exit-code 78 (PAT-mode cannot be auto-refreshed)

### Requirement: Parent detects exit-78 and refreshes

The parent backend SHALL monitor agent-child exit codes. On observing exit 78, it SHALL read `state.data._authFailure.provider`, invoke `TokenManager.refresh(provider)`, and respawn the agent from the last completed checkpoint in `state-unified.ts`.

#### Scenario: Exit-78 triggers refresh and respawn

- **WHEN** the parent observes the child exit with code 78
- **AND** `state.data._authFailure.provider === 'gitlab'`
- **THEN** the parent SHALL call `TokenManager.refresh('gitlab')` and wait for completion
- **AND** on successful refresh, the parent SHALL respawn the agent with fresh `GITLAB_OAUTH_ACCESS_TOKEN` injected into the env
- **AND** the respawned agent SHALL resume from the last checkpoint (same pipeline stage)

#### Scenario: Refresh also fails

- **WHEN** exit-78 is observed and `TokenManager.refresh(provider)` fails with terminal error
- **THEN** the parent SHALL transition the pipeline to `PAUSED_AUTH_REQUIRED`
- **AND** SHALL broadcast SSE `{ type: 'authRequired', provider, reason: 'refresh-failed' }`
- **AND** SHALL NOT respawn the agent until re-auth completes

### Requirement: Respawn cap per pipeline run

The parent SHALL cap exit-78 respawns at 3 per provider per pipeline run. After the cap is reached, the pipeline SHALL transition to `FAILED` with reason `auth-respawn-exhausted`.

#### Scenario: Respawn counter increments

- **WHEN** a child exits with code 78 and the parent respawns
- **THEN** `state.data._authRespawnCount[provider]` SHALL be incremented by 1

#### Scenario: Respawn cap triggers failure

- **WHEN** `_authRespawnCount[provider]` reaches 3 and another exit-78 is observed
- **THEN** the pipeline SHALL transition to `FAILED`
- **AND** the error message SHALL indicate "auth refresh loop exhausted for <provider>"

### Requirement: PAUSED_AUTH_REQUIRED pipeline phase

The `state-unified.ts` phase enum SHALL include `PAUSED_AUTH_REQUIRED` alongside existing paused phases. While in this phase, the pipeline SHALL preserve all completed work and wait for a re-authorization event.

#### Scenario: Transition into PAUSED_AUTH_REQUIRED

- **WHEN** `TokenManager.refresh(provider)` fails with `invalid_grant` or the parent exhausts respawns
- **THEN** the pipeline phase SHALL be set to `PAUSED_AUTH_REQUIRED`
- **AND** `state.data._authFailure` SHALL retain the failure details

#### Scenario: Transition out of PAUSED_AUTH_REQUIRED

- **WHEN** the user completes re-authorization via the UI and `CredentialStore.set(provider, ...)` is called
- **AND** a subsequent `TokenManager.getAccessToken(provider)` succeeds
- **THEN** the parent SHALL restore the pipeline phase to the phase recorded at pause time
- **AND** SHALL respawn the agent
- **AND** SHALL clear `state.data._authFailure`

### Requirement: Pipeline auth timeout

A pipeline in `PAUSED_AUTH_REQUIRED` SHALL transition to `FAILED` after `AUTH_TIMEOUT_MIN` minutes (default 120) without re-authorization.

#### Scenario: Timeout elapses

- **WHEN** the pipeline has been in `PAUSED_AUTH_REQUIRED` for `AUTH_TIMEOUT_MIN` minutes
- **THEN** the phase SHALL transition to `FAILED`
- **AND** the error SHALL reference the provider that required re-auth

#### Scenario: User re-auths just before timeout

- **WHEN** the user re-auths 5 seconds before the timeout
- **AND** the new access token is obtained
- **THEN** the pipeline SHALL resume normally without hitting the timeout

### Requirement: SSE authRequired event

The parent SHALL broadcast SSE `{ type: 'authRequired', provider, reason, state, timestamp }` whenever a pipeline enters `PAUSED_AUTH_REQUIRED`. The UI SHALL display a blocking modal or banner prompting re-auth.

#### Scenario: SSE event fires on pause

- **WHEN** a pipeline enters `PAUSED_AUTH_REQUIRED`
- **THEN** an SSE event SHALL be emitted within 1 second
- **AND** the event payload SHALL include `provider`, `reason` (`refresh-failed` | `respawn-exhausted` | `revoked`), and a machine-readable `authorizeUrl` the UI can open

### Requirement: PAT-mode pipelines use existing escalation

Pipelines using connectors in PAT mode SHALL continue to use the existing escalation path (Slack alert + Jira comment + banner) for 401s, because PAT mode has no automatic refresh.

#### Scenario: PAT-mode Jira 401

- **WHEN** a Jira API call returns 401 and the Jira connector is in PAT mode
- **THEN** the pipeline SHALL use the existing `lib/escalation.ts` flow
- **AND** SHALL NOT enter `PAUSED_AUTH_REQUIRED` (that state is OAuth-specific)
