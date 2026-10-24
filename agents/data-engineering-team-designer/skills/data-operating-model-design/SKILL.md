---
name: data-operating-model-design
description: Designs data engineering ownership, service boundaries, quality and production practices, stakeholder interfaces, and phased maturity roadmaps. Use when establishing or scaling a data engineering function, resolving handoff failures, or defining collaboration across platform, analytics, data science, QA, operations, and business teams.
---

# Data Operating Model Design

## Purpose

Create an operating model that makes data engineering a reliable, understandable service function rather than an informal collection of projects and handoffs.

## Design Principles

1. **Organize around data products and services.** Define what is offered, to whom, at what service expectation, and with what ownership.
2. **Keep accountability singular.** Collaboration can be broad; accountability for an outcome must be explicit.
3. **Design lifecycle ownership.** Discovery, design, build, test, release, operate, improve, and retire must have named responsibilities.
4. **Make quality and operations part of delivery.** They are not end-stage gates or externalized chores.
5. **Use interfaces, not assumptions.** Cross-team work needs contracts, intake paths, decision rights, and escalation routes.

## Procedure

### 1. Define the service portfolio
List recurring services and products, such as:

- Source onboarding and ingestion
- Curated datasets and semantic models
- Data APIs and sharing interfaces
- Pipeline development and orchestration
- Quality monitoring and remediation
- Access, governance, lineage, and documentation
- Platform enablement and developer experience
- Incident support and reliability improvement

For each, define users, value, scope, service level, owner, and exclusions.

### 2. Establish role boundaries
Use a responsibility map for material work. A useful default division is:

| Area | Data engineering | Platform / infrastructure | Analytics / BI | Data science | QA / reliability | Business / domain |
|---|---|---|---|---|---|---|
| Data-product requirements | Shapes feasibility | Consulted | Co-defines consumption | Co-defines ML needs | Consulted | Owns business intent |
| Pipeline implementation | Accountable | Enables runtime | Consulted | Consulted | Tests controls | Validates usefulness |
| Platform reliability | Uses and escalates | Accountable | Uses | Uses | Validates SLOs | Informed |
| Data quality rules | Implements and operates technical controls | Enables observability | Co-defines analytical fitness | Co-defines ML fitness | Co-designs assurance | Defines business correctness |
| Production incidents | Owns pipeline failures | Owns platform failures | Assists impact assessment | Assists model impact | Coordinates quality investigation | Prioritizes business impact |

Adapt this map to the organization. Do not use it to erase shared responsibilities; use it to make the accountable owner clear.

### 3. Design key collaboration mechanisms
Specify only the rituals that solve actual coordination needs:

- Intake and prioritization process with acceptance criteria
- Product discovery sessions for high-value data products
- Architecture and contract review for consequential changes
- Data-quality rule review with business and consumption owners
- Release readiness review proportional to risk
- Incident triage, communications, post-incident learning, and backlog follow-through
- Documentation and catalog ownership
- Capacity planning and roadmap review

For every mechanism, state trigger, participants, decision made, artifact produced, and time boundary.

### 4. Establish production ownership
For each critical product, define:

- Service expectations: freshness, availability, correctness, latency, and support hours
- Observability: monitors, alerts, dashboards, lineage, and ownership metadata
- Incident roles: incident lead, technical resolver, communications owner, business impact owner
- Recovery: runbooks, rollback, replay, backfill, and data correction policies
- Learning loop: post-incident threshold, action ownership, and completion tracking

Avoid models where builders cannot observe production behavior or operators cannot access product knowledge.

### 5. Build a maturity roadmap
Use stages that reflect real organizational readiness:

| Stage | Focus | Typical evidence to advance |
|---|---|---|
| Crawl | Bounded priorities, basic ownership, repeatable delivery | Critical products inventoried; owners and minimum tests exist |
| Walk | Standard interfaces, reliable releases, visible quality and operations | Service expectations, monitoring, contracts, and incident practices are adopted |
| Run | Product portfolio management, resilient coverage, scalable self-service | Measured reliability, capacity planning, governance automation, and durable cross-team collaboration |

Do not advance a stage just because a new platform tool is deployed.

## Output

Deliver:

1. Target operating-model statement.
2. Service portfolio with owners and boundaries.
3. Responsibility map for lifecycle and incident work.
4. Cross-functional collaboration mechanisms.
5. Maturity roadmap with stage gates, dependencies, and measures.
6. Risks, tradeoffs, and leadership decisions required.

## Quality Checks

- No critical activity lacks an accountable owner.
- Teams have an explicit path to request, change, and support a data product.
- Quality rules include both technical validity and business fitness.
- Escalation paths distinguish pipeline, platform, quality, and consumer issues.
- The model is feasible for current capacity and does not introduce ceremonial overhead without a specific purpose.