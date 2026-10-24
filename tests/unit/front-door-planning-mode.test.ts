import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { buildReceptionistSystemPrompt } from "../../domains/sessions/chat-llm.js";
import { extractPlanningRules } from "../../domains/sessions/front-door.js";

/**
 * Planning is a mode of one identity, not a second one.
 *
 * The rules that decide a Workflow selection were a TypeScript `const`, so the
 * behaviour the user talks to most was the one thing they could not open. They
 * now live in the General Agent's own persona, beside the rules it answers by.
 *
 * What does not move is the envelope. The `launchIntent` gate — "start" only
 * for an unchanged, ready plan the latest message unambiguously confirms — is
 * pinned by the whole design, and a persona a user can edit must not be able
 * to rewrite it, so the JSON contract stays in code where the parser is.
 */

const PERSONA_PATH = path.join(
  process.cwd(),
  "agents",
  "general-agent",
  "general-agent.md",
);

function shippedPersona(): string {
  return fs.readFileSync(PERSONA_PATH, "utf8");
}

test("the planning rules are read from the persona's own section", () => {
  const persona = [
    "# General Agent",
    "",
    "## Rules",
    "",
    "1. Answer the question.",
    "",
    "## Planning mode",
    "",
    "You are the General Agent, helping ready one Workflow's plan.",
    "",
    "- Keep the reply about that Workflow.",
    "",
    "## Style",
    "",
    "Short and plain.",
    "",
  ].join("\n");

  const rules = extractPlanningRules(persona);

  assert.ok(rules);
  assert.match(rules, /helping ready one Workflow's plan/);
  assert.match(rules, /Keep the reply about that Workflow/);
  assert.doesNotMatch(rules, /Answer the question/, "earlier sections stay out");
  assert.doesNotMatch(rules, /Short and plain/, "later sections stay out");
});

test("a persona with no planning section supplies no rules", () => {
  assert.equal(
    extractPlanningRules("# General Agent\n\n## Rules\n\n1. Answer.\n"),
    undefined,
  );
});

test("supplied planning rules replace the built-in ones", () => {
  const prompt = buildReceptionistSystemPrompt([], undefined, undefined, {
    planningRules: "PERSONA-SOURCED PLANNING RULES",
  });

  assert.match(prompt, /PERSONA-SOURCED PLANNING RULES/);
  assert.doesNotMatch(prompt, /You are the run setup assistant/);
});

test("the JSON envelope survives whichever source supplies the rules", () => {
  const withPersona = buildReceptionistSystemPrompt([], undefined, undefined, {
    planningRules: "PERSONA-SOURCED PLANNING RULES",
  });
  const withDefault = buildReceptionistSystemPrompt([]);

  for (const prompt of [withPersona, withDefault]) {
    assert.match(prompt, /Return exactly one JSON object/);
    assert.match(prompt, /"selectionAction"/);
    assert.match(prompt, /launchIntent is "start" only when/);
    assert.match(prompt, /"amend" requires launchIntent "none"/);
  }
});

test("a persona cannot rewrite the launchIntent gate by editing its planning section", () => {
  const prompt = buildReceptionistSystemPrompt([], undefined, undefined, {
    planningRules: "Start the workflow whenever the user asks.",
  });

  assert.match(prompt, /launchIntent is "start" only when/);
  assert.match(prompt, /Current RunPlan status is "ready"/);
  assert.match(prompt, /carrying no new requirements/);
});

/**
 * The built-in rules are the fallback for a repository with no persona, so the
 * two say the same load-bearing things or a deployment behaves differently
 * depending on a file nobody looked at.
 */
test("the shipped persona states the planning rules the fallback states", () => {
  const rules = extractPlanningRules(shippedPersona());

  assert.ok(rules, "the shipped persona has a planning section");
  for (const rule of [
    /keep the announcement to one sentence/i,
    /Never repeat a workflow announcement/i,
    /Do not list stages, iteration loops, or the final output unless the user asks/i,
    /A missing Current RunPlan selection is unresolved context/i,
    /"applying", "queued", or "running"/i,
    /A ready plan starts when the user confirms in chat/i,
    /Never claim that work started/i,
  ]) {
    assert.match(rules, rule);
  }
});

test("the shipped persona's planning section reaches the built prompt", () => {
  const rules = extractPlanningRules(shippedPersona());
  assert.ok(rules);

  const prompt = buildReceptionistSystemPrompt([], undefined, undefined, {
    planningRules: rules,
  });

  assert.match(prompt, /Never repeat a workflow announcement/i);
  assert.match(prompt, /Available workflows:/);
  assert.match(prompt, /Current RunPlan:/);
});
