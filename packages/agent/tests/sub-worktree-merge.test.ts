/**
 * Unit tests for M1 — per-agent sub-worktree merge semantics in
 * packages/agent/src/lib/local-repo.ts. Uses real git worktrees on
 * a temp repo so the merge applies the same `git status --porcelain`
 * parsing path used in production.
 *
 * Note: createSubWorktree assumes a specific WORKTREES_DIR layout
 * tied to REPO_CACHE_DIR. These tests bypass that and exercise
 * mergeSubWorktrees directly with hand-built worktree directories,
 * which is the integration surface that matters most.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { mergeSubWorktrees } = require('../src/lib/local-repo');

// Override WORKTREES_DIR so the helper's _subWorktreePath() resolves
// against our temp directory. Since the module loaded WORKTREES_DIR at
// init time, we instead place our temp worktrees under a real path
// that mergeSubWorktrees will read via `localGetChanges` (which only
// needs valid git repos at the given paths).

describe('mergeSubWorktrees', () => {
  let canonicalDir: string;
  let baseRepo: string;
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-m1-test-'));
    baseRepo = path.join(testRoot, 'base');
    canonicalDir = path.join(testRoot, 'canonical');

    // Set up a base repo with one file, then clone it twice as
    // worktrees stand-ins. The merge logic only reads git status from
    // the source paths and writes to the canonical path — it doesn't
    // care that the sources are real git worktrees vs clones.
    fs.mkdirSync(baseRepo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: baseRepo });
    execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: baseRepo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: baseRepo });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: baseRepo });
    fs.mkdirSync(path.join(baseRepo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(baseRepo, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(baseRepo, 'src', 'b.ts'), 'export const b = 2;\n');
    execFileSync('git', ['add', '.'], { cwd: baseRepo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: baseRepo });

    // Canonical worktree = clone of base.
    execFileSync('git', ['clone', '-q', baseRepo, canonicalDir]);
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  function makeFakeSubWorktree(ticket: string, idx: number): string {
    // The library's _subWorktreePath() resolves under WORKTREES_DIR
    // which is fixed at module load. We can't change that, but we CAN
    // stage the structure manually inside testRoot and call into the
    // library's own merge function via a constructed indices array.
    //
    // Workaround: place sub-worktrees at the actual WORKTREES_DIR path,
    // using a unique ticket name to avoid colliding with anything real.
    const { WORKTREES_DIR } = require('../src/lib/local-repo');
    const sub = path.join(WORKTREES_DIR, `${ticket}.dev-${idx}`);
    if (fs.existsSync(sub)) fs.rmSync(sub, { recursive: true, force: true });
    execFileSync('git', ['clone', '-q', baseRepo, sub]);
    return sub;
  }

  function uniqueTicket(): string {
    return `MI-TEST-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  function cleanupSubs(ticket: string, count: number): void {
    const { WORKTREES_DIR } = require('../src/lib/local-repo');
    for (let i = 0; i < count; i++) {
      const sub = path.join(WORKTREES_DIR, `${ticket}.dev-${i}`);
      if (fs.existsSync(sub)) fs.rmSync(sub, { recursive: true, force: true });
    }
  }

  it('merges non-conflicting changes from 2 sub-worktrees into canonical', () => {
    const ticket = uniqueTicket();
    const sub0 = makeFakeSubWorktree(ticket, 0);
    const sub1 = makeFakeSubWorktree(ticket, 1);
    try {
      // Agent 0 modifies a.ts; agent 1 modifies b.ts.
      fs.writeFileSync(path.join(sub0, 'src', 'a.ts'), 'export const a = 99;\n');
      fs.writeFileSync(path.join(sub1, 'src', 'b.ts'), 'export const b = 88;\n');

      const result = mergeSubWorktrees(ticket, [0, 1], canonicalDir);

      expect(result.applied).toBe(2);
      expect(result.conflicts).toHaveLength(0);
      expect(fs.readFileSync(path.join(canonicalDir, 'src', 'a.ts'), 'utf8')).toContain('a = 99');
      expect(fs.readFileSync(path.join(canonicalDir, 'src', 'b.ts'), 'utf8')).toContain('b = 88');
    } finally {
      cleanupSubs(ticket, 2);
    }
  });

  it('detects same-file conflicts (first-agent-wins)', () => {
    const ticket = uniqueTicket();
    const sub0 = makeFakeSubWorktree(ticket, 0);
    const sub1 = makeFakeSubWorktree(ticket, 1);
    try {
      // Both agents modify the same file.
      fs.writeFileSync(path.join(sub0, 'src', 'a.ts'), 'export const a = "from-0";\n');
      fs.writeFileSync(path.join(sub1, 'src', 'a.ts'), 'export const a = "from-1";\n');

      const result = mergeSubWorktrees(ticket, [0, 1], canonicalDir);

      expect(result.applied).toBe(1);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].file).toBe('src/a.ts');
      expect(result.conflicts[0].agents).toEqual([0, 1]);
      // First-wins → agent 0's content lands.
      expect(fs.readFileSync(path.join(canonicalDir, 'src', 'a.ts'), 'utf8')).toContain('from-0');
    } finally {
      cleanupSubs(ticket, 2);
    }
  });

  it('handles "create" actions (new files) from agents', () => {
    const ticket = uniqueTicket();
    const sub0 = makeFakeSubWorktree(ticket, 0);
    try {
      // Create a brand-new file inside the existing `src/` directory.
      // `git status --porcelain` reports it as `?? src/created.ts`,
      // which localGetChanges maps to a `create` action. Creating into
      // a brand-new subdirectory would get collapsed to `?? src/new/`
      // by git's default reporting — a separate issue worth knowing
      // about but not what M1's merge needs to fix.
      fs.writeFileSync(path.join(sub0, 'src', 'created.ts'), 'export const fresh = true;\n');

      const result = mergeSubWorktrees(ticket, [0], canonicalDir);

      expect(result.applied).toBe(1);
      expect(fs.existsSync(path.join(canonicalDir, 'src', 'created.ts'))).toBe(true);
      expect(fs.readFileSync(path.join(canonicalDir, 'src', 'created.ts'), 'utf8')).toContain('fresh');
    } finally {
      cleanupSubs(ticket, 1);
    }
  });

  it('handles "delete" actions from agents', () => {
    const ticket = uniqueTicket();
    const sub0 = makeFakeSubWorktree(ticket, 0);
    try {
      fs.rmSync(path.join(sub0, 'src', 'a.ts'));

      const result = mergeSubWorktrees(ticket, [0], canonicalDir);

      expect(result.applied).toBe(1);
      expect(fs.existsSync(path.join(canonicalDir, 'src', 'a.ts'))).toBe(false);
      // b.ts untouched
      expect(fs.existsSync(path.join(canonicalDir, 'src', 'b.ts'))).toBe(true);
    } finally {
      cleanupSubs(ticket, 1);
    }
  });

  it('skips forbidden secret files (.env, .api-token) even if an agent created them', () => {
    const ticket = uniqueTicket();
    const sub0 = makeFakeSubWorktree(ticket, 0);
    try {
      fs.writeFileSync(path.join(sub0, '.env'), 'SECRET=hunter2\n');
      fs.writeFileSync(path.join(sub0, '.api-token'), 'abc123\n');
      fs.writeFileSync(path.join(sub0, 'src', 'ok.ts'), 'export const ok = true;\n');

      const result = mergeSubWorktrees(ticket, [0], canonicalDir);

      expect(result.skippedForbidden).toContain('.env');
      expect(result.skippedForbidden).toContain('.api-token');
      expect(fs.existsSync(path.join(canonicalDir, '.env'))).toBe(false);
      expect(fs.existsSync(path.join(canonicalDir, '.api-token'))).toBe(false);
      // The legitimate src/ok.ts was created.
      expect(fs.existsSync(path.join(canonicalDir, 'src', 'ok.ts'))).toBe(true);
    } finally {
      cleanupSubs(ticket, 1);
    }
  });

  it('skips non-existent sub-worktree directories gracefully', () => {
    const ticket = uniqueTicket();
    // Don't create any sub-worktrees at all.
    const result = mergeSubWorktrees(ticket, [0, 1, 2], canonicalDir);
    expect(result.applied).toBe(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it('three-way conflict: file modified by agents 0+1+2 is reported once with all agents listed', () => {
    const ticket = uniqueTicket();
    const sub0 = makeFakeSubWorktree(ticket, 0);
    const sub1 = makeFakeSubWorktree(ticket, 1);
    const sub2 = makeFakeSubWorktree(ticket, 2);
    try {
      fs.writeFileSync(path.join(sub0, 'src', 'a.ts'), 'v0\n');
      fs.writeFileSync(path.join(sub1, 'src', 'a.ts'), 'v1\n');
      fs.writeFileSync(path.join(sub2, 'src', 'a.ts'), 'v2\n');

      const result = mergeSubWorktrees(ticket, [0, 1, 2], canonicalDir);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].file).toBe('src/a.ts');
      // All three agents recorded in the conflict entry.
      expect(result.conflicts[0].agents.sort()).toEqual([0, 1, 2]);
      // First-wins → agent 0's content lands.
      expect(fs.readFileSync(path.join(canonicalDir, 'src', 'a.ts'), 'utf8').trim()).toBe('v0');
    } finally {
      cleanupSubs(ticket, 3);
    }
  });
});
