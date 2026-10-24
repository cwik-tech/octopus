---
name: data-incident-analysis
description: >
  Triage and analyze missing, delayed, duplicated, corrupted, or semantically incorrect data using lineage, evidence preservation, repair, communication, and preventive action. Use during a live data incident or for a post-incident review.
---

# Data Incident Analysis

## Immediate response

1. Confirm the symptom, detection time, affected dataset or event, consumer impact, and incident owner.
2. Preserve run identifiers, versions, logs, checkpoints, sample records, quality results, and deployment history before repair.
3. Bound the blast radius through lineage, time windows, partitions, transformations, copies, and consumers.
4. Stop or isolate ongoing harm. Choose pause, quarantine, rollback, forward fix, access restriction, or consumer warning based on evidence.

## Analysis and recovery

5. Build a timeline separating event time, processing time, detection, response, and communication.
6. Trace from the first known bad output toward sources and recent changes. Distinguish root cause, contributing conditions, and detection gaps.
7. Design repair or replay with stable scope, idempotency, rate limits, versioned logic, validation, reconciliation, and rollback or roll-forward.
8. Communicate affected data, consumers, uncertainty, workaround, next update, and recovery status without overstating completeness.
9. Validate recovery at the consumer boundary and reconcile counts or business invariants.
10. Record corrective actions for prevention, detection, response, and recovery with owners and due points.

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../templates/incident-runbook.md`
- `../../templates/post-incident-review.md`
- `../../templates/lineage-record.yaml`
- `../../references/reliability-and-slo-guide.md`

## Output

For a live incident, return status, impact, containment, evidence, hypotheses, next action, owner, and next update. For review, return the timeline, causes, recovery validation, detection gap, and corrective actions. Never alter evidence to make the narrative cleaner.
