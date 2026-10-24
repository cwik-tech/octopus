import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_CONTINUATION_CONTEXT_CHARS,
  MAX_CONTINUATION_RESULT_CHARS,
  MAX_CONTINUATION_RESULTS,
  renderContinuationContext,
  defaultContinuationSelection,
  selectContinuationReferences,
  type ResolvedResult,
} from "../../domains/sessions/continuation-context.js";
import type { ResultReference } from "../../contracts/schemas/result-reference.js";

/**
 * Two rules live here. An explicit selection carries exactly what was named,
 * and refuses rather than trims. With nothing named, the default carries this
 * session's recent finished work: the composer stopped asking, because a
 * session is one topic and making the user restate that was asking them to
 * manage plumbing.
 *
 * The default deliberately leaves out an agent's own reply. That is already in
 * the transcript every agent reads, so quoting it again spends the block on
 * something the reader can see anyway.
 */

function reference(id: string, overrides: Partial<ResultReference> = {}): ResultReference {
  return {
    schemaVersion: 1,
    id,
    sessionId: "session-1",
    producer: { kind: "team", id: "board", label: "Problem Thinking Board" },
    status: "done",
    completedAt: "2026-09-09T10:00:00.000Z",
    brief: "Decompose the launch decision.",
    source: { kind: "run-summary", runId: "run-1" },
    ...overrides,
  };
}

test("nothing selected attaches nothing", () => {
  const selection = selectContinuationReferences({
    available: [reference("a"), reference("b")],
    selectedIds: [],
  });

  assert.deepEqual(selection.selected, []);
  assert.deepEqual(selection.rejected, []);
});

test("only what was chosen is attached, in the order it was chosen", () => {
  const selection = selectContinuationReferences({
    available: [reference("a"), reference("b"), reference("c")],
    selectedIds: ["c", "a"],
  });

  assert.deepEqual(
    selection.selected.map((entry) => entry.id),
    ["c", "a"],
  );
});

test("an id this session does not hold is refused rather than skipped", () => {
  const selection = selectContinuationReferences({
    available: [reference("a")],
    selectedIds: ["from-another-session"],
  });

  assert.deepEqual(selection.rejected, [
    { id: "from-another-session", reason: "unknown" },
  ]);
});

test("a result that did not finish is refused", () => {
  const selection = selectContinuationReferences({
    available: [reference("a", { status: "failed" })],
    selectedIds: ["a"],
  });

  assert.deepEqual(selection.rejected, [{ id: "a", reason: "not-terminal" }]);
});

test("more results than one turn may carry are refused, never trimmed", () => {
  const available = Array.from({ length: MAX_CONTINUATION_RESULTS + 1 }, (_x, i) =>
    reference(`result-${i}`),
  );
  const selection = selectContinuationReferences({
    available,
    selectedIds: available.map((entry) => entry.id),
  });

  assert.equal(selection.selected.length, MAX_CONTINUATION_RESULTS);
  assert.deepEqual(selection.rejected, [
    { id: `result-${MAX_CONTINUATION_RESULTS}`, reason: "too-many" },
  ]);
});

test("the same id twice is one attachment and one refusal", () => {
  const selection = selectContinuationReferences({
    available: [reference("a")],
    selectedIds: ["a", "a"],
  });

  assert.equal(selection.selected.length, 1);
  assert.deepEqual(selection.rejected, [{ id: "a", reason: "duplicate" }]);
});

test("an empty resolution renders nothing rather than an empty heading", () => {
  assert.equal(renderContinuationContext([]), undefined);
});

test("a rendered result keeps its stable id beside its content", () => {
  const block = renderContinuationContext([
    { reference: reference("team:board:attempt-1"), content: "We recommend B." },
  ]);

  assert.ok(block);
  assert.match(block, /Problem Thinking Board \(team\)/);
  assert.match(block, /Result id: team:board:attempt-1/);
  assert.match(block, /We recommend B\./);
});

test("an artifact result names the file it came from", () => {
  const block = renderContinuationContext([
    {
      reference: reference("w1", {
        source: { kind: "artifact", runId: "run-1", path: "output/final.md" },
      }),
      content: "The draft.",
    },
  ]);

  assert.ok(block);
  assert.match(block, /Artifact: output\/final\.md/);
});

test("a shortened result says so and keeps its reference", () => {
  const block = renderContinuationContext([
    {
      reference: reference("w1"),
      content: "x".repeat(MAX_CONTINUATION_RESULT_CHARS + 500),
    },
  ]);

  assert.ok(block);
  assert.match(block, /… \(truncated\)/);
  assert.match(block, /Result id: w1/);
});

test("several results cannot together exceed the block ceiling", () => {
  const results: ResolvedResult[] = Array.from(
    { length: MAX_CONTINUATION_RESULTS },
    (_x, index) => ({
      reference: reference(`result-${index}`),
      content: "y".repeat(MAX_CONTINUATION_RESULT_CHARS),
    }),
  );

  const block = renderContinuationContext(results);

  assert.ok(block);
  assert.ok(
    block.length <= MAX_CONTINUATION_CONTEXT_CHARS + 20,
    `block was ${block.length} characters`,
  );
});

test("content that could not be read says why rather than reading as empty", () => {
  const block = renderContinuationContext([
    {
      reference: reference("w1"),
      unavailable: "binary document, content not inlined",
    },
  ]);

  assert.ok(block);
  assert.match(block, /binary document, content not inlined/);
});

/**
 * Nothing is chosen any more, so the default is what a reader would assume:
 * this session's finished work follows the conversation to whoever is asked
 * next.
 */
function producedBy(
  id: string,
  kind: "team" | "workflow" | "agent",
  completedAt: string,
): ResultReference {
  return reference(id, {
    producer: { kind, id: `${kind}-1`, label: kind },
    completedAt,
  });
}

test("the default carries the session's recent unreachable results", () => {
  const chosen = defaultContinuationSelection({
    available: [
      producedBy("a", "team", "2026-09-09T09:00:00.000Z"),
      producedBy("b", "agent", "2026-09-09T10:00:00.000Z"),
      producedBy("c", "workflow", "2026-09-09T11:00:00.000Z"),
    ],
  });

  assert.deepEqual(chosen, ["a", "c"], "in the order they finished");
});

test("the default never exceeds what one turn may carry", () => {
  const available = ["a", "b", "c", "d", "e"].map((id, index) =>
    producedBy(id, "team", `2026-09-09T0${index + 1}:00:00.000Z`),
  );

  const chosen = defaultContinuationSelection({ available });

  assert.equal(chosen.length, MAX_CONTINUATION_RESULTS);
  assert.deepEqual(chosen, ["c", "d", "e"], "the most recent, oldest first");
});

test("the default passes over work that did not finish", () => {
  const chosen = defaultContinuationSelection({
    available: [
      producedBy("a", "team", "2026-09-09T09:00:00.000Z"),
      { ...producedBy("b", "team", "2026-09-09T10:00:00.000Z"), status: "failed" },
    ],
  });

  assert.deepEqual(chosen, ["a"]);
});
