// ═══════════════════════════════════════════════════════════════
// playground-runner.ts — Playground single-stage entry point
//
// Spawned as its own child process (mirrors run-agent.js/index.ts's
// per-ticket spawn pattern) but runs exactly ONE stage in isolation
// instead of looping the full STAGE_ORDER pipeline. Does not touch
// packages/agent/src/index.ts's main() at all — that entrypoint is
// deeply Jira/GitLab-ticket-specific (required token validation,
// state-<TICKET>.lock files, full stage loop) and unsuitable for an
// ad-hoc single-stage run.
//
// Reads config from env vars set by server/playground-process.ts:
//   PLAYGROUND_RUN_ID    — correlates this run's stdout back to an SSE runId
//   PLAYGROUND_STAGE     — which lite stage to run (e.g. "explore_plan")
//   PLAYGROUND_TICKET    — optional real ticket to borrow context from
//   PLAYGROUND_INSTRUCTION — optional custom instruction overriding the default prompt
//
// Progress is printed as plain stdout lines (captured by the parent via
// wrapProcessOutput and rebroadcast as `playground:log` SSE events). The
// final result is printed as a single `PLAYGROUND_RESULT:<json>` line so
// the parent can tell success from failure without a second IPC channel.
// ═══════════════════════════════════════════════════════════════

const { callClaude } = require('./lib/claude') as {
  callClaude: (prompt: string, timeoutMs?: number, opts?: Record<string, unknown>) => Promise<string>;
};
const { serverAPI } = require('./lib/state-migration') as {
  serverAPI: { getState: (ticket: string) => any };
};
const { ensureLocalRepo, createWorktree, removeWorktree, localGetChanges } = require('./lib/local-repo') as {
  ensureLocalRepo: () => Promise<string | null>;
  createWorktree: (id: string) => string;
  removeWorktree: (id: string) => void;
  localGetChanges: (clonePath: string) => Array<{ action: 'create' | 'update' | 'delete'; file_path: string; content: string }>;
};
const { jira } = require('./lib/jira') as {
  jira: { getIssue: (key: string) => Promise<any> };
};
const { adfToMarkdown } = require('./lib/adf') as {
  adfToMarkdown: (node: unknown) => string;
};

interface TicketContext {
  key?: string;
  summary?: string;
  description?: string;
  ac?: string;
  [key: string]: unknown;
}

/** Read-only clone of a real ticket's already-fetched context. Never writes back. */
function borrowTicketContext(contextTicket: string): TicketContext | null {
  try {
    const realState = serverAPI.getState(contextTicket);
    const ticket = realState?.data?.ticket;
    if (!ticket) {
      console.log(
        `[PLAYGROUND] No fetched ticket data found for ${contextTicket} — it may not have run "Fetch Ticket" yet. Proceeding without ticket context.`,
      );
      return null;
    }
    // Deep clone so nothing here can accidentally mutate the real ticket's in-memory state.
    const cloned = JSON.parse(JSON.stringify(ticket)) as TicketContext;
    console.log(`[PLAYGROUND] Borrowed ticket context from ${contextTicket}: ${cloned.summary || '(no summary)'}`);
    return cloned;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[PLAYGROUND] Could not read state for ${contextTicket}: ${msg} — proceeding without ticket context.`);
    return null;
  }
}

/**
 * Lite `fetch_ticket`: a single real (read-only) Jira GET — no preflight
 * checks (existing-branch/existing-MR probes against GitLab), no comments/
 * linked-issues/attachments/connector fetching, and no state write. Just
 * enough to show what the real stage would see as its starting context.
 */
async function runFetchTicketLite(ticketKey: string): Promise<string> {
  console.log(`[PLAYGROUND] Fetching Jira ticket ${ticketKey}...`);
  const issue = await jira.getIssue(ticketKey);
  const summary: string = issue.fields?.summary || '(No summary)';
  const description: string = issue.fields?.description ? adfToMarkdown(issue.fields.description) : '';
  const issueType: string = issue.fields?.issuetype?.name || 'Task';
  const priority: string = issue.fields?.priority?.name || 'Medium';

  console.log(`[PLAYGROUND] Fetched: [${issueType}/${priority}] ${summary}`);
  if (description) {
    console.log(`[PLAYGROUND] Description: ${description.substring(0, 200).replace(/\n/g, ' ')}${description.length > 200 ? '…' : ''}`);
  }
  console.log('[PLAYGROUND] Read-only fetch — no state was written, no branch/MR preflight checks were run.');

  return `[${issueType}/${priority}] ${summary}`;
}

/**
 * Lite `explore_plan`: a single Claude call producing an implementation
 * plan, with no multi-agent team, no worktree, no OpenSpec artifacts, and
 * no approval-polling loop (unlike the real `stageExplorePlan`). This
 * matches the Phase 2 scope: "no git writes, no deploys — just Jira read
 * and Claude call."
 */
async function runExplorePlanLite(ticketContext: TicketContext | null, customInstruction: string): Promise<string> {
  const promptParts: string[] = [];
  if (ticketContext) {
    promptParts.push(`Ticket: ${ticketContext.key ?? '(unknown)'} — ${ticketContext.summary ?? '(no summary)'}`);
    if (ticketContext.description) promptParts.push(`Description:\n${ticketContext.description}`);
    if (ticketContext.ac) promptParts.push(`Acceptance Criteria:\n${ticketContext.ac}`);
  } else {
    promptParts.push('No specific ticket context was provided for this Playground run.');
  }
  if (customInstruction) {
    promptParts.push(`Custom instruction for this run (overrides the default focus):\n${customInstruction}`);
  }
  promptParts.push(
    'Produce a concise implementation plan (bullet points, no preamble) for the above. ' +
    'This is a Playground/sandbox run — do not reference or assume any real merge request, deployment, or notification.',
  );

  const prompt = promptParts.join('\n\n');
  console.log('[PLAYGROUND] Calling Claude (explore_plan, single call)...');
  const plan = await callClaude(prompt, 120_000, { agentName: 'playground-explore-plan', maxTurns: 3, retry: false });
  console.log(`[PLAYGROUND] Claude responded (${plan.length} chars)`);
  return plan;
}

/**
 * Lite `generate_code`: ONE real Claude call with file-editing tools, scoped
 * to a throwaway ephemeral worktree — not the real multi-agent team
 * (developer/reviewer/fixer/build-check/browser-verify/runtime-tests).
 * After Claude edits files, the diff is computed and logged, then a
 * "SIMULATED — would create MR" line is printed. `push-code.ts`'s
 * `pushCodeToGitLab` (real GitLab/Slack calls) is never invoked — this
 * function has no path to it at all, so there is nothing to accidentally
 * leave "on" in production. The worktree is always removed in `finally`,
 * whether Claude succeeds, fails, or throws.
 */
async function runGenerateCodeLite(ticketContext: TicketContext | null, customInstruction: string, playgroundId: string): Promise<string> {
  console.log('[PLAYGROUND] Setting up ephemeral worktree...');
  await ensureLocalRepo();
  const worktreePath = createWorktree(playgroundId);
  console.log(`[PLAYGROUND] Worktree ready: ${worktreePath}`);

  try {
    const promptParts: string[] = [];
    if (ticketContext) {
      promptParts.push(`Ticket: ${ticketContext.key ?? '(unknown)'} — ${ticketContext.summary ?? '(no summary)'}`);
      if (ticketContext.description) promptParts.push(`Description:\n${ticketContext.description}`);
      if (ticketContext.ac) promptParts.push(`Acceptance Criteria:\n${ticketContext.ac}`);
    } else {
      promptParts.push('No specific ticket context was provided for this Playground run.');
    }
    if (customInstruction) {
      promptParts.push(`Custom instruction for this run (overrides the default focus):\n${customInstruction}`);
    } else {
      promptParts.push('No custom instruction was given — make a small, clearly-scoped illustrative change so the resulting diff is easy to review.');
    }
    promptParts.push(
      'Implement this change directly in the current working directory using the Read/Write/Edit tools. ' +
      'Keep the change small and focused. This is a Playground/sandbox run against a throwaway worktree — ' +
      'nothing you do here will be committed, pushed, deployed, or merged, so do not attempt to run git commands yourself.',
    );
    const prompt = promptParts.join('\n\n');

    console.log('[PLAYGROUND] Calling Claude (generate_code, single call)...');
    await callClaude(prompt, 600_000, {
      agentName: 'playground-generate-code',
      cwd: worktreePath,
      maxTurns: 15,
      allowedTools: ['Read', 'Write', 'Edit', 'Grep', 'Glob'],
      retry: false,
    });
    console.log('[PLAYGROUND] Claude finished editing');

    const changes = localGetChanges(worktreePath);
    if (changes.length === 0) {
      console.log('[PLAYGROUND] No files were changed.');
    } else {
      console.log(`[PLAYGROUND] ${changes.length} file(s) changed:`);
      for (const c of changes) {
        console.log(`[PLAYGROUND]   ${c.action.toUpperCase()} ${c.file_path}`);
      }
    }

    const summary = changes.length > 0
      ? `${changes.length} file(s) changed — ${changes.map((c) => `${c.action} ${c.file_path}`).join(', ')}`
      : 'No files changed';
    console.log(`[PLAYGROUND] SIMULATED — would create MR: "${summary}". No real GitLab branch, MR, or Slack notification was performed.`);

    return summary;
  } finally {
    try {
      removeWorktree(playgroundId);
      console.log('[PLAYGROUND] Ephemeral worktree removed');
    } catch (e: unknown) {
      console.log(`[PLAYGROUND] Worktree cleanup warning: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function main(): Promise<void> {
  const runId = process.env.PLAYGROUND_RUN_ID || '';
  const stage = process.env.PLAYGROUND_STAGE || '';
  const contextTicket = (process.env.PLAYGROUND_TICKET || '').trim();
  const customInstruction = (process.env.PLAYGROUND_INSTRUCTION || '').trim();

  console.log(`[PLAYGROUND] Starting run ${runId} for stage "${stage}"${contextTicket ? ` (context: ${contextTicket})` : ''}`);

  // `fetch_ticket` IS the stage that does the fetching — PLAYGROUND_TICKET
  // means "which real ticket to fetch live from Jira" there, not "borrow
  // this ticket's already-fetched data" (which is what it means for every
  // other stage).
  const ticketContext = (stage !== 'fetch_ticket' && contextTicket) ? borrowTicketContext(contextTicket) : null;

  try {
    let summary: string;
    switch (stage) {
      case 'fetch_ticket':
        if (!contextTicket) throw new Error('A ticket is required to run Fetch Ticket in the Playground');
        summary = await runFetchTicketLite(contextTicket);
        break;
      case 'explore_plan':
        summary = await runExplorePlanLite(ticketContext, customInstruction);
        break;
      case 'generate_code':
        summary = await runGenerateCodeLite(ticketContext, customInstruction, runId);
        break;
      default:
        throw new Error(`Stage "${stage}" is not yet wired for real execution in the Playground`);
    }
    console.log(`PLAYGROUND_RESULT:${JSON.stringify({ ok: true, summary })}`);
    process.exit(0);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`PLAYGROUND_RESULT:${JSON.stringify({ ok: false, error: msg })}`);
    process.exit(1);
  }
}

main();
