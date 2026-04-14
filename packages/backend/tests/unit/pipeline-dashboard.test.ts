// =====================================================================
// pipeline-dashboard.test.ts -- Unit tests for pipeline dashboard
// =====================================================================
//
// Tests: scanAllStates, classifyPipeline, buildPipelineList,
//        getCachedPipelineList, invalidatePipelineCache,
//        cleanupStaleStates, deletePipeline, resume logic
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  scanAllStates,
  classifyPipeline,
  buildPipelineList,
  getCachedPipelineList,
  invalidatePipelineCache,
  cleanupStaleStates,
  deletePipeline,
  wrapEnvelope,
  computeHmac,
  _setStateSecret,
  type PipelineSummary,
} from '../../src/state/state-manager';
import type { PipelineState, PipelineData } from '@shared/types';

// ── Mock logger ──────────────────────────────────────────────────────

vi.mock('../../src/lib/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

// ── Mock native addon ────────────────────────────────────────────────

vi.mock('@native/mi-agent-core', () => {
  throw new Error('Native addon not available in tests');
});

// ── Helpers ──────────────────────────────────────────────────────────

const TEST_SECRET = 'a'.repeat(64);
let tmpDir: string;

function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    ticket: 'AUT-1234',
    stage: 'fetch_ticket',
    data: {},
    _seq: 1,
    ...overrides,
  };
}

function writeStateFile(dir: string, ticket: string, state: PipelineState): string {
  const envelope = wrapEnvelope(state, TEST_SECRET);
  const filePath = path.join(dir, `state-${ticket}.json`);
  fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2));
  return filePath;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ── Setup/Teardown ───────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join('/tmp', 'pipeline-test-'));
  _setStateSecret(TEST_SECRET);
  invalidatePipelineCache();
});

afterEach(() => {
  _setStateSecret(null);
  // Clean up tmp directory
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* best effort */ }
});

// ═════════════════════════════════════════════════════════════════════
// Task 8.1: scanAllStates tests
// ═════════════════════════════════════════════════════════════════════

describe('scanAllStates', () => {
  it('returns empty array for empty directory', () => {
    const results = scanAllStates(tmpDir);
    expect(results).toEqual([]);
  });

  it('scans multiple state files', () => {
    writeStateFile(tmpDir, 'AUT-100', makeState({ ticket: 'AUT-100', stage: 'fetch_ticket' }));
    writeStateFile(tmpDir, 'AUT-200', makeState({ ticket: 'AUT-200', stage: 'generate_code' }));
    writeStateFile(tmpDir, 'AUT-300', makeState({ ticket: 'AUT-300', stage: 'done' }));

    const results = scanAllStates(tmpDir);

    expect(results).toHaveLength(3);
    const tickets = results.map(r => r.ticket).sort();
    expect(tickets).toEqual(['AUT-100', 'AUT-200', 'AUT-300']);
  });

  it('returns correct state data for each file', () => {
    writeStateFile(tmpDir, 'AUT-100', makeState({
      ticket: 'AUT-100',
      stage: 'generate_code',
      data: { _lastActivity: '2026-01-01T00:00:00Z' } as PipelineData,
    }));

    const results = scanAllStates(tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0].ticket).toBe('AUT-100');
    expect(results[0].state.stage).toBe('generate_code');
    expect((results[0].state.data as Record<string, unknown>)._lastActivity).toBe('2026-01-01T00:00:00Z');
  });

  it('skips non-state files', () => {
    writeStateFile(tmpDir, 'AUT-100', makeState({ ticket: 'AUT-100' }));
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'agent-AUT-100.log'), 'some log');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

    const results = scanAllStates(tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0].ticket).toBe('AUT-100');
  });

  it('skips backup and tmp files', () => {
    writeStateFile(tmpDir, 'AUT-100', makeState({ ticket: 'AUT-100' }));
    fs.writeFileSync(path.join(tmpDir, 'state-AUT-100.json.bak'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'state-AUT-100.json.tmp.123'), '{}');

    const results = scanAllStates(tmpDir);

    expect(results).toHaveLength(1);
  });

  it('skips corrupt/unparseable state files', () => {
    writeStateFile(tmpDir, 'AUT-100', makeState({ ticket: 'AUT-100' }));
    fs.writeFileSync(path.join(tmpDir, 'state-AUT-200.json'), 'NOT VALID JSON');

    const results = scanAllStates(tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0].ticket).toBe('AUT-100');
  });

  it('skips files with invalid ticket format', () => {
    writeStateFile(tmpDir, 'AUT-100', makeState({ ticket: 'AUT-100' }));
    // Invalid ticket format: no number
    fs.writeFileSync(path.join(tmpDir, 'state-invalid.json'), '{}');
    // Also invalid: no dash
    fs.writeFileSync(path.join(tmpDir, 'state-123.json'), '{}');

    const results = scanAllStates(tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0].ticket).toBe('AUT-100');
  });

  it('returns filePath for each scanned state', () => {
    writeStateFile(tmpDir, 'AUT-100', makeState({ ticket: 'AUT-100' }));

    const results = scanAllStates(tmpDir);

    expect(results[0].filePath).toBe(path.join(tmpDir, 'state-AUT-100.json'));
  });

  it('returns empty array for non-existent directory', () => {
    const results = scanAllStates('/tmp/nonexistent-dir-' + Date.now());
    expect(results).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Task 8.1 continued: classifyPipeline tests
// ═════════════════════════════════════════════════════════════════════

describe('classifyPipeline', () => {
  it('classifies a running pipeline', () => {
    const state = makeState({
      ticket: 'AUT-100',
      stage: 'generate_code',
      data: {
        _lastActivity: new Date().toISOString(),
        startedAt: daysAgo(0),
      } as PipelineData,
    });

    const result = classifyPipeline('AUT-100', state, true);

    expect(result.status).toBe('running');
    expect(result.running).toBe(true);
    expect(result.resumable).toBe(false);
    expect(result.ticket).toBe('AUT-100');
    expect(result.stage).toBe('generate_code');
  });

  it('classifies a done pipeline', () => {
    const state = makeState({
      ticket: 'AUT-100',
      stage: 'done',
      data: { _lastActivity: daysAgo(1) } as PipelineData,
    });

    const result = classifyPipeline('AUT-100', state, false);

    expect(result.status).toBe('done');
    expect(result.running).toBe(false);
    expect(result.resumable).toBe(false);
  });

  it('classifies an expired pipeline (>7 days)', () => {
    const state = makeState({
      ticket: 'AUT-100',
      stage: 'generate_code',
      data: { _lastActivity: daysAgo(8) } as PipelineData,
    });

    const result = classifyPipeline('AUT-100', state, false);

    expect(result.status).toBe('expired');
    expect(result.resumable).toBe(false);
    expect(result.daysRemaining).toBe(0);
  });

  it('classifies a gate_waiting pipeline', () => {
    const state = makeState({
      ticket: 'AUT-100',
      stage: 'gate_code_review',
      data: { _lastActivity: daysAgo(1) } as PipelineData,
    });

    const result = classifyPipeline('AUT-100', state, false);

    expect(result.status).toBe('gate_waiting');
    expect(result.needsApproval).toBe(true);
    expect(result.gateStage).toBe('gate_code_review');
    expect(result.resumable).toBe(true);
  });

  it('classifies a paused pipeline', () => {
    const state = makeState({
      ticket: 'AUT-100',
      stage: 'generate_code',
      data: { _lastActivity: daysAgo(2) } as PipelineData,
    });

    const result = classifyPipeline('AUT-100', state, false);

    expect(result.status).toBe('paused');
    expect(result.resumable).toBe(true);
    expect(result.daysRemaining).toBeGreaterThan(0);
  });

  it('computes progress correctly', () => {
    // fetch_ticket is index 0 of 11 stages (0-10)
    const state0 = makeState({ stage: 'fetch_ticket', data: {} as PipelineData });
    expect(classifyPipeline('T-1', state0, false).progress).toBe(0);

    // done is index 10 of 11 stages
    const state10 = makeState({ stage: 'done', data: {} as PipelineData });
    expect(classifyPipeline('T-1', state10, false).progress).toBe(1);

    // generate_code is index 2 of 11 stages = 2/10 = 0.2
    const state2 = makeState({ stage: 'generate_code', data: {} as PipelineData });
    expect(classifyPipeline('T-1', state2, false).progress).toBe(0.2);
  });

  it('computes daysRemaining within the 7-day window', () => {
    const state = makeState({
      ticket: 'AUT-100',
      stage: 'generate_code',
      data: { _lastActivity: daysAgo(3) } as PipelineData,
    });

    const result = classifyPipeline('AUT-100', state, false);

    // 7 - 3 = ~4 days remaining
    expect(result.daysRemaining).toBeGreaterThanOrEqual(3.5);
    expect(result.daysRemaining).toBeLessThanOrEqual(4.5);
  });

  it('tracks resumeCount from state data', () => {
    const state = makeState({
      ticket: 'AUT-100',
      stage: 'generate_code',
      data: { _resumeCount: 3, _lastActivity: daysAgo(1) } as PipelineData,
    });

    const result = classifyPipeline('AUT-100', state, false);

    expect(result.resumeCount).toBe(3);
  });

  it('defaults resumeCount to 0', () => {
    const state = makeState({
      ticket: 'AUT-100',
      stage: 'generate_code',
      data: { _lastActivity: daysAgo(1) } as PipelineData,
    });

    const result = classifyPipeline('AUT-100', state, false);

    expect(result.resumeCount).toBe(0);
  });

  it('needsApproval is true for all gate stages', () => {
    for (const gate of ['gate_code_review', 'gate_preprod_approval', 'gate_dual_approval'] as const) {
      const state = makeState({
        stage: gate,
        data: { _lastActivity: daysAgo(1) } as PipelineData,
      });
      const result = classifyPipeline('T-1', state, false);
      expect(result.needsApproval).toBe(true);
      expect(result.gateStage).toBe(gate);
    }
  });

  it('needsApproval is false for non-gate stages', () => {
    for (const stage of ['fetch_ticket', 'generate_code', 'deploy_qa', 'done'] as const) {
      const state = makeState({
        stage,
        data: { _lastActivity: daysAgo(1) } as PipelineData,
      });
      const result = classifyPipeline('T-1', state, false);
      expect(result.needsApproval).toBe(false);
      expect(result.gateStage).toBeNull();
    }
  });

  it('running status takes precedence over gate_waiting', () => {
    const state = makeState({
      stage: 'gate_code_review',
      data: { _lastActivity: daysAgo(0) } as PipelineData,
    });

    const result = classifyPipeline('T-1', state, true);

    expect(result.status).toBe('running');
  });

  it('uses startedAt field from data', () => {
    const startedAt = daysAgo(2);
    const state = makeState({
      ticket: 'AUT-100',
      stage: 'generate_code',
      data: { startedAt, _lastActivity: daysAgo(1) } as PipelineData,
    });

    const result = classifyPipeline('AUT-100', state, false);

    expect(result.startedAt).toBe(startedAt);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Task 8.1: buildPipelineList tests
// ═════════════════════════════════════════════════════════════════════

describe('buildPipelineList', () => {
  it('builds a list from scanned state files', () => {
    writeStateFile(tmpDir, 'AUT-100', makeState({
      ticket: 'AUT-100',
      stage: 'generate_code',
      data: { _lastActivity: daysAgo(1) } as PipelineData,
    }));
    writeStateFile(tmpDir, 'AUT-200', makeState({
      ticket: 'AUT-200',
      stage: 'done',
      data: { _lastActivity: daysAgo(2) } as PipelineData,
    }));

    const list = buildPipelineList({}, tmpDir);

    expect(list).toHaveLength(2);
    const tickets = list.map(p => p.ticket).sort();
    expect(tickets).toEqual(['AUT-100', 'AUT-200']);
  });

  it('marks running pipelines based on agentProcs', () => {
    writeStateFile(tmpDir, 'AUT-100', makeState({
      ticket: 'AUT-100',
      stage: 'generate_code',
      data: { _lastActivity: daysAgo(0) } as PipelineData,
    }));
    writeStateFile(tmpDir, 'AUT-200', makeState({
      ticket: 'AUT-200',
      stage: 'deploy_qa',
      data: { _lastActivity: daysAgo(0) } as PipelineData,
    }));

    const agentProcs = { 'AUT-100': { pid: 1234 } };
    const list = buildPipelineList(agentProcs, tmpDir);

    const running = list.find(p => p.ticket === 'AUT-100');
    const notRunning = list.find(p => p.ticket === 'AUT-200');

    expect(running?.status).toBe('running');
    expect(running?.running).toBe(true);
    expect(notRunning?.status).toBe('paused');
    expect(notRunning?.running).toBe(false);
  });

  it('returns empty list for empty directory', () => {
    const list = buildPipelineList({}, tmpDir);
    expect(list).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Task 8.3: getCachedPipelineList + invalidation tests
// ═════════════════════════════════════════════════════════════════════

describe('getCachedPipelineList', () => {
  it('returns fresh list on first call', () => {
    writeStateFile(tmpDir, 'AUT-100', makeState({
      ticket: 'AUT-100',
      stage: 'fetch_ticket',
      data: { _lastActivity: daysAgo(0) } as PipelineData,
    }));

    const list = getCachedPipelineList({}, tmpDir);

    expect(list).toHaveLength(1);
    expect(list[0].ticket).toBe('AUT-100');
  });

  it('returns cached result on second call within TTL', () => {
    writeStateFile(tmpDir, 'AUT-100', makeState({
      ticket: 'AUT-100',
      data: { _lastActivity: daysAgo(0) } as PipelineData,
    }));

    const list1 = getCachedPipelineList({}, tmpDir);

    // Add another state file (should not appear due to cache)
    writeStateFile(tmpDir, 'AUT-200', makeState({
      ticket: 'AUT-200',
      data: { _lastActivity: daysAgo(0) } as PipelineData,
    }));

    const list2 = getCachedPipelineList({}, tmpDir);

    expect(list2).toHaveLength(1); // Still cached, doesn't see AUT-200
    expect(list1).toBe(list2); // Same reference
  });

  it('returns fresh result after invalidation', () => {
    writeStateFile(tmpDir, 'AUT-100', makeState({
      ticket: 'AUT-100',
      data: { _lastActivity: daysAgo(0) } as PipelineData,
    }));

    getCachedPipelineList({}, tmpDir); // Populate cache

    writeStateFile(tmpDir, 'AUT-200', makeState({
      ticket: 'AUT-200',
      data: { _lastActivity: daysAgo(0) } as PipelineData,
    }));

    invalidatePipelineCache();

    const list = getCachedPipelineList({}, tmpDir);

    expect(list).toHaveLength(2);
  });
});

describe('invalidatePipelineCache', () => {
  it('clears the cache so next call rebuilds', () => {
    writeStateFile(tmpDir, 'AUT-100', makeState({
      ticket: 'AUT-100',
      data: { _lastActivity: daysAgo(0) } as PipelineData,
    }));

    const list1 = getCachedPipelineList({}, tmpDir);
    expect(list1).toHaveLength(1);

    // Delete the state file
    fs.unlinkSync(path.join(tmpDir, 'state-AUT-100.json'));
    invalidatePipelineCache();

    const list2 = getCachedPipelineList({}, tmpDir);
    expect(list2).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// cleanupStaleStates tests
// ═════════════════════════════════════════════════════════════════════

describe('cleanupStaleStates', () => {
  it('archives done pipelines older than 30 days', () => {
    writeStateFile(tmpDir, 'AUT-9001', makeState({
      ticket: 'AUT-9001',
      stage: 'done',
      data: { _lastActivity: daysAgo(35) } as PipelineData,
    }));

    const result = cleanupStaleStates(tmpDir);

    expect(result.archived).toContain('AUT-9001');
    expect(fs.existsSync(path.join(tmpDir, 'state-AUT-9001.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.state-archive', 'state-AUT-9001.json'))).toBe(true);
  });

  it('does not archive done pipelines under 30 days', () => {
    writeStateFile(tmpDir, 'AUT-9002', makeState({
      ticket: 'AUT-9002',
      stage: 'done',
      data: { _lastActivity: daysAgo(10) } as PipelineData,
    }));

    const result = cleanupStaleStates(tmpDir);

    expect(result.archived).not.toContain('AUT-9002');
    expect(fs.existsSync(path.join(tmpDir, 'state-AUT-9002.json'))).toBe(true);
  });

  it('archives expired (non-done) pipelines older than 14 days', () => {
    writeStateFile(tmpDir, 'AUT-9003', makeState({
      ticket: 'AUT-9003',
      stage: 'generate_code',
      data: { _lastActivity: daysAgo(15) } as PipelineData,
    }));

    const result = cleanupStaleStates(tmpDir);

    expect(result.archived).toContain('AUT-9003');
  });

  it('does not archive active pipelines within resume window', () => {
    writeStateFile(tmpDir, 'AUT-9004', makeState({
      ticket: 'AUT-9004',
      stage: 'generate_code',
      data: { _lastActivity: daysAgo(3) } as PipelineData,
    }));

    const result = cleanupStaleStates(tmpDir);

    expect(result.archived).not.toContain('AUT-9004');
  });

  it('also archives accompanying log and backup files', () => {
    writeStateFile(tmpDir, 'AUT-9005', makeState({
      ticket: 'AUT-9005',
      stage: 'done',
      data: { _lastActivity: daysAgo(35) } as PipelineData,
    }));
    fs.writeFileSync(path.join(tmpDir, 'agent-AUT-9005.log'), 'log data');
    fs.writeFileSync(path.join(tmpDir, 'state-AUT-9005.json.bak'), '{}');

    cleanupStaleStates(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, 'agent-AUT-9005.log'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.state-archive', 'agent-AUT-9005.log'))).toBe(true);
  });

  it('deletes archived files older than 7 days', () => {
    const archiveDir = path.join(tmpDir, '.state-archive');
    fs.mkdirSync(archiveDir, { recursive: true });

    const oldFile = path.join(archiveDir, 'state-AUT-9006.json');
    fs.writeFileSync(oldFile, '{}');
    // Set mtime to 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);

    const result = cleanupStaleStates(tmpDir);

    expect(result.deleted).toContain('state-AUT-9006.json');
    expect(fs.existsSync(oldFile)).toBe(false);
  });

  it('preserves recently archived files', () => {
    const archiveDir = path.join(tmpDir, '.state-archive');
    fs.mkdirSync(archiveDir, { recursive: true });

    const recentFile = path.join(archiveDir, 'state-AUT-9007.json');
    fs.writeFileSync(recentFile, '{}');

    const result = cleanupStaleStates(tmpDir);

    expect(result.deleted).not.toContain('state-AUT-9007.json');
    expect(fs.existsSync(recentFile)).toBe(true);
  });

  it('handles empty directory gracefully', () => {
    const result = cleanupStaleStates(tmpDir);
    expect(result.archived).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// deletePipeline tests
// ═════════════════════════════════════════════════════════════════════

describe('deletePipeline', () => {
  it('deletes state file, backup, and log file', () => {
    writeStateFile(tmpDir, 'AUT-100', makeState({ ticket: 'AUT-100' }));
    fs.writeFileSync(path.join(tmpDir, 'state-AUT-100.json.bak'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'agent-AUT-100.log'), 'logs');

    const result = deletePipeline('AUT-100', tmpDir);

    expect(result).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'state-AUT-100.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'state-AUT-100.json.bak'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'agent-AUT-100.log'))).toBe(false);
  });

  it('returns false when no files exist', () => {
    const result = deletePipeline('AUT-NONEXISTENT', tmpDir);
    expect(result).toBe(false);
  });

  it('invalidates pipeline cache after deletion', () => {
    writeStateFile(tmpDir, 'AUT-100', makeState({
      ticket: 'AUT-100',
      data: { _lastActivity: daysAgo(0) } as PipelineData,
    }));
    writeStateFile(tmpDir, 'AUT-200', makeState({
      ticket: 'AUT-200',
      data: { _lastActivity: daysAgo(0) } as PipelineData,
    }));

    // Populate cache
    const before = getCachedPipelineList({}, tmpDir);
    expect(before).toHaveLength(2);

    // Delete one pipeline (also invalidates cache internally)
    deletePipeline('AUT-100', tmpDir);

    const after = getCachedPipelineList({}, tmpDir);
    expect(after).toHaveLength(1);
    expect(after[0].ticket).toBe('AUT-200');
  });

  it('handles partial deletion (only log exists)', () => {
    fs.writeFileSync(path.join(tmpDir, 'agent-AUT-100.log'), 'logs');

    const result = deletePipeline('AUT-100', tmpDir);

    expect(result).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'agent-AUT-100.log'))).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Task 8.2: Resume logic tests
// (These test the data structures that the route handler uses)
// ═════════════════════════════════════════════════════════════════════

describe('resume logic data structures', () => {
  it('7-day window calculation: within window is resumable', () => {
    const state = makeState({
      ticket: 'AUT-100',
      stage: 'generate_code',
      data: { _lastActivity: daysAgo(5) } as PipelineData,
    });

    const result = classifyPipeline('AUT-100', state, false);

    expect(result.resumable).toBe(true);
    expect(result.status).toBe('paused');
    expect(result.daysRemaining).toBeGreaterThan(0);
  });

  it('7-day window calculation: at boundary (7 days) is expired', () => {
    const state = makeState({
      ticket: 'AUT-100',
      stage: 'generate_code',
      data: { _lastActivity: daysAgo(7.1) } as PipelineData,
    });

    const result = classifyPipeline('AUT-100', state, false);

    expect(result.resumable).toBe(false);
    expect(result.status).toBe('expired');
    expect(result.daysRemaining).toBe(0);
  });

  it('resume history tracked via _resumeCount', () => {
    const state = makeState({
      ticket: 'AUT-100',
      stage: 'generate_code',
      data: {
        _lastActivity: daysAgo(1),
        _resumeCount: 5,
        _resumeHistory: [
          { at: daysAgo(5), stage: 'generate_code' },
          { at: daysAgo(3), stage: 'generate_code' },
        ],
      } as PipelineData,
    });

    const result = classifyPipeline('AUT-100', state, false);

    expect(result.resumeCount).toBe(5);
    expect(result.resumable).toBe(true);
  });

  it('done pipelines are not resumable', () => {
    const state = makeState({
      ticket: 'AUT-100',
      stage: 'done',
      data: { _lastActivity: daysAgo(1) } as PipelineData,
    });

    const result = classifyPipeline('AUT-100', state, false);

    expect(result.resumable).toBe(false);
    expect(result.status).toBe('done');
  });

  it('running pipelines are not resumable', () => {
    const state = makeState({
      ticket: 'AUT-100',
      stage: 'generate_code',
      data: { _lastActivity: daysAgo(0) } as PipelineData,
    });

    const result = classifyPipeline('AUT-100', state, true);

    expect(result.resumable).toBe(false);
    expect(result.status).toBe('running');
  });

  it('expired rejection message data', () => {
    const state = makeState({
      ticket: 'AUT-100',
      stage: 'generate_code',
      data: { _lastActivity: daysAgo(10) } as PipelineData,
    });

    const result = classifyPipeline('AUT-100', state, false);

    // The route handler would use this data to construct the error message
    expect(result.status).toBe('expired');
    expect(result.daysRemaining).toBe(0);
    expect(result.resumable).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Task 8.3: Response shape tests
// ═════════════════════════════════════════════════════════════════════

describe('PipelineSummary response shape', () => {
  it('has all required fields', () => {
    const state = makeState({
      ticket: 'AUT-100',
      stage: 'gate_code_review',
      data: {
        _lastActivity: daysAgo(1),
        startedAt: daysAgo(2),
        _resumeCount: 1,
      } as PipelineData,
    });

    const summary: PipelineSummary = classifyPipeline('AUT-100', state, false);

    expect(summary).toHaveProperty('ticket');
    expect(summary).toHaveProperty('stage');
    expect(summary).toHaveProperty('startedAt');
    expect(summary).toHaveProperty('lastActivity');
    expect(summary).toHaveProperty('running');
    expect(summary).toHaveProperty('resumable');
    expect(summary).toHaveProperty('daysRemaining');
    expect(summary).toHaveProperty('needsApproval');
    expect(summary).toHaveProperty('gateStage');
    expect(summary).toHaveProperty('progress');
    expect(summary).toHaveProperty('status');
    expect(summary).toHaveProperty('resumeCount');

    // Validate types
    expect(typeof summary.ticket).toBe('string');
    expect(typeof summary.stage).toBe('string');
    expect(typeof summary.running).toBe('boolean');
    expect(typeof summary.resumable).toBe('boolean');
    expect(typeof summary.daysRemaining).toBe('number');
    expect(typeof summary.needsApproval).toBe('boolean');
    expect(typeof summary.progress).toBe('number');
    expect(typeof summary.status).toBe('string');
    expect(typeof summary.resumeCount).toBe('number');
  });

  it('progress is between 0 and 1', () => {
    const stages = [
      'fetch_ticket', 'explore_plan', 'generate_code',
      'gate_code_review', 'deploy_qa', 'test_qa',
      'gate_preprod_approval', 'create_preprod_mr',
      'gate_dual_approval', 'deploy_prod', 'done',
    ] as const;

    for (const stage of stages) {
      const state = makeState({
        stage,
        data: { _lastActivity: daysAgo(0) } as PipelineData,
      });
      const result = classifyPipeline('T-1', state, false);
      expect(result.progress).toBeGreaterThanOrEqual(0);
      expect(result.progress).toBeLessThanOrEqual(1);
    }
  });

  it('status is one of the valid values', () => {
    const validStatuses = ['running', 'paused', 'gate_waiting', 'done', 'expired'];

    // Test various states
    const scenarios = [
      { stage: 'generate_code' as const, running: true, lastActivity: daysAgo(0) },
      { stage: 'generate_code' as const, running: false, lastActivity: daysAgo(2) },
      { stage: 'gate_code_review' as const, running: false, lastActivity: daysAgo(1) },
      { stage: 'done' as const, running: false, lastActivity: daysAgo(1) },
      { stage: 'generate_code' as const, running: false, lastActivity: daysAgo(10) },
    ];

    for (const s of scenarios) {
      const state = makeState({
        stage: s.stage,
        data: { _lastActivity: s.lastActivity } as PipelineData,
      });
      const result = classifyPipeline('T-1', state, s.running);
      expect(validStatuses).toContain(result.status);
    }
  });
});
