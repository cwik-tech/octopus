# Orchestration Plan: [Problem Title]

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
  <!-- e.g., Work Breakdown Structure, Task Network, Parallel Decomposition -->
- **Rationale:** [1-2 sentences on why this decomposition approach and orchestration method fits for delegating work]

## Problem Statement
[Restate the problem in precise terms. Include scope and success criteria. This is what the orchestrator will assign to sub-agents.]

## Sub-Agent Tasks

### Task ID: SP-001
- **Sub-problem:** [Clear, standalone statement of what this sub-agent must solve. Be specific enough that an agent can work independently.]
- **Methodology:** [Which decomposition or analysis method the sub-agent should apply internally (e.g., "Five Whys", "First Principles", "Comparative Analysis")]
- **Expertise required:** [Type of knowledge/skill needed. Examples: "financial analysis", "UX research", "backend engineering", "data science", "legal review"]
- **Inputs:** [What the sub-agent receives to start work. Include data, context, constraints, or prior results from dependencies.]
- **Expected outputs:** [What the sub-agent must return. Be specific about format (e.g., "ranked list with analysis", "code review with findings", "design mockups with rationale")]
- **Dependencies:** [List of Task IDs that must complete first (e.g., "SP-001, SP-003"), or write "None" if this task can start immediately]
- **Priority:** [Critical path / Parallel / Nice-to-have — indicates importance to overall solution]

### Task ID: SP-002
- **Sub-problem:** [Clear statement of what this sub-agent must solve]
- **Methodology:** [Which method the sub-agent should apply]
- **Expertise required:** [Type of knowledge/skill needed]
- **Inputs:** [What the sub-agent receives to start work]
- **Expected outputs:** [What the sub-agent must return]
- **Dependencies:** [List of Task IDs that must complete first, or "None"]
- **Priority:** [Critical path / Parallel / Nice-to-have]

### Task ID: SP-003
[Same structure as above]

[Continue as needed...]

## Execution Order
[A simple sequence or Directed Acyclic Graph (DAG) showing the order of execution. Group parallel tasks together. Use a readable format.]

Example:
```
SP-001 → SP-002 → SP-004
  ↓
SP-003 (parallel with 001) → SP-005 (parallel with 002)
```

Or in text form:
- **Phase 1 (parallel):** SP-001, SP-003
- **Phase 2 (after Phase 1):** SP-002
- **Phase 3 (after Phase 2):** SP-004, SP-005

## Aggregation Strategy
[How the orchestrator should combine results from sub-agents into a final answer. Be specific about the logic.]

Example:
- SP-001 provides the root cause analysis
- SP-002 evaluates candidate solutions based on that analysis
- SP-003 assesses implementation risk
- Final answer: Recommend the highest-confidence solution that meets the acceptance criteria from the risk assessment

Or: Synthesize findings into a ranked priority list, using scoring from SP-002 and SP-004 as tiebreakers.

## Fallback Plan
[What to do if a sub-agent fails, returns incomplete results, or raises unexpected blockers. Include decision thresholds.]

Example:
- If SP-001 cannot identify root cause with >70% confidence, escalate to domain expert interview and re-run SP-002
- If SP-002 finds no viable solutions, activate brainstorming task (SP-006) to generate alternatives
- If any sub-agent reports blocking dependencies outside our scope, document and surface to stakeholder for decision
