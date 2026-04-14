"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runBuildCheck = runBuildCheck;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const logger_1 = require("../lib/logger");
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
async function runBuildCheck(state, fileChanges, originalFiles, deps) {
    (0, logger_1.logInfo)('Q5: Running build verification (tsc + eslint)...');
    const data = state.data;
    const buildErrors = [];
    try {
        // 1. Ensure node_modules exists
        const nmPath = path.join(deps.cfg.localRepo, 'node_modules');
        if (!fs.existsSync(nmPath)) {
            (0, logger_1.logInfo)('  Installing dependencies (npm install --ignore-scripts)...');
            try {
                (0, child_process_1.execSync)('npm install --ignore-scripts', {
                    cwd: deps.cfg.localRepo,
                    timeout: deps.buildInstallTimeout,
                    stdio: 'pipe',
                });
                (0, logger_1.logOk)('  Dependencies installed');
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                (0, logger_1.logWarn)(`  npm install failed: ${msg.substring(0, 200)}`);
            }
        }
        // 2. Run tsc --noEmit
        try {
            (0, logger_1.logInfo)('  Running TypeScript check...');
            (0, child_process_1.execSync)('npx tsc --noEmit --pretty 2>&1 | head -50', {
                cwd: deps.cfg.localRepo,
                timeout: deps.buildTscTimeout,
                stdio: 'pipe',
                shell: '/bin/bash',
            });
            (0, logger_1.logOk)('  TypeScript: No errors');
            data._build_tsc = 'PASS';
        }
        catch (tscErr) {
            const err = tscErr;
            const tscOutput = ((err.stdout || err.stderr || Buffer.from('')).toString()).substring(0, 3000);
            (0, logger_1.logWarn)(`  TypeScript errors found:\n${tscOutput.substring(0, 500)}`);
            buildErrors.push({ type: 'typescript', output: tscOutput });
            data._build_tsc = 'FAIL';
        }
        // 3. Run eslint on changed files
        const changedPaths = fileChanges
            .map((c) => c.file_path)
            .filter((p) => /\.(tsx?|jsx?)$/.test(p));
        if (changedPaths.length > 0) {
            try {
                (0, logger_1.logInfo)(`  Running ESLint on ${changedPaths.length} file(s)...`);
                // Shell-escape file paths
                const escapePath = (p) => `'${p.replace(/'/g, "'\\''")}'`;
                const eslintCmd = `npx eslint ${changedPaths.map(escapePath).join(' ')} --format json 2>&1`;
                (0, child_process_1.execSync)(eslintCmd, {
                    cwd: deps.cfg.localRepo,
                    timeout: deps.buildEslintTimeout,
                    stdio: 'pipe',
                    shell: '/bin/bash',
                });
                (0, logger_1.logOk)('  ESLint: No errors');
                data._build_eslint = 'PASS';
            }
            catch (eslintErr) {
                const err = eslintErr;
                const eslintOutput = ((err.stdout || err.stderr || Buffer.from('')).toString()).substring(0, 3000);
                (0, logger_1.logWarn)('  ESLint errors found');
                buildErrors.push({ type: 'eslint', output: eslintOutput });
                data._build_eslint = 'FAIL';
            }
        }
        else {
            data._build_eslint = 'SKIP';
        }
        // If build errors -> pass to Fixer Agent for one more attempt
        if (buildErrors.length > 0 && !data._build_fix_attempted) {
            (0, logger_1.logInfo)('Q5: Build errors found -- sending to Fixer Agent...');
            data._build_fix_attempted = true;
            deps.save(state);
            const buildIssues = buildErrors
                .map((e) => `## [BUILD-${e.type.toUpperCase()}]\n\`\`\`\n${e.output}\n\`\`\``)
                .join('\n\n');
            const fixResult = await deps.runSingleAgent({
                name: 'Build Fixer Agent',
                prompt: `You are the **Build Fixer Agent**. Fix ALL build errors below.\n\n` +
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
                (0, logger_1.logOk)('Build Fixer Agent complete -- re-extracting changes');
                fileChanges = deps.localGetChanges(deps.cfg.localRepo);
                for (const c of fileChanges) {
                    if (c.action === 'update' && !originalFiles[c.file_path]) {
                        const orig = deps.localGetOriginal(deps.cfg.localRepo, c.file_path);
                        if (orig)
                            originalFiles[c.file_path] = orig;
                    }
                }
            }
            else {
                (0, logger_1.logWarn)('Build Fixer Agent failed -- proceeding with build errors');
            }
        }
    }
    catch (buildErr) {
        const msg = buildErr instanceof Error ? buildErr.message : String(buildErr);
        (0, logger_1.logWarn)(`Q5: Build verification error: ${msg}`);
    }
    data._build_checked = true;
    deps.save(state);
    return fileChanges;
}
//# sourceMappingURL=build-check.js.map