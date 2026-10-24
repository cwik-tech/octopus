---
name: problem-decomposition
description: >
  Structured problem decomposition methodology toolkit. Classifies problems by domain
  (Clear/Complicated/Complex/Chaotic) and type (Diagnostic/Analytical/Generative/Strategic),
  then applies the matching methodology — Root Cause Analysis (RCA), MECE/Issue Trees, Functional
  Decomposition, Soft Systems Methodology (SSM)/CATWOE, First Principles, or Design Thinking/TRIZ.
  Use when breaking an ambiguous problem into tractable parts.
---

# Problem Decomposition Skill

This skill provides the classification protocol, methodology routing, and output templates for structured problem decomposition. The agent invoking this skill owns the workflow and identity; this skill owns the *how*.

---

## Layer 1: Classification Protocol

Run through these four questions before selecting any methodology.

### Question 1 — Cause-and-effect clarity

What is the relationship between cause and effect in this problem?

| Signal in the problem statement | Classification |
|---|---|
| Known solution exists, just needs applying | Clear |
| Experts can analyze their way to an answer | Complicated |
| Only visible in retrospect, feedback loops present | Complex |
| No discernible pattern, crisis conditions | Chaotic |
| Cannot determine from available information | Confused |

### Question 2 — Problem definition agreement

Is the problem itself agreed upon?

| Signal | Implication |
|---|---|
| Single clear statement, no competing interpretations | Proceed to decomposition |
| Multiple stakeholders describe different problems | Sense-making required first (SSM/CATWOE) |
| Vague or abstract framing ("we need to be more innovative") | Clarification required before classification |

### Question 3 — Problem type

What is the user trying to do?

| Type | Pattern |
|---|---|
| Diagnostic | Something broke or underperforms. "Why did X happen?" |
| Analytical | A scoped question needs a structured answer. "How should we do X?" |
| Generative | A new solution or approach is needed. "What could we build?" |
| Strategic | A decision among competing options. "Should we do X or Y?" |

### Question 4 — Information sufficiency

What do you know, and what is missing? If the problem statement is too vague to classify, do not guess. State what you can infer, identify the 2-3 critical unknowns, and formulate specific questions.

---

## Methodology Routing Table

Based on your classification, select the primary method and read the corresponding reference file. All paths are relative to this skill's directory.

| Classification | Strategy | Primary Method | Reference |
|---|---|---|---|
| Clear + Diagnostic | Root Cause Analysis | Ishikawa + 5 Whys | `references/root-cause-analysis.md` |
| Clear + Analytical | Structured Decomposition | MECE / Issue Trees | `references/mece-issue-trees.md` |
| Complicated + Analytical | Expert Decomposition | Functional Decomposition + Hypothesis-Driven | `references/functional-decomposition.md` |
| Complicated + Strategic | Decision Analysis | First Principles + MECE | `references/first-principles.md` |
| Complex + any | Experimental Decomposition | Probe-Sense-Respond | `references/cynefin-framework.md` |
| Complex + feedback loops | Systems-Level Analysis | Stocks, Flows, Feedback Loops + Archetypes | `references/systems-dynamics.md` |
| Ambiguous definition | Sense-Making First | SSM + CATWOE | `references/soft-systems-methodology.md` |
| Generative / Innovation | Creative Decomposition | Design Thinking + TRIZ | `references/design-thinking.md` |
| Chaotic / Crisis | Stabilize First | Act-Sense-Respond | `references/cynefin-framework.md` |

If the problem spans multiple categories, note which sub-problems fall into which category — they may need different methods applied in parallel.

---

## Layer 2: Decomposition Execution

After reading the relevant reference file, apply the selected method to produce structured output.

**Direct mode** — Produce a decomposition plan using the template in `templates/decomposition-plan.md`. Include: classification rationale, the decomposition tree, per-leaf details (what, information needed, done-when), dependencies, and a confidence assessment.

**Orchestration mode** — Produce an orchestration plan using the template in `templates/orchestration-plan.md`. Each sub-problem is tagged with: unique ID, statement, recommended methodology for the sub-agent, required inputs, expected outputs, dependencies, expertise type needed, and priority. Include an execution order DAG, an aggregation strategy, and a fallback plan.

---

## Self-Check Pass

After producing the initial decomposition, run these checks before presenting output:

- **Completeness:** Is there a category or angle not considered? (The "collectively exhaustive" check.)
- **Independence:** Are sub-problems truly independent, or do hidden dependencies exist?
- **Methodology fit:** Step back — does the method match the problem, or did you default to something familiar?
- **Assumption surfacing:** What assumptions are baked in that should be stated explicitly?
- **Feedback loop detection:** Are there reinforcing or balancing loops between sub-problems? Could solving one amplify or undermine another? If yes, read `references/systems-dynamics.md` and revise.

If this check reveals issues, revise the decomposition. If the problem turns out to be a different type than initially classified, reclassify and restart Layer 2 with the correct method.

---

## Archived Methods

The `references/archive/` directory holds methods not in the routing table but available as supplementary lenses. Read these only when the primary method is insufficient or when a supplementary perspective would strengthen the decomposition:

- `references/archive/six-thinking-hats.md` — Post-decomposition evaluation (apply all six hats to stress-test the plan)
- `references/archive/lateral-thinking.md` — Pattern-breaking when analytical decomposition produces only obvious results
- `references/archive/stacey-matrix.md` — Secondary classifier when stakeholder agreement is ambiguous
- `references/archive/ai-reasoning-architectures.md` — Chain of Thought (CoT), Tree of Thoughts (ToT), Graph of Thoughts (GoT), ReAct patterns

---

## Reference Index

| File | Method | When to read |
|---|---|---|
| `references/cynefin-framework.md` | Cynefin Framework | Classification or Complex/Chaotic problems |
| `references/design-thinking.md` | Design Thinking / Double Diamond / TRIZ | Generative or innovation problems |
| `references/first-principles.md` | First Principles + Hypothesis-Driven | Strategic or assumption-heavy problems |
| `references/functional-decomposition.md` | Functional Decomposition / WBS | Complicated + Analytical technical problems |
| `references/mece-issue-trees.md` | MECE / Issue Trees | Clear or Complicated + Analytical |
| `references/root-cause-analysis.md` | Ishikawa + 5 Whys | Clear + Diagnostic |
| `references/soft-systems-methodology.md` | SSM + CATWOE | Ambiguous problem definition |
| `references/systems-dynamics.md` | Stocks, Flows, Feedback Loops, Archetypes | Complex problems with feedback loops or delayed effects |

## Template Index

| File | When to use |
|---|---|
| `templates/decomposition-plan.md` | Direct solving mode |
| `templates/orchestration-plan.md` | Sub-agent dispatch mode |
