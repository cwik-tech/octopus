---
name: knowledge-base-slo-design
description: SLO design and monitoring for knowledge base operations — define, implement, and monitor service levels for freshness, latency, citation accuracy, access control, and cost per query
---

# Knowledge Base SLO Design

## Purpose

Define measurable service-level objectives (SLOs) for the knowledge base as a data product. Translate operational requirements ("the knowledge base should stay fresh enough to guide agents") into concrete, monitorable SLOs ("P75 source freshness ≤ 30 days, P99 retrieval latency ≤ 2s, citation accuracy ≥ 98%"). Set up monitoring, alerting, and remediation workflows.

SLOs answer the question: "How will we know if the knowledge base is working?" They are not nice-to-haves; they are the operational contract between the governance owner and the production team.

## When to Use

- At WP5 start: define SLOs before handover to production
- Quarterly: review SLO targets against actual performance and business changes
- On operational incidents: use SLOs to determine severity and escalation
- When planning system changes: use SLOs to gate parser upgrades, version changes, or retrieval model swaps

## How to Use

### 1. Identify SLO Categories

Every knowledge base operation has four SLO dimensions:

**Freshness (source currency):** How stale can a document be before it is considered obsolete?

- Define by source category (product specs, SOPs, reference data, etc.).
- Examples: "Product specs must be ≤ 7 days old (re-validated within 7 days of source change)"; "Reference material ≤ 90 days"; "Retired products ≤ 365 days or archived."
- Measure: time since last re-validation per source document.
- Alert: if a source has not been re-validated within its SLO window, escalate to owner.

**Retrieval Latency (response time):** How fast must the knowledge base answer?

- Define by use case: agent real-time query, batch report, interactive UI.
- Examples: "Agent queries must return citations within 2s (P99)"; "Batch reports within 30s."
- Measure: end-to-end retrieval latency (chunking, embedding, search, reranking, citation formatting).
- Alert: if P99 latency exceeds SLO, investigate retrieval stack (vector store load, reranker, network, cost limits).

**Citation Accuracy (relevance and correctness):** How many retrieved passages must be actually relevant and correct?

- Define as: "≥ X% of retrieved citations are relevant to the query" and "≥ Y% of retrieved passages contain the claimed information."
- Measure: continuous sampling via query logging + human spot-check, or automated relevance scoring if available.
- Alert: if relevance drops below SLO, investigate retrieval model drift, embedding quality, corpus quality (parsing errors), or query-time filtering.

**Access Control (permission enforcement):** How reliably must the knowledge base enforce source ACLs?

- Define as: "0 unauthorized retrievals per quarter" or "no access-control violations in audit logs."
- Measure: automated permission-boundary testing (quarterly), access-log audit (monthly).
- Alert: any detected access violation is critical; investigate immediately.

**Cost (unit economics):** What is the acceptable cost per query and per ingested document?

- Define: "≤ $X per query" (embeddings + search + reranking + generation if applicable); "≤ $Y per ingested document per month".
- Measure: cloud cost attribution per operation (API logs, billing tags).
- Alert: if cost per query exceeds budget by 20% or more, investigate (volume spike, model change, retrieval config regression, pricing change).

### 2. Set Alert Thresholds

For each SLO, define:

- **P75/P90/P99 or average**: which percentile matters? (Freshness: median is fine. Latency: P99. Accuracy: average. Access control: any violation.)
- **Threshold value**: the boundary between OK and not-OK.
- **Alert window**: hours/days for investigation before it's a breach.
- **Escalation path**: who owns this SLO? What is the next step if an alert fires?

Example:

| SLO | Measure | Threshold | Alert Window | Owner | Escalation |
|-----|---------|-----------|--------------|-------|------------|
| Freshness | P75 days since re-validation | ≤ 30 days | 7 days | Sync team | Governance owner |
| Latency | P99 retrieval time | ≤ 2 seconds | 1 hour | Retrieval ops | Governance owner |
| Accuracy | Citation relevance (sampled) | ≥ 95% | 1 week | Corpus owner | Governance owner |
| Access | Permission-boundary tests | 0 violations | immediate | Security owner | Governance owner |
| Cost | $/query | ≤ $0.10 | 1 week | Cost owner | Governance owner |

### 3. Implement Monitoring

**Freshness monitoring:**
- Query source metadata: last re-validation timestamp for each document.
- Calculate days-since for all sources; compute P50, P75, P90, P99.
- Create a dashboard showing freshness curve (% of sources within SLO window).
- Alert if any high-priority source exceeds its SLO window.

**Latency monitoring:**
- Log retrieval start/end times in the retrieval service.
- Compute P50, P99 over rolling 1-hour and 24-hour windows.
- Correlate latency spikes with retrieval load, embedding model, or reranker changes.
- Alert if P99 exceeds SLO.

**Accuracy monitoring:**
- Log every retrieval query and the returned passages.
- Periodically (weekly) sample 50–100 queries and rate citations as "relevant" or "not relevant" against the query.
- Compute average relevance % over the sample.
- Alert if relevance drops below SLO threshold.

**Access-control monitoring:**
- Run automated permission-boundary tests quarterly: attempt to retrieve documents the test user should not have access to; verify retrieval returns zero results.
- Audit retrieval request logs monthly: scan for access denials or unexpected permission grants.
- Alert immediately on any detected violation.

**Cost monitoring:**
- Tag all API calls (embeddings, vector search, reranking, generation) with the retrieval query ID.
- Aggregate costs per query and per document.
- Compute rolling averages (daily, weekly).
- Alert if cost per query rises 20% above baseline.

### 4. Remediation Workflows

For each SLO, define the remediation workflow when it is breached:

**Freshness breach:**
- Investigate: why was the source not re-validated? Is the sync schedule too infrequent? Did the source owner disappear?
- Action: trigger immediate re-ingestion of the source; notify the owner; consider escalating to the knowledge-product architect if sync is broken.
- Escalate: if multiple sources are stale, the sync strategy has failed.

**Latency breach:**
- Investigate: is retrieval load spiking? Did the embedding model or vector store change? Is reranking slow?
- Action: check vector-store metrics (queries per second, query latency, cache hit rate); check embedding service load; check reranker performance.
- Escalate: if latency is structural (not a spike), may require architectural change (caching, query optimization, retrieval model swap).

**Accuracy breach:**
- Investigate: did the corpus quality drop? Did the embedding model change? Is the retriever misconfigured? Are metadata filters too aggressive?
- Action: sample more citations to isolate the problem; run a retrieval diagnostic (compare before/after a change); check for parser or chunking regressions.
- Escalate: if accuracy is structural, may require parser fix, retrieval model retraining, or corpus validation gate.

**Access-control breach:**
- Investigate: **immediately**. This is a security violation.
- Action: deny further access to the affected user; review retrieval logs; check ACL filtering configuration; test permission propagation end-to-end.
- Escalate: security team; knowledge-product architect; notify data owners of potential exposure.

**Cost breach:**
- Investigate: did query volume spike? Did embedding/search/reranking prices change? Is retrieval config inefficient (over-chunking, over-reranking)?
- Action: check query logs (volume by time, cost per query over time); compare to baseline; check cloud provider pricing.
- Escalate: if cost is structural, may require retrieval config optimization, model downgrade, or budget revision.

## Rules

1. SLOs must be defined before handover to production. "Best effort" is not an SLO.
2. Every SLO must have an owner and an escalation path.
3. Measurement must be automated (dashboard query, not manual inspection).
4. Alerting must be timely and actionable (within hours, not days).
5. Remediation workflows must be documented and tested.
6. SLO targets must be reviewed quarterly against actual performance and business changes.
7. SLO breaches are not optional — they trigger investigation and escalation.