// =====================================================================
// MI Dev Agent -- Environment Setup (TypeScript port)
// =====================================================================
// Phase 0: Ensure the local repo environment is ready for browser
// verification.
//
// Steps:
//   1. Write .env file for enterprise app
//   2. Verify/fix node_modules health
//   3. Install Playwright chromium if needed
//
// Ported from: stages/generate-code/env-setup.js
// =====================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import type { PipelineState } from '@shared/types';
import { logInfo, logOk, logWarn, logErr } from '../lib/logger';

// ── Types ────────────────────────────────────────────────────────────

/** Dependencies for environment setup */
export interface EnvSetupDeps {
  /** Whether browser verification is enabled */
  browserVerify: boolean;
  /** npm install timeout */
  buildInstallTimeout: number;
  /** Save state */
  save: (state: PipelineState) => void;
  /** Check if a dev server process is alive */
  isProcessAlive: (pid: number) => boolean;
}

// ── Constants ────────────────────────────────────────────────────────

const ENV_TEMPLATE = `VITE_APP_API_URL=\${VITE_APP_API_URL:-https://qa-enterprise.mastersindia-einv.com/api/v2.1/}
VITE_PRODUCT_ID=enterprises
VITE_APP_QA=\${VITE_APP_QA:-https://qa-enterprise.mastersindia-einv.com}
VITE_APP_ENV=qa
VITE_APP_TYPE=enterprise
VITE_INITIAL_URL=/dashboard
VITE_CHAT_SOCKET_URL=wss://qa-taxgptbackend.mastersindia-einv.com/ws/v1/
VITE_APP_NICKNAME=Masters India
VITE_SHOW_CLARITY=false
VITE_SHOW_TOUR_GUIDE=no
VITE_DISABLE_CAPTCHA_ON_QA=true
NODE_OPTIONS=--max_old_space_size=4096
`;

// Resolve environment variables in template
function resolveEnvTemplate(): string {
  return `VITE_APP_API_URL=${process.env.VITE_APP_API_URL || 'https://qa-enterprise.mastersindia-einv.com/api/v2.1/'}
VITE_PRODUCT_ID=enterprises
VITE_APP_QA=${process.env.VITE_APP_QA || 'https://qa-enterprise.mastersindia-einv.com'}
VITE_APP_ENV=qa
VITE_APP_TYPE=enterprise
VITE_INITIAL_URL=/dashboard
VITE_CHAT_SOCKET_URL=wss://qa-taxgptbackend.mastersindia-einv.com/ws/v1/
VITE_APP_NICKNAME=Masters India
VITE_SHOW_CLARITY=false
VITE_SHOW_TOUR_GUIDE=no
VITE_DISABLE_CAPTCHA_ON_QA=true
NODE_OPTIONS=--max_old_space_size=4096
`;
}

// ── Main function ───────────────────────────────────────────────────

/**
 * Phase 0: Ensure the local repo environment is ready for browser verification.
 *
 * @param state - Pipeline state
 * @param clonePath - Path to .repo-cache
 * @param deps - Injected dependencies
 * @returns true if environment is ready
 */
export async function ensureEnvironment(
  state: PipelineState,
  clonePath: string,
  deps: EnvSetupDeps,
): Promise<boolean> {
  const data = state.data as Record<string, unknown>;

  if (!deps.browserVerify) {
    logInfo('Phase 0: BROWSER_VERIFY=false -- skipping environment setup');
    return false;
  }

  // Checkpoint: skip if already complete AND dev server still alive
  if (data._env_setup_complete && data._dev_server_ready) {
    if (deps.isProcessAlive(data._nx_serve_pid as number)) {
      logOk('Phase 0: Environment ready (cached) -- dev server alive');
      return true;
    }
    // Dev server died -- need to restart it, but env is still good
    logInfo('Phase 0: Environment cached but dev server dead -- will restart');
  }

  logInfo('Phase 0: Setting up browser verification environment...');
  const startTime = Date.now();

  try {
    // Step 1: Write .env file
    writeEnvFile(clonePath);

    // Step 2: Verify node_modules
    const modulesOk = await verifyNodeModules(clonePath, state, deps);
    if (!modulesOk) {
      logWarn('Phase 0: node_modules verification failed -- skipping browser verification');
      data._env_setup_complete = false;
      deps.save(state);
      return false;
    }

    // Step 3: Install Playwright
    const playwrightOk = await ensurePlaywright();
    if (!playwrightOk) {
      logWarn('Phase 0: Playwright install failed -- skipping browser verification');
      data._browser_verify_available = false;
      deps.save(state);
      return false;
    }

    data._env_setup_complete = true;
    data._browser_verify_available = true;
    deps.save(state);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logOk(`Phase 0: Environment ready (${elapsed}s)`);
    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logErr(`Phase 0: Unexpected error: ${msg.substring(0, 300)}`);
    data._env_setup_complete = false;
    deps.save(state);
    return false;
  }
}

/**
 * Write .env file for the enterprise app if missing or incomplete.
 */
export function writeEnvFile(clonePath: string): void {
  try {
    const envPath = path.join(clonePath, 'apps', 'enterprise', '.env');
    const envDir = path.dirname(envPath);

    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      if (content.includes('VITE_APP_API_URL')) {
        logOk('Phase 0: .env verified (already exists)');
        return;
      }
      logWarn('Phase 0: .env exists but missing VITE_APP_API_URL -- overwriting');
    }

    // Ensure directory exists
    if (!fs.existsSync(envDir)) {
      fs.mkdirSync(envDir, { recursive: true });
    }

    fs.writeFileSync(envPath, resolveEnvTemplate(), 'utf8');
    logOk('Phase 0: .env written with 12 VITE_* variables');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logErr(`Phase 0: Failed to write .env: ${msg.substring(0, 200)}`);
    throw e;
  }
}

/**
 * Verify node_modules health by checking .bin/nx exists.
 * If broken, run npm install.
 */
export async function verifyNodeModules(
  clonePath: string,
  state: PipelineState,
  deps: EnvSetupDeps,
): Promise<boolean> {
  const data = state.data as Record<string, unknown>;
  const nxBin = path.join(clonePath, 'node_modules', '.bin', 'nx');

  // Check package-lock hash for cache invalidation
  const lockPath = path.join(clonePath, 'package-lock.json');
  let currentHash: string | null = null;
  try {
    if (fs.existsSync(lockPath)) {
      const lockContent = fs.readFileSync(lockPath);
      currentHash = crypto.createHash('sha256').update(lockContent).digest('hex').substring(0, 16);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logWarn(`Phase 0: Could not hash package-lock.json: ${msg.substring(0, 80)}`);
  }

  const needsInstall = !fs.existsSync(nxBin) ||
    (currentHash && data._npm_install_hash && data._npm_install_hash !== currentHash);

  if (!needsInstall) {
    logOk('Phase 0: node_modules healthy (.bin/nx exists)');
    return true;
  }

  const reason = !fs.existsSync(nxBin) ? '.bin/nx missing' : 'package-lock.json changed';
  logInfo(`Phase 0: node_modules needs install (${reason}) -- running npm install...`);

  try {
    execSync('npm install --legacy-peer-deps', {
      cwd: clonePath,
      stdio: 'pipe',
      timeout: deps.buildInstallTimeout,
      env: { ...process.env, NODE_OPTIONS: '--max_old_space_size=4096' },
    });

    // Verify after install
    if (!fs.existsSync(nxBin)) {
      logErr('Phase 0: npm install completed but .bin/nx still missing');
      return false;
    }

    if (currentHash) {
      data._npm_install_hash = currentHash;
    }

    logOk('Phase 0: npm install completed successfully');
    return true;
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer; message?: string };
    const detail = err.stderr ? err.stderr.toString().substring(0, 300) : (err.message || '');
    logErr(`Phase 0: npm install failed: ${detail}`);
    return false;
  }
}

/**
 * Ensure Playwright chromium browser is installed.
 */
export async function ensurePlaywright(): Promise<boolean> {
  try {
    // Quick check: try to see if chromium is available
    execSync('npx playwright install --dry-run chromium 2>&1', {
      stdio: 'pipe',
      timeout: 15_000,
    });
    logOk('Phase 0: Playwright chromium cached');
    return true;
  } catch {
    // Not installed -- install it
    logInfo('Phase 0: Installing Playwright chromium (first run, ~150MB download)...');
    try {
      execSync('npx playwright install chromium', {
        stdio: 'pipe',
        timeout: 420_000, // 7 min for first install
      });
      logOk('Phase 0: Playwright chromium installed');
      return true;
    } catch (e: unknown) {
      const err = e as { stderr?: Buffer; message?: string };
      const detail = err.stderr ? err.stderr.toString().substring(0, 300) : (err.message || '');
      logErr(`Phase 0: Playwright install failed: ${detail}`);
      return false;
    }
  }
}
