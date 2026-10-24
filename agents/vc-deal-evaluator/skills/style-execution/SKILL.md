---
name: style-execution
description: >
  Adapted from the Writer agent. Use this when the Deal Evaluator must write the
  final investment memo in a controlled house style rather than only orchestrate
  debate.
---

# Style Execution Skill

## When to Use

Use this whenever the Deal Evaluator writes the final `output/investment-memo.md`.

## Required Profile

For venture-capital memo synthesis, use `teams/writing-team/profiles/strategic-consulting.yaml`.

That means:

- lead with the answer, not the scene-setting
- write in third person
- keep hedging low and earned
- use short-to-medium sentences
- translate observations into decision meaning
- avoid chatty framing, rhetorical flourish, and casual labels

## Execution Rules

1. Start with the recommendation and its implication.
2. Prefer precise business language over vivid phrasing.
3. State uncertainty explicitly instead of letting vagueness leak into every sentence.
4. If evidence is incomplete, write `Information not provided`.
5. Do not narrate the meeting. Synthesize the investment case.

## Banned Patterns

- "the story is"
- "the reality is"
- "it seems"
- "looks like"
- "straightforward"
- casual intensifiers and rhetorical setup
