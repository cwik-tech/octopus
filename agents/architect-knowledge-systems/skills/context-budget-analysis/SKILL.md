---
name: context-budget-analysis
description: Prices retrieval in tokens, latency, and money — computes per-query context budget, models cost and latency at target and 10x scale, names which stage degrades first, and produces the honest curated-context baseline that any retrieval topology must beat.
---

# Context Budget Analysis

## Purpose

Retrieval decisions are usually argued in quality terms and paid for in tokens, milliseconds, and dollars. This skill makes the payment explicit and produces the baseline every retrieval topology must actually beat: the curated context that needs no infrastructure.

## When to use

When cost, latency, or context window is contested; when the critic raises scale; and whenever a retrieval topology is proposed for a corpus small enough that curation is plausible.

## Step 1 — Enumerate the budget

Everything competing for the context window, counted:

| Consumer | Typical share | Notes |
|---|---|---|
| System instructions | Fixed | Grows quietly over a project's life |
| Tool or schema definitions | Fixed | Often the largest unnoticed consumer |
| Conversation history | Growing | Needs a truncation or summarization policy |
| Retrieved context | Variable | The part under design |
| Output reservation | Fixed | Must be held back, not discovered at generation time |

Compute what is actually left for retrieval. Teams routinely design a topology assuming a full window that the system prompt already consumed a third of.

## Step 2 — Price the retrieved unit

- Tokens per chunk, measured on real corpus samples rather than assumed.
- Chunks per query (k after reranking, not the candidate k).
- Metadata, provenance, and separator overhead per chunk — usually underestimated by half.
- Total retrieved tokens per query, against the budget from Step 1.

If retrieved tokens exceed the remaining budget, the topology is already broken. Fix k, chunk size, or compression before proceeding.

## Step 3 — Latency path

Walk the query path and attribute time to each hop:

1. Query embedding
2. Index search (dense)
3. Index search (sparse), if present
4. Graph traversal, if present — including depth-dependent fan-out
5. Fusion
6. Reranking
7. Assembly
8. Generation time-to-first-token

Report p50, p95, and p99. p50 flatters every retrieval system; p99 is where the graph traversal fan-out and the cold index shard show up.

Mark which hops are parallelizable and which are strictly sequential. Sequential hops set the floor.

## Step 4 — Cost model

Per query: embedding, index query, rerank, and generation input tokens. Then multiply by realistic query volume — daily, monthly, peak.

Separately: index build and rebuild cost, storage cost at target corpus size, and full re-embed cost when the embedding model changes. That last one is the number nobody budgets for and everyone eventually pays.

## Step 5 — Scale projection

At 10x corpus, name what happens to each of:

| Dimension | Scaling behavior | First threshold |
|---|---|---|
| Index size and memory | Usually linear | When it exceeds host memory |
| Query latency | Sub-linear for ANN, worse with filters | When p99 breaks the budget |
| Recall at fixed k | Degrades — more near-neighbors compete | When recall@k drops below the gate |
| Rerank cost | Linear in candidate k | When k must shrink, costing recall |
| Reindex window | Linear, often superlinear with compute limits | When it exceeds the maintenance window |

**State the degradation order explicitly.** Which stage breaks first, at what corpus size, and what the mitigation is. Deliver this before the critic asks — it is the single question they will always ask.

## Step 6 — The curated-context baseline

Build the honest alternative. For the same problem, assume no retrieval:

- What is the total corpus in tokens, and does a curated subset fit the budget?
- What would that curated context cost to assemble once, and to maintain per change?
- What accuracy does it deliver on the golden set query classes?
- What does it cost per query — usually just input tokens, with zero infrastructure?

The baseline is not rhetorical. On bounded, stable corpora it frequently wins on accuracy, latency, cost, *and* operational burden simultaneously. Report it fairly; if it wins, say so.

## Step 7 — Compression options, in order of preference

When the budget is tight, work these before adding infrastructure:

1. Reduce k — cheapest, costs recall, measure it.
2. Shrink chunks — costs context coherence.
3. Extractive compression — cheap, lossy at boundaries.
4. Abstractive summarization of retrieved chunks — adds a model call and a new failure mode.
5. Hierarchical retrieval, summaries then detail — adds a round trip.

Each option trades a measurable quantity. Name the trade rather than asserting the option.

## Output

A budget statement containing: remaining context after fixed consumers, tokens per query, latency at p50/p95/p99 with per-hop attribution, cost per query and per month, the 10x degradation order with first-failing stage and threshold, and the curated-context baseline with an honest verdict on whether retrieval beats it.
