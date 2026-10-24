---
name: evaluation-harness-design
description: Methodology for defining retrieval quality metrics, acceptance thresholds, and benchmarking frameworks before tooling selection.
---

# Evaluation Harness Design

## Purpose

Define how to measure retrieval quality systematically. Choose metrics that matter for agent use cases. Set acceptance thresholds that reflect real requirements. Design a benchmarking workflow so the team can re-run evaluations as retrieval changes without redoing the entire testing process.

## When to Use

- Designing evaluation frameworks before retrieval architecture is chosen
- Establishing quality gates for retrieval systems
- Setting up continuous evaluation as retrieval evolves
- Defining acceptance criteria for production deployment

## Core Metrics

### Recall@k

**What it measures:** Of the top k results returned, how many relevant passages did we actually retrieve?

Recall@10 = (# relevant passages in top 10) / (# total relevant passages)

- Answers the question: "Will the agent find an answer if it looks at the top k results?"
- Common thresholds: Recall@10 ≥ 80%, Recall@5 ≥ 60%
- For FST: Multiple valid passages often answer one question. If the corpus has redundancy, Recall@10 might be your primary metric.
- **Interpretation risk:** High Recall doesn't guarantee the agent picks the *best* passage; reranking and citation correctness matter.

### nDCG / MRR (Ranking Quality)

**nDCG (normalized Discounted Cumulative Gain):** How well are relevant results ranked? Do the best answers appear first?

nDCG@10 = (DCG@10) / (Ideal DCG@10)

- DCG gives higher credit to relevant results ranked earlier
- Answers: "Are the top results better than the bottom results?"
- Common thresholds: nDCG@10 ≥ 0.7 (70%)
- For FST: Useful if some passages are more authoritative or complete than others. If all correct answers are equally valid, nDCG matters less than Recall.

**MRR (Mean Reciprocal Rank):** How high is the first relevant result, on average?

MRR = 1 / (average rank of first relevant result)

- Simpler than nDCG; good when you care most about the first correct answer
- Common threshold: MRR ≥ 0.6

### Citation Correctness

**What it measures:** For every passage returned, can we trace it to a source document and locate it in that document?

Citation correctness = (passages with valid source + chunk ID + location) / (total passages returned)

- Answers: "Is every answer traceable to the corpus?"
- Common threshold: 100% (no citations should be wrong)
- **Critical for FST:** Agents must cite sources. A retrieval system that returns high-quality passages but loses citation metadata is unusable.

Measure:
- Source document ID present?
- Chunk ID or heading path present?
- Physical location (page, section) reconstructable?
- Can a human verify the cited passage matches the source?

If any citation is wrong, the entire response is untrustworthy.

### Latency (Response Time)

**What it measures:** How long does a query take?

- p50 (median): 50% of queries complete in this time
- p95 (95th percentile): 95% of queries complete in this time
- Common thresholds: p50 ≤ 200ms, p95 ≤ 1000ms (agent-facing SLA)

For FST: Determine from actual agent workflows. If an agent waits on retrieval, slow retrieval blocks the entire interaction.

### Cost per Query

**What it measures:** How much does one retrieval query cost?

- Embedding API calls (cost per query)
- Reranking (cost per top-k result)
- Storage and indexing (amortized per query)

Common thresholds: Set based on query volume and budget. If the corpus answers 1,000 queries/day, total daily cost must fit in operational budget.

## Setting Acceptance Thresholds

Don't choose thresholds in abstract. Ground them in requirements:

| Requirement | Threshold Implication |
|---|---|
| Agents must find an answer 95% of the time | Recall@10 ≥ 90% |
| If multiple answers exist, show the best one first | nDCG@10 ≥ 0.75 |
| Every cited passage must be verifiable | Citation correctness = 100% |
| Agents cannot wait >1 second per query | p95 latency ≤ 1000ms |
| Monthly retrieval cost must fit in $X budget | Cost per query ≤ $(X / monthly queries) |

Thresholds should be tight enough to catch real failures, loose enough that the team can actually meet them.

## Benchmarking Workflow

Design the workflow so evaluations can be repeated as retrieval evolves:

1. **Baseline:** Run the evaluation set against current retrieval. Record all metrics. This is your reference point.
2. **Change:** Modify chunking, embedding model, reranker, or metadata filters.
3. **Re-evaluate:** Run the same evaluation set against the modified retrieval. Compare metrics to baseline.
4. **Decision:** Did the change improve recall, latency, cost? By how much? Is it worth the tradeoff?

### Automation Checklist

- [ ] Evaluation set loaded and versioned (tag with corpus version, date)
- [ ] Retrieval queries automated (script that runs all questions against current retrieval)
- [ ] Metrics computed automatically (Recall@k, nDCG, citation correctness, latency, cost)
- [ ] Results saved with timestamp, corpus version, retrieval configuration
- [ ] Comparison tool shows delta from baseline
- [ ] Runbook for re-running evaluations documented

Without automation, evaluation becomes ad-hoc and people skip it.

## Testing Hybrid Retrieval

A common hypothesis: hybrid (dense + lexical) retrieval beats either alone.

Test this systematically:

| Strategy | Queries | Recall@10 | nDCG@10 | Citation Correct | Latency p95 | Cost per Query |
|---|---|---|---|---|---|---|
| Lexical only (BM25) | 200 | 72% | 0.68 | 100% | 45ms | $0.001 |
| Dense only (embeddings) | 200 | 78% | 0.71 | 100% | 120ms | $0.015 |
| Hybrid (combined) | 200 | 85% | 0.76 | 100% | 140ms | $0.016 |
| Hybrid + reranker | 200 | 87% | 0.78 | 100% | 180ms | $0.020 |

Conclusions:
- Hybrid beats either alone (85% vs 72–78%)
- Reranker adds 2–3% recall, but cost and latency increase 30%
- Cost per query (hybrid + reranker) is ~20x lexical alone

Decision: "Hybrid retrieval is justified. Reranking is marginal; proceed with hybrid, skip reranker for now."

## Quality Gates

Establish gates that block decisions:

| Gate | Blocks What | Trigger |
|---|---|---|
| Citation correctness < 100% | Agent API finalization | Wrong citations are unacceptable |
| Recall@10 < acceptance threshold | Architecture lock-in | Retrieval doesn't meet requirements |
| Latency p95 > SLA | Production deployment | Speed commitments not met |
| Cost per query > budget | Scaling decision | Economics don't work at volume |

If a gate fails, the team does not proceed. They tune retrieval or revisit requirements.

## Output

A documented evaluation harness including:
- **Metric definitions:** Formulas and implementation for Recall@k, nDCG, citation correctness, latency, cost
- **Acceptance thresholds:** Per-metric targets with justification
- **Benchmarking workflow:** Steps and automation for re-running evaluations
- **Baseline results:** Metrics for current/reference retrieval (if any) against the evaluation set
- **Quality gates:** Conditions that block architecture, deployment, or scaling decisions
- **Reporting template:** How results are presented (tables, charts, narrative)

The harness becomes a living artifact. Update it as requirements change. Document every gate that blocks a decision.
