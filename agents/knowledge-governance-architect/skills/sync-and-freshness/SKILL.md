---
name: sync-and-freshness
description: Sync strategy and freshness enforcement — incremental/full reconciliation, change detection, version management, drift detection, and reprocessing triggers to keep knowledge base synchronized with sources
---

# Sync and Freshness

## Purpose

Keep the knowledge base synchronized with authoritative sources and aligned with SLO freshness targets. A knowledge base that is out of sync is untrustworthy: agents will cite stale information, access-control changes will be missed, and parse improvements will not reach the corpus.

This skill owns the sync strategy: incremental sync on change signals, full reconciliation on schedule, version upgrades (parser, chunking, embedding model), drift detection, and remediation.

## When to Use

- At WP5 start: design the sync strategy and synchronization schedule
- At WP5 end: validate sync works end-to-end before handover
- Continuously: operate sync pipelines, detect drift, trigger reprocessing on change
- On version upgrades: implement and validate upgrade strategy with rollback
- On operational incidents: investigate sync failures, data drift, stale content

## How to Use

### 1. Design Sync Strategy

Every knowledge base operates on two synchronization patterns:

**Incremental Sync (change-driven):**

When a source changes, detect it and re-ingest only that source.

- **Change detection:** File hash (deterministic MD5 on source); Source version/timestamp (if available); SharePoint change-notification API; Scheduled polling on a short cycle (hourly, daily).
- **Trigger:** When hash or timestamp changes, queue the source for re-ingestion.
- **Latency:** Minutes to hours from source change to knowledge-base update (near real-time).
- **Cost:** Low — only changed documents are re-processed.
- **Risk:** May miss sources with no change-detection mechanism; may miss metadata changes (owner, classification) that require re-processing even if content is unchanged.

**Full Reconciliation (scheduled, complete):**

Periodically (weekly, monthly) re-process the entire source corpus and compare MD5 hashes.

- **Trigger:** Calendar schedule (e.g., every Sunday 2 AM).
- **Process:** Re-parse all sources; compute hashes; compare to current knowledge-base; ingest only changed sources; delete sources that no longer exist in the source system; flag orphaned knowledge-base documents (sources deleted but docs remain).
- **Latency:** Hours (full re-parse takes time).
- **Cost:** High — full corpus re-processing; mitigate by parallelizing and incremental comparison.
- **Benefit:** Catches drift, missing sources, orphaned content, and metadata changes.

Recommended: **Incremental daily + full reconciliation weekly**.

### 2. Design Version-Upgrade Procedures

When the parser, chunker, embedding model, or retriever changes, you must decide: do all existing documents need to be re-processed?

**Parser upgrade (e.g., new OCR model, layout-analysis improvement):**
- Decision: does the upgrade produce meaningfully different Markdown output? Test on a representative sample (10–20 documents).
- If yes: flag all documents for re-ingestion.
- If no: update parser metadata (version, run timestamp) and proceed.
- Validation: compare sample outputs (old vs. new) manually; check for loss of content or structure.
- Rollback: retain old Markdown and index; revert to previous parser if validation fails.

**Chunking strategy upgrade (e.g., different overlap, different section-boundary logic):**
- Decision: do chunks change significantly? Measure using chunk hash variance and retrieval-quality tests.
- If yes: flag all documents for re-chunking and re-indexing.
- If no: update chunking metadata and proceed.
- Validation: run retrieval quality benchmarks (labelled evaluation set) before and after; require ≥ same quality before cutover.
- Rollback: retain old chunks; revert index if quality drops.

**Embedding model upgrade (e.g., new embedding API, fine-tuned model):**
- Decision: does the new model produce significantly different embeddings? Test on 50–100 sample chunks.
- If yes: re-embed entire corpus (high cost; plan for off-peak time).
- If no: update embedding metadata and proceed.
- Validation: retrieval quality benchmarks before/after; require ≥ same accuracy.
- Rollback: retain old embeddings; revert retriever to previous model.

**Retrieval model upgrade (e.g., different reranker, hybrid retrieval parameters):**
- Decision: run retrieval quality benchmarks before cutover.
- Validation: ≥ same accuracy and latency on labelled evaluation set.
- Rollback: retain old configuration; revert immediately if quality drops.

For all upgrades: **test on labelled evaluation set before production; build a rollback procedure; plan for off-peak execution; monitor quality closely in the first 48 hours.**

### 3. Detect and Fix Drift

**Drift scenarios:**

- **Source changed; knowledge base did not:** sync missed the change (hash detection failed, API notification lost, scheduled sync did not run).
- **Source deleted; knowledge base document remains:** orphaned content is serving stale information.
- **Knowledge base chunk is corrupted or malformed:** parsing error, storage corruption, index corruption.
- **ACL changed in source; knowledge base retrieval filter is stale:** access control leakage or false denials.
- **Embedding or index is out of sync with Markdown:** parser ran, but indexing failed or rolled back.

**Detection and fix:**

- **Daily: Check ingestion lag:** query the knowledge-base metadata for (current_timestamp - last_ingestion_timestamp) per source. Alert if any source exceeds freshness SLO.
- **Weekly: Full corpus reconciliation:** re-scan all sources; compute MD5 hashes; compare to knowledge-base metadata. Flag mismatches for re-ingestion. Delete orphaned knowledge-base documents.
- **Weekly: Spot-check retrieval:** query the knowledge base for recent changes (e.g., "new products added this week"). Verify retrieved results are current.
- **Monthly: ACL audit:** re-check source ACLs; compare to knowledge-base filter metadata; test permission-boundary enforcement (see `skills/access-control-and-audit/SKILL.md`).
- **Monthly: Embedding/index audit:** sample 50 random chunks; verify chunk content matches the Markdown source; verify embeddings are up-to-date.

**Remediation:**
- Source mismatch: re-ingest the source immediately.
- Orphaned content: delete from knowledge base; log what was removed and why.
- Corrupted chunk: re-parse the source.
- ACL mismatch: update metadata and query-time filters.
- Embedding lag: re-embed the corpus (on schedule, off-peak).

### 4. Schedule and Automate

**Recommended schedule:**

| Task | Frequency | Timing | Owner | Escalation |
|------|-----------|--------|-------|------------|
| Incremental sync (change-driven) | Hourly | Continuous | Connector | Sync team |
| Full reconciliation | Weekly | Sunday 2:00 AM UTC | Reconciliation job | Sync team |
| Ingestion-lag check | Daily | 06:00 UTC | Monitor | Governance owner |
| Freshness report | Weekly | Monday 08:00 UTC | Dashboard | Governance owner |
| Retrieval spot-check | Weekly | Wednesday 10:00 UTC | Manual | Retrieval team |
| ACL audit | Monthly | 1st of month | Audit job | Security owner |
| Embedding/index audit | Monthly | 15th of month | Audit job | Retrieval team |
| Version-upgrade test | On change | (ad hoc) | Engineering | Governance owner |

**Automation:**
- Incremental sync: Event-driven (change notification) or polling (hourly hash check).
- Full reconciliation: Scheduled job (Kubernetes CronJob, Azure Functions, or equivalent).
- Drift detection: Automated dashboards (Markdown age, hash mismatches, orphaned documents).
- Alerting: When freshness SLO is breached, alert the sync-team owner and escalate to governance if not resolved within 24 hours.

## Rules

1. Incremental sync must detect source changes within 1 hour of change.
2. Full reconciliation must run at least weekly; more often if source change frequency is high.
3. Any version upgrade (parser, chunking, embedding, retrieval) must be validated against a labelled evaluation set before production cutover.
4. All version upgrades must have a rollback procedure and must be monitored for 48 hours post-cutover.
5. Drift detection must be automated; do not rely on manual inspection.
6. SLO freshness breaches must be escalated within 24 hours.
7. Orphaned documents must be deleted; never left to rot.
8. Re-ingestion and re-indexing must be logged with reason (source change, parser upgrade, remediation).