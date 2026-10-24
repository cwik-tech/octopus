---
name: learning-progression-and-scaffolding
description: >
  Assess whether teaching content is logically sequenced, properly scaffolded,
  and builds from known to unknown in ways that support learner understanding.
  Verify prerequisites are taught before dependent concepts, difficulty increases
  gradually, and no unexplained conceptual jumps occur. Use when evaluating
  whether a teaching manual or instructional guide presents information in the
  order that maximizes learner comprehension and retention, or when auditing
  whether learners have the foundational knowledge before facing advanced concepts.
---

# Learning Progression and Scaffolding

## Purpose

Assess whether a teaching manual presents concepts in the right sequence, with appropriate scaffolding (support structures that help learners climb from simple to complex). Poor sequencing is invisible until learners fail to understand something that should be clear—often because a prerequisite was taught too late or skipped entirely.

## Methodology

### 1. Extract the Prerequisite Graph

List every major concept taught in the manual. For each concept, name the prerequisite concepts learners must understand first. Build a dependency map:

```
Concept A → requires [Concept B, Concept C]
Concept B → requires [Concept D]
Concept C → requires [Concept D]
Concept D → no prerequisites (or only prior-knowledge prerequisites)
```

### 2. Verify Prerequisite Teaching Order

Check the manual's structure against the prerequisite graph:

- Is Concept D taught before B and C?
- Is B taught before A?
- Are any prerequisites omitted (assumed prior knowledge)?
- If prerequisites are assumed, is that assumption safe for the stated learner level?

Flag any teaching order that violates the prerequisite structure.

### 3. Evaluate Scaffolding Density

For each major concept, assess whether the manual builds support gradually:

- **Concrete-to-abstract:** Does it start with examples, then move to abstraction? Or jump straight to abstract rules?
- **Part-to-whole:** Does it introduce pieces first, then show how they fit together?
- **Guided-to-independent:** Does it show worked examples, then guided practice with hints, then independent practice? Or expect independence too soon?
- **Known-to-unknown:** Does it connect new concepts to prior knowledge? Or feel disconnected?

Flag scaffolding that is insufficient (learner struggles because support withdraws too soon) or excessive (learner doesn't gain independence).

### 4. Assess Difficulty Curve

Map the difficulty level of each section (Novice → Intermediate → Advanced):

- Does difficulty increase gradually or jaggedly?
- Are there sudden jumps where a learner might get lost?
- Is there review of harder concepts or only forward momentum?
- Does the manual spiral (revisit concepts at higher difficulty), or move on linearly and never revisit?

### 5. Check for Conceptual Jumps

Read transitions between sections for:

- "Now we move to X..." when the reader doesn't know why X matters or how it connects.
- Technical terms introduced without definition or example.
- Procedures taught without explanation of *why* the procedure works.
- Conclusions drawn from examples without explicitly naming the principle being illustrated.

### 6. Identify Prerequisite Gaps

For each unmet prerequisite, assess risk:

- **Safe assumption:** "We assume you know basic algebra" for a calculus manual aimed at high-school learners. Reasonable.
- **Risky assumption:** "We assume you understand machine learning" in a manual on prompt engineering for non-technical users. Risky; should include foundation.
- **Hidden prerequisite:** The manual never states it assumes knowledge of X, but concept Y doesn't make sense without understanding X first. This is a pedagogical bug.

## Output

### Strengths

- What sequencing and scaffolding choices work well?
- Where is progression particularly clear or the difficulty gradient particularly gentle?
- Are transitions between concepts explicit and well-connected?

### Gaps

- Missing prerequisites or gaps in prerequisite teaching?
- Insufficient scaffolding (learner pushed into independence too fast)?
- Excessive scaffolding (learner not given enough autonomy)?
- Unsupported conceptual jumps?
- Jagged difficulty curve with unexplained jumps?
- Concepts that are never revisited (no spiraling)?

### Recommendations

For each gap, recommend a specific fix:

- **Reorder:** "Move introduction to X before Y because Y assumes understanding of X."
- **Add scaffolding:** "Add a worked example before the first independent practice."
- **Add connection:** "Explicitly link this concept to the prerequisite taught in Section 2."
- **Define terms:** "Define 'threshold concept' before using it in the explanation."
- **Add foundation:** "Include a 1-paragraph review of basic algebra for learners who lack it fresh."
- **Add spiral:** "Revisit recursion in Chapter 5 when teaching tree traversal, so learners practice it again in a new context."

**Evidence-Based Basis**

Cite the pedagogical principle:
- Scaffolding theory (Wood, Bruner, Ross): Learners need support that gradually diminishes as competence grows.
- Prerequisite structure: Cognitive load is minimized when prerequisites are understood before dependent concepts.
- Concrete-to-abstract progression: Novices learn better when examples precede rules.
- Spiral curriculum (Bruner): Revisiting concepts at higher difficulty is more effective than one-pass teaching.
