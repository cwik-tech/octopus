---
name: pipeline-observability
description: >
  Define production monitoring, SLOs, dashboards, alerts, and runbook links for pipelines and data products. Use when designing operations, preparing a release, or diagnosing blind spots in freshness, latency, volume, schema, distributions, task health, or consumer impact.
---

# Pipeline Observability

## Method

1. Identify the consumer-visible outcomes and define freshness, latency, availability, completeness, or delivery SLIs at the boundary they experience.
2. Define SLO targets, measurement windows, exclusions, error budgets, owners, and the decision each SLO controls.
3. Instrument run status, duration, retries, skipped work, backlog, throughput, checkpoints, and terminal failures.
4. Instrument freshness, row or event volume, schema drift, distribution change, nulls, duplicates, and quality-rule outcomes.
5. Connect failures to lineage so alerts name affected datasets and consumers rather than only the failed task.
6. Set thresholds from requirements and baselines. Avoid alerts without a specific operator action.
7. Define deduplication, suppression, routing, escalation, dashboard views, and runbook links.
8. Test detection and response with a representative stale-data, schema-change, and failed-task scenario.

## Alert quality rule

Every page must identify impact, owner, immediate check, and next action. Conditions that do not require timely action belong in a dashboard or report.

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../templates/data-product-slo.yaml`
- `../../templates/production-readiness-checklist.md`
- `../../references/reliability-and-slo-guide.md`
- `../../references/data-quality-dimensions.md`

## Output

Return the SLI and SLO definitions, instrumentation map, alert catalog, routing, dashboards, runbooks, validation scenarios, and remaining blind spots.
