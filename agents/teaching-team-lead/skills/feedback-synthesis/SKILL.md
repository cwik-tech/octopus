---
name: feedback-synthesis
description: Synthesize pedagogical and technical feedback into unified teaching improvement roadmap. Resolve conflicts between specialist perspectives, identify coverage gaps, and order improvements by author workflow and priority. Use after both pedagogical and technical reviews are complete to translate specialist feedback into actionable guidance.
---

# Teaching Feedback Synthesis

## Purpose

Bring pedagogical and technical reviews together into one coherent improvement strategy that authors can execute, preventing contradictory guidance and ensuring no feedback silo misses critical gaps.

## Synthesis Framework

### Step 1: Feedback Inventory

For each specialist review, extract:
1. **Blocking issues:** Problems that prevent the manual from meeting its learning goals or technical standards
2. **Warnings:** Issues that weaken the manual but don't fully break it
3. **Suggestions:** Optional enhancements
4. **Implicit gaps:** Coverage holes the reviewer hinted at but didn't explicitly name

### Step 2: Cross-Specialist Analysis

#### Identify Direct Contradictions
- Pedagogical feedback: "Simplify for engagement"
- Technical feedback: "Add more detail for accuracy"

For each contradiction:
1. Name it explicitly
2. Determine whether it's real (both valid concerns) or false (one reviewer misunderstood the goal)
3. If real, decide the priority: Does learning goal or technical accuracy take precedence?
4. Reconcile into one improvement action

#### Identify Redundancy
- Both reviewers flagged the same issue from different angles
- Merge into one improvement action (avoiding author confusion from duplicate feedback)
- Note which specialist's framing was more useful

#### Identify Coverage Gaps
- Neither reviewer mentioned a learning outcome, technical edge case, or audience need
- Name why it was missed (e.g., "Technical reviewer assumed this edge case was rare; pedagogical reviewer didn't check prerequisites")
- Determine if gap is pedagogical, technical, or both

#### Identify Reinforcement
- Both reviewers flagged the same issue from the same angle
- Strong signal: This is a definite improvement
- Prioritize accordingly

### Step 3: Priority and Sequence

For each improvement, determine:

1. **Priority Level:**
   - **Blocking:** Prevents learning goal achievement or violates technical accuracy requirements
   - **High:** Significantly weakens teaching or technical credibility
   - **Medium:** Noticeable weakness; should be addressed
   - **Low:** Polish or enhancement

2. **Execution Sequence:**
   - What must be fixed first?
   - What depends on prior fixes?
   - What can the author do in parallel?

3. **Effort Estimate:**
   - Quick fix (sentence rewrite)
   - Moderate work (section restructure)
   - Major overhaul (rewrite, new section)

### Step 4: Roadmap Composition

Do NOT organize by specialist (pedagogical feedback, then technical feedback). Instead, organize by:

1. **What the author must do first** (prerequisite improvements)
2. **What can happen in parallel** (independent improvements)
3. **What depends on prior fixes** (dependent improvements)

Example structure:

**Blocking Improvements (Must Fix Before Resubmit)**
- [Fix 1]: [What and why] (pedagogical + technical grounding)
- [Fix 2]: [What and why] (only if multiple blocking issues exist)

**Coverage Gaps (Should Fill These)**
- [Gap 1]: [What's missing, why it matters, how to fill it]
- [Gap 2]: ...

**Pedagogical Enhancements (Can Do in Parallel)**
- [Enhancement 1]: [What and why] (which specialist suggested it)
- [Enhancement 2]: ...

**Technical Enhancements (Can Do in Parallel)**
- [Enhancement 1]: [What and why]
- [Enhancement 2]: ...

**Optional Polish**
- [Polish 1]: [What and why]
- [Polish 2]: ...

### Step 5: Synthesis Memo

Write a brief synthesis memo that:
1. **States the manual's type and learning goal** (from classification)
2. **Summarizes pedagogical feedback** (2-3 key themes, not a list)
3. **Summarizes technical feedback** (2-3 key themes, not a list)
4. **Names contradictions** and how you resolved them
5. **Calls out coverage gaps** neither specialist flagged
6. **Presents the roadmap** organized by author workflow

## Common Tensions and Resolutions

| Tension | Pedagogical View | Technical View | Resolution Strategy |
|---------|---|---|---|
| Depth vs. Simplicity | "Simplify for engagement" | "Add missing detail for accuracy" | Check learning goals: if goal is conceptual understanding, simplicity wins; if goal includes applied technical skill, detail wins |
| Breadth vs. Depth | "Cover more topics for completeness" | "Go deeper on each topic for rigor" | Check audience: if learners are domain-adjacent, breadth wins; if experts, depth wins |
| Happy Path vs. Edge Cases | "Focus sequence on common use case" | "Explain edge cases and exceptions" | Check manual type: procedural guides need both; introductory guides lead with happy path |
| Scaffolding vs. Rigor | "Use metaphors and analogies" | "Use precise technical language" | Check audience: novices need scaffolding; experts need precision |

## Output

Teaching Improvement Roadmap with:
- Manual type and learning goals
- Pedagogical feedback summary (themes, not list)
- Technical feedback summary (themes, not list)
- Explicit conflict resolutions (if any)
- Identified coverage gaps
- Prioritized, sequenced improvement roadmap
- Synthesis memo (2-3 paragraphs on how the reviews reinforce each other and where they diverge)
