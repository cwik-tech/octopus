---
name: creative-ideation
description: >
  Divergent thinking protocols for generating novel solutions, approaches, and ideas.
  Applies SCAMPER, brainwriting, constraint removal, analogical transfer, and "How Might We"
  reframing to expand the solution space before convergent evaluation.
  Use when generating varied ideas and possible solutions.
---

# Creative Ideation Skill

This skill is the divergent counterpart to Decision Analysis (which is convergent). Use it when the problem is clear but the solution space hasn't been adequately explored — when the team is defaulting to obvious approaches, when innovation is explicitly needed, or when problem decomposition reveals a generative sub-problem.

Problem Decomposition classifies and breaks down. Decision Analysis evaluates and selects. This skill sits between them: it **generates the options** that Decision Analysis will later evaluate.

---

## When to Use This Skill

- Problem Decomposition routes to "Generative / Innovation"
- The team has only 1-2 obvious solutions and needs more options
- Stakeholders say "we need fresh thinking" or "what else could we do?"
- The current approach has failed and a fundamentally different approach is needed
- Before Decision Analysis, to ensure the option set is rich enough

## When NOT to Use This Skill

- The problem is diagnostic (something is broken — use Root Cause Analysis)
- The options are already well-defined and the task is selection (use Decision Analysis)
- Time pressure demands immediate action (use Cynefin Act-Sense-Respond)

---

## Ideation Protocol

### Phase 1: Problem Reframing (5-10 minutes)

Before generating solutions, ensure you're solving the right problem. Reframe the problem statement using "How Might We" (HMW) questions:

**Transform the problem statement into 3-5 HMW questions at different levels of abstraction:**

- **Narrow HMW:** Close to the original problem. "How might we reduce customer support ticket volume by 30%?"
- **Medium HMW:** Slightly broader. "How might we help customers solve problems without contacting support?"
- **Broad HMW:** Challenges the framing. "How might we design a product that doesn't generate confusion?"
- **Inverted HMW:** Flip the problem. "How might we make every support interaction so valuable that customers seek it out?"

**Select the HMW that opens the most interesting solution space.** The narrow version often leads to incremental improvements; the broad version opens transformative possibilities. Choose based on the mandate (incremental vs. breakthrough).

### Phase 2: Divergent Generation (15-30 minutes)

Apply 2-3 techniques from the toolkit below. **Quantity over quality** — defer judgment entirely during this phase. Bad ideas often contain seeds of great ones.

**Technique Selection Guide:**

| Situation | Recommended Technique |
|---|---|
| Improving an existing product/process | SCAMPER |
| Need radically different approaches | Constraint Removal |
| Stuck in domain-specific thinking | Analogical Transfer |
| Group brainstorming with diverse participants | Brainwriting |
| Need to push past obvious ideas | Random Entry / Forced Association |

See `references/divergent-techniques.md` for detailed protocols for each technique.

**Generation targets:**
- Minimum 15 ideas for any ideation session
- At least 3 ideas should feel uncomfortable or impractical (signs you've pushed beyond the obvious)
- Ideas should span at least 3 different approaches or categories

### Phase 3: Clustering and Theming (10 minutes)

After generating, organize without judging:

1. **Group similar ideas** into clusters. Give each cluster a theme name.
2. **Identify outliers** — ideas that don't fit any cluster. These are often the most innovative; don't discard them.
3. **Map clusters on an axes** of:
   - Feasibility (easy to implement → hard to implement)
   - Novelty (incremental → breakthrough)
4. **Name the "interesting quadrant":** High novelty + moderate feasibility. These are your breakthrough candidates.

### Phase 4: Idea Development (10-15 minutes per promising idea)

Take 2-4 ideas from Phase 3 (prioritize the "interesting quadrant") and develop each:

1. **Concept statement:** What is this idea, in 2-3 sentences?
2. **How it works:** The basic mechanism or approach.
3. **Why it might work:** What makes this plausible? What evidence or analogy supports it?
4. **Why it might fail:** What's the biggest risk or unknown?
5. **What it would take:** Resources, time, expertise, and dependencies needed.
6. **Minimum viable test:** The smallest experiment that would test the core assumption.

### Phase 5: Handoff to Decision Analysis

Package developed ideas as options for structured evaluation:

- Each developed idea becomes an "option" in the Decision Analysis framework
- Include the concept statement, mechanism, plausibility argument, risk, and resource estimate
- Flag which ideas are incremental improvements vs. breakthrough bets
- Recommend evaluation criteria based on the problem's priorities

Use the template at `templates/ideation-output.md`.

---

## Core Techniques (Quick Reference)

**SCAMPER:** Substitute, Combine, Adapt, Modify/Magnify, Put to other uses, Eliminate, Reverse/Rearrange. Apply each prompt to the current product or process. See `references/divergent-techniques.md`.

**Constraint Removal:** List all constraints (technical, budgetary, political, regulatory, physical). Remove each one and ask: "What would we do if this constraint didn't exist?" Then work backward: can any of these "impossible" ideas become partially feasible?

**Analogical Transfer:** Find a domain that solves a structurally similar problem differently. How do hospitals handle surge capacity? How do airlines price perishable inventory? How do open-source projects coordinate without hierarchy? Import the mechanism.

**Brainwriting:** Each participant writes 3 ideas in 5 minutes, passes their sheet to the next person, who builds on or is inspired by the previous ideas. 3 rounds produces 9+ ideas per person with cross-pollination.

**Random Entry:** Pick a random word, image, or object. Force a connection to the problem. "How would a library solve this?" "What if this were edible?" Absurdity triggers lateral thinking.

See `references/divergent-techniques.md` for full protocols and `references/ideation-facilitation.md` for guidance on running ideation sessions.

---

## Anti-Patterns

- **Premature judgment:** Evaluating ideas during generation kills creativity. Separate divergent and convergent phases strictly.
- **Anchoring on the first idea:** The first suggestion frames all subsequent thinking. Deliberately generate alternatives before discussing any idea in depth.
- **Domain myopia:** Only generating ideas from within the problem's domain. Force at least one cross-domain analogy.
- **Feasibility filter too early:** Dismissing "impossible" ideas before extracting their useful components. Wild ideas often contain transferable mechanisms.
- **Convergent disguised as divergent:** "Let's brainstorm!" followed by discussing only 2 pre-existing ideas is not ideation.
- **Stopping at obvious:** If every idea feels safe and incremental, you haven't pushed far enough. Apply Constraint Removal or Random Entry to break the pattern.

---

## Integration with Other Skills

- **Problem Decomposition** routes generative sub-problems here. Returns developed options.
- **Decision Analysis** receives the options this skill generates. Evaluates and selects.
- **Domain Research** informs analogical transfer. Understanding other domains provides source material for cross-pollination.
- **Argument Synthesis** builds the case for the selected option after ideation and evaluation.

---

## Reference Index

| File | Content | When to read |
|---|---|---|
| `references/divergent-techniques.md` | Full protocols for SCAMPER, Constraint Removal, Analogical Transfer, Brainwriting, Random Entry | During Phase 2 |
| `references/ideation-facilitation.md` | Running ideation sessions, managing group dynamics, avoiding groupthink | When facilitating multi-agent or multi-stakeholder ideation |
| `templates/ideation-output.md` | Structured output for developed ideas | Phase 5 handoff |
