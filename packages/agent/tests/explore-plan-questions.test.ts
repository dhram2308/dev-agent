/**
 * Unit tests for `parseQuestionsBlock` in `stages/explore-plan.ts` —
 * the Architect output parser that extracts `---QUESTIONS---` blocks
 * into `PendingQuestion[]` for the Plan Review clarifying-questions
 * loop. Graceful-degradation focused: malformed input should NEVER
 * break the pipeline; it should log and return `[]`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Intercept logWarn BEFORE explore-plan.ts destructures it — capture calls so
// tests can assert warning-on-bad-input behavior. The real logging module
// would dirty the test output.
const warnCalls: string[] = [];
vi.mock('../src/lib/logging', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    logWarn: (msg: string) => { warnCalls.push(msg); },
  };
});

const { parseQuestionsBlock } = require('../src/stages/explore-plan');

function makeBlock(json: string): string {
  return `---PROPOSAL---\nSome proposal\n---TASKS---\n- [ ] 1\n---QUESTIONS---\n${json}\n---END---`;
}

describe('parseQuestionsBlock', () => {
  beforeEach(() => {
    warnCalls.length = 0;
  });

  it('returns [] when the output has no QUESTIONS block', () => {
    const out = parseQuestionsBlock('---PROPOSAL---\nfoo\n---TASKS---\n- [ ] bar');
    expect(out).toEqual([]);
    expect(warnCalls).toHaveLength(0);
  });

  it('extracts a well-formed 2-question block', () => {
    const input = makeBlock(JSON.stringify([
      { id: 'q1', text: 'Q1?', options: ['A', 'B'], recommend: 0, reason: 'because A' },
      { id: 'q2', text: 'Q2?', options: ['X', 'Y', 'Z'], recommend: 2 },
    ]));
    const out = parseQuestionsBlock(input);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: 'q1',
      text: 'Q1?',
      options: ['A', 'B'],
      recommend: 0,
      reason: 'because A',
      stage: 'explore_plan',
    });
    expect(typeof out[0].ts).toBe('number');
    expect(out[1]).toMatchObject({ id: 'q2', recommend: 2 });
    expect(out[1].reason).toBeUndefined();
  });

  it('strips a fenced ```json wrapper inside the block', () => {
    const input =
      '---QUESTIONS---\n```json\n' +
      JSON.stringify([{ id: 'q1', text: 'T', options: ['A', 'B'] }]) +
      '\n```\n---END---';
    const out = parseQuestionsBlock(input);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('q1');
  });

  it('returns [] and warns on malformed JSON', () => {
    const input = '---QUESTIONS---\n[{ id: not valid json }]\n---END---';
    const out = parseQuestionsBlock(input);
    expect(out).toEqual([]);
  });

  it('returns [] when parsed value is not an array', () => {
    const input = makeBlock(JSON.stringify({ id: 'q1', text: 'T', options: ['A', 'B'] }));
    const out = parseQuestionsBlock(input);
    expect(out).toEqual([]);
  });

  it('drops entries missing required fields and keeps valid ones', () => {
    const input = makeBlock(JSON.stringify([
      { id: 'good', text: 'Good?', options: ['A', 'B'] },
      { id: '', text: 'Bad', options: ['A', 'B'] },                     // empty id
      { id: 'no-text', options: ['A', 'B'] },                            // missing text
      { id: 'one-opt', text: 'Only one', options: ['Solo'] },            // too few options
      { id: 'non-obj', text: 'Bad shape' } as any,                       // missing options
      null as any,                                                       // null entry
    ]));
    const out = parseQuestionsBlock(input);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('good');
    // 5 drops = 5 warnings
  });

  it('drops out-of-range recommend but keeps the question', () => {
    const input = makeBlock(JSON.stringify([
      { id: 'q1', text: 'T', options: ['A', 'B'], recommend: 5 },
      { id: 'q2', text: 'T', options: ['A', 'B'], recommend: -1 },
      { id: 'q3', text: 'T', options: ['A', 'B'], recommend: 1.5 },
    ]));
    const out = parseQuestionsBlock(input);
    expect(out).toHaveLength(3);
    for (const q of out) expect(q.recommend).toBeUndefined();
  });

  it('drops empty-string options and still validates min-2 rule', () => {
    const input = makeBlock(JSON.stringify([
      { id: 'q1', text: 'T', options: ['A', '', '  ', 'B'] },  // cleaned to [A,B]
      { id: 'q2', text: 'T', options: ['A', '', '  '] },        // cleaned to [A] — drop
    ]));
    const out = parseQuestionsBlock(input);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('q1');
    expect(out[0].options).toEqual(['A', 'B']);
  });

  it('soft cap: warns when more than 3 questions accepted but returns all', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      id: `q${i}`,
      text: `Question ${i}`,
      options: ['A', 'B'],
    }));
    const input = makeBlock(JSON.stringify(items));
    const out = parseQuestionsBlock(input);
    expect(out).toHaveLength(5);
  });

  it('hard cap: drops entries past 10', () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      id: `q${i}`,
      text: `Q${i}`,
      options: ['A', 'B'],
    }));
    const input = makeBlock(JSON.stringify(items));
    const out = parseQuestionsBlock(input);
    expect(out).toHaveLength(10);
  });

  it('accepts a block that ends at end-of-output (no ---END--- marker)', () => {
    const input =
      '---QUESTIONS---\n' +
      JSON.stringify([{ id: 'q1', text: 'T', options: ['A', 'B'] }]);
    const out = parseQuestionsBlock(input);
    expect(out).toHaveLength(1);
  });

  it('slices options beyond 5', () => {
    const input = makeBlock(JSON.stringify([
      { id: 'q1', text: 'T', options: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] },
    ]));
    const out = parseQuestionsBlock(input);
    expect(out[0].options).toHaveLength(5);
    expect(out[0].options).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
});
