// =====================================================================
// state-manager.test.ts -- Unit tests for state management
// =====================================================================
//
// Tests: HMAC envelope wrap/unwrap, CAS via _seq,
//        V2/V3 backward compatibility, pruneState, mergeUIFieldsFromDisk
// =====================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import {
  wrapEnvelope,
  unwrapEnvelope,
  computeHmac,
  pruneState,
  mergeUIFieldsFromDisk,
  applyUIPatch,
  _setStateSecret,
} from '../../src/state/state-manager';
import type { PipelineState, PipelineData } from '@shared/types';

// ── Mock logger ──────────────────────────────────────────────────────

vi.mock('../../src/lib/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

// ── Mock native addon (not available in test environment) ────────────

vi.mock('@native/mi-agent-core', () => {
  throw new Error('Native addon not available in tests');
});

// ── Helpers ──────────────────────────────────────────────────────────

const TEST_SECRET = 'a'.repeat(64); // 64-char hex string for testing

function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    ticket: 'AUT-1234',
    stage: 'fetch_ticket',
    data: {},
    _seq: 1,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// computeHmac Tests
// ═══════════════════════════════════════════════════════════════════════

describe('computeHmac', () => {
  it('returns a 64-char hex string (SHA256)', () => {
    const state = makeState();
    const hmac = computeHmac(state, TEST_SECRET);

    expect(hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same HMAC for the same state and secret', () => {
    const state = makeState();
    const hmac1 = computeHmac(state, TEST_SECRET);
    const hmac2 = computeHmac(state, TEST_SECRET);

    expect(hmac1).toBe(hmac2);
  });

  it('returns different HMACs for different states', () => {
    const state1 = makeState({ stage: 'fetch_ticket' });
    const state2 = makeState({ stage: 'generate_code' });

    const hmac1 = computeHmac(state1, TEST_SECRET);
    const hmac2 = computeHmac(state2, TEST_SECRET);

    expect(hmac1).not.toBe(hmac2);
  });

  it('returns different HMACs for different secrets', () => {
    const state = makeState();
    const hmac1 = computeHmac(state, 'secret-alpha');
    const hmac2 = computeHmac(state, 'secret-bravo');

    expect(hmac1).not.toBe(hmac2);
  });

  it('computes HMAC using Node.js crypto (fallback path)', () => {
    const state = makeState();
    const hmac = computeHmac(state, TEST_SECRET);

    // Verify manually
    const payload = JSON.stringify(state, null, 2);
    const expected = crypto.createHmac('sha256', TEST_SECRET).update(payload).digest('hex');

    expect(hmac).toBe(expected);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// wrapEnvelope Tests
// ═══════════════════════════════════════════════════════════════════════

describe('wrapEnvelope', () => {
  it('creates a V3 envelope with correct structure', () => {
    const state = makeState({ _seq: 5 });
    const envelope = wrapEnvelope(state, TEST_SECRET);

    expect(envelope._version).toBe(3);
    expect(envelope._hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(envelope._seq).toBe(6); // _seq + 1
    expect(envelope._written_by).toBe(process.pid);
    expect(envelope._written_at).toBeDefined();
    expect(envelope.state).toBe(state);
  });

  it('increments _seq from 0 to 1', () => {
    const state = makeState({ _seq: 0 });
    const envelope = wrapEnvelope(state, TEST_SECRET);

    expect(envelope._seq).toBe(1);
  });

  it('increments _seq from undefined (treated as 0) to 1', () => {
    const state = makeState();
    delete state._seq;
    const envelope = wrapEnvelope(state, TEST_SECRET);

    expect(envelope._seq).toBe(1);
  });

  it('produces a verifiable HMAC', () => {
    const state = makeState();
    const envelope = wrapEnvelope(state, TEST_SECRET);
    const expectedHmac = computeHmac(state, TEST_SECRET);

    expect(envelope._hmac).toBe(expectedHmac);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// unwrapEnvelope Tests — V3
// ═══════════════════════════════════════════════════════════════════════

describe('unwrapEnvelope (V3)', () => {
  it('unwraps a valid V3 envelope with valid=true', () => {
    const state = makeState({ _seq: 3 });
    const envelope = wrapEnvelope(state, TEST_SECRET);
    const raw = JSON.stringify(envelope, null, 2);

    const result = unwrapEnvelope(raw, TEST_SECRET, 'main');

    expect(result.valid).toBe(true);
    expect(result.version).toBe(3);
    expect(result.seq).toBe(4); // _seq was incremented by wrapEnvelope
    expect(result.state.ticket).toBe('AUT-1234');
    expect(result.state.stage).toBe('fetch_ticket');
  });

  it('detects tampered state (valid=false)', () => {
    const state = makeState();
    const envelope = wrapEnvelope(state, TEST_SECRET);

    // Tamper with the state inside the envelope
    envelope.state.ticket = 'TAMPERED-999';
    const raw = JSON.stringify(envelope, null, 2);

    const result = unwrapEnvelope(raw, TEST_SECRET, 'main');

    expect(result.valid).toBe(false);
    expect(result.state.ticket).toBe('TAMPERED-999'); // State is still returned
  });

  it('detects wrong secret (valid=false)', () => {
    const state = makeState();
    const envelope = wrapEnvelope(state, TEST_SECRET);
    const raw = JSON.stringify(envelope, null, 2);

    const result = unwrapEnvelope(raw, 'wrong-secret', 'main');

    expect(result.valid).toBe(false);
  });

  it('returns seq from envelope._seq', () => {
    const state = makeState({ _seq: 10 });
    const envelope = wrapEnvelope(state, TEST_SECRET);
    const raw = JSON.stringify(envelope, null, 2);

    const result = unwrapEnvelope(raw, TEST_SECRET, 'main');

    expect(result.seq).toBe(11); // 10 + 1 from wrap
  });
});

// ═══════════════════════════════════════════════════════════════════════
// unwrapEnvelope Tests — V2 Backward Compatibility
// ═══════════════════════════════════════════════════════════════════════

describe('unwrapEnvelope (V2 backward compat)', () => {
  it('reads a V2 envelope and verifies HMAC', () => {
    const state = makeState();
    const stateJson = JSON.stringify(state, null, 2);
    const hmac = crypto.createHmac('sha256', TEST_SECRET).update(stateJson).digest('hex');

    const v2Envelope = {
      _version: 2,
      _hmac: hmac,
      state,
    };
    const raw = JSON.stringify(v2Envelope, null, 2);

    const result = unwrapEnvelope(raw, TEST_SECRET, 'main');

    expect(result.valid).toBe(true);
    expect(result.version).toBe(2);
    expect(result.state.ticket).toBe('AUT-1234');
  });

  it('detects tampered V2 envelope (valid=false)', () => {
    const state = makeState();
    const stateJson = JSON.stringify(state, null, 2);
    const hmac = crypto.createHmac('sha256', TEST_SECRET).update(stateJson).digest('hex');

    const v2Envelope = {
      _version: 2,
      _hmac: hmac,
      state: { ...state, ticket: 'TAMPERED' },
    };
    const raw = JSON.stringify(v2Envelope, null, 2);

    const result = unwrapEnvelope(raw, TEST_SECRET, 'main');

    expect(result.valid).toBe(false);
    expect(result.version).toBe(2);
  });

  it('extracts _seq from state when V2 has no top-level _seq', () => {
    const state = makeState({ _seq: 7 });
    const stateJson = JSON.stringify(state, null, 2);
    const hmac = crypto.createHmac('sha256', TEST_SECRET).update(stateJson).digest('hex');

    const v2Envelope = {
      _version: 2,
      _hmac: hmac,
      state,
    };
    const raw = JSON.stringify(v2Envelope, null, 2);

    const result = unwrapEnvelope(raw, TEST_SECRET, 'main');

    expect(result.seq).toBe(7);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// unwrapEnvelope Tests — V1 (plain state, no envelope)
// ═══════════════════════════════════════════════════════════════════════

describe('unwrapEnvelope (V1 plain state)', () => {
  it('reads a V1 plain state with valid=false (unverified)', () => {
    const plainState = makeState();
    const raw = JSON.stringify(plainState);

    const result = unwrapEnvelope(raw, TEST_SECRET, 'main');

    expect(result.valid).toBe(false);
    expect(result.version).toBe(1);
    expect(result.seq).toBe(0);
    expect(result.state.ticket).toBe('AUT-1234');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// unwrapEnvelope Tests — Error handling
// ═══════════════════════════════════════════════════════════════════════

describe('unwrapEnvelope error handling', () => {
  it('throws on unparseable JSON', () => {
    expect(() => unwrapEnvelope('NOT VALID JSON', TEST_SECRET)).toThrow();
  });

  it('throws on unrecognized format (object without stage or _version)', () => {
    expect(() => unwrapEnvelope('{"foo":"bar"}', TEST_SECRET)).toThrow(/Unrecognized state format/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CAS via _seq Tests
// ═══════════════════════════════════════════════════════════════════════

describe('CAS via _seq (compare-and-swap)', () => {
  it('wrapEnvelope increments _seq monotonically', () => {
    const state = makeState({ _seq: 1 });

    const e1 = wrapEnvelope(state, TEST_SECRET);
    expect(e1._seq).toBe(2);

    state._seq = e1._seq;
    const e2 = wrapEnvelope(state, TEST_SECRET);
    expect(e2._seq).toBe(3);

    state._seq = e2._seq;
    const e3 = wrapEnvelope(state, TEST_SECRET);
    expect(e3._seq).toBe(4);
  });

  it('unwrapped seq matches wrapped seq', () => {
    const state = makeState({ _seq: 5 });
    const envelope = wrapEnvelope(state, TEST_SECRET);
    const raw = JSON.stringify(envelope, null, 2);

    const result = unwrapEnvelope(raw, TEST_SECRET, 'main');

    expect(result.seq).toBe(envelope._seq);
  });

  it('CAS conflict detectable via _seq mismatch', () => {
    const state = makeState({ _seq: 5 });

    // Writer A wraps with seq 5 -> envelope seq 6
    const envelopeA = wrapEnvelope(state, TEST_SECRET);

    // Writer B also wraps with seq 5 -> envelope seq 6
    const envelopeB = wrapEnvelope(state, TEST_SECRET);

    // Both have the same _seq = 6, so a CAS-aware reader can detect
    // that both wrote from the same base (no conflict IF changes are mergeable,
    // conflict IF they're not)
    expect(envelopeA._seq).toBe(envelopeB._seq);

    // If a writer expected seq 7 but found 6, that's a mismatch
    const memSeq = 7;
    const diskSeq = envelopeA._seq; // 6
    expect(memSeq).not.toBe(diskSeq); // CAS conflict detected
  });
});

// ═══════════════════════════════════════════════════════════════════════
// pruneState Tests
// ═══════════════════════════════════════════════════════════════════════

describe('pruneState', () => {
  it('returns state unchanged when below threshold', () => {
    const state = makeState();
    const result = pruneState(state);

    expect(result).toBe(state);
  });

  it('returns state unchanged for null/undefined state', () => {
    expect(pruneState(null as unknown as PipelineState)).toBeNull();
  });

  it('trims metrics runs when over threshold', () => {
    const state = makeState();
    // Create a large state that exceeds the 8MB prune threshold
    const bigPayload = 'x'.repeat(100_000);
    state.data._metrics = {} as Record<string, { runs: unknown[] }>;
    for (let i = 0; i < 50; i++) {
      (state.data._metrics as Record<string, { runs: unknown[] }>)[`stage_${i}`] = {
        runs: Array(10).fill({ data: bigPayload }),
      };
    }

    const before = JSON.stringify(state).length;
    // Only prune if above threshold; we need to verify the logic path
    if (before >= 8_000_000) {
      const result = pruneState(state);
      // Each stage should have at most 3 runs
      for (const key of Object.keys(result.data._metrics as Record<string, { runs: unknown[] }>)) {
        const m = (result.data._metrics as Record<string, { runs: unknown[] }>)[key];
        expect(m.runs.length).toBeLessThanOrEqual(3);
      }
    }
  });

  it('trims warnings array when over threshold', () => {
    const state = makeState();
    const bigWarning = { stage: 'test', message: 'w'.repeat(200_000), timestamp: '' };
    (state.data as Record<string, unknown>)._warnings = Array(100).fill(bigWarning);

    const size = JSON.stringify(state).length;
    if (size >= 8_000_000) {
      const result = pruneState(state);
      const warnings = (result.data as Record<string, unknown>)._warnings as unknown[];
      expect(warnings.length).toBeLessThanOrEqual(50);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// mergeUIFieldsFromDisk Tests
// ═══════════════════════════════════════════════════════════════════════

describe('mergeUIFieldsFromDisk', () => {
  it('copies UI fields from disk state to memory state', () => {
    const memState = makeState();
    const diskState = makeState();
    (diskState.data as Record<string, unknown>).gate1_ui_approved = true;
    (diskState.data as Record<string, unknown>).gate1_ui_feedback = 'looks good';

    mergeUIFieldsFromDisk(memState, diskState);

    expect((memState.data as Record<string, unknown>).gate1_ui_approved).toBe(true);
    expect((memState.data as Record<string, unknown>).gate1_ui_feedback).toBe('looks good');
  });

  it('does not overwrite existing memory UI fields', () => {
    const memState = makeState();
    (memState.data as Record<string, unknown>).gate1_ui_approved = false;
    const diskState = makeState();
    (diskState.data as Record<string, unknown>).gate1_ui_approved = true;

    mergeUIFieldsFromDisk(memState, diskState);

    // Memory value should NOT be overwritten since it's already defined
    expect((memState.data as Record<string, unknown>).gate1_ui_approved).toBe(false);
  });

  it('does not copy non-UI fields', () => {
    const memState = makeState();
    const diskState = makeState();
    (diskState.data as Record<string, unknown>).code_branch = 'enterprise-ts-AUT-1234';

    mergeUIFieldsFromDisk(memState, diskState);

    expect((memState.data as Record<string, unknown>).code_branch).toBeUndefined();
  });

  it('handles null/undefined disk state gracefully', () => {
    const memState = makeState();

    // Should not throw
    mergeUIFieldsFromDisk(memState, null as unknown as PipelineState);
    mergeUIFieldsFromDisk(memState, undefined as unknown as PipelineState);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// applyUIPatch Tests
// ═══════════════════════════════════════════════════════════════════════

describe('applyUIPatch', () => {
  it('sets UI fields with the gate prefix', () => {
    const state = makeState();

    const result = applyUIPatch(state, 'gate1', { _ui_approved: true });

    expect((result.data as Record<string, unknown>).gate1_ui_approved).toBe(true);
  });

  it('deletes fields when value is null/undefined', () => {
    const state = makeState();
    (state.data as Record<string, unknown>).gate1_ui_approved = true;

    applyUIPatch(state, 'gate1', { _ui_approved: null });

    expect((state.data as Record<string, unknown>).gate1_ui_approved).toBeUndefined();
  });

  it('handles multiple fields in a single patch', () => {
    const state = makeState();

    applyUIPatch(state, 'gate2b', {
      _ui_approved: true,
      _ui_feedback: 'approved for prod',
    });

    expect((state.data as Record<string, unknown>)['gate2b_ui_approved']).toBe(true);
    expect((state.data as Record<string, unknown>)['gate2b_ui_feedback']).toBe('approved for prod');
  });

  it('returns the same state reference', () => {
    const state = makeState();
    const result = applyUIPatch(state, 'gate1', { _ui_approved: true });

    expect(result).toBe(state);
  });
});
