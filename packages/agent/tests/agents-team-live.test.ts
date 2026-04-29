/**
 * Unit tests for the `live-codegen-diff-view` feature helpers in
 * `packages/agent/src/lib/agents-team.ts`:
 *   - `simpleHash`        — stable xor/rolling hash used to dedupe
 *                            live-poller broadcasts between ticks.
 *   - `buildLiveSnapshot` — synchronous snapshot builder that reads
 *                            the working tree and produces the payload
 *                            broadcast on `codegen:live`.
 *
 * `agents-team.ts` uses CommonJS `module.exports`, so we import via
 * `require`. The setup file (`tests/setup.ts`) registers tsx's CJS
 * hook so nested `require('./logging')` style calls resolve to the
 * sibling `.ts` files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// agents-team.ts uses CommonJS exports
const { buildLiveSnapshot, simpleHash } = require('../src/lib/agents-team');

describe('simpleHash', () => {
  it('produces the same hash for the same input', () => {
    const a = simpleHash('src/foo.ts|update|42');
    const b = simpleHash('src/foo.ts|update|42');
    expect(a).toBe(b);
  });

  it('produces different hashes for slightly different inputs', () => {
    const a = simpleHash('src/foo.ts|update|42');
    const b = simpleHash('src/foo.ts|update|43');
    expect(a).not.toBe(b);
  });

  it('returns a consistent hash for an empty string', () => {
    const a = simpleHash('');
    const b = simpleHash('');
    expect(a).toBe(b);
    expect(typeof a).toBe('string');
  });

  it('returns a string (base36) not a number', () => {
    const h = simpleHash('anything');
    expect(typeof h).toBe('string');
    // base36 alphabet only
    expect(h).toMatch(/^[0-9a-z]+$/);
  });
});

describe('buildLiveSnapshot', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-live-test-'));
    execFileSync('git', ['init', '-q'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpRepo });

    // Seed the repo with a tracked file we can later modify.
    fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'src', 'foo.ts'), 'export const x = 1;\n');

    execFileSync('git', ['add', '.'], { cwd: tmpRepo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpRepo });
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  it('clean repo produces an empty snapshot with no truncation', () => {
    const snap = buildLiveSnapshot(tmpRepo, 'AUT-1', 'Team', ['Agent A']);
    expect(snap.changes.length).toBe(0);
    expect(snap.original_files).toEqual({});
    expect(snap.truncated).toBeUndefined();
    expect(snap.ticket).toBe('AUT-1');
    expect(snap.team).toBe('Team');
    expect(snap.activeAgents).toEqual(['Agent A']);
    expect(typeof snap.ts).toBe('number');
    expect(snap.ts).toBeGreaterThan(0);
  });

  it('updating one file (unstaged) records an update action with HEAD original', () => {
    // The live poller's whole job is to observe unstaged working-tree
    // edits from Claude's Write/Edit tool calls. Porcelain output for an
    // unstaged modification begins with " M path" — the leading space is
    // significant (it encodes the worktree column). `localGetChanges`
    // preserves that space by stripping only trailing newlines.
    fs.writeFileSync(path.join(tmpRepo, 'src', 'foo.ts'), 'export const x = 2;\n');

    const snap = buildLiveSnapshot(tmpRepo, 'AUT-1', 'Team', ['Agent A']);

    expect(snap.changes.length).toBe(1);
    const change = snap.changes[0];
    expect(change.action).toBe('update');
    expect(change.file_path).toBe('src/foo.ts');
    expect(change.content).toBe('export const x = 2;\n');

    expect(snap.original_files['src/foo.ts']).toBe('export const x = 1;\n');
    expect(snap.activeAgents).toEqual(['Agent A']);
    expect(snap.ticket).toBe('AUT-1');
    expect(snap.team).toBe('Team');
    expect(typeof snap.ts).toBe('number');
    expect(snap.ts).toBeGreaterThan(0);
    expect(snap.truncated).toBeUndefined();
  });

  it('creating one file records a create action and no original entry', () => {
    fs.writeFileSync(path.join(tmpRepo, 'src', 'bar.ts'), 'export const y = 99;\n');

    const snap = buildLiveSnapshot(tmpRepo, 'AUT-1', 'Team', ['Agent A']);

    const created = snap.changes.find((c: any) => c.file_path === 'src/bar.ts');
    expect(created).toBeDefined();
    expect(created!.action).toBe('create');
    expect(created!.content).toBe('export const y = 99;\n');

    // No HEAD content for brand-new files.
    expect(snap.original_files['src/bar.ts']).toBeUndefined();
  });

  it('truncates content larger than MAX_FILE_BYTES_LIVE (200 KB)', () => {
    const huge = 'a'.repeat(250_000);
    fs.writeFileSync(path.join(tmpRepo, 'src', 'big.ts'), huge);

    const snap = buildLiveSnapshot(tmpRepo, 'AUT-1', 'Team', ['Agent A']);

    const big = snap.changes.find((c: any) => c.file_path === 'src/big.ts');
    expect(big).toBeDefined();
    expect(typeof big!.content).toBe('string');
    expect(big!.content.length).toBeLessThanOrEqual(200_000);

    expect(snap.truncated).toBeDefined();
    expect(snap.truncated!.bytes).toContain('src/big.ts');
  });

  it('caps `changes` at MAX_FILES_LIVE (40) and reports dropped count', () => {
    for (let i = 0; i < 45; i++) {
      fs.writeFileSync(path.join(tmpRepo, 'src', `f${i}.ts`), `export const n${i} = ${i};\n`);
    }

    const snap = buildLiveSnapshot(tmpRepo, 'AUT-1', 'Team', ['Agent A']);

    expect(snap.changes.length).toBe(40);
    expect(snap.truncated).toBeDefined();
    expect(snap.truncated!.files).toBe(5);
  });
});
