---
name: technical-accuracy-verification
description: >
  Validate technical claims, code examples, formulas, procedures, and domain-specific
  facts for correctness and soundness. Use when reviewing code walkthroughs for
  execution correctness, scientific methods for methodological soundness, historical
  claims for factual accuracy, mathematical derivations for correctness, technical
  procedures for workability, or any domain-specific statement to ensure it is
  factually true and appropriate for the stated learner level.
---

# Technical Accuracy Verification

## Purpose

Validate that technical claims, code examples, procedures, and factual statements are correct, current, and will work as described for learners at the stated level. This is your core gate between a draft and a review verdict.

## When to Use This Skill

Apply this skill to **every fact-bearing element** of the teaching manual:

- **Code examples:** Will they run in the stated environment? Do they use correct syntax and logic? Are they idiomatic for the language and learner level?
- **Scientific methods or procedures:** Do they follow current best practice? Are steps in the right order? Will they produce the intended result?
- **Historical claims:** Are dates, names, events, and attributions factually accurate? Are claims sourced?
- **Mathematical or technical formulas:** Are they derived correctly? Do they apply to the stated context?
- **Domain-specific definitions and terminology:** Are terms defined correctly? Is usage aligned with professional standards?
- **Performance claims or comparisons:** If the manual claims one approach is faster, safer, or better, are those claims supported?

## Evaluation Frame by Domain

### Coding Tutorials

- **Execution:** Does the code run without error in the stated environment (Python 3.9+, Node.js 16, etc.)?
- **Correctness:** Does it produce the claimed output? Are edge cases handled?
- **Idiom:** Does it use language idioms appropriate for the learner level? A beginner tutorial shouldn't require advanced metaprogramming; an advanced tutorial shouldn't use beginner patterns.
- **Imports and dependencies:** Are all required imports listed? Do they work with the stated versions?
- **Explanation accuracy:** Does the text-based explanation of the code match what the code actually does?
- **Beginner-readability:** If this is a beginner tutorial, can a learner who has read the preceding material understand this example without external research?

### Scientific and Procedural Content

- **Method soundness:** Does the procedure follow current best practice in the field? Is it the most appropriate method for the goal?
- **Completeness:** Are all necessary steps present? Are there hidden prerequisites?
- **Safety and warnings:** Are hazards, precautions, or common mistakes noted?
- **Reproducibility:** Could a learner at the stated level follow these steps and get the intended result?
- **Terminology:** Are technical terms used correctly and defined where needed?

### Historical or Factual Content

- **Accuracy:** Are dates, names, events, and attributions correct? Cross-reference against authoritative sources.
- **Context:** Is the claim contextualized appropriately, or is it misleading through omission?
- **Currency:** If describing historical "common belief," is it clear what the belief was and when it changed?
- **Attribution:** Are quotes, data, and arguments properly attributed?

### Mathematical and Technical Derivations

- **Correctness:** Are steps valid? Do formulas apply to the stated context?
- **Completeness:** Are intermediate steps shown at appropriate granularity for the learner level?
- **Notation:** Is notation consistent and defined?
- **Verification:** Can the result be spot-checked or verified independently?

## Verification Workflow

1. **Identify each factual claim** in the section. Don't skip "obvious" claims—verify them.
2. **Determine the claim type:** code, procedure, historical fact, formula, definition, performance claim, best-practice assertion.
3. **Set the verification bar.** For well-established domain facts (e.g., "Python lists are mutable"), general knowledge suffices. For novel claims, performance comparisons, or newer practices, require stronger evidence.
4. **Verify or test:**
   - **Code:** Run it. Trace through it step by step. Check for off-by-one errors, edge cases, and assumptions.
   - **Procedures:** Mentally walk through or research whether the steps work in the stated context.
   - **Facts:** Cross-reference against authoritative sources.
   - **Formulas:** Verify derivation or cross-check against textbook/academic sources.
   - **Definitions:** Check against field-standard definitions.
5. **Note the learner-level bar.** A claim that's correct but too advanced for the learner level is flagged as a precision/scaffolding issue, not an accuracy failure.
6. **Document findings.** For each claim: Verdict (correct, incorrect, or unclear/unsupported), Evidence (what you verified against), Confidence (high, medium, or low), Recommendation (approve, flag for correction, or note caveat needed).

## Common Accuracy Pitfalls

- **Outdated guidance:** Code using deprecated APIs, scientific methods superseded by newer approaches, historical "facts" that have been revised.
- **Undeclared assumptions:** Code assumes a particular version, environment, or prerequisite knowledge not stated in the manual.
- **Off-by-one errors and edge cases:** Code that works for the happy path but fails on boundary conditions.
- **Imprecise terminology:** Using a term in a way that doesn't match professional usage, causing learners to misunderstand when they encounter the term elsewhere.
- **Unattributed claims:** Performance comparisons, historical assertions, or technical claims presented without citing evidence.
- **Learner-level mismatches:** Explanations that assume too much or too little prior knowledge.

## Decision Rules

- **If a claim is factually wrong:** Flag as a blocker. Do not approve.
- **If a claim is outdated:** Note the recency concern. Approve with caveat if context is provided ("this was standard before 2020"), or request update if current practice differs significantly.
- **If precision is imprecise for the domain but correct:** Flag as a warning if learner level demands precision, or as a suggestion if precision is optional at this level.
- **If a code example has a minor bug that learners would catch during practice:** Flag as a warning if the bug teaches something useful, or as a blocker if it's a careless mistake.
- **If you cannot verify a claim:** Note your uncertainty. Flag as a concern to be resolved by a domain expert or primary source.

## Red Lines

- Never approve code that doesn't run or produces incorrect output.
- Never approve factual claims you cannot verify or that contradict authoritative sources.
- Never accept imprecision as acceptable just because it's simpler. Flag and recommend better explanation.
- Never demand evidence for established domain-standard facts. But do demand evidence for novel, comparative, or contested claims.
