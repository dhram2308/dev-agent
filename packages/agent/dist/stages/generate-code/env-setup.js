"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureEnvironment = ensureEnvironment;
exports.writeEnvFile = writeEnvFile;
exports.verifyNodeModules = verifyNodeModules;
exports.ensurePlaywright = ensurePlaywright;
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { cfg, BUILD_INSTALL_TIMEOUT, BROWSER_VERIFY } = require("../../lib/config");
const { logInfo, logOk, logWarn, logErr } = require("../../lib/logging");
const { save } = require("../../lib/state");
const ENV_TEMPLATE = `VITE_APP_API_URL=${process.env.VITE_APP_API_URL || "https://qa-enterprise.mastersindia-einv.com/api/v2.1/"}
VITE_PRODUCT_ID=enterprises
VITE_APP_QA=${process.env.VITE_APP_QA || "https://qa-enterprise.mastersindia-einv.com"}
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
/**
 * Phase 0: Ensure the local repo environment is ready for browser verification.
 * - Write .env file for enterprise app
 * - Verify/fix node_modules health
 * - Install Playwright chromium if needed
 */
async function ensureEnvironment(state, clonePath) {
    if (!BROWSER_VERIFY) {
        logInfo("Phase 0: BROWSER_VERIFY=false -- skipping environment setup");
        return false;
    }
    // Checkpoint: skip if already complete AND dev server still alive
    if (state.data._env_setup_complete && state.data._dev_server_ready) {
        const { isProcessAlive } = require("./dev-server");
        if (isProcessAlive(state.data._nx_serve_pid)) {
            logOk("Phase 0: Environment ready (cached) -- dev server alive");
            return true;
        }
        // Dev server died -- need to restart it, but env is still good
        logInfo("Phase 0: Environment cached but dev server dead -- will restart");
    }
    logInfo("Phase 0: Setting up browser verification environment...");
    const startTime = Date.now();
    try {
        // Step 1: Write .env file
        writeEnvFile(clonePath);
        // Step 2: Verify node_modules
        const modulesOk = await verifyNodeModules(clonePath, state);
        if (!modulesOk) {
            logWarn("Phase 0: node_modules verification failed -- skipping browser verification");
            state.data._env_setup_complete = false;
            save(state);
            return false;
        }
        // Step 3: Install Playwright
        const playwrightOk = await ensurePlaywright();
        if (!playwrightOk) {
            logWarn("Phase 0: Playwright install failed -- skipping browser verification");
            state.data._browser_verify_available = false;
            save(state);
            return false;
        }
        state.data._env_setup_complete = true;
        state.data._browser_verify_available = true;
        save(state);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        logOk(`Phase 0: Environment ready (${elapsed}s)`);
        return true;
    }
    catch (e) {
        logErr(`Phase 0: Unexpected error: ${e.message.substring(0, 300)}`);
        state.data._env_setup_complete = false;
        save(state);
        return false;
    }
}
/**
 * Write .env file for the enterprise app if missing or incomplete.
 */
function writeEnvFile(clonePath) {
    try {
        const envPath = path.join(clonePath, "apps", "enterprise", ".env");
        const envDir = path.dirname(envPath);
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, "utf8");
            if (content.includes("VITE_APP_API_URL")) {
                logOk("Phase 0: .env verified (already exists)");
                return;
            }
            logWarn("Phase 0: .env exists but missing VITE_APP_API_URL -- overwriting");
        }
        // Ensure directory exists
        if (!fs.existsSync(envDir)) {
            fs.mkdirSync(envDir, { recursive: true });
        }
        fs.writeFileSync(envPath, ENV_TEMPLATE, "utf8");
        logOk("Phase 0: .env written with 12 VITE_* variables");
    }
    catch (e) {
        logErr(`Phase 0: Failed to write .env: ${e.message.substring(0, 200)}`);
        throw e; // Let ensureEnvironment catch handle it
    }
}
/**
 * Verify node_modules health by checking .bin/nx exists.
 * If broken, run npm install.
 */
async function verifyNodeModules(clonePath, state) {
    const { execSync } = require("child_process");
    const nxBin = path.join(clonePath, "node_modules", ".bin", "nx");
    // Check package-lock hash for cache invalidation
    const lockPath = path.join(clonePath, "package-lock.json");
    let currentHash = null;
    try {
        if (fs.existsSync(lockPath)) {
            const lockContent = fs.readFileSync(lockPath);
            currentHash = crypto.createHash("sha256").update(lockContent).digest("hex").substring(0, 16);
        }
    }
    catch (e) {
        logWarn(`Phase 0: Could not hash package-lock.json: ${e.message.substring(0, 80)}`);
    }
    const needsInstall = !fs.existsSync(nxBin) ||
        (currentHash && state.data._npm_install_hash && state.data._npm_install_hash !== currentHash);
    if (!needsInstall) {
        logOk("Phase 0: node_modules healthy (.bin/nx exists)");
        return true;
    }
    const reason = !fs.existsSync(nxBin) ? ".bin/nx missing" : "package-lock.json changed";
    logInfo(`Phase 0: node_modules needs install (${reason}) -- running npm install...`);
    try {
        execSync("npm install --legacy-peer-deps", {
            cwd: clonePath,
            stdio: "pipe",
            timeout: BUILD_INSTALL_TIMEOUT,
            env: { ...process.env, NODE_OPTIONS: "--max_old_space_size=4096" },
        });
        // Verify after install
        if (!fs.existsSync(nxBin)) {
            logErr("Phase 0: npm install completed but .bin/nx still missing");
            return false;
        }
        if (currentHash) {
            state.data._npm_install_hash = currentHash;
        }
        logOk("Phase 0: npm install completed successfully");
        return true;
    }
    catch (e) {
        const detail = e.stderr ? e.stderr.toString().substring(0, 300) : e.message;
        logErr(`Phase 0: npm install failed: ${detail}`);
        return false;
    }
}
/**
 * Ensure Playwright chromium browser is installed.
 */
async function ensurePlaywright() {
    const { execSync } = require("child_process");
    try {
        // Quick check: try to see if chromium is available
        execSync("npx playwright install --dry-run chromium 2>&1", {
            stdio: "pipe",
            timeout: 15_000,
        });
        logOk("Phase 0: Playwright chromium cached");
        return true;
    }
    catch {
        // Not installed -- install it
        logInfo("Phase 0: Installing Playwright chromium (first run, ~150MB download)...");
        try {
            execSync("npx playwright install chromium", {
                stdio: "pipe",
                timeout: 420_000, // 7 min for first install
            });
            logOk("Phase 0: Playwright chromium installed");
            return true;
        }
        catch (e) {
            const detail = e.stderr ? e.stderr.toString().substring(0, 300) : e.message;
            logErr(`Phase 0: Playwright install failed: ${detail}`);
            return false;
        }
    }
}
//# sourceMappingURL=env-setup.js.map