/**
 * Example Red → Green → Refactor test (generic reference).
 *
 * This file is a live template showing the TDD loop mandated in AGENTS.md,
 * using a trivial pure function so it has no production-code dependency. Copy
 * the shape — not the domain — when writing a new test.
 *
 * The three phases below are what a real change goes through, in order:
 *
 *   Red        — a failing test that encodes one behavior.
 *   Green      — the minimum code to make it pass (shown inline here; in real
 *                work this lives in a module under domains/, services/, …).
 *   Refactor   — the same tests stay green while the code is cleaned up.
 *
 * Run: `npm run test:unit`
 */

import test from "node:test";
import assert from "node:assert/strict";

// ─── Implementation (kept inline so the example is self-contained) ──────────
// In real TDD this module is written *after* the tests below, one line at a
// time, only to turn each red test green.

function clampNonNegative(raw: number, max: number): number {
  if (typeof raw !== "number" || Number.isNaN(raw)) {
    throw new TypeError("raw must be a number");
  }
  if (max < 0) {
    throw new RangeError("max must be non-negative");
  }
  if (raw < 0) return 0;
  if (raw > max) return max;
  return raw;
}

// ─── Factory ────────────────────────────────────────────────────────────────
// Centralize default inputs so each test states only what it varies.
function makeArgs(overrides: { raw?: number; max?: number } = {}) {
  return { raw: 5, max: 10, ...overrides };
}

// ─── Happy path ─────────────────────────────────────────────────────────────
test("returns the input unchanged when it lies within the range", () => {
  const { raw, max } = makeArgs({ raw: 5, max: 10 });
  assert.equal(clampNonNegative(raw, max), 5);
});

// ─── Edge cases ─────────────────────────────────────────────────────────────
test("clamps a negative input up to the lower bound", () => {
  const { raw, max } = makeArgs({ raw: -3, max: 10 });
  assert.equal(clampNonNegative(raw, max), 0);
});

test("clamps an over-limit input down to the max", () => {
  const { raw, max } = makeArgs({ raw: 42, max: 10 });
  assert.equal(clampNonNegative(raw, max), 10);
});

test("treats zero on both sides as a valid boundary, not an error", () => {
  const { raw, max } = makeArgs({ raw: 0, max: 0 });
  assert.equal(clampNonNegative(raw, max), 0);
});

// ─── Error cases ────────────────────────────────────────────────────────────
test("throws TypeError when the input is not a number", () => {
  const { max } = makeArgs();
  assert.throws(
    () => clampNonNegative(Number.NaN, max),
    /raw must be a number/,
  );
});

test("throws RangeError when the configured max is negative", () => {
  const { raw } = makeArgs();
  assert.throws(
    () => clampNonNegative(raw, -1),
    /max must be non-negative/,
  );
});
