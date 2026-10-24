/**
 * The card copy for a planned Agent.
 *
 * A current plan carries a summary its author wrote for the card, and that is
 * what the card shows. A plan saved before summaries existed has only the
 * detailed build brief, so the card derives display copy from it: the first
 * complete sentence when it fits the 240-character card limit, otherwise the
 * words that fit in 239 characters and one ellipsis. The derivation is pure and
 * deterministic, and nothing writes it back to the plan.
 *
 * Every expected value below is a literal worked out by hand from that rule.
 * Characters are counted as code points, the way the provider schema's
 * `maxLength` counts them.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { plannedAgentCardSummary } from "../../contracts/planned-agent-summary.js";

function legacyAgent(description: string, role = "Renewal risk reviewer") {
  return { role, description };
}

test("a card shows the summary its author wrote, whatever the brief says", () => {
  const card = plannedAgentCardSummary({
    role: "Renewal risk reviewer",
    summary: "Flags renewal clauses worth renegotiating.",
    description: "Reviews supplier contracts. Lists every notice window. Ranks the clauses.",
  });

  assert.equal(card, "Flags renewal clauses worth renegotiating.");
});

test("a legacy brief shows its first complete sentence", () => {
  const cases: Array<[string, string]> = [
    [
      "Reviews supplier contracts for renewal risk. Then it lists every notice window. Finally it ranks clauses.",
      "Reviews supplier contracts for renewal risk.",
    ],
    [
      "Which renewals cost the most? It ranks them by the money at stake.",
      "Which renewals cost the most?",
    ],
    [
      "Prüft Lieferverträge auf Verlängerungsrisiken! Danach ordnet es die Klauseln.",
      "Prüft Lieferverträge auf Verlängerungsrisiken!",
    ],
  ];
  for (const [description, expected] of cases) {
    assert.equal(plannedAgentCardSummary(legacyAgent(description)), expected);
  }
});

test("a legacy brief is read with its whitespace collapsed", () => {
  const card = plannedAgentCardSummary(legacyAgent(
    "  Reviews\tsupplier\ncontracts   for renewal risk.\nThen it lists every notice window.",
  ));

  assert.equal(card, "Reviews supplier contracts for renewal risk.");
});

test("a legacy brief that opens with a heading line shows the heading, not the heading and a list number", () => {
  const cases: Array<[string, string]> = [
    ["Reviews supplier contracts\n\n1. Find each renewal clause.\n2. Rank them.", "Reviews supplier contracts"],
    ["Reviews supplier contracts\n1. Find each renewal clause.\n2. Rank them.", "Reviews supplier contracts"],
    ["Reviews supplier contracts\n- Find each renewal clause.\n- Rank them.", "Reviews supplier contracts"],
    ["Contract renewal reviewer\n\nReviews supplier contracts for renewal risk.", "Contract renewal reviewer"],
  ];
  for (const [description, expected] of cases) {
    assert.equal(plannedAgentCardSummary(legacyAgent(description)), expected, JSON.stringify(description));
  }
});

// The card shows plain text, so Markdown syntax in a brief would appear there
// as literal `#` and `*` characters. A Markdown heading labels a section; the
// card shows the prose under it.
test("a legacy brief written in Markdown shows its first prose sentence without Markdown syntax", () => {
  const cases: Array<[string, string]> = [
    [
      "# Supplier Auditor\n\nBuild an Agent that audits supplier agreements. Then it ranks them.",
      "Build an Agent that audits supplier agreements.",
    ],
    [
      "## Purpose\nBuild an Agent that audits supplier agreements. Then it ranks them.",
      "Build an Agent that audits supplier agreements.",
    ],
    [
      "**Purpose:** Build an Agent that audits supplier agreements. Then it ranks them.",
      "Purpose: Build an Agent that audits supplier agreements.",
    ],
    [
      "Build an Agent that audits supplier agreements\n## Run order\n1. Find each renewal clause.",
      "Build an Agent that audits supplier agreements",
    ],
  ];
  for (const [description, expected] of cases) {
    assert.equal(plannedAgentCardSummary(legacyAgent(description)), expected, JSON.stringify(description));
  }
});

test("a legacy brief of nothing but Markdown headings shows the role", () => {
  const card = plannedAgentCardSummary(legacyAgent("# Supplier Auditor\n\n## Purpose\n", "Supplier contract auditor"));

  assert.equal(card, "Supplier contract auditor");
});

test("a list number does not end the first sentence", () => {
  const cases: Array<[string, string]> = [
    ["1. Find each renewal clause.\n2. Rank them.", "1. Find each renewal clause."],
    ["Scope:\n1. Find each renewal clause.\n2. Rank them.", "Scope: 1. Find each renewal clause."],
    ["For every contract:\n\n1. Find each renewal clause.\n2. Rank them.", "For every contract: 1. Find each renewal clause."],
    ["Steps: 1. Find each renewal clause. 2. Rank them.", "Steps: 1. Find each renewal clause."],
  ];
  for (const [description, expected] of cases) {
    assert.equal(plannedAgentCardSummary(legacyAgent(description)), expected, JSON.stringify(description));
  }
});

test("an abbreviation does not end the first sentence", () => {
  const cases: Array<[string, string]> = [
    [
      "Reviews contracts, e.g. NDAs and MSAs, for renewal risk. Then it ranks them.",
      "Reviews contracts, e.g. NDAs and MSAs, for renewal risk.",
    ],
    [
      "Reviews supplier contracts (e.g. NDAs and MSAs) for renewal risk. Then it ranks them.",
      "Reviews supplier contracts (e.g. NDAs and MSAs) for renewal risk.",
    ],
    [
      "Checks U.S. supplier contracts for renewal risk. Then it ranks them.",
      "Checks U.S. supplier contracts for renewal risk.",
    ],
    [
      "Prepares renewal briefs for Dr. Okafor. Then it ranks them.",
      "Prepares renewal briefs for Dr. Okafor.",
    ],
    [
      "Reviews NDAs, MSAs, etc. for renewal risk. Then it ranks them.",
      "Reviews NDAs, MSAs, etc. for renewal risk.",
    ],
  ];
  for (const [description, expected] of cases) {
    assert.equal(plannedAgentCardSummary(legacyAgent(description)), expected, JSON.stringify(description));
  }
});

test("a legacy brief in Japanese or Chinese shows its first sentence", () => {
  const cases: Array<[string, string]> = [
    ["契約書を確認し、更新リスクを報告します。次に条項を順位付けします。", "契約書を確認し、更新リスクを報告します。"],
    ["审查供应商合同的续约风险！然后对条款排序。", "审查供应商合同的续约风险！"],
  ];
  for (const [description, expected] of cases) {
    assert.equal(plannedAgentCardSummary(legacyAgent(description)), expected, JSON.stringify(description));
  }
});

test("a word longer than the card is never cut between a letter and its accent", () => {
  // "e" followed by a combining acute accent is one visible letter and two
  // code points. 150 of them are 300 code points with no space to cut at.
  // 119 letters are 238 code points; the 120th would end at 240, past the
  // 239 the cut allows, so the card keeps 119 whole letters.
  const description = "é".repeat(150);

  const card = plannedAgentCardSummary(legacyAgent(description));

  assert.equal(card, `${"é".repeat(119)}…`);
});

test("a legacy brief with no sentence boundary is shown whole when it fits", () => {
  const card = plannedAgentCardSummary(legacyAgent("Reviews supplier contracts for renewal risk"));

  assert.equal(card, "Reviews supplier contracts for renewal risk");
});

test("a first sentence of exactly 240 characters is shown whole, and one more is cut", () => {
  // Forty five-letter words and their separators are 239 characters.
  const words = Array.from({ length: 40 }, () => "abcde").join(" ");
  const exact = `${words}.`;
  assert.equal(Array.from(exact).length, 240);
  assert.equal(plannedAgentCardSummary(legacyAgent(exact)), exact);

  // "abcdef." makes it 241. The first 239 characters end inside that last
  // word, so the cut falls back to the space before it.
  const overByOne = `${words}f.`;
  assert.equal(Array.from(overByOne).length, 241);
  assert.equal(
    plannedAgentCardSummary(legacyAgent(overByOne)),
    `${Array.from({ length: 39 }, () => "abcde").join(" ")}…`,
  );
});

test("a first sentence longer than the card is cut at a word boundary with one ellipsis", () => {
  // Sixty "clause" words are 419 characters before the full stop. Thirty-four
  // of them are 237 characters, and the 239-character cut ends two letters
  // into the thirty-fifth, so the card keeps thirty-four.
  const description = `${Array.from({ length: 60 }, () => "clause").join(" ")}. Second sentence.`;

  const card = plannedAgentCardSummary(legacyAgent(description));

  assert.equal(card, `${Array.from({ length: 34 }, () => "clause").join(" ")}…`);
  assert.ok(Array.from(card).length <= 240);
});

test("a long legacy brief is measured in code points and never split inside one", () => {
  // Each word is a receipt emoji and three letters: four code points, five
  // UTF-16 units. Forty-eight words and their spaces are exactly 239 code
  // points, so the card keeps forty-eight words. Counting UTF-16 units would
  // keep only forty.
  const description = Array.from({ length: 60 }, () => "🧾abc").join(" ");

  const card = plannedAgentCardSummary(legacyAgent(description));

  assert.equal(card, `${Array.from({ length: 48 }, () => "🧾abc").join(" ")}…`);
  assert.equal(Array.from(card).length, 240);
});

test("a legacy Agent with an empty brief shows its role", () => {
  const card = plannedAgentCardSummary(legacyAgent("  \n\t ", "  Renewal risk reviewer "));

  assert.equal(card, "Renewal risk reviewer");
});
