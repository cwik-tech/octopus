---
name: retrieval-evaluation-harness
description: Designs the evaluation harness for a retrieval system — golden set construction, metric selection, stage-wise attribution, regression gating, and the offline/online split — treating measurability as a blocking architectural requirement rather than a later addition.
---

# Retrieval Evaluation Harness

## Purpose

Make retrieval quality observable. A retrieval architecture without a harness is unfalsifiable: nobody can tell whether the reranker helped, whether the chunk size was wrong, or whether the whole layer is returning noise the model politely routes around. This skill produces the harness *before* the topology is treated as decided.

## When to use

Every session involving retrieval, without exception. If the topology is proposed and the harness is deferred, the harness is the deliverable.

## Step 1 — Golden set construction

The golden set is the asset. Everything else is arithmetic over it.

- **Query sourcing.** Real queries beat invented ones. Pull from logs, support tickets, user interviews. Invented queries encode the builder's assumptions about what users ask.
- **Query classes.** Stratify deliberately: factual lookup, multi-hop, comparison, negation, rare-term, ambiguous, out-of-corpus. A harness that only tests easy lookups will report health while the hard classes fail silently.
- **Relevance labels.** Binary relevance is cheap and coarse; graded relevance is expensive and sharper. Choose per query class. Label at the chunk level, not the document level — document-level labels hide chunking failures.
- **Out-of-corpus set.** Include queries the corpus genuinely cannot answer. A system that always retrieves something will always retrieve something wrong.
- **Size.** Enough per class to detect the effect size that matters. Under ~30 per class, class-level differences are noise.
- **Ownership.** Name who maintains the set and how it grows. An unowned golden set decays within one quarter.

## Step 2 — Metric selection

Match the metric to what the system actually needs.

| Metric | Answers | Use when |
|---|---|---|
| Recall@k | Did the right chunk make it into the candidate set? | Diagnosing first-stage retrieval |
| Precision@k | How much of what we retrieved was relevant? | Context budget is tight |
| nDCG@k | Is relevant content ranked near the top? | Reranking is in play, order matters |
| MRR | How deep is the first relevant hit? | Single-answer lookup workloads |
| Faithfulness | Is the generated answer grounded in retrieved content? | End-to-end quality gate |
| Latency p50/p95/p99 | Does it meet the budget under load? | Always — p99 is the one that pages someone |
| Cost per query | Is this economically viable at volume? | Always |

Pick a small set with an explicit primary metric. Teams that track ten metrics optimize none.

## Step 3 — Stage-wise attribution

End-to-end answer quality tells you nothing about which stage broke. Instrument per stage:

1. **Retrieval stage.** Recall@k of the candidate set, before reranking. If the right chunk never enters the candidate set, no downstream stage can recover it.
2. **Reranking stage.** nDCG shift from pre-rerank to post-rerank ordering. A reranker with no measurable shift is latency with a job title.
3. **Assembly stage.** Does the right chunk survive truncation, deduplication, and ordering into the final context?
4. **Generation stage.** Given a context that provably contains the answer, does the model use it?

The common failure: months spent tuning generation prompts when recall@k is 0.4.

## Step 4 — Regression gating

- What is the primary metric threshold below which a change does not ship?
- What secondary metrics act as guardrails against gaming the primary?
- Does the harness run in CI, on a schedule, or on demand? On-demand harnesses are run once and abandoned.
- What is the runtime and cost of a full harness pass, and is that cheap enough to run on every meaningful change?

If the harness is too slow or expensive to run routinely, it will not be run. Design a fast subset for per-change gating and a full pass for release gating.

## Step 5 — Offline and online split

- **Offline.** Golden set, deterministic, fast, catches regressions. Cannot detect distribution shift in real queries.
- **Online.** Real traffic signals — click-through on citations, follow-up query rate, thumbs, escalation rate. Detects drift, but slow and confounded.

Name which signals live where. An offline-only harness goes stale as query distribution moves; an online-only harness cannot gate a deploy.

## Step 6 — Ablation plan

For each retrieval path, reranker, and non-trivial parameter, state the ablation that would prove it earns its place:

- Remove the sparse path — which query classes degrade, and by how much?
- Remove the reranker — what is the nDCG cost, and what is the latency saving?
- Halve k — what recall is lost, and what context budget is freed?

A component that survives no ablation test is complexity nobody has justified.

## Output

A harness specification containing: golden set shape and owner, primary and guardrail metrics, per-stage instrumentation points, regression thresholds, execution cadence, the offline/online signal split, and the ablation plan. This ships *with* the topology, not after it.
