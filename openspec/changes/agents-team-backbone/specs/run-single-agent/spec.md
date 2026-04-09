# Spec: runSingleAgent Wrapper + Output Validation

## Capability: ADDED — `runSingleAgent()` in `lib/agents-team.js`

### WHEN `runSingleAgent` is called with valid arguments
THEN it delegates to `runAgentsTeam` with a single-agent team
AND returns the agent's output string on success
AND returns null if `required: false` and agent fails

### WHEN `runSingleAgent` is called with `checkpointKey` and the key exists in state
THEN it returns the cached value immediately without calling `callClaude`
AND logs "[AgentName] Skipped (checkpoint: key)"

### WHEN `runSingleAgent` is called with `checkpointKey` and the key does NOT exist in state
THEN it calls `callClaude` with the provided prompt, timeout, and opts
AND on success: saves output to `state.data[checkpointKey]`
AND on failure with `required: true`: throws error
AND on failure with `required: false`: returns null (does NOT checkpoint)

### WHEN `runSingleAgent` is called
THEN `state.data._active_agents` is set to `[agentName]` before execution
AND `state.data._active_agents` is cleared to `[]` after execution (success or failure)
AND `save(state)` is called after both set and clear

### WHEN `runSingleAgent` is called
THEN it logs `[AgentName] Starting… (timeout: Xs)` before execution
AND it logs `[AgentName] Complete (Xs, N chars)` after success
AND it logs `[AgentName] Failed: <error>` after failure

## Capability: MODIFIED — Output Validation in `runAgentsTeam` Phase 2

### WHEN an agent in `runAgentsTeam` returns output
THEN `validateClaudeNotEmpty(output, agent.name)` is called
AND `detectClaudeRefusal(output, agent.name)` is called
AND validation happens BEFORE checkpointing (invalid output is never cached)

### WHEN validation fails (empty or refusal)
THEN the agent is treated as "rejected"
AND if `required: true`: the team throws after all agents settle
AND if `required: false`: the agent result is `{ status: "rejected", output: null }`

### WHEN validation passes
THEN the agent output is checkpointed to `state.data[agent.checkpointKey]`
AND the agent result is `{ status: "fulfilled", output: validatedOutput }`

## Capability: MODIFIED — `runAgentsTeam` export

### WHEN `lib/agents-team.js` is required
THEN it exports both `runAgentsTeam` and `runSingleAgent`
AND existing callers of `runAgentsTeam` continue to work unchanged
