## ADDED Requirements

### Requirement: GET /api/tickets returns overview of all active tickets
The server SHALL expose a `GET /api/tickets` endpoint that returns a lightweight overview of all tickets that have running agents OR have state files on disk.

#### Scenario: Two agents running, one completed ticket on disk
- **WHEN** client calls `GET /api/tickets?token=xxx`
- **THEN** response is:
```json
{
  "ok": true,
  "tickets": [
    {
      "ticket": "AUT-8203",
      "stage": "generate_code",
      "running": true,
      "activeAgents": ["Dev Agent 1", "Dev Agent 2"],
      "startedAt": "2026-04-10T10:00:00Z",
      "needsApproval": false,
      "progress": 0.27
    },
    {
      "ticket": "AUT-8343",
      "stage": "gate_code_review",
      "running": true,
      "activeAgents": [],
      "startedAt": "2026-04-10T09:30:00Z",
      "needsApproval": true,
      "progress": 0.36
    }
  ]
}
```

#### Scenario: No agents running
- **WHEN** client calls `GET /api/tickets` and no agents are in `agentProcs`
- **THEN** response is `{ "ok": true, "tickets": [] }`

### Requirement: Ticket progress calculation
Each ticket in the `/api/tickets` response SHALL include a `progress` field (0.0 to 1.0) calculated as the index of the current stage divided by the total number of stages.

#### Scenario: Ticket at generate_code stage
- **WHEN** ticket is at `generate_code` (index 2 in STAGES array of 11)
- **THEN** `progress` is approximately `2 / 11 = 0.18`

#### Scenario: Ticket at done stage
- **WHEN** ticket is at `done` (index 10 in STAGES array of 11)
- **THEN** `progress` is approximately `10 / 11 = 0.91`

### Requirement: Gate detection in ticket overview
Each ticket SHALL include a `needsApproval` boolean that is `true` when the ticket's current stage is a gate stage (`gate_code_review`, `gate_preprod_approval`, `gate_dual_approval`, or `explore_plan` when plan is posted).

#### Scenario: Ticket at gate_code_review
- **WHEN** ticket's stage is `gate_code_review`
- **THEN** `needsApproval` is `true`

#### Scenario: Ticket at generate_code
- **WHEN** ticket's stage is `generate_code`
- **THEN** `needsApproval` is `false`

### Requirement: Active agents in ticket overview
Each ticket SHALL include an `activeAgents` array read from `state.data._active_agents` in the ticket's state file.

#### Scenario: Ticket with 3 parallel agents running
- **WHEN** `state-AUT-8203.json` contains `data._active_agents: ["Requirements Agent", "Explorer Agent", "Risk Agent"]`
- **THEN** ticket entry has `activeAgents: ["Requirements Agent", "Explorer Agent", "Risk Agent"]`

#### Scenario: Ticket between agent runs
- **WHEN** `state-AUT-8203.json` contains `data._active_agents: []` or field is absent
- **THEN** ticket entry has `activeAgents: []`

### Requirement: /api/tickets requires authentication
The `/api/tickets` endpoint SHALL require the same auth token as all other API endpoints.

#### Scenario: Unauthenticated request
- **WHEN** client calls `GET /api/tickets` without a valid token
- **THEN** response is `401 Unauthorized`
