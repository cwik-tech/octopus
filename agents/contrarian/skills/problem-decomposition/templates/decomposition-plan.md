# Decomposition Plan: [Problem Title]

## Classification
- **Domain:** [Clear / Complicated / Complex / Chaotic]
  <!--
  Domain classification:
  - Clear: Well-defined problem with known solutions and predictable outcomes
  - Complicated: Multiple interconnected factors; solutions exist but require expert knowledge
  - Complex: Many variables, feedback loops; best practices emerge through probing
  - Chaotic: No clear patterns; focus on stabilization and sense-making
  -->
- **Type:** [Diagnostic / Analytical / Generative / Strategic]
  <!--
  Problem type:
  - Diagnostic: Identify root causes or understand what's happening
  - Analytical: Evaluate options, compare alternatives, measure impact
  - Generative: Create or design new solutions, plans, or artifacts
  - Strategic: Set direction, make multi-step decisions with long-term consequences
  -->
- **Method selected:** [Name of methodology]
  <!-- e.g., Five Whys, First Principles, Constraint Analysis, Systems Thinking, Hypothesis Testing -->
- **Rationale:** [1-2 sentences on why this method fits]

## Problem Statement
[Restate the problem in precise, unambiguous terms. Include scope boundaries. Example: "We need to reduce API response time from 500ms to under 200ms for the checkout flow, given current database constraints."]

## Assumptions
[List assumptions baked into this decomposition. Each assumption should be testable. Flag any assumptions marked as risky or low confidence with [VALIDATE] tag.]

- Example: [VALIDATE] User traffic will remain stable during implementation
- Example: We have access to production logs for analysis

## Decomposition

### Sub-problem 1: [Title]
- **Description:** [What needs to be resolved. Keep focused and specific.]
- **Information needed:** [What data, context, or facts are required to solve this. What's unknown?]
- **Approach:** [Concrete steps or method to tackle this sub-problem.]
- **Done when:** [Clear success criteria or exit condition. How will we know this is solved?]
- **Confidence:** [High / Medium / Low — and 1-2 words on why]

### Sub-problem 2: [Title]
[Same structure as Sub-problem 1]

### Sub-problem 3: [Title]
[Same structure as Sub-problem 1]

[Continue as needed...]

## Dependencies
[Which sub-problems must be solved before others can begin. Use notation like "SP2 requires SP1" or "SP3 can proceed in parallel with SP1-SP2".]

Example:
- SP1 must complete before SP2 (we need root cause before evaluating solutions)
- SP3 and SP4 can work in parallel (independent tracks)

## Risks and Unknowns
[What assumptions are weakest? Where could this decomposition fail? What information gaps remain? Are there edge cases we're not considering?]

- Example: We may lack deep expertise in [domain] — consider bringing in specialists
- Example: Regulatory constraints not yet identified — validate with compliance team

## Next Steps
[The first concrete action to take. Be specific: who, what, by when. This should be executable immediately.]

Example: Schedule a 1-hour discovery call with the database team to understand current bottlenecks (by tomorrow EOD).
