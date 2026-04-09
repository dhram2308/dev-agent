#!/usr/bin/env node
"use strict";

/**
 * test-state-unified.js — Comprehensive tests for the unified state manager
 *
 * Run:  node test/test-state-unified.js
 *
 * Tests all 8 design components:
 *   1. Unified State Writer (sync + async)
 *   2. File Locking (exclusive, timeout, stale detection)
 *   3. HMAC Enforcement (mandatory, quarantine)
 *   4. Atomic Read-Modify-Write (CAS)
 *   5. Field-Level Merge (UI vs agent)
 *   6. State Size Management (pruning)
 *   7. Crash Recovery (tmp files, corrupt JSON)
 *   8. Migration Path (v2 -> v3 compat)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

// Test harness
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
    process.stdout.write(".");
  } else {
    failed++;
    failures.push(msg);
    process.stdout.write("F");
  }
}

function assertEqual(actual, expected, msg) {
  if (actual === expected) {
    passed++;
    process.stdout.write(".");
  } else {
    failed++;
    failures.push(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.stdout.write("F");
  }
}

function section(name) {
  process.stdout.write(`\n  ${name}: `);
}

// Setup test directory
const TEST_DIR = path.join(os.tmpdir(), `state-test-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

const TEST_SECRET = crypto.randomBytes(32).toString("hex");
fs.writeFileSync(path.join(TEST_DIR, ".state-secret"), TEST_SECRET, { mode: 0o600 });

const unified = require("../lib/state-unified");
const lock = require("../lib/state-lock");

unified._setStateSecret(TEST_SECRET);

let fileCounter = 0;
function testFile(name) {
  return path.join(TEST_DIR, `state-${name || "T" + (++fileCounter)}.json`);
}

function writeV2Envelope(filePath, state) {
  const stateJson = JSON.stringify(state, null, 2);
  const hmac = crypto.createHmac("sha256", TEST_SECRET).update(stateJson).digest("hex");
  const envelope = { _version: 2, _hmac: hmac, state };
  fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2));
}

function writeV3Envelope(filePath, state) {
  const hmac = unified.computeHmac(state, TEST_SECRET);
  const envelope = {
    _version: 3,
    _hmac: hmac,
    _seq: state._seq || 1,
    _written_by: process.pid,
    _written_at: new Date().toISOString(),
    state,
  };
  fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2));
}

// Wrap everything in async
async function runTests() {
  console.log("\n  Unified State Manager -- Test Suite\n  ======================================");

  // == 1. Unified State Writer ==

  section("1. Unified Writer -- loadSync creates fresh state");
  {
    const f = testFile();
    const state = unified.loadSync(f, { stage: "fetch_ticket", ticket: "AUT-1" });
    assertEqual(state.stage, "fetch_ticket", "stage");
    assertEqual(state.ticket, "AUT-1", "ticket");
    assert(state._seq >= 1, "has seq");
    assert(typeof state.data === "object", "has data");
  }

  section("1. Unified Writer -- saveSync + loadSync roundtrip");
  {
    const f = testFile();
    const state = { stage: "generate_code", ticket: "AUT-2", data: { foo: "bar" }, _seq: 1 };
    unified.saveSync(f, state);
    assert(fs.existsSync(f), "file exists");

    const loaded = unified.loadSync(f, { stage: "fetch_ticket", ticket: "AUT-2" });
    assertEqual(loaded.stage, "generate_code", "stage roundtrip");
    assertEqual(loaded.data.foo, "bar", "data roundtrip");
    assert(loaded._seq > 1, "seq incremented");
  }

  section("1. Unified Writer -- saveAsync + loadAsync roundtrip");
  {
    const f = testFile();
    const state = { stage: "test_qa", ticket: "AUT-3", data: { x: 42 }, _seq: 1 };
    await unified.saveAsync(f, state);
    assert(fs.existsSync(f), "async file exists");

    const loaded = await unified.loadAsync(f);
    assertEqual(loaded.stage, "test_qa", "async stage roundtrip");
    assertEqual(loaded.data.x, 42, "async data roundtrip");
  }

  // == 2. File Locking ==

  section("2. Locking -- acquire and release sync");
  {
    const f = testFile();
    fs.writeFileSync(f, "{}");
    const handle = lock.acquireLockSync(f);
    assert(fs.existsSync(f + ".wlock"), "lock file created");

    let timedOut = false;
    try {
      lock.acquireLockSync(f, { timeoutMs: 200 });
    } catch (e) {
      timedOut = e.message.includes("timeout");
    }
    assert(timedOut, "second acquire times out");

    handle.release();
    assert(!fs.existsSync(f + ".wlock"), "lock file removed after release");
  }

  section("2. Locking -- stale lock from dead PID");
  {
    const f = testFile();
    fs.writeFileSync(f, "{}");
    const lockPath = f + ".wlock";
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, ts: Date.now() - 60000, host: "test" }));

    const handle = lock.acquireLockSync(f, { timeoutMs: 500 });
    assert(true, "acquired lock after breaking stale");
    handle.release();
  }

  section("2. Locking -- async acquire and release");
  {
    const f = testFile();
    fs.writeFileSync(f, "{}");
    const handle = await lock.acquireLockAsync(f);
    assert(fs.existsSync(f + ".wlock"), "async lock file created");
    handle.release();
    assert(!fs.existsSync(f + ".wlock"), "async lock file removed");
  }

  // == 3. HMAC Enforcement ==

  section("3. HMAC -- valid v3 loads successfully");
  {
    const f = testFile();
    const state = { stage: "done", ticket: "AUT-4", data: {}, _seq: 5 };
    writeV3Envelope(f, state);
    const loaded = unified.loadSync(f, { stage: "fetch_ticket", ticket: "AUT-4" });
    assertEqual(loaded.stage, "done", "valid v3 loads");
  }

  section("3. HMAC -- tampered v3 is quarantined");
  {
    const f = testFile();
    const state = { stage: "done", ticket: "AUT-5", data: { secret: "value" }, _seq: 3 };
    writeV3Envelope(f, state);

    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    raw.state.data.secret = "TAMPERED";
    fs.writeFileSync(f, JSON.stringify(raw, null, 2));

    const warnings = [];
    const loaded = unified.loadSync(f, { stage: "fetch_ticket", ticket: "AUT-5" }, {
      allowUnverified: false,
      onWarn: (msg) => warnings.push(msg),
    });
    assertEqual(loaded.stage, "fetch_ticket", "tampered state not loaded");
    assert(warnings.some((w) => w.includes("quarantin") || w.includes("HMAC")), "warning about quarantine");
  }

  section("3. HMAC -- backup recovery on corrupt main");
  {
    const f = testFile();
    const bakFile = f + ".bak";
    const goodState = { stage: "deploy_qa", ticket: "AUT-6", data: {}, _seq: 10 };
    writeV3Envelope(bakFile, goodState);

    fs.writeFileSync(f, "NOT VALID JSON AT ALL {{{");

    const warnings = [];
    const loaded = unified.loadSync(f, { stage: "fetch_ticket", ticket: "AUT-6" }, {
      onWarn: (msg) => warnings.push(msg),
    });
    assertEqual(loaded.stage, "deploy_qa", "recovered from backup");
    assert(warnings.some((w) => w.includes("backup") || w.includes("corrupt")), "warning about recovery");
  }

  // == 4. Atomic Read-Modify-Write (CAS) ==

  section("4. CAS -- updateSync applies mutation");
  {
    const f = testFile();
    const state = { stage: "fetch_ticket", ticket: "AUT-7", data: { count: 0 }, _seq: 1 };
    unified.saveSync(f, state);

    const result = unified.updateSync(f, (s) => {
      s.data.count = 42;
      return s;
    });
    assertEqual(result.data.count, 42, "mutation applied");
    assert(result._seq > 1, "seq bumped");
  }

  section("4. CAS -- updateAsync applies mutation");
  {
    const f = testFile();
    const state = { stage: "test_qa", ticket: "AUT-8", data: { items: [] }, _seq: 1 };
    unified.saveSync(f, state);

    const result = await unified.updateAsync(f, async (s) => {
      s.data.items.push("new-item");
      return s;
    });
    assertEqual(result.data.items.length, 1, "async mutation applied");
  }

  // == 5. Field-Level Merge ==

  section("5. Merge -- UI fields preserved during agent save");
  {
    const f = testFile();
    const diskState = { stage: "gate_code_review", ticket: "AUT-9", data: { gate1_ui_approved: true }, _seq: 1 };
    writeV3Envelope(f, diskState);

    const agentState = { stage: "gate_code_review", ticket: "AUT-9", data: { code_mr_iid: 123 }, _seq: 1 };
    unified.saveSync(f, agentState);

    const loaded = unified.loadSync(f, { stage: "fetch_ticket", ticket: "AUT-9" });
    assertEqual(loaded.data.gate1_ui_approved, true, "UI approval preserved");
    assertEqual(loaded.data.code_mr_iid, 123, "agent data preserved");
  }

  section("5. Merge -- patchUIAsync only writes UI fields");
  {
    const f = testFile();
    const state = { stage: "gate_code_review", ticket: "AUT-10", data: { code_mr_iid: 456, _metrics: {} }, _seq: 1 };
    unified.saveSync(f, state);

    await unified.patchUIAsync(f, "gate1", {
      "_ui_rejected": true,
      "_ui_feedback": "Needs more tests",
    });

    const loaded = unified.readForDisplay(f);
    assertEqual(loaded.data.gate1_ui_rejected, true, "UI rejected set");
    assertEqual(loaded.data.gate1_ui_feedback, "Needs more tests", "UI feedback set");
    assertEqual(loaded.data.code_mr_iid, 456, "agent data untouched");
  }

  section("5. Merge -- isUIField pattern matching");
  {
    assert(unified.isUIField("gate1_ui_approved"), "gate1_ui_approved is UI");
    assert(unified.isUIField("explore_plan_ui_feedback"), "explore_plan_ui_feedback is UI");
    assert(unified.isUIField("gate2b_ui_refine_instructions"), "gate2b_ui_refine_instructions is UI");
    assert(!unified.isUIField("code_mr_iid"), "code_mr_iid is NOT UI");
    assert(!unified.isUIField("_metrics"), "_metrics is NOT UI");
    assert(!unified.isUIField("stage"), "stage is NOT UI");
  }

  // == 6. State Size Management ==

  section("6. Size -- pruneState trims oversized metrics");
  {
    const state = { stage: "done", ticket: "AUT-11", data: { _metrics: {} }, _seq: 1 };
    for (let i = 0; i < 11; i++) {
      state.data._metrics[`stage_${i}`] = {
        runs: Array.from({ length: 20 }, () => ({
          start: Date.now(),
          end: Date.now() + 1000,
          durationMs: 1000,
          durationHuman: "1.0s",
          payload: "x".repeat(100_000),
        })),
      };
    }

    const pruned = unified.pruneState(state);
    for (const key of Object.keys(pruned.data._metrics)) {
      assert(pruned.data._metrics[key].runs.length <= 3, `${key} runs trimmed to 3`);
    }
  }

  section("6. Size -- pruneState trims warnings");
  {
    const state = { stage: "done", ticket: "AUT-12", data: { _warnings: [], _big_payload: "x".repeat(7_000_000) }, _seq: 1 };
    for (let i = 0; i < 300; i++) {
      state.data._warnings.push({ stage: "test", message: "w".repeat(1_000), timestamp: new Date().toISOString() });
    }
    const pruned = unified.pruneState(state);
    assert(pruned.data._warnings.length <= 50, "warnings trimmed");
  }

  // == 7. Crash Recovery ==

  section("7. Recovery -- orphaned .tmp promoted when no main file");
  {
    const f = testFile();
    const tmpFile = f + ".tmp.12345.1000";
    const state = { stage: "explore_plan", ticket: "AUT-13", data: {}, _seq: 1 };
    const envelope = unified.wrapEnvelope(state, TEST_SECRET);
    fs.writeFileSync(tmpFile, JSON.stringify(envelope, null, 2));

    const oldTime = new Date(Date.now() - 30_000);
    fs.utimesSync(tmpFile, oldTime, oldTime);

    const recovered = unified.recoverTmpFiles(f);
    assert(recovered.length > 0, "recovery detected tmp");
    assert(recovered[0].action === "promoted_to_main", "tmp promoted");
    assert(fs.existsSync(f), "main file now exists");
  }

  section("7. Recovery -- orphaned .tmp removed when main exists");
  {
    const f = testFile();
    const tmpFile = f + ".tmp.12345.2000";
    const state = { stage: "done", ticket: "AUT-14", data: {}, _seq: 1 };
    writeV3Envelope(f, state);
    fs.writeFileSync(tmpFile, "some old tmp data");

    const oldTime = new Date(Date.now() - 30_000);
    fs.utimesSync(tmpFile, oldTime, oldTime);

    const recovered = unified.recoverTmpFiles(f);
    assert(recovered.some((r) => r.action === "removed_orphan"), "orphan removed");
    assert(!fs.existsSync(tmpFile), "tmp file cleaned up");
  }

  section("7. Recovery -- corrupt JSON quarantined");
  {
    const f = testFile();
    fs.writeFileSync(f, "{ broken json ::::");

    const warnings = [];
    const loaded = unified.loadSync(f, { stage: "fetch_ticket", ticket: "AUT-15" }, {
      onWarn: (msg) => warnings.push(msg),
    });
    assertEqual(loaded.stage, "fetch_ticket", "fresh state returned");
    assert(warnings.some((w) => w.includes("corrupt")), "corruption warned");
    assert(!fs.existsSync(f) || fs.readFileSync(f, "utf8") !== "{ broken json ::::", "corrupt file quarantined");
  }

  // == 8. Migration -- v2 to v3 ==

  section("8. Migration -- v2 envelope loaded with allowUnverified");
  {
    const f = testFile();
    const state = { stage: "deploy_prod", ticket: "AUT-16", data: { old_field: true } };
    writeV2Envelope(f, state);

    const loaded = unified.loadSync(f, { stage: "fetch_ticket", ticket: "AUT-16" }, {
      allowUnverified: true,
      onWarn: () => {},
    });
    assertEqual(loaded.stage, "deploy_prod", "v2 state loaded");
    assertEqual(loaded.data.old_field, true, "v2 data preserved");
  }

  section("8. Migration -- v2 re-saved as v3 after load+save");
  {
    const f = testFile();
    const state = { stage: "test_qa", ticket: "AUT-17", data: { migrated: false } };
    writeV2Envelope(f, state);

    const loaded = unified.loadSync(f, { stage: "fetch_ticket", ticket: "AUT-17" }, {
      allowUnverified: true,
    });
    loaded.data.migrated = true;
    unified.saveSync(f, loaded);

    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    assertEqual(raw._version, unified.ENVELOPE_VERSION, "now v3 envelope");
    assert(raw._hmac && raw._hmac.length === 64, "has v3 HMAC");
  }

  section("8. Migration -- plain v1 state loaded with allowUnverified");
  {
    const f = testFile();
    const state = { stage: "generate_code", ticket: "AUT-18", data: {} };
    fs.writeFileSync(f, JSON.stringify(state, null, 2));

    const loaded = unified.loadSync(f, { stage: "fetch_ticket", ticket: "AUT-18" }, {
      allowUnverified: true,
    });
    assertEqual(loaded.stage, "generate_code", "v1 state loaded");
  }

  // == Extra tests ==

  section("Extra -- readForDisplay returns null for missing file");
  {
    const f = testFile();
    const result = unified.readForDisplay(f);
    assertEqual(result, null, "null for missing");
  }

  section("Extra -- checkUIApprovalSync");
  {
    const f = testFile();
    const state = { stage: "gate_code_review", ticket: "AUT-19", data: {
      gate1_ui_rejected: true,
      gate1_ui_feedback: "Fix spacing",
    }, _seq: 1 };
    writeV3Envelope(f, state);

    const result = unified.checkUIApprovalSync(f, "gate1");
    assertEqual(result.approved, false, "rejected");
    assertEqual(result.feedback, "Fix spacing", "feedback");
  }

  section("Extra -- checkUIApprovalSync refine priority");
  {
    const f = testFile();
    const state = { stage: "explore_plan", ticket: "AUT-20", data: {
      explore_plan_ui_refine: true,
      explore_plan_ui_refine_instructions: "Add error handling",
      explore_plan_ui_approved: true,
    }, _seq: 1 };
    writeV3Envelope(f, state);

    const result = unified.checkUIApprovalSync(f, "explore_plan");
    assert(result.refine === true, "refine takes priority");
    assertEqual(result.instructions, "Add error handling", "instructions");
  }

  section("Extra -- review comments roundtrip");
  {
    const f = testFile();
    const state = { stage: "gate_code_review", ticket: "AUT-21", data: {}, _seq: 1 };
    unified.saveSync(f, state);

    await unified.saveReviewComments(f, { "file.ts:10": "check null" });
    const comments = unified.getReviewComments(f);
    assertEqual(comments["file.ts:10"], "check null", "comments roundtrip");
  }

  // == Stress tests ==

  section("Stress -- 10 sequential sync writes with incrementing counter");
  {
    const f = testFile();
    const state = { stage: "generate_code", ticket: "AUT-22", data: { counter: 0 }, _seq: 1 };
    unified.saveSync(f, state);

    for (let i = 1; i <= 10; i++) {
      unified.updateSync(f, (s) => {
        s.data.counter = i;
        return s;
      });
    }

    const loaded = unified.loadSync(f, { stage: "fetch_ticket", ticket: "AUT-22" });
    assertEqual(loaded.data.counter, 10, "10 sequential writes");
    assert(loaded._seq >= 11, "seq incremented 10+ times");
  }

  section("Stress -- 5 concurrent async writes");
  {
    const f = testFile();
    const state = { stage: "test_qa", ticket: "AUT-23", data: { writes: [] }, _seq: 1 };
    unified.saveSync(f, state);

    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        unified.updateAsync(f, async (s) => {
          s.data.writes.push(i);
          return s;
        })
      );
    }
    await Promise.all(promises);

    const loaded = await unified.loadAsync(f);
    assertEqual(loaded.data.writes.length, 5, "all 5 concurrent writes preserved");
  }

  // Cleanup
  try { fs.rmSync(TEST_DIR, { recursive: true }); } catch {}

  console.log(`\n\n  ======================================`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log(`\n  Failures:`);
    for (const f of failures) console.log(`    - ${f}`);
  }
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("\n  TEST SUITE ERROR:", err);
  try { fs.rmSync(TEST_DIR, { recursive: true }); } catch {}
  process.exit(1);
});
