---
name: data-design-review
description: >
  Run an integrated approval review across requirements, architecture, contracts, models, quality, observability, security, recovery, and operability. Use before approving a major data design, migration cutover, or production release.
---

# Data Design Review

## Outcome

Issue an evidence-backed approval, conditional approval, or rejection with named blockers and owners.

## Review sequence

1. Trace every design objective to a stated requirement and observable acceptance criterion.
2. Verify the architecture has explicit source-to-consumption, ownership, trust, failure, and recovery paths.
3. Verify producer-consumer contracts cover semantics, compatibility, delivery, freshness, ownership, and deprecation.
4. Verify model grain, identity, temporal rules, metadata, lineage, and impact analysis.
5. Verify quality rules are executable and have thresholds, severity, quarantine, remediation, and owners.
6. Verify observability covers freshness, latency, volume, schema, distribution, task health, and consumer impact with actionable SLOs.
7. Run the security checklist and record any required specialist review.
8. Verify backfill, replay, rollback or roll-forward, disaster recovery, cost, capacity, support, and incident runbooks.
9. Check that material decisions and exceptions have durable records and reversal conditions.

## Decision rule

- Approve only when every release-critical control has evidence and a named owner.
- Conditionally approve only when remaining conditions are bounded, owned, and cannot invalidate the design before they are met.
- Reject when an unresolved item can cause data loss, semantic corruption, unauthorized exposure, unrecoverable operation, or failure of a primary consumer outcome.

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../templates/production-readiness-checklist.md`
- `../../templates/data-model-review.md`
- `../../templates/architecture-decision-record.md`
- `../../references/evidence-citation-guide.md`

## Output

Return the decision, evidence reviewed, passed controls, blockers, conditions, owners, due points, and residual risk. Do not bury blockers in prose.
