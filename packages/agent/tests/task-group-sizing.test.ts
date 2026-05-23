/**
 * Unit tests for Fix C — task-group size audit + parseTaskGroups
 * sensitivity to oversized groups. The architect prompt is exercised
 * only at integration time, but the parser + audit are pure functions
 * we can verify in isolation.
 */

import { describe, it, expect } from 'vitest';

const {
  parseTaskGroups,
  _auditTaskGroupSizes,
  TASK_GROUP_FILES_WARN,
  TASK_GROUP_FILES_HARD,
} = require('../src/stages/generate-code/developer');

function mkState(): any {
  return { data: { _warnings: [] } };
}

describe('_auditTaskGroupSizes', () => {
  it('records no warning when all groups are within budget', () => {
    const state = mkState();
    _auditTaskGroupSizes(
      [
        { title: 'Auth', content: 'work', files: ['src/auth/a.ts', 'src/auth/b.ts'] },
        { title: 'Routing', content: 'work', files: ['src/routes/x.ts'] },
      ],
      state,
    );
    expect(state.data._warnings).toHaveLength(0);
  });

  it('records a warning when a group hits the warn threshold', () => {
    const state = mkState();
    const files = Array.from({ length: TASK_GROUP_FILES_WARN }, (_, i) => `src/f${i}.ts`);
    _auditTaskGroupSizes(
      [{ title: 'Medium group', content: '', files }],
      state,
    );
    expect(state.data._warnings.length).toBeGreaterThan(0);
    expect(state.data._warnings[0].message).toMatch(/oversized/i);
  });

  it('records a hard severity warning when a group hits the hard threshold', () => {
    const state = mkState();
    const files = Array.from({ length: TASK_GROUP_FILES_HARD + 1 }, (_, i) => `src/f${i}.ts`);
    _auditTaskGroupSizes(
      [{ title: 'Kitchen sink', content: '', files }],
      state,
    );
    expect(state.data._warnings[0].message).toMatch(/OVERSIZED \(hard\)/);
  });

  it('flags multiple violations independently', () => {
    const state = mkState();
    const big = Array.from({ length: TASK_GROUP_FILES_HARD + 2 }, (_, i) => `a/${i}.ts`);
    const med = Array.from({ length: TASK_GROUP_FILES_WARN }, (_, i) => `b/${i}.ts`);
    _auditTaskGroupSizes(
      [
        { title: 'A', content: '', files: big },
        { title: 'B', content: '', files: med },
        { title: 'C', content: '', files: ['x.ts'] },
      ],
      state,
    );
    expect(state.data._warnings).toHaveLength(2);
  });

  it('exposes sane thresholds', () => {
    expect(TASK_GROUP_FILES_WARN).toBeGreaterThanOrEqual(4);
    expect(TASK_GROUP_FILES_HARD).toBeGreaterThan(TASK_GROUP_FILES_WARN);
  });
});

describe('parseTaskGroups + audit pipeline', () => {
  it('detects oversized groups in real architect output shape', () => {
    const md = `
## 1. Foundation Setup
- Add src/types/foo.ts
- Add src/types/bar.ts
- Add src/constants/auth.ts

## 2. Massive Kitchen Sink Group
Touch src/auth/login.tsx, src/auth/setup.tsx, src/auth/verify.tsx,
src/components/Modal.tsx, src/components/Form.tsx, src/components/Input.tsx,
src/services/api.ts, src/services/store.ts, src/hooks/useAuth.ts,
src/utils/validate.ts, src/utils/format.ts, src/utils/i18n.ts.
`;
    const groups = parseTaskGroups(md);
    expect(groups.length).toBeGreaterThanOrEqual(1);
    const state = mkState();
    _auditTaskGroupSizes(groups, state);
    // At least one group should trip the hard threshold given 12 files.
    expect(state.data._warnings.some((w: any) => /OVERSIZED \(hard\)/.test(w.message))).toBe(true);
  });

  it('does not flag well-sized groups extracted from real markdown', () => {
    const md = `
## 1. Auth Context
Update src/contexts/AuthContext.tsx and src/hooks/useAuth.ts.

## 2. Login Page
Add src/pages/Login.tsx and src/pages/Login.test.tsx.

## 3. Routes
Update src/routes/index.tsx.
`;
    const groups = parseTaskGroups(md);
    const state = mkState();
    _auditTaskGroupSizes(groups, state);
    expect(state.data._warnings).toHaveLength(0);
  });
});
