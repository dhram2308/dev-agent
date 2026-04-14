// =====================================================================
// MI Dev Agent -- Build Check Agent (TypeScript port)
// =====================================================================
// Q5: Build verification -- tsc + eslint + Build Fixer Agent.
//
// Steps:
//   1. Ensure node_modules exists (npm install)
//   2. Run tsc --noEmit
//   3. Run eslint on changed files
//   4. If errors: pass to Fixer Agent for one attempt
//
// Ported from: stages/generate-code/build-check.js
// =====================================================================

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { PipelineState } from '@shared/types';
import { logInfo, logOk, logWarn } from '../lib/logger';

// ── Types ────────────────────────────────────────────────────────────

/** A single file change */
export interface FileChange {
  action: string;
  file_path: string;
  content?: string;
}

/** Build error entry */
interface BuildError {
  type: 'typescript' | 'eslint';
  output: string;
}

/** Dependencies for the build check */
export interface BuildCheckDeps {
  cfg: {
    localRepo: string;
  };
  /** Timeout values */
  buildInstallTimeout: number;
  buildTscTimeout: number;
  buildEslintTimeout: number;
  developerTimeoutMs: number;
  /** Apply complexity timeout multiplier */
  applyComplexityTimeout: (baseMs: number, state: PipelineState) => number;
  /** Save pipeline state */
  save: (state: PipelineState) => void;
  /** Run a single agent */
  runSingleAgent: (opts: {
    name: string;
    prompt: string;
    timeout: number;
    opts: Record<string, unknown>;
    state: PipelineState;
    checkpointKey: string;
    required: boolean;
  }) => Promise<string | null>;
  /** Get local repo changes */
  localGetChanges: (repoPath: string) => FileChange[];
  /** Get original file content from git */
  localGetOriginal: (repoPath: string, filePath: string) => string | null;
}

// ── Main function ───────────────────────────────────────────────────

/**
 * Q5: Build verification -- tsc + eslint + Build Fixer Agent.
 *
 * @param state - pipeline state
 * @param fileChanges - current file changes array
 * @param originalFiles - map of file_path -> original content (mutated in place)
 * @param deps - injected dependencies
 * @returns updated fileChanges after build fixer (if any)
 */
export async function runBuildCheck(
  state: PipelineState,
  fileChanges: FileChange[],
  originalFiles: Record<string, string>,
  deps: BuildCheckDeps,
): Promise<FileChange[]> {
  logInfo('Q5: Running build verification (tsc + eslint)...');

  const data = state.data as Record<string, unknown>;
  const buildErrors: BuildError[] = [];

  try {
    // 1. Ensure node_modules exists
    const nmPath = path.join(deps.cfg.localRepo, 'node_modules');
    if (!fs.existsSync(nmPath)) {
      logInfo('  Installing dependencies (npm install --ignore-scripts)...');
      try {
        execSync('npm install --ignore-scripts', {
          cwd: deps.cfg.localRepo,
          timeout: deps.buildInstallTimeout,
          stdio: 'pipe',
        });
        logOk('  Dependencies installed');
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logWarn(`  npm install failed: ${msg.substring(0, 200)}`);
      }
    }

    // 2. Run tsc --noEmit
    try {
      logInfo('  Running TypeScript check...');
      execSync('npx tsc --noEmit --pretty 2>&1 | head -50', {
        cwd: deps.cfg.localRepo,
        timeout: deps.buildTscTimeout,
        stdio: 'pipe',
        shell: '/bin/bash',
      });
      logOk('  TypeScript: No errors');
      data._build_tsc = 'PASS';
    } catch (tscErr: unknown) {
      const err = tscErr as { stdout?: Buffer; stderr?: Buffer; message?: string };
      const tscOutput = ((err.stdout || err.stderr || Buffer.from('')).toString()).substring(0, 3000);
      logWarn(`  TypeScript errors found:\n${tscOutput.substring(0, 500)}`);
      buildErrors.push({ type: 'typescript', output: tscOutput });
      data._build_tsc = 'FAIL';
    }

    // 3. Run eslint on changed files
    const changedPaths = fileChanges
      .map((c) => c.file_path)
      .filter((p) => /\.(tsx?|jsx?)$/.test(p));

    if (changedPaths.length > 0) {
      try {
        logInfo(`  Running ESLint on ${changedPaths.length} file(s)...`);
        // Shell-escape file paths
        const escapePath = (p: string): string => `'${p.replace(/'/g, "'\\''")}'`;
        const eslintCmd = `npx eslint ${changedPaths.map(escapePath).join(' ')} --format json 2>&1`;
        execSync(eslintCmd, {
          cwd: deps.cfg.localRepo,
          timeout: deps.buildEslintTimeout,
          stdio: 'pipe',
          shell: '/bin/bash',
        });
        logOk('  ESLint: No errors');
        data._build_eslint = 'PASS';
      } catch (eslintErr: unknown) {
        const err = eslintErr as { stdout?: Buffer; stderr?: Buffer };
        const eslintOutput = ((err.stdout || err.stderr || Buffer.from('')).toString()).substring(0, 3000);
        logWarn('  ESLint errors found');
        buildErrors.push({ type: 'eslint', output: eslintOutput });
        data._build_eslint = 'FAIL';
      }
    } else {
      data._build_eslint = 'SKIP';
    }

    // If build errors -> pass to Fixer Agent for one more attempt
    if (buildErrors.length > 0 && !data._build_fix_attempted) {
      logInfo('Q5: Build errors found -- sending to Fixer Agent...');
      data._build_fix_attempted = true;
      deps.save(state);

      const buildIssues = buildErrors
        .map((e) => `## [BUILD-${e.type.toUpperCase()}]\n\`\`\`\n${e.output}\n\`\`\``)
        .join('\n\n');

      const fixResult = await deps.runSingleAgent({
        name: 'Build Fixer Agent',
        prompt:
          `You are the **Build Fixer Agent**. Fix ALL build errors below.\n\n` +
          `YOU HAVE DIRECT ACCESS TO THE REPOSITORY. Read the flagged files and fix them directly.\n\n` +
          `${buildIssues}\n\n` +
          `## Changed files:\n${fileChanges.map((c) => `- ${c.action}: ${c.file_path}`).join('\n')}\n\n` +
          `Read the erroring files, fix the build issues, and confirm what you changed.`,
        timeout: deps.applyComplexityTimeout(deps.developerTimeoutMs, state),
        opts: {
          cwd: deps.cfg.localRepo,
          maxTurns: 15,
          allowedTools: ['Read', 'Write', 'Edit', 'Grep', 'Glob'],
        },
        state,
        checkpointKey: '_build_fix_result',
        required: false,
      });

      if (fixResult) {
        logOk('Build Fixer Agent complete -- re-extracting changes');
        fileChanges = deps.localGetChanges(deps.cfg.localRepo);
        for (const c of fileChanges) {
          if (c.action === 'update' && !originalFiles[c.file_path]) {
            const orig = deps.localGetOriginal(deps.cfg.localRepo, c.file_path);
            if (orig) originalFiles[c.file_path] = orig;
          }
        }
      } else {
        logWarn('Build Fixer Agent failed -- proceeding with build errors');
      }
    }
  } catch (buildErr: unknown) {
    const msg = buildErr instanceof Error ? buildErr.message : String(buildErr);
    logWarn(`Q5: Build verification error: ${msg}`);
  }

  data._build_checked = true;
  deps.save(state);

  return fileChanges;
}
