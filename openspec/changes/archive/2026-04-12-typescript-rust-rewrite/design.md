## Context

MI Dev Agent: 48 JS files, ~18K LOC, CommonJS, zero npm deps, Node.js http/https. Automates Jira → Claude Code Gen → GitLab MR → QA → Production. Runs unattended for hours against internal GitLab (10.200.11.32) prone to ECONNRESET.

Three rounds of exploration with 15 parallel research agents produced:
- Complete Rust crate designs with working code
- File-by-file migration map (48 files → 4 packages)
- Anthropic API tool executor with security sandbox
- Full test strategy (5 layers) + Docker + CI/CD
- All 14 resilience patterns mapped to new architecture

## Goals / Non-Goals

**Goals:**
- Type-safe pipeline with compile-time guarantees (TS strict + Rust enums)
- Rust native addons for safety-critical paths (HMAC, locks, circuit breaker, buffers)
- React frontend eliminating all 7 html.js gaps by design
- Anthropic API replacing Claude CLI (enables Docker/cloud)
- 100% resilience pattern coverage (14/14 modules mapped)
- Backward-compatible state files (old JS can still read)

**Non-Goals:**
- Changing the 11-stage pipeline architecture
- Changing SSE wire protocol or HTTP route signatures
- Adding external databases (keep JSON state files)
- Rewriting everything at once (phased migration)

## Decisions

### D1: Monorepo Structure — packages/ Layout

```
packages/
├── native/          # Rust crates (napi-rs)
│   ├── http-engine/ # CircuitBreaker, retry, dedup, rate limiter
│   ├── state-engine/# HMAC, FileLock, atomic write, CAS
│   └── sse-engine/  # CircularBuffer, broadcast
├── backend/         # TypeScript (Node.js server + pipeline)
│   └── src/
│       ├── pipeline/    # Stage handlers, runner, recovery
│       ├── services/    # claude, jira, gitlab, slack
│       ├── agents/      # developer, reviewer, fixer, tool-executor
│       ├── server/      # HTTP, routes, SSE wrapper
│       ├── state/       # State API, manager, IO
│       ├── config/      # Loader, validator, snapshot
│       └── lib/         # Utils, logger, redaction
├── frontend/        # React + Vite + Zustand
│   └── src/
│       ├── components/  # UI components
│       ├── hooks/       # useSSE, usePolling, etc.
│       └── store/       # Zustand stores
└── shared/          # Types + Zod schemas + constants
    └── src/
        ├── types/       # PipelineState, StageName, Config
        └── schema/      # Zod validation schemas
```

**Why not flat**: 48 files in one directory is already hard to navigate. Packages enforce dependency boundaries.

### D2: Rust for Correctness, Not Performance

**Choice**: Use Rust for modules where compile-time guarantees prevent bugs that TypeScript cannot catch.

| Module | Rust Guarantee | TS Alternative (Weaker) |
|--------|---------------|------------------------|
| CircuitBreaker | Enum exhaustive match — impossible to forget a state | String comparison, easy to miss |
| HMAC | ring = constant-time by default | crypto.timingSafeEqual works but easy to misuse |
| FileLock | Drop trait = lock ALWAYS released | try/finally can be forgotten |
| CircularBuffer | Borrow checker = no use-after-free | Array.shift() is O(n) |
| AtomicWrite | fsync+rename atomicity, fd leak via Drop | fd=-1 guard (current JS) works but fragile |

**Why not pure TS**: The 10 remaining JS gaps are exactly in these safety-critical paths. Rust eliminates them at compile time.

**JS Fallback**: If Rust addon fails to load (wrong platform, missing build), fall back to JS implementations. Log WARNING.

### D3: Anthropic API — Direct HTTPS, No SDK

**Choice**: Use native Node.js https module to call api.anthropic.com directly. No @anthropic-ai/sdk dependency.

**Why**: Consistent with existing zero-dependency philosophy. The API is simple (POST /v1/messages + tool_use loop).

**Tool Executor**: 7 tools (read_file, write_file, edit_file, bash, glob, grep, list_dir) with security sandbox:
- Path validation (realpath + bounds check)
- Bash whitelist (npm, git read-only, grep)
- Output limits (2MB stdout, 1MB stderr)
- Symlink escape prevention

**Drop-in replacement**: `callClaude()` signature unchanged. agents-team.js needs zero modifications.

### D4: React + Zustand — Eliminates All Frontend Gaps

**Choice**: Vite + React + Zustand replaces 6,000-line html.js monolith.

| html.js Gap | React Solution |
|-------------|---------------|
| 8 setInterval without cleanup | useEffect cleanup in every hook |
| 2 duplicate visibilitychange | Single useVisibility hook |
| showConfirmDialog null checks | TypeScript strict null checks |
| No ticket validation | Zod schema on TicketForm |
| formDrafts no size/expiry | useDraft hook with TTL logic |
| Timer leaks across tabs | useTimer hook with pause/resume |
| No leader election cleanup | useLeaderElection hook with BroadcastChannel |

### D5: Phased Migration — Old JS Runs Until New TS Validated

**Choice**: Keep old JS files during migration. New TS files live in packages/. Switch over per-module after testing.

**Why not big-bang**: A single switchover of 48 files is too risky. Phase-by-phase allows validation.

**State compatibility**: New TS reads/writes same state-*.json format. HMAC secret (.state-secret) shared.

### D6: Testing — 5 Layers

| Layer | Tool | Coverage Target |
|-------|------|----------------|
| Rust unit | cargo test | 85%+ |
| TS unit | vitest | 80%+ |
| React component | vitest + RTL | 80%+ |
| Integration | vitest (mocked services) | Key paths |
| E2E | Playwright | UI flows |

## Risks / Trade-offs

- **[Rust build complexity]** → napi-rs requires Rust toolchain on build machine. Mitigation: JS fallback if addon missing.
- **[Anthropic API cost]** → CLI is free (Claude Code subscription). API is pay-per-token. Mitigation: same model, same token usage.
- **[6-week timeline]** → Ambitious for one developer. Mitigation: Phase-by-phase, parallel agent implementation.
- **[State file compatibility]** → Must read old V2/V3 envelopes. Mitigation: envelope.rs handles both formats.
- **[React adds build step]** → Current html.js needs no build. Mitigation: Vite dev server + production build.
