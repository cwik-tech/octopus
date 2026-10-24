---
name: vector-store-selection
description: Evaluates vector, graph, and relational database backends (Pinecone, Weaviate, Milvus, Neo4j, pgvector) on latency, cost, filtering capability, scalability, and operational fit.
---

# Vector Store Selection

## Purpose

Choose a vector store backend that meets latency, filtering, cost, and operational requirements without unnecessary lock-in or operational complexity. The store is the bottleneck for retrieval latency and operational burden post-launch; choose deliberately.

## Evaluation framework

### 1. Latency and quality

- Measure query latency (p50, p95, p99) on the labelled evaluation set; test with metadata filtering applied (e.g., "retrieve product category X, language Y, lifecycle state active").
- Measure quality degradation when filtering is active. Does filtering make latency unacceptable or reduce result relevance significantly?
- Record index time for the pilot corpus and extrapolate to 10x scale. Ingestion latency matters for freshness; slow indexing blocks updates.
- Test batch query performance: can the store handle concurrent requests (what is throughput at p95 latency)?

### 2. Filtering capability

- Test whether the store supports:
  - **Metadata filtering:** product category, language, document type, lifecycle state (draft, approved, deprecated), access-control tags, revision timestamp.
  - **Hybrid retrieval:** dense vector + BM25 lexical search in one query, or must they be separate?
  - **Reranking integration:** does the store expose APIs for post-retrieval reranking, or must reranking be external?
- Quantify filtering performance impact: does "show only approved documents in product category X" slow the query by 10%, 50%, or more?
- Identify filter expressiveness: can you express complex conditions (e.g., "approved AND (category A OR category B) AND language IN (EN, ES)"?

### 3. Cost model

- Measure cost per index write: parsing + ingestion costs ($/1000 documents).
- Measure cost per query at baseline volume ($/1M queries), at 2x, and at 10x volume.
- Break down infrastructure costs: compute, storage (Markdown + vector index + metadata), networking, backups.
- Understand the pricing model:
  - **Per-seat (e.g., Pinecone):** fixed cost per index, scales queries for free. Works for small teams; explodes as query load grows.
  - **Per-token (e.g., some Azure OpenAI integrations):** cost per embedding + query. Scales linearly; predictable but can dominate at high volume.
  - **Per-GB (e.g., pgvector on cloud Postgres):** fixed infrastructure cost + storage. Good for self-managed; requires ops capacity.
- Compare total cost of ownership (TCO) at baseline, 2x, and 10x query volume across options.

### 4. Scaling and availability

- Document the store's scaling model:
  - At what vector count does it require sharding (Milvus, Neo4j)?
  - What's the cost delta between development scale (1M vectors) and production scale (1B vectors)?
- Availability:
  - Is geo-redundancy built in (Pinecone) or added cost (Weaviate in k8s)?
  - What's the SLA? 99.9%, 99.99%?
- Disaster recovery:
  - How long does a restore from backup take? Hours? Days?
  - Are backups automatic or manual?
  - What's the RPO (Recovery Point Objective) and RTO (Recovery Time Objective)?

### 5. Operational fit

- **Team skills:** Who operates this? DBA? Data engineer? Do they need specialized vector-database knowledge, or can standard database operations handle it?
- **Maintenance:** What are the required operations?
  - Reindexing (when embedding models change, must vectors be recomputed?).
  - Compaction and garbage collection (do vectors accumulate stale data?).
  - Security patching (what's the lag from release to your production deploy?).
- **Observability:** Does the store emit metrics (query latency, index size, error rates)? Can you integrate with your monitoring system?
- **Support:** Is there commercial support, or are you on the community roadmap? What's the response time for critical bugs?

### 6. Comparison matrix

Build a table like the one below. Fill it with real data from your tests, not vendor specs.

| Store | Latency p95 (ms) | Query throughput (q/s) | Metadata filter cost | Cost per 1M queries | Yearly cost (baseline) | Operational burden | Commercial support | Exit cost |
|-------|---|---|---|---|---|---|---|---|
| Pinecone | 50 | 100 | Included | $0.02 | $2400 | Low | Yes | Medium (data export) |
| Weaviate | 80 | 50 | Included | $0.03 | $3600 | High (k8s) | Yes | Low (self-managed) |
| Milvus | 100 | 200 | Included | $0.01 | $1200 | High (self-managed) | Limited | Low (self-managed) |
| Neo4j | 120 | 50 | Included | $0.04 | $4800 | High (graph ops) | Yes | High (graph lock-in) |
| pgvector | 60 | 150 | Included | $0.01 | $1200 | Medium (Postgres ops) | Limited | Low (standard SQL) |

### 7. Recommendation

- State the chosen store and the decision logic (e.g., "Pinecone for lowest operational burden and predictable cost at baseline volume, accepting 2x cost per query relative to pgvector for the next 2 years").
- Document the fallback if the primary choice doesn't scale (e.g., "Primary: Pinecone up to 500K queries/month. Fallback: migrate to pgvector if volume exceeds 1M/month").
- Quantify the cost and operational tradeoff explicitly.

## Failure modes

- **Vendor latency claims from benchmarks without metadata filtering applied.** Marketing specs never include filtering overhead. Test it yourself.
- **Cost estimates from vendor pricing calculators without real-world traffic patterns.** Calculators assume steady state; account for spikes, dev/test environments, and reindexing.
- **Operational burden underestimated.** Vector databases need ongoing care: monitoring, tuning, reindexing when models change. They are not "just a data store."
- **Lock-in cost ignored.** Exporting vectors from Pinecone, retraining on a different model, and migrating to pgvector takes weeks. Plan for it.
- **Reranking orchestration overhead hidden.** If reranking must be external (e.g., vector store → app → reranker → client), that network latency and parsing cost adds up fast. Measure it.
- **High-availability cost shock.** Turning on geo-redundancy or upgrading to 99.99% SLA often doubles cost. Decide upfront whether you need it.

## Output

- **Comparison matrix:** latency, throughput, filtering, cost, operational fit (as above).
- **Decision:** primary store, rationale, fallback plan.
- **Cost projection:** TCO over 2 years at baseline, 2x, and 10x query volume.
- **Operational runbook summary:** backup cadence, scaling procedure, security patching, disaster recovery RTO/RPO.
- **Lock-in assessment:** what's hard to change (data format, embedding model, query language).
- **Monitoring:** which metrics to track post-launch (latency p95, query throughput, index size, cost).
