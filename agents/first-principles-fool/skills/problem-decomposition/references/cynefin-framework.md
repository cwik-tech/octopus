# Cynefin Framework for Problem Classification

## Overview

The Cynefin Framework (Welsh for "habitat" or "place") is a sense-making model developed by Dave Snowden that helps classify problems into distinct domains based on the relationship between cause and effect. Use it to determine which problem-solving approach is appropriate before attempting decomposition.

## When to Use Cynefin

- When you encounter a novel problem and must decide whether to apply analytical, prescriptive, experimental, or adaptive approaches
- Before selecting decomposition methods (MECE trees work well for Complicated; experimentation suits Complex)
- When stakeholder disagreement exists about problem nature and urgency
- To justify why certain methodologies will or will not succeed
- When deciding between planning (Clear/Complicated) vs. learning (Complex/Chaotic)

## The Five Domains

### Clear (Previously "Simple")

**Characteristics:** Cause and effect are obvious to all stakeholders.
- Problems are straightforward; best practices exist and apply universally
- High predictability; low novelty
- Examples: manufacturing defects, documented process failures, routine configurations

**Response Pattern:** Sense → Categorize → Respond
- Sense the situation (observe)
- Categorize it using existing frameworks
- Respond by applying known best practices

**Agent Action:** Classify, retrieve, and apply standard procedures. Decompose only to verify full coverage of known causes.

### Complicated

**Characteristics:** Cause and effect require analysis; multiple right answers may exist.
- Requires expertise, investigation, and deliberation
- Problems have knowable solutions but not immediately obvious
- Examples: software architecture decisions, medical diagnosis, financial modeling

**Response Pattern:** Sense → Analyze → Respond
- Gather and structure information
- Use expert analysis (logic, frameworks, investigation)
- Apply reasoned solutions

**Agent Action:** This domain rewards decomposition. Use Issue Trees (MECE), Fishbone Diagrams, or functional decomposition. Break the problem into sub-problems that experts can evaluate independently.

### Complex

**Characteristics:** Cause and effect can only be determined in retrospect; the system itself co-evolves.
- High interdependence; non-linear dynamics; emergent properties
- Multiple possible futures; path-dependent outcomes
- Examples: organizational culture change, market dynamics, ecosystem design, AI alignment

**Response Pattern:** Probe → Sense → Respond
- Run experiments or interventions (probes)
- Observe what emerges
- Respond by amplifying or dampening patterns

**Agent Action:** Avoid heavy upfront decomposition. Instead, identify leverage points and hypothesize likely outcomes. Run small experiments. Structure problems iteratively based on what you learn. First Principles and hypothesis-driven approaches work better than prescriptive trees.

### Chaotic

**Characteristics:** Cause and effect are unclear even in retrospect; immediate action is necessary.
- Crisis mode; no time for analysis or probes
- System is unstable
- Examples: active system failures, natural disasters, acute product failures

**Response Pattern:** Act → Sense → Respond
- Take immediate action to restore stability
- Observe the result
- Only then analyze and adapt

**Agent Action:** Do not decompose. Move to Complicated or Complex only after stabilizing. Frame problems narrowly around immediate containment.

### Confused/Disorder

**Characteristics:** Unclear which domain a problem belongs to; multiple stakeholders perceive it differently.

**Agent Action:** Resolve disagreement about domain classification before proceeding with any decomposition method. Use workshops, interviews, or root cause analysis to establish shared understanding.

## Textual Cues for Domain Classification

Read the problem statement and apply these heuristics:

| Cue | Domain |
|-----|--------|
| "Always fails the same way," "best practice," "documented procedure" | Clear |
| "Requires analysis," "expert needed," "causes unclear," "multiple approaches," "why," "root cause" | Complicated |
| "Unpredictable," "feedback loops," "emergent," "system behavior," "evolving," "we tried X but Y happened" | Complex |
| "Urgent," "immediate action," "critical," "broken," "down," "cannot wait" | Chaotic |
| "Unclear if," "some say X, others say Y," "depends on perspective," "not sure what kind of problem" | Confused |

## Decision Workflow for Agents

1. **Read the problem statement.** Extract all constraints, goals, and context.
2. **Look for crisis indicators.** If yes → Chaotic. Stabilize first.
3. **Check for domain disagreement.** If yes → Confused. Facilitate alignment first.
4. **Assess predictability:** Can you apply a known rule or best practice?
   - Yes, universally → Clear
   - Yes, with analysis → Complicated
5. **Assess system coupling:** Does solving one subproblem affect others unpredictably?
   - No → Complicated
   - Yes → Complex
6. **Declare the domain** and communicate it to stakeholders.

## Working at Domain Boundaries

Problems often span multiple domains:
- **Clear + Complicated:** Apply best practices (Clear) while investigating root causes (Complicated)
- **Complicated + Complex:** Use structured analysis (Complicated) with built-in learning loops (Complex)
- **Complex + Chaotic:** Stabilize the chaotic elements first, then treat remaining as Complex

## Common Pitfalls

- **Assuming a problem is Clear when it is Complicated.** This leads to missed root causes. Always ask "Why?" at least once.
- **Treating Complex problems as Complicated.** Heavy upfront decomposition wastes effort; better to run experiments.
- **Ignoring Chaotic signals.** Acting as if you have time to analyze during a crisis compounds damage.
- **Confusing Confused with another domain.** Always establish shared understanding before selecting methods.

## References and Further Reading

- Snowden, D. J., & Boone, M. E. (2007). "A Leader's Framework for Decision Making." *Harvard Business Review*.
- Cynefin Co. resources: https://thecynefinco.com/
