---
name: data-platform-decision-record
description: >
  Compare and record a material data-platform decision with constraints, trade-offs, consequences, risks, and reversal conditions. Use when choosing ETL or ELT, batch or streaming, a storage pattern, an ownership topology, or a consequential tool or platform.
---

# Data Platform Decision Record

## Outcome

Create a decision record that another team can understand, operate, challenge, and reverse without reconstructing the original discussion.

## Method

1. State the decision in one sentence and name its owner and status.
2. Describe the context, affected consumers, scope, and decision deadline.
3. Separate hard constraints, preferred qualities, assumptions, and unknowns.
4. Define viable options, including the current state when it is genuinely viable.
5. Compare each option against the same load-bearing criteria. Include reliability, security, recovery, operability, cost, migration, and lock-in where relevant.
6. Record the selected option and the evidence-backed rationale. Do not turn popularity or vendor claims into evidence.
7. State positive and negative operational consequences, follow-on work, ownership changes, and residual risks.
8. Define reversal conditions, exit cost, and the signals that would reopen the decision.

## Evidence rules

- Cite user-supplied requirements and measured workload facts directly.
- Verify time-sensitive product behavior against current primary documentation.
- Label inferences and estimates.
- Record unresolved conflicts rather than manufacturing consensus.

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../templates/architecture-decision-record.md`
- `../../references/architecture-pattern-catalog.md`
- `../../references/evidence-citation-guide.md`
- `../../references/data-engineering-principles.md`

## Completion check

A record is incomplete if the losing options are caricatures, the selected option has no operational downside, or no condition could cause reconsideration.
