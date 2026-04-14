// =====================================================================
// Integration Test: Checkpoint Recovery -- Crash Recovery
// =====================================================================
// Test that a pipeline can be checkpointed at generate_code,
// and a new instance can load from the checkpoint with full integrity.
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Mock logger ────────────────────────────────────────────────────

vi.mock('../../src/lib/logger', () => ({
  logOk: vi.fn(),
  logErr: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

// ── Import real state-manager (we test the actual persistence) ────

import {
  wrapEnvelope,
  unwrapEnvelope,
  atomicWriteSync,
  readStateFromDisk,
  pruneState,
  computeHmac,
  _setStateSecret,
  recoverTmpFiles,
  quarantineFile,
} from '../../src/state/state-manager';

import type { PipelineState, StageName, PipelineData } from '@mi/shared/src/types';

// ── Helpers ────────────────────────────────────────────────────────

const TEST_SECRET = 'a'.repeat(64); // 32 bytes hex

let tmpDir: string;

function stateFilePath(ticket: string): string {
  return path.join(tmpDir, `state-${ticket}.json`);
}

function makeCheckpointState(
  ticket: string,
  stage: StageName,
  data: Record<string, unknown> = {},
): PipelineState {
  return {
    ticket,
    stage,
    data: {
      _pipeline_start: Date.now() - 60_000,
      _checkpoint: {
        stage,
        previousStage: 'explore_plan',
        entryTime: new Date().toISOString(),
        pipelineElapsedMs: 60_000,
        stateHash: '',
        completedGates: ['fetch_ticket', 'explore_plan'],
        version: 1,
      },
      _completedGates: ['fetch_ticket', 'explore_plan'],
      _stage_completions: {
        fetch_ticket: { completedAt: new Date().toISOString(), stateHash: '' },
        explore_plan: { completedAt: new Date().toISOString(), stateHash: '' },
      },
      _last_completed_stage: 'explore_plan',
      _warnings: [],
      _metrics: {},
      _config_snapshot: { hash: 'test-snap' },
      ticket: ticket,
      explore_plan: 'The plan content',
      ...data,
    } as PipelineData,
    _seq: 5,
  };
}

// ── Setup/Teardown ────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-checkpoint-test-'));
  _setStateSecret(TEST_SECRET);
});

afterEach(() => {
  _setStateSecret(null);
  // Clean up tmp directory
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* best effort */ }
});

// ── Tests ──────────────────────────────────────────────────────────

describe('Checkpoint Recovery', () => {
  describe('save and load checkpoint', () => {
    it('saves checkpoint at generate_code and loads with full integrity', () => {
      const ticket = 'AUT-CKPT-1';
      const state = makeCheckpointState(ticket, 'generate_code');
      const filePath = stateFilePath(ticket);

      // Save checkpoint
      const envelope = wrapEnvelope(state, TEST_SECRET);
      atomicWriteSync(filePath, envelope);

      // Verify file exists
      expect(fs.existsSync(filePath)).toBe(true);

      // Load from checkpoint (simulate new instance)
      const loaded = readStateFromDisk(filePath, { allowUnverified: false });

      expect(loaded).not.toBeNull();
      expect(loaded!.source).toBe('main');
      expect(loaded!.state.ticket).toBe(ticket);
      expect(loaded!.state.stage).toBe('generate_code');
      expect(loaded!.seq).toBe(6); // wrapEnvelope increments _seq
    });

    it('preserves all accumulated data fields', () => {
      const ticket = 'AUT-CKPT-2';
      const state = makeCheckpointState(ticket, 'generate_code', {
        code_branch: 'enterprise-ts-AUT-CKPT-2',
        custom_field: 'hello',
      });
      const filePath = stateFilePath(ticket);

      const envelope = wrapEnvelope(state, TEST_SECRET);
      atomicWriteSync(filePath, envelope);

      const loaded = readStateFromDisk(filePath, { allowUnverified: false });
      const data = loaded!.state.data as Record<string, unknown>;

      expect(data.ticket).toBe(ticket);
      expect(data.explore_plan).toBe('The plan content');
      expect(data.code_branch).toBe('enterprise-ts-AUT-CKPT-2');
      expect(data.custom_field).toBe('hello');
      expect(data._pipeline_start).toBeDefined();
      expect(data._completedGates).toEqual(['fetch_ticket', 'explore_plan']);
    });

    it('preserves checkpoint metadata', () => {
      const ticket = 'AUT-CKPT-3';
      const state = makeCheckpointState(ticket, 'generate_code');
      const filePath = stateFilePath(ticket);

      const envelope = wrapEnvelope(state, TEST_SECRET);
      atomicWriteSync(filePath, envelope);

      const loaded = readStateFromDisk(filePath, { allowUnverified: false });
      const data = loaded!.state.data as Record<string, unknown>;
      const checkpoint = data._checkpoint as Record<string, unknown>;

      expect(checkpoint.stage).toBe('generate_code');
      expect(checkpoint.previousStage).toBe('explore_plan');
      expect(checkpoint.completedGates).toEqual(['fetch_ticket', 'explore_plan']);
    });
  });

  describe('HMAC integrity verification', () => {
    it('detects tampered state file', () => {
      const ticket = 'AUT-CKPT-TAMPER';
      const state = makeCheckpointState(ticket, 'generate_code');
      const filePath = stateFilePath(ticket);

      const envelope = wrapEnvelope(state, TEST_SECRET);
      atomicWriteSync(filePath, envelope);

      // Tamper with the file
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      parsed.state.stage = 'done'; // Tamper!
      fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2));

      // Strict load should detect the mismatch
      const result = readStateFromDisk(filePath, {
        allowUnverified: false,
        onWarn: vi.fn(),
      });

      // Main file should be quarantined, and no backup exists
      expect(result).toBeNull();
    });

    it('computeHmac produces consistent results', () => {
      const state = makeCheckpointState('AUT-HMAC', 'fetch_ticket');

      const hmac1 = computeHmac(state, TEST_SECRET);
      const hmac2 = computeHmac(state, TEST_SECRET);

      expect(hmac1).toBe(hmac2);
      expect(hmac1).toHaveLength(64); // SHA-256 hex = 64 chars
    });

    it('computeHmac changes when state changes', () => {
      const state = makeCheckpointState('AUT-HMAC', 'fetch_ticket');
      const hmac1 = computeHmac(state, TEST_SECRET);

      state.stage = 'generate_code';
      const hmac2 = computeHmac(state, TEST_SECRET);

      expect(hmac1).not.toBe(hmac2);
    });
  });

  describe('backup recovery', () => {
    it('recovers from backup when main file is corrupt', () => {
      const ticket = 'AUT-CKPT-BAK';
      const state = makeCheckpointState(ticket, 'deploy_qa');
      const filePath = stateFilePath(ticket);
      const bakPath = filePath + '.bak';

      // Write valid backup
      const envelope = wrapEnvelope(state, TEST_SECRET);
      const bakData = JSON.stringify(envelope, null, 2);
      fs.writeFileSync(bakPath, bakData);

      // Write corrupt main file
      fs.writeFileSync(filePath, '{ corrupt json !!!');

      const warnings: string[] = [];
      const result = readStateFromDisk(filePath, {
        allowUnverified: false,
        onWarn: (msg) => warnings.push(msg),
      });

      expect(result).not.toBeNull();
      expect(result!.source).toBe('backup');
      expect(result!.state.ticket).toBe(ticket);
      expect(result!.state.stage).toBe('deploy_qa');
      expect(warnings.length).toBeGreaterThan(0);
    });
  });

  describe('crash recovery -- orphaned tmp files', () => {
    it('promotes valid orphan tmp when no main file exists', () => {
      const ticket = 'AUT-CKPT-TMP';
      const filePath = stateFilePath(ticket);
      const state = makeCheckpointState(ticket, 'test_qa');

      // Create an "orphaned" tmp file (simulating crash during write)
      const tmpFile = filePath + '.tmp.12345.9999.1';
      fs.writeFileSync(tmpFile, JSON.stringify(state));

      // Make it look old enough (>10s) by backdating mtime
      const oldTime = new Date(Date.now() - 30_000);
      fs.utimesSync(tmpFile, oldTime, oldTime);

      // No main file exists
      expect(fs.existsSync(filePath)).toBe(false);

      const recovered = recoverTmpFiles(filePath);

      expect(recovered.length).toBe(1);
      expect(recovered[0].action).toBe('promoted_to_main');

      // Main file should now exist
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('removes orphan tmp when main file already exists', () => {
      const ticket = 'AUT-CKPT-TMP2';
      const filePath = stateFilePath(ticket);
      const state = makeCheckpointState(ticket, 'test_qa');

      // Create main file
      const envelope = wrapEnvelope(state, TEST_SECRET);
      atomicWriteSync(filePath, envelope);

      // Create orphaned tmp
      const tmpFile = filePath + '.tmp.12345.9999.1';
      fs.writeFileSync(tmpFile, JSON.stringify({ old: 'data' }));
      const oldTime = new Date(Date.now() - 30_000);
      fs.utimesSync(tmpFile, oldTime, oldTime);

      const recovered = recoverTmpFiles(filePath);

      expect(recovered.length).toBe(1);
      expect(recovered[0].action).toBe('removed_orphan');
      expect(fs.existsSync(tmpFile)).toBe(false);
    });
  });

  describe('state pruning', () => {
    it('pruneState returns state unchanged when below threshold', () => {
      const state = makeCheckpointState('AUT-PRUNE', 'generate_code');
      const before = JSON.stringify(state);

      const pruned = pruneState(state);

      expect(JSON.stringify(pruned)).toBe(before);
    });
  });

  describe('quarantine', () => {
    it('quarantines corrupt files to quarantine directory', () => {
      const ticket = 'AUT-QUARANTINE';
      const filePath = stateFilePath(ticket);

      // Write a file to quarantine
      fs.writeFileSync(filePath, 'corrupt data');

      const dest = quarantineFile(filePath, tmpDir);

      expect(dest).not.toBeNull();
      expect(fs.existsSync(filePath)).toBe(false);
      expect(fs.existsSync(dest!)).toBe(true);
    });
  });
});
