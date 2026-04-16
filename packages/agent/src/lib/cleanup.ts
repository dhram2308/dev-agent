/**
 * cleanup.ts — Process cleanup handlers for MI Dev Agent
 *
 * Converted from lib/cleanup.js (zero functional changes).
 */

import fs from "fs";
import path from "path";

// Hub files not yet converted — use require
const { TICKET } = require("./config") as { TICKET: string };
const { httpAgent, httpsAgent } = require("./http-client") as {
  httpAgent: { destroy: () => void };
  httpsAgent: { destroy: () => void };
};
const { closeLogStream, closeLogStreamSync } = require("./logging") as {
  closeLogStream: () => void;
  closeLogStreamSync: () => void;
};
const { getCurrentState, save } = require("./state") as {
  getCurrentState: () => any;
  save: (state: any) => void;
};
const { syncToState } = require("./notification-audit") as {
  syncToState: (state: any) => void;
};
const { stopMonitoring } = require("./escalation") as {
  stopMonitoring: () => void;
};

function cleanupTestProcesses(): void {
  try {
    const state = getCurrentState();
    if (state && state.data) {
      // Clean up vite preview
      if (state.data._vite_preview_pid) {
        const pid = state.data._vite_preview_pid as number;
        try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
        setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } }, 5000);
        state.data._vite_preview_pid = null;
        state.data._vite_preview_port = null;
      }
      // Clean up nx serve dev server
      if (state.data._nx_serve_pid) {
        const pid = state.data._nx_serve_pid as number;
        try { process.kill(pid, "SIGTERM"); } catch {}
        setTimeout(() => { try { process.kill(pid, "SIGKILL"); } catch {} }, 5000);
        state.data._nx_serve_pid = null;
        state.data._nx_serve_port = null;
        state.data._dev_server_ready = false;
      }
    }
  } catch {}
}

function cleanup(signal: string): void {
  console.log(`\n  Received ${signal} -- shutting down gracefully`);

  // Stop escalation monitoring
  try { stopMonitoring(); } catch {}

  try { cleanupTestProcesses(); } catch {}

  try {
    const state = getCurrentState();
    if (state) {
      state.data._shutdown = { signal, ts: new Date().toISOString() };
      // Sync notification audit trail before final save
      syncToState(state);
      save(state);
    }
  } catch {}

  try { httpAgent.destroy(); httpsAgent.destroy(); } catch {}

  // Use synchronous close in signal handler (cannot await)
  try { closeLogStreamSync(); } catch {}

  try {
    const lockFile = path.join(__dirname, "..", "..", `state-${TICKET}.lock`);
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  } catch {}
  process.exit(0);
}

function setupErrorHandlers(): void {
  process.on("uncaughtException", (err: Error) => {
    console.error(`\n  UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);

    try { stopMonitoring(); } catch {}
    try { cleanupTestProcesses(); } catch {}

    try {
      const state = getCurrentState();
      if (state) {
        state.data._crash = { message: err.message, ts: new Date().toISOString() };
        syncToState(state);
        save(state);
      }
    } catch {}

    try { httpAgent.destroy(); httpsAgent.destroy(); } catch {}

    // Synchronous close -- crash handler cannot await
    try { closeLogStreamSync(); } catch {}

    try {
      const lockFile = path.join(__dirname, "..", "..", `state-${TICKET}.lock`);
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    } catch {}
    process.exit(1);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    console.error(`\n  UNHANDLED REJECTION: ${reason}`);

    try { stopMonitoring(); } catch {}
    try { cleanupTestProcesses(); } catch {}

    try {
      const state = getCurrentState();
      if (state) {
        state.data._crash = { message: String(reason), ts: new Date().toISOString() };
        syncToState(state);
        save(state);
      }
    } catch {}

    try { httpAgent.destroy(); httpsAgent.destroy(); } catch {}
    try { closeLogStreamSync(); } catch {}

    try {
      const lockFile = path.join(__dirname, "..", "..", `state-${TICKET}.lock`);
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    } catch {}
    process.exit(1);
  });

  process.on("SIGTERM", () => cleanup("SIGTERM"));
  process.on("SIGINT", () => cleanup("SIGINT"));
}

export { cleanupTestProcesses, cleanup, setupErrorHandlers };
