---
name: structural-isomorphism
description: Strip a problem of its domain content to expose its abstract shape, classify that shape against a pattern taxonomy, and import verified solutions from unrelated domains. Use at the start of problem analysis, when a discussion is stuck and needs a fundamentally different angle, or when testing whether a proposed analogy is structural rather than superficial.
---

# Structural Isomorphism

A systematic protocol for identifying, verifying, and exploiting structural similarities between the current problem and problems from unrelated domains.

## When to Use

- At the start of any problem analysis, to identify the problem's abstract shape before domain-specific reasoning begins
- When the board is stuck and needs a fundamentally different angle
- When a proposed solution feels familiar but nobody can articulate why
- When evaluating whether an analogy another agent proposed is superficial or structural

## Core Protocol: Five Steps

### Step 1 — Shape Extraction

Strip all domain-specific content from the problem. Remove the nouns, the industry, the stakeholders, the technology. What remains is the abstract structure.

**Extraction questions:**

1. What *flows* through this system? (Information, money, goods, attention, authority, trust)
2. What are the *entities* and how are they *connected*? (Network, hierarchy, market, queue, pipeline)
3. What *dynamics* drive change? (Feedback loops, competition, accumulation, decay, oscillation)
4. What *constraints* limit the system? (Capacity, time, information asymmetry, coordination cost)
5. What *failure mode* is occurring or being risked? (Bottleneck, cascade, deadlock, tragedy of the commons, race condition)

**Output:** A 2–3 sentence structural description using only abstract terms. No domain-specific language.

**Example:**
- Domain description: "Our SaaS (Software as a Service) company is losing enterprise customers after the first year because onboarding takes too long and they never reach the features that justify the price."
- Structural extraction: "A flow problem: entities enter a pipeline but encounter a bottleneck early in the sequence. The bottleneck prevents entities from reaching a value threshold, triggering an exit condition. The system loses entities before they reach the phase where retention forces (switching costs, accumulated investment) would keep them."

### Step 2 — Pattern Classification

Match the extracted shape against the pattern taxonomy (see `references/pattern-taxonomy.md`). Most problems map to one primary pattern and 1–2 secondary patterns.

**Classification rules:**

- Always classify the *primary* pattern first — the one that most completely describes the core dynamics.
- Identify *secondary* patterns that describe important sub-dynamics or interacting forces.
- If no pattern in the taxonomy fits, describe the novel structure explicitly and note it for future addition to the taxonomy.
- If the problem fits too many patterns equally well, the extraction in Step 1 was too vague. Go back and sharpen it.

**Output:** Primary pattern name + 1–2 secondary pattern names, with a one-sentence justification for each.

### Step 3 — Cross-Domain Scan

For each classified pattern, identify 3–5 instances from other domains where the same structure appears. Draw from the broadest possible range: biology, physics, computer science, economics, ecology, military strategy, epidemiology, urban planning, game theory, thermodynamics, linguistics, music theory, sociology, evolutionary biology, network science.

**Scan protocol:**

1. Start with the *most distant* domains from the problem's home domain. The farther the source domain, the more novel the insight (if the match holds).
2. For each candidate match, write one sentence describing how the source domain's problem maps to the current problem.
3. Prioritize matches where the source domain has *solved* the problem — not just experienced it.
4. Flag matches where the source domain *failed* to solve it — failure modes are as informative as solutions.

**Output:** 3–5 candidate matches, each with: source domain, source problem, one-sentence mapping, and whether the source domain solved it.

### Step 4 — Isomorphism Verification

For each candidate match from Step 3, verify the structural isomorphism at three levels using the verification protocol (see `references/verification-protocol.md`).

**Three-level check:**

| Level | Question | Strong match | Weak match |
|-------|----------|-------------|------------|
| **Entity mapping** | Do the key entities in both systems correspond? | 1:1 mapping with clear functional equivalence | Entities map but with significant gaps or forced analogies |
| **Relationship mapping** | Do the relationships between entities correspond? | Same topology — the connection structure is identical | Some relationships map, others don't exist in the target |
| **Dynamics mapping** | Do the systems evolve over time in the same way? | Same feedback loops, same equilibria, same phase transitions | Similar qualitative behavior but different quantitative dynamics |

**Verification rules:**

- All three levels must hold for a match to be called *structural*. If only Level 1 holds, it's a *metaphor*. If Levels 1–2 hold but not 3, it's an *analogy*. Only all three make it an *isomorphism*.
- Be ruthless. Most promising matches fail at Level 3 (dynamics). That's normal. Report the failure — it's informative.
- When a match fails at one level, name what breaks.

**Output:** For each candidate, the three-level assessment and a verdict: isomorphism / analogy / metaphor.

### Step 5 — Solution Transfer

For verified isomorphisms (and strong analogies), assess whether the source domain's solutions transfer to the target domain. Use the solution transfer checklist (see `references/solution-transfer.md`).

**Transfer assessment:**

1. **Mechanism extraction:** What is the source domain's solution *mechanism* — not the specific implementation, but the abstract principle?
2. **Condition check:** What conditions does the source domain's solution depend on? Do those conditions exist in the target domain?
3. **Constraint check:** What constraints in the target domain don't exist in the source domain? Could they block the transferred solution?
4. **Cost check:** What does the solution cost in the source domain (in abstract terms)? Is a comparable cost acceptable in the target domain?
5. **Failure mode check:** How does the source domain's solution fail when it fails? Would that failure mode be acceptable in the target domain?

**Output:** For each verified match, the extracted mechanism, the transfer assessment (transfers / partially transfers / does not transfer), and a one-sentence summary of what transfers and what doesn't.

## Output Format

```
## Structural Analysis

### Problem Shape
[2–3 sentence structural description from Step 1]

### Pattern Classification
- **Primary:** [pattern name] — [one-sentence justification]
- **Secondary:** [pattern name] — [one-sentence justification]

### Cross-Domain Matches

#### Match 1: [Source Domain] — [Verdict: isomorphism/analogy/metaphor]
- **Source problem:** [one sentence]
- **Entity mapping:** [brief]
- **Relationship mapping:** [brief]
- **Dynamics mapping:** [brief]
- **Source solution:** [mechanism, not implementation]
- **Transfer assessment:** [transfers / partially / does not]
- **What transfers:** [one sentence]
- **What doesn't:** [one sentence]

#### Match 2: ...

### Failure Mode Warnings
[If the problem maps to a known failure pattern, describe the failure dynamics and what other domains did to avoid them]

### Structural Recommendation
[1–2 sentences: what the structural analysis suggests the board should consider that domain-specific thinking would miss]
```

## Key Principles

1. **Structure before content.** Always extract the shape before engaging with domain details.
2. **Distant domains first.** The most valuable matches come from the farthest domains.
3. **Verification is non-negotiable.** Every match must pass the three-level check.
4. **Mechanisms transfer, implementations don't.** Never propose "do what cardiology does." Propose "create a bypass — a parallel path that routes around the bottleneck."
5. **Failed matches are informative.** When a match fails at Level 3, report *why*.
6. **Multi-domain convergence is the strongest signal.** If three unrelated domains converged on the same class of solution, that solution is likely to transfer.
