import { expect, it } from "vitest";

import { diffLines } from "@/lib/utils/line-diff";

it("reports no changes for identical documents", () => {
  const result = diffLines("a\nb\nc", "a\nb\nc");
  expect(result.kinds).toEqual(["unchanged", "unchanged", "unchanged"]);
  expect(result.deletions).toEqual([]);
  expect(result.addedCount).toBe(0);
  expect(result.removedCount).toBe(0);
});

it("marks inserted lines as added", () => {
  const result = diffLines("a\nc", "a\nb\nc");
  expect(result.kinds).toEqual(["unchanged", "added", "unchanged"]);
  expect(result.deletions).toEqual([]);
  expect(result.addedCount).toBe(1);
  expect(result.removedCount).toBe(0);
});

it("marks appended lines as added", () => {
  const result = diffLines("a", "a\nb\nc");
  expect(result.kinds).toEqual(["unchanged", "added", "added"]);
  expect(result.addedCount).toBe(2);
});

it("attaches a deleted block to the following line", () => {
  const result = diffLines("a\nb\nc", "a\nc");
  expect(result.kinds).toEqual(["unchanged", "unchanged"]);
  expect(result.deletions).toEqual([{ atLine: 1, lines: ["b"] }]);
  expect(result.addedCount).toBe(0);
  expect(result.removedCount).toBe(1);
});

it("attaches a trailing deletion to the end of the document", () => {
  const result = diffLines("a\nb\nc", "a");
  expect(result.kinds).toEqual(["unchanged"]);
  expect(result.deletions).toEqual([{ atLine: 1, lines: ["b", "c"] }]);
  expect(result.removedCount).toBe(2);
});

it("marks rewritten lines as modified without a deletion marker", () => {
  const result = diffLines("a\nb\nc", "a\nB\nc");
  expect(result.kinds).toEqual(["unchanged", "modified", "unchanged"]);
  expect(result.deletions).toEqual([]);
  expect(result.addedCount).toBe(1);
  expect(result.removedCount).toBe(1);
});

it("splits a rewrite of more old lines than new into modified plus deletion", () => {
  const result = diffLines("a\nb\nc\nd", "a\nX\nd");
  expect(result.kinds).toEqual(["unchanged", "modified", "unchanged"]);
  expect(result.deletions).toEqual([{ atLine: 2, lines: ["c"] }]);
  expect(result.addedCount).toBe(1);
  expect(result.removedCount).toBe(2);
});

it("handles an empty baseline as all added", () => {
  const result = diffLines("", "a\nb");
  expect(result.kinds).toEqual(["modified", "added"]);
  expect(result.addedCount).toBe(2);
  expect(result.removedCount).toBe(1);
});

it("tracks multiple separate hunks", () => {
  const before = "one\ntwo\nthree\nfour\nfive";
  const after = "one\nTWO\nthree\nfour\nfive\nsix";
  const result = diffLines(before, after);
  expect(result.kinds).toEqual([
    "unchanged",
    "modified",
    "unchanged",
    "unchanged",
    "unchanged",
    "added",
  ]);
  expect(result.deletions).toEqual([]);
  expect(result.addedCount).toBe(2);
  expect(result.removedCount).toBe(1);
});
