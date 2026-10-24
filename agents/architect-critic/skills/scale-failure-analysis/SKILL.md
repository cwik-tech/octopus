---
name: scale-failure-analysis
description: Take an architecture proposal to 10x users, 10x data, and 10x request rate independently, identify which dimension breaks first and at what threshold, and check whether an operator who did not design it can diagnose the failure at 3am.
---

# Scale Failure Analysis

## Purpose

Most architecture reviews stop at "will it scale," which is unanswerable, and settle for "probably," which is useless. This skill replaces that with three independent sweeps that each produce a named mechanism, an approximate threshold, and an observable symptom — the three things that turn a worry into a finding a decision record can carry.

It then checks the design against the only test that matters after deployment: can someone who did not build it figure out what is wrong, at night, under pressure, in fifteen minutes.

## When to use

- After a proposal survives `complexity-budget-audit` — there is no point stress-testing a design that should be cut.
- Whenever a proposal explicitly claims it will scale.
- When a design introduces state, caching, queuing, fan-out, or any in-process accumulation.
- On any desktop or embedded architecture where resource ceilings are hard rather than elastic.

## The three sweeps

Run each dimension **independently**. Systems rarely break on all three at once, and conflating them hides which one actually bites first. For each sweep, hold the other two constant.

### Sweep 1 — 10x users

Multiply concurrent and total users by ten. Walk the design and ask:

- What becomes contended? Locks, connection pools, single-writer paths, leader elections, shared caches.
- What is per-user and now multiplied? Sessions, websockets, subscriptions, in-memory state, open file handles.
- What was implicitly serialized because there was only ever one user at a time?
- Where does a fair-scheduling assumption break — does one heavy user now starve the rest?
- What in the auth, rate-limit, or quota path assumed a small population?

### Sweep 2 — 10x data

Multiply records, documents, or bytes by ten. Walk the design and ask:

- What was loaded fully into memory and now is not? Indices, embeddings, caches, config, lookup tables.
- Which query goes from index scan to table scan, or from bounded to unbounded result set?
- What is O(n) per request that was invisible at n=100 and is fatal at n=100,000?
- What has a hard ceiling rather than a soft one? Renderer heap, mobile memory limit, filesystem inode count, single-file size limits, IPC message size caps.
- What migration, reindex, or backfill now takes longer than an acceptable maintenance window?
- Where does a full-corpus operation exist that was fine when the corpus was small?

### Sweep 3 — 10x request rate

Multiply operations per second by ten, holding users and data constant. Walk the design and ask:

- Where does a queue form, and is it bounded? An unbounded queue is a memory leak with a schedule.
- What retries, and does the retry policy amplify rather than absorb? Retry storms turn a brownout into an outage.
- What downstream dependency now sees 10x, and what is its actual limit — including third-party rate limits and per-minute API quotas?
- Where is there a synchronous call that should have been asynchronous, or an asynchronous one with no backpressure?
- What has a cold-start or warm-up cost that was amortized at low rate and is now on the critical path?

## Naming the failure mode

A finding is only complete when it has all three of these. Anything less is a mood, and moods do not belong in a decision record.

| Component | Requirement | Bad | Good |
|---|---|---|---|
| **Mechanism** | The specific thing that runs out or blocks | "memory issues" | "the in-process embedding cache holds one float32 vector per chunk with no eviction" |
| **Threshold** | Approximate point where it bites | "at scale" | "around 50k chunks, ~1.5GB, against the renderer heap cap" |
| **Symptom** | What an operator observes | "it breaks" | "renderer process hard-crashes with no error dialog; user sees the window vanish" |

The threshold may be a rough order of magnitude — precision is not required, but a number is. If you cannot produce one, you have not yet found the mechanism. Keep working or drop the concern.

Rank findings by **which dimension breaks first**. A design that fails at 3x data and survives 100x users has a data problem, and that is the sentence the decision record needs.

## The 3am operability check

Assume the failure you named has occurred. The person responding did not design the system, has a laptop and a dashboard, and has roughly fifteen minutes before it becomes a business problem.

Walk the path:

1. **Alert.** Does anything fire, or does the first signal come from a user? Silent failures are the most expensive kind.
2. **Localize.** Can the operator tell which component is at fault from the alert alone, or must they check five things in sequence?
3. **Diagnose.** Are the relevant metrics, logs, and traces actually emitted — and correlated? A distributed design with uncorrelated logs converts every incident into archaeology.
4. **Mitigate.** Is there something they can do right now — restart, flag, scale, shed load — without a code change? If mitigation requires a deploy, the MTTR floor is your deploy time.
5. **Contain.** When this component fails, what else fails with it? Map the blast radius. Shared infrastructure means one failure presents as five unrelated symptoms.

Record where visibility disappears. Opacity is a design defect with the same standing as a performance defect, and it should be reported with the same specificity.

## Degradation shape

For each named failure, classify how it arrives. This determines whether the failure is survivable.

- **Graceful** — throughput drops, latency rises, the system stays up and recovers when load falls. Acceptable.
- **Cliff** — fine until a threshold, then sudden and total. Dangerous, because monitoring below the threshold shows green right up until it does not.
- **Cascading** — one component's failure loads the next, which fails, which loads the next. The worst kind; the initial trigger is often unrecoverable from logs.
- **Silent corruption** — the system stays up and produces wrong answers. Worse than an outage, because nobody knows to respond.

Cliff and silent-corruption findings should be escalated regardless of how distant the threshold appears, because both defeat the monitoring that would otherwise warn you.

## Output

1. **Breaks-first verdict** — which of users, data, or rate fails earliest, with its threshold.
2. **Named failure modes** — one entry per finding, each with mechanism, threshold, symptom, and degradation shape.
3. **Operability gaps** — where the 3am walk loses visibility, and at which step.
4. **Blast radius** — what else fails when the first thing does.
5. **Bounded and understood** — dimensions where the design is genuinely safe within the planning horizon. Say so explicitly; this is as useful as the failures.

## Failure modes of this skill

- **10x on a problem that will never be 2x.** Check the planning horizon before sweeping. A design correctly sized for a fixed 500-user internal tool does not need to survive 5,000.
- **Concern without threshold.** If you cannot produce a number, you have not finished the analysis. Drop it rather than reporting it soft.
- **Conflating the sweeps.** Run them independently, or you will not know which dimension to fix.
- **Ignoring the clean result.** "Bounded and understood at all three dimensions" is a real and valuable finding. Report it plainly and stop.
