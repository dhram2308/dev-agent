"use strict";
/**
 * cleanup.ts — Process cleanup handlers for MI Dev Agent
 *
 * Converted from lib/cleanup.js (zero functional changes).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanupTestProcesses = cleanupTestProcesses;
exports.cleanup = cleanup;
exports.setupErrorHandlers = setupErrorHandlers;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// Hub files not yet converted — use require
const { TICKET } = require("./config");
const { httpAgent, httpsAgent } = require("./http-client");
const { closeLogStream, closeLogStreamSync } = require("./logging");
const { getCurrentState, save } = require("./state");
const { syncToState } = require("./notification-audit");
const { stopMonitoring } = require("./escalation");
function cleanupTestProcesses() {
    try {
        const state = getCurrentState();
        if (state && state.data) {
            // Clean up vite preview
            if (state.data._vite_preview_pid) {
                const pid = state.data._vite_preview_pid;
                try {
                    process.kill(-pid, "SIGTERM");
                }
                catch {
                    try {
                        process.kill(pid, "SIGTERM");
                    }
                    catch { }
                }
                setTimeout(() => { try {
                    process.kill(-pid, "SIGKILL");
                }
                catch {
                    try {
                        process.kill(pid, "SIGKILL");
                    }
                    catch { }
                } }, 5000);
                state.data._vite_preview_pid = null;
                state.data._vite_preview_port = null;
            }
            // Clean up nx serve dev server
            if (state.data._nx_serve_pid) {
                const pid = state.data._nx_serve_pid;
                try {
                    process.kill(pid, "SIGTERM");
                }
                catch { }
                setTimeout(() => { try {
                    process.kill(pid, "SIGKILL");
                }
                catch { } }, 5000);
                state.data._nx_serve_pid = null;
                state.data._nx_serve_port = null;
                state.data._dev_server_ready = false;
            }
        }
    }
    catch { }
}
function cleanup(signal) {
    console.log(`\n  Received ${signal} -- shutting down gracefully`);
    // Stop escalation monitoring
    try {
        stopMonitoring();
    }
    catch { }
    try {
        cleanupTestProcesses();
    }
    catch { }
    try {
        const state = getCurrentState();
        if (state) {
            state.data._shutdown = { signal, ts: new Date().toISOString() };
            // Sync notification audit trail before final save
            syncToState(state);
            save(state);
        }
    }
    catch { }
    try {
        httpAgent.destroy();
        httpsAgent.destroy();
    }
    catch { }
    // Use synchronous close in signal handler (cannot await)
    try {
        closeLogStreamSync();
    }
    catch { }
    try {
        const lockFile = path_1.default.join(__dirname, "..", "..", `state-${TICKET}.lock`);
        if (fs_1.default.existsSync(lockFile))
            fs_1.default.unlinkSync(lockFile);
    }
    catch { }
    process.exit(0);
}
function setupErrorHandlers() {
    process.on("uncaughtException", (err) => {
        console.error(`\n  UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
        try {
            stopMonitoring();
        }
        catch { }
        try {
            cleanupTestProcesses();
        }
        catch { }
        try {
            const state = getCurrentState();
            if (state) {
                state.data._crash = { message: err.message, ts: new Date().toISOString() };
                syncToState(state);
                save(state);
            }
        }
        catch { }
        try {
            httpAgent.destroy();
            httpsAgent.destroy();
        }
        catch { }
        // Synchronous close -- crash handler cannot await
        try {
            closeLogStreamSync();
        }
        catch { }
        try {
            const lockFile = path_1.default.join(__dirname, "..", "..", `state-${TICKET}.lock`);
            if (fs_1.default.existsSync(lockFile))
                fs_1.default.unlinkSync(lockFile);
        }
        catch { }
        process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
        console.error(`\n  UNHANDLED REJECTION: ${reason}`);
        try {
            stopMonitoring();
        }
        catch { }
        try {
            cleanupTestProcesses();
        }
        catch { }
        try {
            const state = getCurrentState();
            if (state) {
                state.data._crash = { message: String(reason), ts: new Date().toISOString() };
                syncToState(state);
                save(state);
            }
        }
        catch { }
        try {
            httpAgent.destroy();
            httpsAgent.destroy();
        }
        catch { }
        try {
            closeLogStreamSync();
        }
        catch { }
        try {
            const lockFile = path_1.default.join(__dirname, "..", "..", `state-${TICKET}.lock`);
            if (fs_1.default.existsSync(lockFile))
                fs_1.default.unlinkSync(lockFile);
        }
        catch { }
        process.exit(1);
    });
    process.on("SIGTERM", () => cleanup("SIGTERM"));
    process.on("SIGINT", () => cleanup("SIGINT"));
}
//# sourceMappingURL=cleanup.js.map