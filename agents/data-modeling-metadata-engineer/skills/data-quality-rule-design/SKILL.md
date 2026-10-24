---
name: data-quality-rule-design
description: >
  Convert business expectations into executable data quality rules with dimensions, scope, thresholds, severity, quarantine, ownership, and remediation. Use when profiling a dataset, defining acceptance controls, or closing a known quality failure.
---

# Data Quality Rule Design

## Method

1. State the business expectation, affected consumer, dataset grain, and harm caused by failure.
2. Choose the relevant dimension: completeness, validity, accuracy proxy, uniqueness, consistency, timeliness, or referential integrity.
3. Define the exact population, fields, predicate or calculation, observation window, exclusions, and independent expected result.
4. Define pass threshold, warning threshold, severity, confidence, and whether the rule blocks, quarantines, alerts, or observes.
5. Assign rule owner, data owner, response owner, escalation route, and maximum response time.
6. Define evidence retained on failure, record handling, correction, replay, reconciliation, and consumer communication.
7. Establish a baseline from profiling where appropriate, then distinguish a fixed requirement from an anomaly threshold.
8. Version the rule and link it to the contract, dataset, pipeline stage, lineage, SLO, and runbook.

## Accuracy discipline

Direct accuracy often requires a trusted reference or source verification. When that is unavailable, label a rule as an accuracy proxy and state what it can and cannot prove.

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../templates/data-quality-rule-catalog.yaml`
- `../../templates/dataset-specification.md`
- `../../references/data-quality-dimensions.md`
- `../../references/metadata-minimum-standard.md`

## Output

Return each rule as an executable specification with owner, threshold, severity, action, remediation, and evidence. Reject vague rules such as "data should be accurate."
