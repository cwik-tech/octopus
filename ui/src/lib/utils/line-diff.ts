export type LineChangeKind = "added" | "modified" | "unchanged";

export interface LineDeletion {
  /** Index of the current line that follows the deleted block. Equals the
   * total line count when the deletion sits at the end of the document. */
  atLine: number;
  lines: string[];
}

export interface LineDiffResult {
  /** Change kind for each line of the current document, by line index. */
  kinds: LineChangeKind[];
  /** Blocks of lines present in the baseline but removed from the current
   * document. */
  deletions: LineDeletion[];
  /** Git-style counts: a modified line counts as one addition and one
   * removal. */
  addedCount: number;
  removedCount: number;
}

/** Above this many LCS table cells the diff falls back to treating the whole
 * changed region as replaced, which is what it looks like in practice. */
const MAX_LCS_CELLS = 2_000_000;

type LineOp = { type: "keep" | "ins" | "del"; text: string };

export function diffLines(before: string, after: string): LineDiffResult {
  const a = before.split("\n");
  const b = after.split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const aMid = a.slice(start, endA);
  const bMid = b.slice(start, endB);

  const ops: LineOp[] = [];
  for (let i = 0; i < start; i += 1) ops.push({ type: "keep", text: lineAt(a, i) });
  if (aMid.length * bMid.length <= MAX_LCS_CELLS) {
    ops.push(...lcsOps(aMid, bMid));
  } else {
    for (const text of aMid) ops.push({ type: "del", text });
    for (const text of bMid) ops.push({ type: "ins", text });
  }
  for (let i = endA; i < a.length; i += 1) {
    ops.push({ type: "keep", text: lineAt(a, i) });
  }

  return buildResult(ops, b.length);
}

/** Longest-common-subsequence edit script over the two line slices. */
function lcsOps(a: string[], b: string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  const cell = (row: number, column: number): number => {
    const value = table[row * width + column];
    if (value === undefined) {
      throw new Error(`LCS table has no cell at row ${row}, column ${column}`);
    }
    return value;
  };
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? cell(i + 1, j + 1) + 1
          : Math.max(cell(i + 1, j), cell(i, j + 1));
    }
  }

  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "keep", text: lineAt(a, i) });
      i += 1;
      j += 1;
    } else if (cell(i + 1, j) >= cell(i, j + 1)) {
      ops.push({ type: "del", text: lineAt(a, i) });
      i += 1;
    } else {
      ops.push({ type: "ins", text: lineAt(b, j) });
      j += 1;
    }
  }
  for (; i < n; i += 1) ops.push({ type: "del", text: lineAt(a, i) });
  for (; j < m; j += 1) ops.push({ type: "ins", text: lineAt(b, j) });
  return ops;
}

function lineAt(lines: string[], index: number): string {
  const line = lines[index];
  if (line === undefined) {
    throw new Error(`Line ${index} is outside a ${lines.length}-line slice`);
  }
  return line;
}

function buildResult(ops: LineOp[], totalLines: number): LineDiffResult {
  const kinds: LineChangeKind[] = new Array<LineChangeKind>(totalLines).fill(
    "unchanged",
  );
  const deletions: LineDeletion[] = [];
  let addedCount = 0;
  let removedCount = 0;
  let lineIndex = 0;
  let pendingDels: string[] = [];
  let pendingIns: string[] = [];

  // Flush one change hunk: paired del/ins lines become "modified", leftover
  // inserted lines become "added", leftover deleted lines become a deletion
  // marker attached to the line that follows the hunk.
  const flush = () => {
    if (pendingDels.length === 0 && pendingIns.length === 0) return;
    const paired = Math.min(pendingDels.length, pendingIns.length);
    for (let k = 0; k < pendingIns.length; k += 1) {
      kinds[lineIndex - pendingIns.length + k] =
        k < paired ? "modified" : "added";
    }
    if (pendingDels.length > paired) {
      deletions.push({ atLine: lineIndex, lines: pendingDels.slice(paired) });
    }
    addedCount += pendingIns.length;
    removedCount += pendingDels.length;
    pendingDels = [];
    pendingIns = [];
  };

  for (const op of ops) {
    if (op.type === "keep") {
      flush();
      lineIndex += 1;
    } else if (op.type === "del") {
      pendingDels.push(op.text);
    } else {
      pendingIns.push(op.text);
      lineIndex += 1;
    }
  }
  flush();

  return { kinds, deletions, addedCount, removedCount };
}
