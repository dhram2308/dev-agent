// ===================================================================
// MI Dev Agent -- Diff Utility Functions
// Char-level highlighting, stats parsing, file grouping
// ===================================================================

// -- Types ----------------------------------------------------------

export interface CharHighlight {
  /** Ranges of characters that changed within the old line */
  oldRanges: Array<{ start: number; end: number }>;
  /** Ranges of characters that changed within the new line */
  newRanges: Array<{ start: number; end: number }>;
}

export interface DiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk';
  content: string;
  oldNum: number | null;
  newNum: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface ParsedFileDiff {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export interface DirectoryNode {
  name: string;
  path: string;
  files: string[];
  children: DirectoryNode[];
}

// -- computeCharHighlights ------------------------------------------
// Finds character-level differences between a removed and added line
// using a simple longest-common-subsequence approach.

export function computeCharHighlights(
  oldLine: string,
  newLine: string,
): CharHighlight {
  // Strip the leading +/- prefix for comparison
  const oldText = oldLine.startsWith('-') ? oldLine.slice(1) : oldLine;
  const newText = newLine.startsWith('+') ? newLine.slice(1) : newLine;

  if (oldText === newText) {
    return { oldRanges: [], newRanges: [] };
  }

  // Find common prefix
  let prefixLen = 0;
  while (
    prefixLen < oldText.length &&
    prefixLen < newText.length &&
    oldText[prefixLen] === newText[prefixLen]
  ) {
    prefixLen++;
  }

  // Find common suffix (not overlapping with prefix)
  let oldSuffix = oldText.length;
  let newSuffix = newText.length;
  while (
    oldSuffix > prefixLen &&
    newSuffix > prefixLen &&
    oldText[oldSuffix - 1] === newText[newSuffix - 1]
  ) {
    oldSuffix--;
    newSuffix--;
  }

  const oldRanges: Array<{ start: number; end: number }> = [];
  const newRanges: Array<{ start: number; end: number }> = [];

  if (oldSuffix > prefixLen) {
    oldRanges.push({ start: prefixLen, end: oldSuffix });
  }
  if (newSuffix > prefixLen) {
    newRanges.push({ start: prefixLen, end: newSuffix });
  }

  return { oldRanges, newRanges };
}

// -- parseDiffStats -------------------------------------------------
// Extract file count, additions, deletions from unified diff text

export function parseDiffStats(diffText: string): DiffStats {
  let additions = 0;
  let deletions = 0;
  const filesChanged = new Set<string>();

  const lines = diffText.split('\n');
  for (const line of lines) {
    if (line.startsWith('diff --git') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      // Extract filename
      const match = line.match(/[ab]\/(.+)$/);
      if (match) {
        filesChanged.add(match[1]);
      }
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    }
  }

  return {
    filesChanged: Math.max(filesChanged.size, 1),
    additions,
    deletions,
  };
}

// -- parseDiffStatsFromChanges --------------------------------------
// Compute stats from ReviewData.changes array

export function parseDiffStatsFromChanges(
  changes: Array<{ file: string; action: string; diff?: string }>,
): DiffStats {
  let additions = 0;
  let deletions = 0;

  for (const change of changes) {
    if (change.diff) {
      const lines = change.diff.split('\n');
      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) additions++;
        else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
      }
    }
  }

  return {
    filesChanged: changes.length,
    additions,
    deletions,
  };
}

// -- parseUnifiedDiff -----------------------------------------------
// -- synthesizeFullFileHunk -----------------------------------------
// For create/delete file changes the backend produces no unified diff
// (there's no "before" or no "after" to compare against). To still
// render them in split / unified mode like GitHub does — empty pane on
// one side, full content on the other — we synthesize a single hunk
// whose lines are all `add` (for `create`) or all `del` (for `delete`).
//
// For `update` actions that arrive with only `content` and no diff
// (rare; usually the backend fills in `diff`), we fall back to
// showing the new content on the right pane and leave the left blank.

export function synthesizeFullFileHunk(
  content: string,
  action: 'create' | 'update' | 'delete',
): DiffHunk[] {
  // Strip a single trailing newline to avoid an empty phantom line.
  const text = content.endsWith('\n') ? content.slice(0, -1) : content;
  const lines = text.split('\n');
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
    return [];
  }

  const type: DiffLine['type'] = action === 'delete' ? 'del' : 'add';
  const diffLines: DiffLine[] = lines.map((content, i) => ({
    type,
    content,
    oldNum: type === 'del' ? i + 1 : null,
    newNum: type === 'add' ? i + 1 : null,
  }));

  const hunk: DiffHunk = {
    header: `@@ ${action === 'delete' ? `-1,${lines.length} +0,0` : `-0,0 +1,${lines.length}`} @@`,
    oldStart: action === 'delete' ? 1 : 0,
    oldCount: action === 'delete' ? lines.length : 0,
    newStart: action === 'delete' ? 0 : 1,
    newCount: action === 'delete' ? 0 : lines.length,
    lines: diffLines,
  };
  return [hunk];
}

// Parse unified diff text into structured hunks with line numbers

export function parseUnifiedDiff(diffText: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diffText.split('\n');

  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(
      /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/,
    );

    if (hunkMatch) {
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount = parseInt(hunkMatch[2] ?? '1', 10);
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = parseInt(hunkMatch[4] ?? '1', 10);

      currentHunk = {
        header: line,
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [],
      };
      hunks.push(currentHunk);
      oldLine = oldStart;
      newLine = newStart;

      // Add hunk header as a line
      currentHunk.lines.push({
        type: 'hunk',
        content: line,
        oldNum: null,
        newNum: null,
      });
      continue;
    }

    // Skip diff metadata lines
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('similarity index') ||
      line.startsWith('rename from') ||
      line.startsWith('rename to') ||
      line.startsWith('Binary files')
    ) {
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith('+')) {
      currentHunk.lines.push({
        type: 'add',
        content: line.slice(1),
        oldNum: null,
        newNum: newLine,
      });
      newLine++;
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({
        type: 'del',
        content: line.slice(1),
        oldNum: oldLine,
        newNum: null,
      });
      oldLine++;
    } else if (line.startsWith(' ') || line === '') {
      currentHunk.lines.push({
        type: 'ctx',
        content: line.startsWith(' ') ? line.slice(1) : line,
        oldNum: oldLine,
        newNum: newLine,
      });
      oldLine++;
      newLine++;
    }
  }

  return hunks;
}

// -- groupFilesByDirectory ------------------------------------------
// Group an array of file paths into a directory tree structure

export function groupFilesByDirectory(
  files: string[],
): DirectoryNode {
  const root: DirectoryNode = {
    name: '',
    path: '',
    files: [],
    children: [],
  };

  for (const filePath of files) {
    const parts = filePath.split('/');
    const fileName = parts.pop()!;
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const dirName = parts[i];
      const dirPath = parts.slice(0, i + 1).join('/');
      let child = current.children.find((c) => c.name === dirName);
      if (!child) {
        child = { name: dirName, path: dirPath, files: [], children: [] };
        current.children.push(child);
      }
      current = child;
    }

    current.files.push(fileName);
  }

  return root;
}

// -- getFileExtension -----------------------------------------------
// Get file extension for syntax-related styling hints

export function getFileExtension(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  return dot >= 0 ? filePath.slice(dot + 1).toLowerCase() : '';
}

// -- actionColor ----------------------------------------------------
// Color for file action indicators

export function actionColor(action: string): string {
  switch (action) {
    case 'create': return 'var(--success)';
    case 'update': return 'var(--warning)';
    case 'delete': return 'var(--danger)';
    default: return 'var(--text-tertiary)';
  }
}

// -- actionBgColor --------------------------------------------------

export function actionBgColor(action: string): string {
  switch (action) {
    case 'create': return 'var(--success-muted)';
    case 'update': return 'var(--warning-muted)';
    case 'delete': return 'var(--danger-muted)';
    default: return 'var(--bg-elevated)';
  }
}

// -- actionLabel ----------------------------------------------------

export function actionLabel(action: string): string {
  switch (action) {
    case 'create': return 'A';
    case 'update': return 'M';
    case 'delete': return 'D';
    default: return '?';
  }
}
