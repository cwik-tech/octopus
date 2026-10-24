---
name: data-engineering-intake
description: >
  Scope a data pipeline, migration, warehouse, lakehouse, streaming, or platform assignment and select the smallest capable roster. Use when beginning data-engineering work or when requirements are incomplete, contradictory, or solution-led.
---

# Data Engineering Intake

## Outcome

Produce a bounded brief with measurable acceptance criteria, declared unknowns, and a justified roster. Do not choose tools during intake unless a tool is already a stated constraint.

## Method

1. Name the business outcome and each consumer. Record the decision or operation the data enables.
2. Inventory sources and targets with owners, access method, format, schema authority, change behavior, and environment.
3. Quantify current and expected volume, velocity, variety, retention, history, and growth. Mark estimates as estimates.
4. Record latency, freshness, completeness, availability, recovery-time, and recovery-point expectations. Resolve whether each is an SLA, an SLO, or an aspiration.
5. Record data classification, residency, consent, deletion, audit, and non-production-use constraints. Escalate legal interpretation.
6. Record cost limits, platform constraints, deadlines, team capabilities, and migration or coexistence requirements.
7. Turn the outcome into acceptance criteria that a consumer can observe. List assumptions, open questions, dependencies, and evidence sources separately.
8. Select the smallest roster that covers the work and state why each selected agent is needed.

## Roster selection

- Straightforward batch pipeline: pipeline owner plus quality review, or one combined owner.
- Warehouse or lakehouse: pipeline, modeling and metadata, and quality and reliability.
- Multi-domain platform: all three specialists plus the lead.
- Regulated or sensitive data: add security or privacy expertise.
- Enterprise governance, major MDM, or unusually complex streaming: add the matching specialist.

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../templates/data-engineering-intake.md`
- `../../templates/source-system-profile.md`
- `../../references/dama-knowledge-area-map.md`
- `../../references/terminology-glossary.md`

## Completion check

Do not close intake while an unknown could reverse the proposed topology, delivery mode, security posture, or acceptance criteria. Return those items as decision-blocking questions.
