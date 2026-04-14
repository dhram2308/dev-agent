## ADDED Requirements

### Requirement: Create per-ticket detached-HEAD worktree
The system SHALL create an isolated git worktree for each ticket before spawning `run-agent.js`. The worktree SHALL be created using `git worktree add --detach <path> <sha>` where `<sha>` is `origin/enterprise-ts` HEAD. The worktree path SHALL be `.repo-cache/.worktrees/{TICKET}/`.

#### Scenario: First ticket starts
- **WHEN** `startAgent("AUT-8203")` is called and no worktree exists for AUT-8203
- **THEN** system runs `git worktree add --detach .repo-cache/.worktrees/AUT-8203 <sha>`
- **THEN** system passes `WORKTREE_PATH=.repo-cache/.worktrees/AUT-8203` as env var to the spawned `run-agent.js` process

#### Scenario: Three tickets running simultaneously
- **WHEN** AUT-8203, AUT-8343, and AUT-834 are all started
- **THEN** three independent worktrees exist at `.repo-cache/.worktrees/AUT-8203/`, `.repo-cache/.worktrees/AUT-8343/`, `.repo-cache/.worktrees/AUT-834/`
- **THEN** each has a detached HEAD at the `origin/enterprise-ts` commit (no branch checkout conflicts)

#### Scenario: Worktree already exists for ticket (restart after crash)
- **WHEN** `startAgent("AUT-8203")` is called and `.repo-cache/.worktrees/AUT-8203/` already exists
- **THEN** system resets the existing worktree (`git checkout -f . && git clean -fd`) instead of creating a new one

### Requirement: Agent uses worktree path as local repo
The `run-agent.js` process SHALL read `WORKTREE_PATH` from environment and set `cfg.localRepo` to that path. If `WORKTREE_PATH` is not set (standalone mode), it SHALL fall back to `ensureLocalRepo()` as before.

#### Scenario: Agent started with WORKTREE_PATH
- **WHEN** `run-agent.js` starts with `WORKTREE_PATH=/path/to/.repo-cache/.worktrees/AUT-8203`
- **THEN** `cfg.localRepo` is set to `/path/to/.repo-cache/.worktrees/AUT-8203`
- **THEN** all Claude agent `cwd`, `localGetChanges()`, `localResetRepo()`, and build/test commands use this path

#### Scenario: Agent started without WORKTREE_PATH (backward compat)
- **WHEN** `run-agent.js` starts without `WORKTREE_PATH` env var
- **THEN** `cfg.localRepo` is set via `ensureLocalRepo()` (existing behavior, returns `.repo-cache/`)

### Requirement: localResetRepo works in worktree context
`localResetRepo(clonePath)` SHALL use `git checkout -f .` (revert all files to HEAD) instead of `git checkout -f enterprise-ts` (branch checkout). This SHALL work in both worktree and non-worktree contexts.

#### Scenario: Reset inside a detached-HEAD worktree
- **WHEN** `localResetRepo("/path/.worktrees/AUT-8203")` is called
- **THEN** system runs `git -C /path/.worktrees/AUT-8203 checkout -f .`
- **THEN** system runs `git -C /path/.worktrees/AUT-8203 clean -fd -e .env -e .env.* -e .api-token -e .state-secret -e .debug`
- **THEN** all modified files are reverted to the detached HEAD commit (which equals enterprise-ts)

#### Scenario: Reset inside main clone (non-worktree, backward compat)
- **WHEN** `localResetRepo("/path/.repo-cache")` is called on the main clone
- **THEN** `git checkout -f .` reverts all modifications to HEAD (enterprise-ts branch)
- **THEN** behavior is identical to the previous `git checkout -f enterprise-ts`

### Requirement: Remove worktree on agent exit
The system SHALL remove the worktree directory when the agent process exits (normal completion or crash).

#### Scenario: Agent completes successfully
- **WHEN** `run-agent.js` for AUT-8203 exits with code 0
- **THEN** system runs `git -C .repo-cache worktree remove .worktrees/AUT-8203 --force`
- **THEN** `.repo-cache/.worktrees/AUT-8203/` no longer exists

#### Scenario: Agent crashes (non-zero exit)
- **WHEN** `run-agent.js` for AUT-8203 exits with non-zero code
- **THEN** system still runs `git worktree remove --force` for that ticket's worktree
- **THEN** worktree is cleaned up regardless of exit code

#### Scenario: Worktree removal fails
- **WHEN** `git worktree remove --force` fails (e.g., permissions, corrupted .git)
- **THEN** system falls back to `rm -rf .repo-cache/.worktrees/AUT-8203/` followed by `git worktree prune`

### Requirement: Clean orphaned worktrees on server startup
The system SHALL scan `.repo-cache/.worktrees/` on startup and remove any worktrees whose owning agent process is no longer alive.

#### Scenario: Server restarts after crash with orphaned worktrees
- **WHEN** server starts and `.repo-cache/.worktrees/AUT-8203/` exists but no agent process is running for AUT-8203
- **THEN** system removes the orphaned worktree
- **THEN** system runs `git worktree prune` to clean up git's internal tracking

#### Scenario: Server restarts with a surviving agent process
- **WHEN** server starts and `.repo-cache/.worktrees/AUT-8203/` exists and `state-AUT-8203.lock` holds a live PID
- **THEN** system does NOT remove that worktree

### Requirement: Clean worktrees on graceful shutdown
The system SHALL register a shutdown hook that removes all active worktrees during graceful shutdown (SIGTERM/SIGINT).

#### Scenario: Server receives SIGTERM with 2 active worktrees
- **WHEN** server receives SIGTERM and worktrees exist for AUT-8203 and AUT-8343
- **THEN** shutdown hook removes both worktrees (after child processes are killed in an earlier phase)
- **THEN** `git worktree prune` runs to clean up git metadata

### Requirement: ensureLocalRepo skips hard reset when worktrees active
`ensureLocalRepo()` SHALL run `git fetch` but SHALL NOT run `git reset --hard` when active worktrees exist in `.repo-cache/.worktrees/`.

#### Scenario: Fetch with active worktrees
- **WHEN** `ensureLocalRepo()` is called and 2 worktrees are active
- **THEN** system runs `git fetch origin enterprise-ts` to update refs
- **THEN** system does NOT run `git reset --hard origin/enterprise-ts`
- **THEN** new worktrees created after this fetch use the latest `origin/enterprise-ts` SHA

#### Scenario: Fetch with no active worktrees
- **WHEN** `ensureLocalRepo()` is called and `.repo-cache/.worktrees/` is empty or does not exist
- **THEN** system runs `git fetch origin enterprise-ts` AND `git reset --hard origin/enterprise-ts` (existing behavior)

### Requirement: Disk space check before worktree creation
The system SHALL check available disk space before creating a worktree and refuse to create if below threshold.

#### Scenario: Insufficient disk space
- **WHEN** `createWorktree("AUT-8203")` is called and available disk space is less than 1GB
- **THEN** system returns an error: "Insufficient disk space for worktree (need 1GB, have Xmb)"
- **THEN** `startAgent()` returns `{ ok: false, error: "..." }`
