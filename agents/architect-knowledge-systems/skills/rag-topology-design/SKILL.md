---
name: rag-topology-design
description: End-to-end retrieval topology design — runs a necessity gate before proposing any retrieval layer, then works ingestion, chunking, embedding, index, hybrid composition, reranking, context assembly, and freshness in order, justifying each layer against actual query shapes.
---

# RAG Topology Design

## Purpose

Produce a defensible retrieval architecture, or a defensible refusal to build one. Most retrieval systems are assembled by picking a vector database first and reverse-engineering the rest. This skill inverts that: establish whether retrieval is warranted, then derive each layer from the query shapes the system must serve.

## When to use

Every session where retrieval is proposed, assumed, or already built. Run it even when the brief opens with "our RAG pipeline" — especially then.

## Step 0 — The necessity gate

Before any topology work, answer three questions:

| Dimension | Question | Retrieval warranted when |
|---|---|---|
| Size | How many tokens is the full corpus? | Exceeds a comfortable context budget by a wide margin |
| Volatility | How often does content change? | Changes faster than a curated context can be maintained |
| Heterogeneity | How varied are the queries? | Queries hit unpredictable, non-overlapping slices |

**Decision rule.** Fewer than two dimensions failing means curate the context and do not build retrieval. Say this plainly and propose the curated alternative — a hand-assembled context, a static index of summaries, or a routing layer over a handful of documents.

If the gate fails but the team is committed to retrieval anyway, name the cost explicitly: infrastructure, evaluation burden, latency, and a new failure mode where the system confidently retrieves the wrong passage.

## Layer 1 — Ingestion

- What are the source formats, and what fidelity is lost converting them?
- What structure exists in the source (headings, tables, code blocks, threading) that must survive?
- What metadata is available at ingestion that could later filter or boost retrieval?
- What is the ingestion cadence, and is it batch or streaming?

Metadata captured at ingestion is nearly impossible to recover later. Enumerate it now.

## Layer 2 — Chunking

Chunk boundaries follow the shape of the *questions*, not the shape of the *files*.

- What is the typical answer span — a sentence, a paragraph, a section, a whole document?
- Do queries need cross-boundary context, and if so, does overlap or parent-document retrieval serve it better?
- Are there natural semantic boundaries (sections, functions, turns) that should be respected?
- What breaks when a chunk splits mid-table, mid-code-block, or mid-argument?

Name the chunking strategy, the size, the overlap, and the reason for each. "512 tokens with 50 overlap" without a reason is a default, not a decision.

## Layer 3 — Embedding

- What is the domain vocabulary, and does a general-purpose model cover it?
- What dimensionality, and what does the extra dimension cost in index size and query latency?
- Is the query distribution symmetric with the document distribution, or asymmetric (short query, long passage)?
- What is the max sequence length, and does it accommodate the chosen chunk size?
- What is the cost and latency of embedding the full corpus, and of re-embedding it when the model changes?

Model choice binds the index. Changing embedding models later means a full reindex — treat it as a migration, not a config change.

## Layer 4 — Index

- Approximate or exact nearest neighbor, and what recall loss is acceptable?
- What is the index build time and memory footprint at target corpus size?
- Does the workload need metadata filtering, and does the index support it without collapsing to a scan?
- Is the deployment target server, edge, or local? Local-first constrains index size and build compute severely.

## Layer 5 — Hybrid composition

Add a retrieval path only when a query class systematically fails on existing paths.

| Path | Serves | Costs |
|---|---|---|
| Dense | Semantic similarity, paraphrase, conceptual match | Embedding compute, weak on rare exact terms |
| Sparse (BM25 or similar) | Exact terms, identifiers, rare vocabulary, negation | Index maintenance, weak on paraphrase |
| Graph traversal | Multi-hop relations, provenance chains, structural queries | Schema dependency, traversal latency, depth budget |

For each path included, state the query class it serves and what breaks if it is removed. For fusion, name the method (reciprocal rank fusion, weighted score, cascade) and how the weights will be tuned — an untuned fusion weight is a guess.

Graph traversal has a boundary: the traversal *strategy, depth budget, and cost* are retrieval decisions. The *entity and relation schema* is not — route that to the ontology owner.

## Layer 6 — Reranking

- Does the first-stage retrieval have a recall problem or a precision problem? Reranking fixes precision only.
- What is the rerank latency at target k, and does it fit the budget?
- Cross-encoder, LLM-as-reranker, or heuristic — and what does each cost per query?
- What k goes in and what k comes out?

A reranker over a first stage with poor recall is expensive polish on a hole. Fix recall first.

## Layer 7 — Context assembly

- How many chunks reach the model, and in what order?
- Is there deduplication, and does it operate on text or on source?
- Are chunks presented with provenance, and does downstream output need to cite them?
- What happens when retrieved content contradicts itself?
- What is the assembled context size against the total budget, and what else competes for that budget?

## Layer 8 — Freshness and reindexing

Decide this alongside the index, never after.

- What is the acceptable staleness contract, stated in time?
- Full rebuild, incremental upsert, or dual-write with cutover?
- What happens to in-flight queries during a rebuild?
- How are deletions propagated, and is there a tombstone requirement?
- What triggers a full re-embed, and what does it cost in time and money?

## Output

A layer-by-layer topology where every layer names the query class it serves and the cost it adds. Any layer that cannot name both should be removed. Pair the topology with the evaluation harness from `retrieval-evaluation-harness` before treating it as decided.
