---
name: architecture-question-classification
description: Classify an incoming architecture question into one of eight domains, distinguish the stated question from the load-bearing question underneath it, and handle mixed-domain and hidden-domain cases so seat selection is driven by what will actually decide the question.
---

# Architecture Question Classification

## Purpose

Seat selection is only as good as the classification behind it. This skill turns a raw architecture question into a primary domain, an optional secondary domain, and a one-sentence statement of the load-bearing question — the three inputs the convening step needs.

Run this before any seat is convened. Never classify silently: state the result and the reasoning so the user can correct you cheaply, before the room fills with the wrong specialists.

## The eight domains

| Domain | Owns questions about | Typical surface wording |
|---|---|---|
| **web-cloud** | Web application architecture, rendering strategy, server/client boundaries, deployment topology, hosting and edge, API shape | "SSR or client-side?", "how should this API be structured?", "where does this run?" |
| **native-desktop** | Electron and Tauri runtimes, packaging, distribution, auto-update, code signing and notarization, native API access, IPC, OS integration | "Tauri or Electron?", "how do we ship updates?", "can we reach the OS accessibility layer?" |
| **knowledge-retrieval** | Knowledge representation, indexing and chunking, retrieval strategy, embedding and ranking, context assembly, evaluation of retrieval quality | "how do we chunk this?", "why is retrieval returning the wrong thing?", "vector or keyword or both?" |
| **domain-modeling** | Entity and aggregate design, bounded contexts, invariants, state machines, naming and conceptual integrity, where behavior lives | "what is the right model here?", "should these be one entity or two?", "where does this rule belong?" |
| **agent-runtime** | Agent and pipeline orchestration, control flow, handoff and delegation, tool boundaries, context windows, loop control, failure and retry semantics | "how do these agents hand off?", "who owns this step?", "how do we stop the loop?" |
| **storage** | Database selection, schema and migration strategy, consistency and transaction boundaries, caching layers, read/write patterns, scale and throughput | "which database?", "how do we migrate this?", "will this hold at volume?" |
| **security** | Authentication and authorization, secrets handling, trust boundaries, threat surface, data protection, supply chain, signing and provenance | "is this safe to expose?", "where do the credentials live?", "who can reach this?" |
| **mixed** | Questions where two or three domains jointly decide the answer and none dominates | Anything that keeps pulling a second domain in every time you try to answer it |

## Classification procedure

1. **Read the question as stated.** Note the domain the wording points at. Hold it loosely.
2. **Find the load-bearing question.** Ask: what would actually have to be resolved for this question to be answered? That is the load-bearing question, and it frequently sits in a different domain than the wording suggests. Classify on it.
3. **Assign a primary domain.** Exactly one. This is the domain that will supply the deciding constraint.
4. **Assign a secondary domain if one applies.** At most one, and only when a second domain will materially shape the answer rather than merely touch it. If you find yourself wanting a third, you are looking at a mixed question or a question that should be split.
5. **Check for a hidden domain.** Some questions carry an unstated constraint that outranks everything named — most often security, cost, or team capability. If one is present, name it even if it does not become the primary.
6. **State the classification out loud** in one or two sentences: primary, secondary if any, and the load-bearing question. Invite correction implicitly by being specific, not by asking permission.

## The stated-vs-load-bearing gap

This is the highest-value move in the skill. Common gaps:

| Stated as | Load-bearing domain is often | Because |
|---|---|---|
| "Tauri or Electron?" | native-desktop, but frequently security or web-cloud | Signing, notarization, and update-channel trust often decide it, not the runtime |
| "Which vector database?" | knowledge-retrieval, not storage | Chunking and ranking strategy usually determine the answer before infrastructure does |
| "How should agents hand off?" | domain-modeling, not agent-runtime | Unclear handoff usually means unclear ownership of the underlying concept |
| "Should this be one service or two?" | domain-modeling, not web-cloud | The boundary question is conceptual before it is topological |
| "How do we cache this?" | storage or domain-modeling | Caching questions frequently reveal an unclear consistency requirement |

When the stated and load-bearing domains differ, say both. "This reads as a runtime question, but what will decide it is distribution and signing" gives the user a chance to redirect you in one line.

## Handling mixed questions

A question is genuinely **mixed** when two or three domains each supply a constraint that could independently decide it, and no single domain dominates.

- Two or three domains → classify as mixed, list the contributing domains in priority order, and convene from each.
- Four or more domains → do not classify as mixed. The question is too large. Split it into sequenced sub-questions, each with its own classification, and run them as separate convenings in dependency order.

Mixed is a real classification, not a fallback for uncertainty. If you are unsure between two domains, pick the one supplying the deciding constraint and name the other as secondary — do not reach for mixed to avoid choosing.

## Re-classification triggers

Classification is not permanent. Re-classify when:

- The discussion has spent several exchanges on a domain outside the primary and secondary.
- A specialist names a constraint from an unconvened domain that changes what the answer would be.
- The user supplies new context — scale, team, deadline, compliance — that shifts which constraint decides.
- The board reaches consensus suspiciously fast, which usually means the deciding domain is absent from the room.

On re-classification, hand the new primary/secondary to the convening skill and announce the change.

## Anti-patterns

- **Classifying on vocabulary.** The presence of the word "database" does not make it a storage question.
- **Multi-primary hedging.** "This is primarily web-cloud and storage and security" is not a classification; it is an unwillingness to commit.
- **Silent classification.** If the user never sees the classification, they cannot correct the one input every later step depends on.
- **Defaulting to mixed.** Mixed should be a minority of sessions. If most questions are landing there, the taxonomy is being applied to surface wording rather than deciding constraints.

## Output of this skill

A three-part result handed to `board-convening`:

- **Primary domain:** one of the eight.
- **Secondary domain:** one of the eight, or none.
- **Load-bearing question:** one sentence, plus a note if it differs from the question as stated.
