/**
 * Regression tests for the AUT-9773 post-mortem fixes:
 *
 * 1. classifyError must treat EABORTED as TRANSIENT, not fall through to
 *    the default PERMANENT bucket (which halted every stage on a plain
 *    network abort with zero retries).
 * 2. classifyError must treat a GQ7_RETRYABLE-tagged error as TRANSIENT
 *    even though its message contains "does not exist" (which otherwise
 *    matches PERMANENT_PATTERNS).
 * 3. classifyError must treat an F3_FORBIDDEN_FILES-tagged error as
 *    PERMANENT, not AUTH (the word "forbidden" otherwise matches
 *    AUTH_PATTERNS and gets misread as a 403/credentials issue).
 * 4. _validateDevChanges' GQ7 import-resolution regex must ignore imports
 *    that appear inside a `//` line comment — the root cause of AUT-9773's
 *    repeated "unresolved import" halts was GQ7 flagging a pre-existing,
 *    never-executed commented-out import as if it were live code.
 */

import { describe, it, expect } from 'vitest';

const { classifyError, ERROR_CLASS } = require('../src/lib/error-recovery');

describe('AUT-9773 post-mortem — error classification', () => {
  it('classifies EABORTED as TRANSIENT (was falling through to PERMANENT default)', () => {
    const err = Object.assign(new Error('Request aborted'), { code: 'EABORTED' });
    const result = classifyError(err);
    expect(result.class).toBe(ERROR_CLASS.TRANSIENT);
    expect(result.retryable).toBe(true);
  });

  it('classifies a GQ7_RETRYABLE-tagged error as TRANSIENT despite "does not exist" in the message', () => {
    const err = Object.assign(
      new Error("GQ7: 1 unresolved relative import(s). ... file does not exist"),
      { code: 'GQ7_RETRYABLE' },
    );
    const result = classifyError(err);
    expect(result.class).toBe(ERROR_CLASS.TRANSIENT);
    expect(result.retryable).toBe(true);
  });

  it('classifies an F3_FORBIDDEN_FILES-tagged error as PERMANENT, not AUTH', () => {
    const err = Object.assign(
      new Error('Developer Agent modified forbidden files: .env.local. Pipeline halted.'),
      { code: 'F3_FORBIDDEN_FILES' },
    );
    const result = classifyError(err);
    expect(result.class).toBe(ERROR_CLASS.PERMANENT);
    expect(result.class).not.toBe(ERROR_CLASS.AUTH);
    expect(result.retryable).toBe(false);
  });

  it('an UNTAGGED "forbidden files" message still falls through to the old (buggy) AUTH match', () => {
    // Documents the trade-off explicitly: the fix is the throw-site tag,
    // not a change to AUTH_PATTERNS itself (which would risk false
    // negatives on real 403/forbidden HTTP errors). Any new throw site
    // that reuses the word "forbidden" without tagging will regress to
    // the old bug — this test exists so that regression is visible
    // rather than silently reintroduced.
    const err = new Error('Developer Agent modified forbidden files: .env.local. Pipeline halted.');
    const result = classifyError(err);
    expect(result.class).toBe(ERROR_CLASS.AUTH);
  });
});

describe('AUT-9773 post-mortem — GQ7 line-comment false positive', () => {
  // _validateDevChanges is not exported standalone (it reads cfg.localRepo
  // via require("../lib/config") internals), so we pin the regex+skip
  // logic directly — this is the same STATIC_RE and comment-detection
  // logic as developer.ts's collect() function. If that logic changes,
  // update both together.
  const STATIC_RE = /(?:^|[^.\w])(?:import|export)(?:[^'"\n]*?from\s+|\s+)['"](\.\.?\/[^'"]+)['"]/gm;

  function extractLiveImports(content: string): string[] {
    const live: string[] = [];
    for (const m of content.matchAll(STATIC_RE)) {
      const importPath = m[1];
      const lineStart = content.lastIndexOf('\n', m.index!) + 1;
      const linePrefix = content.substring(lineStart, m.index!);
      if (linePrefix.includes('//')) continue;
      live.push(importPath);
    }
    return live;
  }

  it('does NOT report an import that lives entirely inside a // comment', () => {
    const content = "// export {Analytics} from './depricated/Analytics';\n";
    expect(extractLiveImports(content)).toEqual([]);
  });

  it('DOES report a genuinely live import on an uncommented line', () => {
    const content = "export { ViewResults } from './ViewResults';\n";
    expect(extractLiveImports(content)).toEqual(['./ViewResults']);
  });

  it('DOES report a live import that has a trailing (not leading) comment', () => {
    const content = "import x from './real'; // trailing note\n";
    expect(extractLiveImports(content)).toEqual(['./real']);
  });

  it('handles a live import and its dead commented sibling in the same file correctly', () => {
    const content =
      "export { ViewResults } from './ViewResults';\n" +
      "// export {Analytics} from './depricated/Analytics';\n" +
      "export { RecoJobs } from './RecoJobs';\n";
    expect(extractLiveImports(content)).toEqual(['./ViewResults', './RecoJobs']);
  });

  it('ignores indented comments (e.g. inside a function body)', () => {
    const content = "function f() {\n  // export {X} from './dead';\n}\n";
    expect(extractLiveImports(content)).toEqual([]);
  });
});
