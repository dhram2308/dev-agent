"use strict";

import type { QuestionAnswer } from '@mi/shared';

/**
 * Build a prompt fragment that feeds user-confirmed decisions from the
 * Plan Review clarifying-questions loop into downstream agents
 * (Developer, Reviewer, Security, Fixer, AC-Verifier).
 *
 * Returns an empty string when `_qa_answers` is absent or empty, so
 * consumers can safely concatenate it unconditionally.
 */
function buildDecisionsBlock(qaAnswers: QuestionAnswer[] | undefined | null): string {
  if (!qaAnswers || qaAnswers.length === 0) return "";
  const lines = qaAnswers.map((a) => `- ${a.id}: "${a.optionText}"`);
  return (
    `\n## User-confirmed decisions\n` +
    `The user already answered these clarifying questions during plan review. ` +
    `Use them as BINDING constraints — do not re-derive them and do not flag them as ambiguous:\n` +
    lines.join("\n") +
    `\n`
  );
}

module.exports = { buildDecisionsBlock };
