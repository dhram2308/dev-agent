/**
 * Regression test for the AUT-9773 post-mortem fix to
 * mergeUIFieldsFromDisk's concurrency-field merge logic.
 *
 * Bug: when saveSync detects the on-disk _seq is ahead of the in-memory
 * copy (another writer touched the file first), it merges "concurrency
 * fields" (_dev_group_N, _dev_single_result, etc.) from disk into memory
 * — but only intended to do so when memory had never seen the field at
 * all. The original code checked `mem === undefined || mem === null`,
 * which meant an explicit `null` (a caller intentionally clearing a
 * stale checkpoint, e.g. after a GQ7/F3 failure discarded the underlying
 * file changes) was silently overwritten by disk's stale value — the
 * checkpoint came back from the dead on every save that raced another
 * writer. This caused "succeed via checkpoint" against work that no
 * longer existed on disk, repeatedly, across an entire multi-day
 * debugging session.
 *
 * Fix: only adopt disk's value when mem is `undefined` (never touched).
 * An explicit `null` must win.
 */

import { describe, it, expect } from 'vitest';

const { mergeUIFieldsFromDisk } = require('../src/lib/state-unified');

function makeState(data: Record<string, any>) {
  return { stage: 'generate_code', ticket: 'AUT-TEST', data } as any;
}

describe('AUT-9773 post-mortem — state merge null-vs-undefined', () => {
  it('an explicit null on a concurrency field wins over a non-null disk value', () => {
    const memory = makeState({ _dev_group_0: null });
    const disk = makeState({ _dev_group_0: 'stale content from a discarded attempt' });
    mergeUIFieldsFromDisk(memory, disk);
    expect(memory.data._dev_group_0).toBeNull();
  });

  it('an untouched (undefined) concurrency field still adopts disk\'s value', () => {
    const memory = makeState({});
    const disk = makeState({ _dev_group_0: 'legit content from a concurrent writer' });
    mergeUIFieldsFromDisk(memory, disk);
    expect(memory.data._dev_group_0).toBe('legit content from a concurrent writer');
  });

  it('applies the same null-wins rule to all documented concurrency fields', () => {
    const fields = [
      '_dev_group_0', '_dev_group_3', '_dev_single_result', '_dev_retry_result',
      '_review_result', '_security_result', '_fixer_result',
      '_build_fix_result', '_ac_fix_result', '_browser_fix_result',
    ];
    for (const field of fields) {
      const memory = makeState({ [field]: null });
      const disk = makeState({ [field]: 'stale' });
      mergeUIFieldsFromDisk(memory, disk);
      expect(memory.data[field], `field ${field} should stay null`).toBeNull();
    }
  });

  it('a non-null in-memory value is left alone regardless of disk (existing behavior, unaffected by the fix)', () => {
    const memory = makeState({ _dev_group_0: 'my fresh content' });
    const disk = makeState({ _dev_group_0: 'someone else\'s content' });
    mergeUIFieldsFromDisk(memory, disk);
    expect(memory.data._dev_group_0).toBe('my fresh content');
  });

  it('_agents_history still union-merges by (name, startedAt) when in-memory has an array', () => {
    const memory = makeState({ _agents_history: [{ name: 'A', startedAt: 1 }] });
    const disk = makeState({ _agents_history: [{ name: 'A', startedAt: 1 }, { name: 'B', startedAt: 2 }] });
    mergeUIFieldsFromDisk(memory, disk);
    expect(memory.data._agents_history).toHaveLength(2);
    expect(memory.data._agents_history.map((e: any) => e.name).sort()).toEqual(['A', 'B']);
  });
});
